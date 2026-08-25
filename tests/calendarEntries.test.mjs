// Développement des répétitions du calendrier.
//
// C'est le seul endroit du calendrier où une erreur ne se voit pas : une
// occurrence qui manque, ou qui glisse d'un jour, passe inaperçue jusqu'à ce
// qu'on rate une sortie. Les cas piégeux sont ici : le 31 dans un mois court,
// le 29 février, une fenêtre qui commence longtemps après la première
// occurrence, et le décalage de fuseau qu'introduit `new Date('YYYY-MM-DD')`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const load = () => {
  const source = readFileSync('src/utils/calendarEntries.ts', 'utf8')
    .replace(/^import type \{[\s\S]*?\} from '\.\.\/types\/calendar';$/m, '');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return { ...mod.exports, _store: store };
};

const entry = (over = {}) => ({
  id: 'e1', title: 'Test', date: '2026-03-15', category: 'event',
  recurrence: 'none', createdAt: '2026-01-01T00:00:00.000Z', ...over,
});

const dates = (occs) => occs.map((o) => o.date);

test('sans répétition : une seule occurrence, et seulement dans la fenêtre', () => {
  const { expandEntry } = load();
  assert.deepEqual(dates(expandEntry(entry(), '2026-03-01', '2026-03-31')), ['2026-03-15']);
  assert.deepEqual(dates(expandEntry(entry(), '2026-04-01', '2026-04-30')), []);
  assert.deepEqual(dates(expandEntry(entry(), '2026-01-01', '2026-03-14')), []);
});

test('bornes de la fenêtre incluses', () => {
  const { expandEntry } = load();
  assert.deepEqual(dates(expandEntry(entry(), '2026-03-15', '2026-03-15')), ['2026-03-15']);
});

test('hebdomadaire : tous les sept jours', () => {
  const { expandEntry } = load();
  assert.deepEqual(
    dates(expandEntry(entry({ recurrence: 'weekly' }), '2026-03-01', '2026-04-10')),
    ['2026-03-15', '2026-03-22', '2026-03-29', '2026-04-05'],
  );
});

test('hebdomadaire : une fenêtre lointaine ne repart pas de la première occurrence', () => {
  const { expandEntry } = load();
  const occs = dates(expandEntry(entry({ recurrence: 'weekly' }), '2027-03-01', '2027-03-31'));
  assert.equal(occs.length, 4);
  // 2026-03-15 + 51 semaines = 2027-03-07, puis tous les 7 jours.
  assert.deepEqual(occs, ['2027-03-07', '2027-03-14', '2027-03-21', '2027-03-28']);
});

test('mensuel : le quantième est conservé', () => {
  const { expandEntry } = load();
  assert.deepEqual(
    dates(expandEntry(entry({ date: '2026-01-15', recurrence: 'monthly' }), '2026-01-01', '2026-04-30')),
    ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'],
  );
});

test('mensuel le 31 : les mois trop courts sont sautés, pas la série', () => {
  const { expandEntry } = load();
  assert.deepEqual(
    dates(expandEntry(entry({ date: '2026-01-31', recurrence: 'monthly' }), '2026-01-01', '2026-07-31')),
    ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31'],
  );
});

test('annuel le 29 février : uniquement les années bissextiles', () => {
  const { expandEntry } = load();
  assert.deepEqual(
    dates(expandEntry(entry({ date: '2024-02-29', recurrence: 'yearly' }), '2024-01-01', '2033-12-31')),
    ['2024-02-29', '2028-02-29', '2032-02-29'],
  );
});

test('annuel ordinaire', () => {
  const { expandEntry } = load();
  assert.deepEqual(
    dates(expandEntry(entry({ date: '2026-03-15', recurrence: 'yearly' }), '2026-01-01', '2029-12-31')),
    ['2026-03-15', '2027-03-15', '2028-03-15', '2029-03-15'],
  );
});

test('une date de fin arrête la série', () => {
  const { expandEntry } = load();
  assert.deepEqual(
    dates(expandEntry(
      entry({ recurrence: 'weekly', recurrenceUntil: '2026-03-29' }), '2026-03-01', '2026-05-01',
    )),
    ['2026-03-15', '2026-03-22', '2026-03-29'],
  );
});

test('les occurrences portent une clé distincte par date', () => {
  const { expandEntry } = load();
  const occs = expandEntry(entry({ recurrence: 'weekly' }), '2026-03-01', '2026-04-10');
  assert.equal(new Set(occs.map((o) => o.key)).size, occs.length);
  assert.ok(occs.every((o) => o.entryId === 'e1' && o.source === 'custom'));
});

test('les dates ne glissent pas selon le fuseau', () => {
  const { toDateKey, parseDateKey } = load();
  for (const key of ['2026-01-01', '2026-03-15', '2026-12-31']) {
    assert.equal(toDateKey(parseDateKey(key)), key, `aller-retour cassé pour ${key}`);
  }
  // Le piège d'origine : `new Date('2026-03-15')` vaut minuit UTC.
  assert.notEqual(parseDateKey('2026-03-15').getTime(), new Date('2026-03-15').getTime()
    - new Date('2026-03-15').getTimezoneOffset() * 60000 - 1);
});

test('une date impossible est refusée', () => {
  const { parseDateKey } = load();
  assert.equal(parseDateKey('2026-02-31'), null);
  assert.equal(parseDateKey('2026-13-01'), null);
  assert.equal(parseDateKey('15/03/2026'), null);
});

test('categorie : les cinq valeurs connues passent, le reste devient « autre »', () => {
  const mod = load();
  mod._store.set('movixCalendarEntries', JSON.stringify([
    entry({ id: 'a', category: 'movie' }),
    entry({ id: 'b', category: 'tv' }),
    entry({ id: 'c', category: 'anime' }),
    entry({ id: 'd', category: 'documentary' }),
    entry({ id: 'e', category: 'other' }),
    // « event » a existe dans la premiere version : l'entree est conservee,
    // pas jetee, et bascule dans la categorie fourre-tout.
    entry({ id: 'f', category: 'event' }),
    entry({ id: 'g', category: 'nimporte quoi' }),
    entry({ id: 'h', category: undefined }),
  ]));
  assert.deepEqual(
    mod.readCalendarEntries().map((e) => `${e.id}:${e.category}`),
    ['a:movie', 'b:tv', 'c:anime', 'd:documentary', 'e:other', 'f:other', 'g:other', 'h:other'],
  );
});

test('libelle libre : garde pour « autre », borne, ignore ailleurs', () => {
  const mod = load();
  mod._store.set('movixCalendarEntries', JSON.stringify([
    entry({ id: 'a', category: 'other', customCategory: '  Concert  ' }),
    entry({ id: 'b', category: 'movie', customCategory: 'Concert' }),
    entry({ id: 'c', category: 'other', customCategory: '   ' }),
    entry({ id: 'd', category: 'other', customCategory: 'x'.repeat(80) }),
    entry({ id: 'e', category: 'event', customCategory: 'Anniversaire' }),
  ]));
  const kept = mod.readCalendarEntries();
  assert.equal(kept[0].customCategory, 'Concert');
  assert.equal(kept[1].customCategory, undefined);
  assert.equal(kept[2].customCategory, undefined);
  assert.equal(kept[3].customCategory.length, 24);
  // Une entree migree depuis « event » garde son libelle : elle est desormais
  // « autre », donc le libelle y a sa place.
  assert.equal(kept[4].customCategory, 'Anniversaire');
});

test('le libelle libre suit jusque dans les occurrences', () => {
  const mod = load();
  const occurrences = mod.expandEntry(
    { ...entry({ category: 'other', customCategory: 'Concert' }) },
    '2026-03-01', '2026-03-31',
  );
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].customCategory, 'Concert');
});

test('le stockage rejette ce qui n a pas la bonne forme', () => {
  const mod = load();
  mod._store.set('movixCalendarEntries', JSON.stringify([
    entry(),
    { id: 'x', title: '', date: '2026-03-15' },        // titre vide
    { id: 'y', title: 'Sans date' },                    // pas de date
    { title: 'Sans id', date: '2026-03-15' },           // pas d'id
    { id: 'z', title: 'Date impossible', date: '2026-02-31' },
    'pas un objet',
  ]));
  const kept = mod.readCalendarEntries();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'e1');
});

test('ajout, modification et suppression', () => {
  const mod = load();
  const created = mod.addCalendarEntry({
    title: 'Sortie Dune 3', date: '2026-07-17', category: 'movie', recurrence: 'none',
  });
  assert.equal(mod.readCalendarEntries().length, 1);

  mod.updateCalendarEntry(created.id, {
    title: 'Dune 3 — avant-première', date: '2026-07-15', category: 'movie', recurrence: 'none',
  });
  assert.equal(mod.readCalendarEntries()[0].title, 'Dune 3 — avant-première');
  assert.equal(mod.readCalendarEntries()[0].date, '2026-07-15');

  mod.removeCalendarEntry(created.id);
  assert.equal(mod.readCalendarEntries().length, 0);
});

test('une répétition sans fin reste bornée sur une fenêtre large', () => {
  const { expandEntry } = load();
  const occs = expandEntry(entry({ date: '2000-01-01', recurrence: 'weekly' }), '2000-01-01', '2100-01-01');
  assert.ok(occs.length <= 500, `garde-fou inopérant : ${occs.length} occurrences`);
});
