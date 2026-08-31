// Fusion des segments TMDB en épisodes diffusés.
//
// Les pièges sont tous des trous dans les données TMDB : un code de production
// absent, une durée absente, une durée fausse sur un segment, un code répété.
// Chacun a une saison réelle de « Bienvenue chez les Loud » derrière lui — voir
// `scripts/check-segmented-show.mjs`, qui rejoue la fusion sur les vraies
// données.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const load = (path) => {
  const js = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
};

const { mergeSegmentedSeason } = load('src/utils/mergeSegmentedSeason.ts');
const { SEGMENTED_SHOWS, getSegmentedShowConfig, getSeasonLimit, getProductionCodeFixes, isMergeableSeason } =
  load('src/utils/segmentedShows.ts');

let nextId = 1;
/** Segment de 11 minutes. `code` optionnel pour tester le repli par adjacence. */
const seg = (number, name, code) => ({
  id: nextId++,
  episode_number: number,
  name,
  overview: `Synopsis ${name}`,
  runtime: 11,
  air_date: `2020-01-${String(number).padStart(2, '0')}`,
  still_path: `/still-${number}.jpg`,
  vote_average: 8,
  production_code: code ?? null,
});

/** Épisode pleine durée. */
const full = (number, name, code, runtime = 22) => ({
  ...seg(number, name, code),
  runtime,
});

const names = (result) => result.episodes.map((episode) => episode.name);
const numbers = (result) => result.episodes.map((episode) => episode.episode_number);

// ---------------------------------------------------------------------------

test('paire simple : deux segments du même code deviennent un épisode', () => {
  const result = mergeSegmentedSeason([seg(1, 'A', '101A'), seg(2, 'B', '101B')]);

  assert.equal(result.episodes.length, 1);
  const [episode] = result.episodes;
  assert.equal(episode.name, 'A / B');
  assert.equal(episode.overview, 'Synopsis A\n\nSynopsis B');
  assert.equal(episode.runtime, 22);
  assert.equal(episode.episode_number, 1);
  assert.equal(episode.air_date, '2020-01-01');
  assert.equal(episode.still_path, '/still-1.jpg');
  assert.deepEqual(episode.source_episode_numbers, [1, 2]);
  assert.equal(episode.source_episode_ids.length, 2);
  assert.equal(episode.production_slot, '101');
  assert.equal(episode.is_merged, true);
  assert.equal(episode.part, null);
  assert.deepEqual(result.warnings, []);
});

test('épisode entier en début de saison : émis seul, sans consommer de segment', () => {
  const result = mergeSegmentedSeason([
    full(1, 'Spécial', '201'),
    seg(2, 'A', '202A'),
    seg(3, 'B', '202B'),
  ]);

  assert.deepEqual(names(result), ['Spécial', 'A / B']);
  assert.equal(result.episodes[0].is_merged, false);
  assert.equal(result.stats.standaloneCount, 1);
  assert.equal(result.stats.pairCount, 1);
});

test('épisode entier au milieu de la saison : ne casse pas les paires qui l\'entourent', () => {
  const result = mergeSegmentedSeason([
    seg(1, 'A', '201A'),
    seg(2, 'B', '201B'),
    full(3, 'Spécial', '202'),
    seg(4, 'C', '203A'),
    seg(5, 'D', '203B'),
  ]);

  assert.deepEqual(names(result), ['A / B', 'Spécial', 'C / D']);
  assert.deepEqual(numbers(result), [1, 2, 3]);
});

test('les deux moitiés se retrouvent même à distance dans la liste TMDB', () => {
  // Cas réel : saison 3, `309A` en position 15 et `309B` en position 33.
  const result = mergeSegmentedSeason([
    seg(1, 'Scientifique', '309A'),
    seg(2, 'Marché', '310A'),
    seg(3, 'Amis', '310B'),
    seg(4, 'Connexion', '309B'),
  ]);

  assert.deepEqual(names(result), ['Scientifique / Connexion', 'Marché / Amis']);
  assert.deepEqual(result.episodes[0].source_episode_numbers, [1, 4]);
  assert.deepEqual(result.warnings, []);
});

test('le suffixe du code prime sur une durée fausse', () => {
  // Cas réel : saison 4, TMDB annonce 22 minutes pour `414A`, qui est un segment.
  const result = mergeSegmentedSeason([full(1, 'Bons joueurs', '414A'), seg(2, 'Papy', '414B')]);

  assert.deepEqual(names(result), ['Bons joueurs / Papy']);
  assert.equal(result.stats.orphanCount, 0);
});

test('entrée double : une seule entrée TMDB, deux épisodes', () => {
  // Cas réels : `501 502` (44 min) en saison 5, `811` (44 min) en saison 8.
  const result = mergeSegmentedSeason([full(1, 'Rentrée', '501 502', 44), seg(2, 'A', '503A'), seg(3, 'B', '503B')]);

  assert.deepEqual(names(result), ['Rentrée (1/2)', 'Rentrée (2/2)', 'A / B']);
  assert.deepEqual(numbers(result), [1, 2, 3]);
  assert.deepEqual(result.episodes[0].part, { index: 1, total: 2 });
  assert.deepEqual(result.episodes[1].part, { index: 2, total: 2 });
  assert.equal(result.episodes[0].runtime, 22);
  assert.equal(result.stats.splitCount, 1);
});

test('code de production répété : une nouvelle case, pas quatre titres empilés', () => {
  // Cas réel : saison 10, `1013A`/`1013B` présents deux fois.
  const result = mergeSegmentedSeason([
    seg(1, 'A', '1013A'),
    seg(2, 'B', '1013B'),
    seg(3, 'C', '1013A'),
    seg(4, 'D', '1013B'),
  ]);

  assert.deepEqual(names(result), ['A / B', 'C / D']);
  assert.equal(result.warnings.filter((w) => w.code === 'duplicate-production-code').length, 1);
});

test('segment orphelin en fin de saison : émis seul, avec avertissement', () => {
  const result = mergeSegmentedSeason([seg(1, 'A', '101A'), seg(2, 'B', '101B'), seg(3, 'Seul', '102A')]);

  assert.deepEqual(names(result), ['A / B', 'Seul']);
  assert.equal(result.episodes[1].is_merged, false);
  assert.equal(result.stats.orphanCount, 1);
  const warning = result.warnings.find((w) => w.code === 'orphan-segment');
  assert.equal(warning.episodeNumber, 3);
});

test('sans code de production : repli sur la fusion par adjacence', () => {
  const result = mergeSegmentedSeason([seg(1, 'A'), seg(2, 'B'), full(3, 'Spécial')]);

  assert.deepEqual(names(result), ['A / B', 'Spécial']);
  assert.equal(result.episodes[0].production_slot, null);
  assert.equal(result.stats.uncodedCount, 3);
  assert.equal(result.warnings.filter((w) => w.code === 'missing-production-code').length, 3);
});

test('repli : un segment suivi d\'un épisode entier reste seul', () => {
  const result = mergeSegmentedSeason([seg(1, 'Seul'), full(2, 'Spécial')]);

  assert.deepEqual(names(result), ['Seul', 'Spécial']);
  assert.equal(result.stats.orphanCount, 1);
  assert.equal(result.warnings.filter((w) => w.code === 'orphan-segment').length, 1);
});

test('repli : deux entrées sans code non adjacentes ne sont pas recollées', () => {
  const result = mergeSegmentedSeason([seg(1, 'Sans code A'), seg(2, 'Codé', '101A'), seg(3, 'Sans code B')]);

  // « Codé » n'a pas de jumeau : il reste seul, et les deux entrées sans code
  // ne se touchent pas, donc aucune fusion.
  assert.deepEqual(names(result), ['Sans code A', 'Codé', 'Sans code B']);
  assert.equal(result.stats.orphanCount, 3);
});

test('runtime null : traité comme un segment, avec avertissement', () => {
  const result = mergeSegmentedSeason([
    { ...seg(1, 'A'), runtime: null },
    { ...seg(2, 'B'), runtime: undefined },
  ]);

  assert.deepEqual(names(result), ['A / B']);
  assert.equal(result.episodes[0].runtime, 0);
  assert.equal(result.warnings.filter((w) => w.code === 'missing-runtime').length, 2);
});

test('saison vide ou absente : aucun épisode, aucune exception', () => {
  for (const input of [[], null, undefined]) {
    const result = mergeSegmentedSeason(input);
    assert.deepEqual(result.episodes, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.stats.sourceCount, 0);
    assert.equal(result.stats.finalCount, 0);
  }
});

test('limite de saison : appliquée APRÈS la fusion', () => {
  const source = [
    seg(1, 'A', '101A'),
    seg(2, 'B', '101B'),
    seg(3, 'C', '102A'),
    seg(4, 'D', '102B'),
    seg(5, 'E', '103A'),
    seg(6, 'F', '103B'),
  ];

  const result = mergeSegmentedSeason(source, { limit: 2 });
  assert.deepEqual(names(result), ['A / B', 'C / D']);
  assert.equal(result.stats.mergedCount, 3);
  assert.equal(result.stats.finalCount, 2);

  // Une limite plus large que la saison ne retire rien.
  assert.equal(mergeSegmentedSeason(source, { limit: 99 }).episodes.length, 3);
  // `limit: 0` vide la saison — utile pour masquer une saison non doublée.
  assert.equal(mergeSegmentedSeason(source, { limit: 0 }).episodes.length, 0);
  // Sans limite, rien n'est tronqué.
  assert.equal(mergeSegmentedSeason(source, { limit: null }).episodes.length, 3);
});

test('repli en-US : comble un titre ou un synopsis manquant côté fr-FR', () => {
  const source = [
    { ...seg(1, 'Épisode 1', '101A'), overview: '' },
    { ...seg(2, '', '101B'), overview: null },
  ];
  const fallback = [
    { episode_number: 1, name: 'First Half', overview: 'First overview' },
    { episode_number: 2, name: 'Second Half', overview: 'Second overview' },
  ];

  const result = mergeSegmentedSeason(source, { fallbackEpisodes: fallback });
  // « Épisode 1 » est le gabarit renvoyé par TMDB faute de traduction : il doit
  // céder la place à l'anglais, pas être affiché tel quel.
  assert.equal(result.episodes[0].name, 'First Half / Second Half');
  assert.equal(result.episodes[0].overview, 'First overview\n\nSecond overview');
});

test('codes de production injectés par la configuration', () => {
  const result = mergeSegmentedSeason([seg(1, 'A'), seg(2, 'Codé', '999A'), seg(3, 'B')], {
    productionCodes: { 1: '216A', 3: '216B' },
  });

  assert.deepEqual(names(result), ['A / B', 'Codé']);
  assert.equal(result.episodes[0].production_slot, '216');
});

test('la configuration décrit « Bienvenue chez les Loud » comme attendu', () => {
  const config = getSegmentedShowConfig(68073);
  assert.ok(config);
  assert.equal(config.segmentMaxRuntime, 12);
  assert.equal(getSeasonLimit(config, 9), 13);
  assert.equal(getSeasonLimit(config, 10), 7);
  assert.equal(getSeasonLimit(config, 1), null);
  assert.equal(getProductionCodeFixes(config, 2)[27], '216A');
  assert.equal(getProductionCodeFixes(config, 1), null);

  // Une série non listée ne doit rien déclencher.
  assert.equal(getSegmentedShowConfig(1399), null);
  assert.equal(getSegmentedShowConfig(null), null);
  assert.ok(Object.keys(SEGMENTED_SHOWS).length >= 1);
});

test('la saison 0 (spéciaux) n\'est jamais fusionnée', () => {
  assert.equal(isMergeableSeason(0), false);
  assert.equal(isMergeableSeason(1), true);
  assert.equal(isMergeableSeason(null), false);
});
