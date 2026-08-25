// Deux séquences ne doivent jamais couvrir le même instant.
//
// C'est l'invariant que tient `resolveOverlaps` dans
// `src/utils/segmentConsensus.ts`, et il n'a rien de théorique : `outro` et
// `credits` désignent la même chose chez plusieurs bases, une proposition de la
// communauté peut mordre sur le consensus, et deux séquences actives ensemble
// se traduisent à l'écran par deux marqueurs superposés et deux cartes qui se
// disputent le même coin.
//
// Le module est transpilé à la volée (même approche que `calendarCache`) :
// TypeScript est déjà une dépendance, et cela évite un harnais de test de plus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const load = () => {
  const source = readFileSync('src/utils/segmentConsensus.ts', 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
};

const { applyProviderPreferences, mergeTrustedProposals } = load();

/** Réglages neutres : rien ne doit être écarté par un seuil dans ces cas. */
const settings = {
  providerOrder: ['skipdb', 'introdb', 'theintrodb', 'aniskip'],
  enabledProviders: ['skipdb', 'introdb', 'theintrodb', 'aniskip'],
  minConfidence: 0.4,
  minSources: 1,
  endOffset: 0,
  trustPendingProposals: true,
};

const seg = (type, start, end, confidence, source = 'skipdb') => ({
  type, start, end, confidence, agreement: 1, sourceCount: 1,
  sources: [source], source, match: 'exact',
  candidates: [{ source, start, end, confidence, match: 'exact' }],
});

function assertNoOverlap(segments) {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(
      sorted[i].start >= sorted[i - 1].end,
      `chevauchement : ${JSON.stringify(sorted[i - 1])} / ${JSON.stringify(sorted[i])}`,
    );
  }
}

test('outro et générique qui décrivent la même séquence : une seule survit', () => {
  const result = applyProviderPreferences(
    [seg('outro', 1290, 1380, 0.9), seg('credits', 1320, 1400, 0.7)],
    settings,
    1440,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'outro');
});

test('recouvrement partiel : la moins sûre est rognée, pas jetée', () => {
  const result = applyProviderPreferences(
    [seg('intro', 85, 175, 0.9), seg('recap', 60, 120, 0.6)],
    settings,
    1440,
  );
  assertNoOverlap(result);
  assert.equal(result.length, 2);
  const recap = result.find((segment) => segment.type === 'recap');
  assert.deepEqual([recap.start, recap.end], [60, 85]);
});

test('reste trop court après rognage : la séquence disparaît', () => {
  const result = applyProviderPreferences(
    [seg('intro', 10, 120, 0.9), seg('recap', 8, 60, 0.5)],
    settings,
    1440,
  );
  assertNoOverlap(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'intro');
});

test('trois séquences enchevêtrées ressortent disjointes', () => {
  const result = applyProviderPreferences(
    [seg('intro', 0, 90, 0.95), seg('recap', 70, 200, 0.6), seg('credits', 150, 400, 0.5)],
    settings,
    1440,
  );
  assertNoOverlap(result);
});

test('une proposition promue ne chevauche jamais le consensus', () => {
  const base = applyProviderPreferences([seg('outro', 1200, 1400, 0.9)], settings, 1440);
  const merged = mergeTrustedProposals(
    base,
    [{ id: '1', type: 'credits', startMs: 1300000, endMs: 1439000, adopted: false, score: 1 }],
    settings,
    1440,
  );
  assertNoOverlap(merged);
});

test('séquences disjointes : rien ne bouge', () => {
  const result = applyProviderPreferences(
    [seg('intro', 10, 100, 0.9), seg('credits', 1300, 1430, 0.8)],
    settings,
    1440,
  );
  assert.equal(result.length, 2);
  assertNoOverlap(result);
});
