/**
 * Vérifie, sur les vraies données TMDB, que la fusion « 2 segments → 1 épisode »
 * rend bien le nombre d'épisodes attendu saison par saison.
 *
 *   node scripts/check-segmented-show.mjs [tmdbId]
 *
 * Sans argument : « Bienvenue chez les Loud » (68073), avec les comptes attendus
 * relevés sur les fichiers vidéo. Sort en code 1 si un compte ne correspond pas.
 *
 * La clé TMDB est lue dans `.env` (VITE_TMDB_API_KEY) ou dans l'environnement.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ---------------------------------------------------------------------------
// Chargement des modules TypeScript sans build
// ---------------------------------------------------------------------------
const loadTs = (path) => {
  const js = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
};

const { mergeSegmentedSeason } = loadTs('src/utils/mergeSegmentedSeason.ts');
const { SEGMENTED_SHOWS, getSeasonLimit, getProductionCodeFixes } = loadTs('src/utils/segmentedShows.ts');

// ---------------------------------------------------------------------------
// Clé API
// ---------------------------------------------------------------------------
const readEnvKey = () => {
  if (process.env.VITE_TMDB_API_KEY) return process.env.VITE_TMDB_API_KEY;
  if (process.env.TMDB_API_KEY) return process.env.TMDB_API_KEY;
  try {
    const match = readFileSync('.env', 'utf8').match(/^VITE_TMDB_API_KEY=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
};

const API_KEY = readEnvKey();
if (!API_KEY) {
  console.error('Clé TMDB introuvable (VITE_TMDB_API_KEY dans .env ou dans l\'environnement).');
  process.exit(2);
}

const TMDB = 'https://api.themoviedb.org/3';

const getJson = async (url) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url);
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`);
    return response.json();
  }
  throw new Error(`429 persistant — ${url}`);
};

// ---------------------------------------------------------------------------
// Comptes attendus (nombre de fichiers vidéo par saison)
// ---------------------------------------------------------------------------
const EXPECTED = {
  68073: { 1: 26, 2: 26, 3: 26, 4: 26, 5: 26, 6: 26, 7: 20, 8: 13, 9: 13, 10: 7 },
};

// ---------------------------------------------------------------------------
const showId = Number(process.argv[2] || 68073);
const config = SEGMENTED_SHOWS[showId];
if (!config) {
  console.error(`La série ${showId} n'est pas dans SEGMENTED_SHOWS.`);
  process.exit(2);
}

const expected = EXPECTED[showId] ?? {};

const details = await getJson(`${TMDB}/tv/${showId}?api_key=${API_KEY}&language=fr-FR`);
const seasons = (details.seasons ?? [])
  .filter((season) => season.season_number > 0)
  .sort((a, b) => a.season_number - b.season_number);

console.log(`\n${config.label} (TMDB ${showId}) — ${seasons.length} saisons\n`);

const header = [
  'Saison',
  'TMDB',
  'Sans code',
  'Cases',
  'Paires',
  'Entiers',
  'Orphelins',
  'Scindés',
  'Fusionnés',
  'Final',
  'Attendu',
  '',
];
const rows = [];
let failures = 0;
const allWarnings = [];

for (const season of seasons) {
  const number = season.season_number;
  const [fr, en] = await Promise.all([
    getJson(`${TMDB}/tv/${showId}/season/${number}?api_key=${API_KEY}&language=fr-FR`),
    getJson(`${TMDB}/tv/${showId}/season/${number}?api_key=${API_KEY}&language=en-US`),
  ]);

  const result = mergeSegmentedSeason(fr.episodes ?? [], {
    segmentMaxRuntime: config.segmentMaxRuntime,
    slotRuntime: config.slotRuntime,
    limit: getSeasonLimit(config, number),
    productionCodes: getProductionCodeFixes(config, number),
    fallbackEpisodes: en.episodes ?? [],
  });

  const want = expected[number];
  const ok = want === undefined ? null : result.stats.finalCount === want;
  if (ok === false) failures += 1;

  for (const warning of result.warnings) {
    allWarnings.push(`  S${number} · ${warning.code} · ${warning.message}`);
  }

  rows.push([
    `S${number}`,
    String(result.stats.sourceCount),
    String(result.stats.uncodedCount),
    String(result.stats.slotCount),
    String(result.stats.pairCount),
    String(result.stats.standaloneCount),
    String(result.stats.orphanCount),
    String(result.stats.splitCount),
    String(result.stats.mergedCount),
    String(result.stats.finalCount),
    want === undefined ? '—' : String(want),
    ok === null ? '' : ok ? 'OK' : 'ÉCART',
  ]);
}

const widths = header.map((_, column) =>
  Math.max(header[column].length, ...rows.map((row) => row[column].length))
);
const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

console.log(line(header));
console.log(widths.map((width) => '-'.repeat(width)).join('  ').trimEnd());
for (const row of rows) console.log(line(row));

if (allWarnings.length) {
  console.log(`\nAvertissements (${allWarnings.length}) :`);
  for (const warning of allWarnings) console.log(warning);
} else {
  console.log('\nAucun avertissement.');
}

if (failures) {
  console.error(`\n${failures} saison(s) hors compte attendu.`);
  process.exit(1);
}
console.log('\nTous les comptes correspondent aux fichiers.');
