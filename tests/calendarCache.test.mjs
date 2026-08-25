// Cache des fenêtres du calendrier.
//
// Un cache qui ment coûte plus cher qu'un cache absent : une fenêtre gardée
// trop longtemps affiche des sorties périmées, une clé mal formée mélange deux
// mois, une éviction ratée fait tomber le stockage en quota. Ce sont les
// quatre cas testés ici, plus l'horloge reculée — le seul moyen connu de
// rendre une entrée éternelle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const load = ({ failWrites = false } = {}) => {
  const source = readFileSync('src/utils/calendarCache.ts', 'utf8')
    .replace(/^import type \{[\s\S]*?\} from '\.\.\/types\/calendar';$/m, '')
    // `import.meta.env` est remplacé par Vite au build ; en CommonJS transpilé,
    // la syntaxe elle-même est illégale. On substitue la valeur, comme Vite.
    .replace(/import\.meta\.env\.VITE_APP_BUILD_ID/g, "'test-build'");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const map = new Map();
  globalThis.sessionStorage = {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => { map.delete(k); },
  };

  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return { ...mod.exports, _store: map };
};

const occurrence = (date) => ({
  key: `k-${date}`, source: 'watchlistEpisodes', category: 'tv', date, title: 'Test',
});

/** Recule l'horodatage d'une entrée déjà écrite, sans toucher à l'horloge. */
const age = (store, key, ms) => {
  const parsed = JSON.parse(store.get(key));
  parsed.ts -= ms;
  store.set(key, JSON.stringify(parsed));
};

test('une fenêtre écrite est relue fraîche, à l identique', () => {
  const mod = load();
  const key = mod.calendarCacheKey('2026-03-01', '2026-03-31', ['alerts'], 'fr');
  mod.writeCalendarWindow(key, [occurrence('2026-03-12')]);

  const read = mod.readCalendarWindow(key);
  assert.equal(read.fresh, true);
  assert.deepEqual(read.occurrences, [occurrence('2026-03-12')]);
});

test('passé la fraîcheur, la fenêtre reste affichable mais n est plus fraîche', () => {
  const mod = load();
  const key = mod.calendarCacheKey('2026-03-01', '2026-03-31', ['alerts'], 'fr');
  mod.writeCalendarWindow(key, [occurrence('2026-03-12')]);
  age(mod._store, key, mod.FRESH_MS + 1000);

  const read = mod.readCalendarWindow(key);
  assert.equal(read.fresh, false);
  assert.equal(read.occurrences.length, 1);
});

test('passé la péremption dure, la fenêtre est jetée', () => {
  const mod = load();
  const key = mod.calendarCacheKey('2026-03-01', '2026-03-31', ['alerts'], 'fr');
  mod.writeCalendarWindow(key, [occurrence('2026-03-12')]);
  age(mod._store, key, mod.HARD_EXPIRY_MS + 1000);

  assert.equal(mod.readCalendarWindow(key), null);
  assert.equal(mod._store.has(key), false);
});

test('une horloge reculée ne rend pas une entrée éternelle', () => {
  const mod = load();
  const key = mod.calendarCacheKey('2026-03-01', '2026-03-31', ['alerts'], 'fr');
  mod.writeCalendarWindow(key, [occurrence('2026-03-12')]);
  age(mod._store, key, -60 * 60 * 1000);

  assert.equal(mod.readCalendarWindow(key), null);
});

test('la clé ignore l ordre des sources mais pas la langue ni la fenêtre', () => {
  const mod = load();
  const a = mod.calendarCacheKey('2026-03-01', '2026-03-31', ['alerts', 'custom'], 'fr');
  const b = mod.calendarCacheKey('2026-03-01', '2026-03-31', ['custom', 'alerts'], 'fr');
  const en = mod.calendarCacheKey('2026-03-01', '2026-03-31', ['alerts', 'custom'], 'en');
  const other = mod.calendarCacheKey('2026-04-01', '2026-04-30', ['alerts', 'custom'], 'fr');

  assert.equal(a, b);
  assert.notEqual(a, en);
  assert.notEqual(a, other);
});

test('une entrée illisible ne fait pas planter la lecture', () => {
  const mod = load();
  const key = mod.calendarCacheKey('2026-03-01', '2026-03-31', ['alerts'], 'fr');
  mod._store.set(key, '{ pas du json');
  assert.equal(mod.readCalendarWindow(key), null);

  mod._store.set(key, JSON.stringify({ ts: Date.now(), occurrences: 'pas un tableau' }));
  assert.equal(mod.readCalendarWindow(key), null);
});

test('le nombre de fenêtres gardées est borné', () => {
  const mod = load();
  for (let month = 1; month <= 20; month += 1) {
    const from = `2026-${String(month).padStart(2, '0')}-01`;
    mod.writeCalendarWindow(
      mod.calendarCacheKey(from, from, ['alerts'], 'fr'),
      [occurrence(from)],
    );
  }
  assert.ok(mod._store.size <= 12, `12 attendu au plus, ${mod._store.size} gardées`);

  // Le dernier mois écrit doit être là : c'est le plus ancien qui saute.
  const last = mod.calendarCacheKey('2026-20-01', '2026-20-01', ['alerts'], 'fr');
  assert.ok(mod._store.has(last));
});

test('un stockage en échec dégrade sans jamais lever', () => {
  const mod = load({ failWrites: true });
  const key = mod.calendarCacheKey('2026-03-01', '2026-03-31', ['alerts'], 'fr');
  assert.doesNotThrow(() => mod.writeCalendarWindow(key, [occurrence('2026-03-12')]));
  assert.equal(mod.readCalendarWindow(key), null);
});

test('une fenêtre démesurée n est pas persistée', () => {
  const mod = load();
  const key = mod.calendarCacheKey('2026-03-01', '2026-03-31', ['alerts'], 'fr');
  const huge = Array.from({ length: 4000 }, (_, index) => ({
    ...occurrence('2026-03-12'),
    key: `k${index}`,
    note: 'x'.repeat(60),
  }));
  mod.writeCalendarWindow(key, huge);
  assert.equal(mod._store.size, 0);
});
