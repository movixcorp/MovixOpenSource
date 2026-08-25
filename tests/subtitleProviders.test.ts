import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { SubtitleTrack } from '../src/services/subtitles/types.ts';
import type { SubtitleProvider } from '../src/services/subtitles/types.ts';
import {
  computeFacets,
  dedupeByUrl,
  filterTracks,
  normalizeForSearch,
  sortTracks,
} from '../src/services/subtitles/filtering.ts';
import {
  buildSheguUrl,
  mapSheguEntries,
  sheguProvider,
} from '../src/services/subtitles/shegu.ts';
import {
  buildOpenSubtitlesUrl,
  mapOpenSubtitlesEntries,
  normalizeLangCode,
  opensubtitlesLegacyProvider,
} from '../src/services/subtitles/opensubtitlesLegacy.ts';
import { searchAll, SUBTITLE_PROVIDERS } from '../src/services/subtitles/index.ts';

function track(over: Partial<SubtitleTrack> & { id: string }): SubtitleTrack {
  return {
    provider: 'shegu',
    source: 'shegu',
    lang: 'en',
    label: 'Some.Release.1080p.WEB-DL.srt',
    url: `https://example.test/${over.id}`,
    format: 'srt',
    encoding: 'plain',
    ...over,
  };
}

function fakeProvider(id: string, result: SubtitleTrack[] | Error): SubtitleProvider {
  return {
    id,
    label: id,
    async search() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const SAMPLE: SubtitleTrack[] = [
  track({ id: 'a', lang: 'fr', source: 'shegu', label: 'Silo.S01E01.WEB-DL.French.srt' }),
  track({ id: 'b', lang: 'en', source: 'shegu', label: 'Silo.S01E01.720p.PSA.srt' }),
  track({ id: 'c', lang: 'fr', source: 'opensubs', label: 'French (9538878)', downloads: 42 }),
  track({ id: 'd', lang: 'es', source: 'opensubs', label: 'Spanish (9538876)', downloads: 7 }),
];

test('normalizeForSearch removes case and diacritics', () => {
  assert.equal(normalizeForSearch('Français ÉLÈVE'), 'francais eleve');
});

test('filterTracks narrows by language, source and free query independently', () => {
  const all = filterTracks(SAMPLE, { lang: 'all', source: 'all', query: '' });
  assert.equal(all.length, 4);

  const french = filterTracks(SAMPLE, { lang: 'fr', source: 'all', query: '' });
  assert.deepEqual(french.map(t => t.id), ['a', 'c']);

  const shegu = filterTracks(SAMPLE, { lang: 'all', source: 'shegu', query: '' });
  assert.deepEqual(shegu.map(t => t.id), ['a', 'b']);

  const psa = filterTracks(SAMPLE, { lang: 'all', source: 'all', query: 'psa' });
  assert.deepEqual(psa.map(t => t.id), ['b']);
});

test('computeFacets counts each dimension without applying its own filter', () => {
  // Avec la langue « fr » sélectionnée, les compteurs de langue doivent
  // rester ceux de l'ensemble non filtré par langue : sinon l'utilisateur
  // ne voit plus vers quelle autre langue basculer.
  const facets = computeFacets(SAMPLE, { lang: 'fr', source: 'all', query: '' });

  const languages = Object.fromEntries(facets.languages.map(o => [o.value, o.count]));
  assert.equal(languages.fr, 2);
  assert.equal(languages.en, 1);
  assert.equal(languages.es, 1);

  // Les compteurs de source, eux, tiennent compte du filtre de langue actif.
  const sources = Object.fromEntries(facets.sources.map(o => [o.value, o.count]));
  assert.equal(sources.shegu, 1);
  assert.equal(sources.opensubs, 1);
});

test('computeFacets exposes an "all" option carrying the cross-filtered total', () => {
  const facets = computeFacets(SAMPLE, { lang: 'all', source: 'shegu', query: '' });
  assert.equal(facets.languages[0].value, 'all');
  assert.equal(facets.languages[0].count, 2);
  assert.equal(facets.sources[0].value, 'all');
  assert.equal(facets.sources[0].count, 4);
});

test('sortTracks puts the preferred language first, then downloads, then label', () => {
  const sorted = sortTracks(SAMPLE, 'fr');
  assert.deepEqual(sorted.map(t => t.id), ['c', 'a', 'd', 'b']);
});

test('sortTracks is stable for fully equivalent entries', () => {
  const equivalent: SubtitleTrack[] = [
    track({ id: 'x', lang: 'de', label: 'Same.srt' }),
    track({ id: 'y', lang: 'de', label: 'Same.srt' }),
  ];
  assert.deepEqual(sortTracks(equivalent, 'fr').map(t => t.id), ['x', 'y']);
});

test('dedupeByUrl keeps the first occurrence of a repeated url', () => {
  const withDupe: SubtitleTrack[] = [
    track({ id: 'a', url: 'https://example.test/same' }),
    track({ id: 'b', url: 'https://example.test/same' }),
    track({ id: 'c', url: 'https://example.test/other' }),
  ];
  assert.deepEqual(dedupeByUrl(withDupe).map(t => t.id), ['a', 'c']);
});

const SHEGU_FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/shegu-tv-125988-s1e1.json', import.meta.url)),
  'utf-8',
));

test('buildSheguUrl encodes movie and tv queries', () => {
  assert.equal(
    buildSheguUrl({ type: 'movie', tmdbId: '550' }),
    'https://subtitles.shegu.st/subtitles?type=movie&tmdb=550',
  );
  assert.equal(
    buildSheguUrl({ type: 'tv', tmdbId: '125988', season: 1, episode: 1 }),
    'https://subtitles.shegu.st/subtitles?type=tv&tmdb=125988&season=1&episode=1',
  );
});

test('buildSheguUrl refuses incomplete queries', () => {
  assert.equal(buildSheguUrl({ type: 'movie' }), null);
  assert.equal(buildSheguUrl({ type: 'tv', tmdbId: '125988' }), null);
  assert.equal(buildSheguUrl({ type: 'tv', tmdbId: '125988', season: 1 }), null);
});

test('mapSheguEntries normalizes entries and carries the real sub-source', () => {
  const tracks = mapSheguEntries(SHEGU_FIXTURE);
  const first = tracks[0];

  assert.equal(first.provider, 'shegu');
  assert.equal(first.source, 'shegu');
  assert.equal(first.lang, 'fr');
  assert.equal(first.format, 'srt');
  assert.equal(first.encoding, 'plain');
  assert.equal(first.label, 'Silo.S01E01.720p.10bit.WEBRip.2CH.x265.HEVC-PSA.French.FRE.srt');
  assert.ok(first.id.startsWith('shegu:'));

  assert.ok(tracks.some(t => t.source === 'opensubs'), 'la sous-source opensubs doit survivre au mapping');
});

test('mapSheguEntries drops MicroDVD .sub entries', () => {
  const tracks = mapSheguEntries(SHEGU_FIXTURE);
  assert.equal(tracks.some(t => t.label.endsWith('.sub')), false);
  assert.equal(tracks.some(t => (t.format as string) === 'sub'), false);
});

test('mapSheguEntries dedupes repeated urls', () => {
  const tracks = mapSheguEntries(SHEGU_FIXTURE);
  // La fixture compte 8 entrees : 1 MicroDVD exclue + 1 doublon retire = 6.
  assert.equal(tracks.length, 6);
});

test('mapSheguEntries tolerates a malformed payload', () => {
  assert.deepEqual(mapSheguEntries(null), []);
  assert.deepEqual(mapSheguEntries({}), []);
  assert.deepEqual(mapSheguEntries({ subtitles: 'nope' }), []);
  assert.deepEqual(mapSheguEntries({ subtitles: [{ url: '', language: 'fr' }] }), []);
});

test('sheguProvider.search returns [] without calling fetch on an incomplete query', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error('should not be called'); }) as typeof fetch;
  try {
    const result = await sheguProvider.search({ type: 'movie' }, new AbortController().signal);
    assert.deepEqual(result, []);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sheguProvider.search maps a successful response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(SHEGU_FIXTURE), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  try {
    const result = await sheguProvider.search(
      { type: 'tv', tmdbId: '125988', season: 1, episode: 1 },
      new AbortController().signal,
    );
    assert.equal(result.length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sheguProvider.search throws on a non-ok response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(
      () => sheguProvider.search(
        { type: 'tv', tmdbId: '125988', season: 1, episode: 1 },
        new AbortController().signal,
      ),
      /503/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildOpenSubtitlesUrl builds movie and episode routes', () => {
  assert.equal(
    buildOpenSubtitlesUrl({ type: 'movie', imdbId: '0137523' }),
    'https://rest.opensubtitles.org/search/imdbid-0137523',
  );
  assert.equal(
    buildOpenSubtitlesUrl({ type: 'tv', imdbId: '14688458', season: 1, episode: 1 }),
    'https://rest.opensubtitles.org/search/episode-1/imdbid-14688458/season-1',
  );
});

test('buildOpenSubtitlesUrl refuses a query without an imdb id', () => {
  assert.equal(buildOpenSubtitlesUrl({ type: 'movie', tmdbId: '550' }), null);
  assert.equal(buildOpenSubtitlesUrl({ type: 'tv', imdbId: '14688458' }), null);
});

test('mapOpenSubtitlesEntries normalizes the legacy payload shape', () => {
  const tracks = mapOpenSubtitlesEntries([
    {
      IDSubtitleFile: '1900001',
      SubFileName: 'Fight.Club.1999.1080p.BluRay.srt',
      SubLanguageID: 'fre',
      ISO639: 'fr',
      SubFormat: 'srt',
      SubDownloadsCnt: '12345',
      SubDownloadLink: 'https://dl.opensubtitles.org/en/download/src-api/vrf-1/file/1900001.gz',
    },
  ]);

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].provider, 'opensubtitles');
  assert.equal(tracks[0].source, 'opensubtitles');
  assert.equal(tracks[0].lang, 'fr', 'ISO639 doit primer sur SubLanguageID');
  assert.equal(tracks[0].encoding, 'gzip');
  assert.equal(tracks[0].downloads, 12345);
  assert.equal(tracks[0].id, 'opensubtitles:1900001');
});

test('normalizeLangCode maps ISO 639-2 codes onto the ISO 639-1 used everywhere else', () => {
  assert.equal(normalizeLangCode('fre'), 'fr');
  assert.equal(normalizeLangCode('ger'), 'de', 'code bibliographique non devinable par troncature');
  assert.equal(normalizeLangCode('dut'), 'nl', 'code bibliographique non devinable par troncature');
  assert.equal(normalizeLangCode('FRE'), 'fr', 'la casse ne doit pas compter');
  assert.equal(normalizeLangCode('fr'), 'fr', 'un code deja en 639-1 passe tel quel');
  assert.equal(normalizeLangCode('zzz'), 'zzz', 'un code inconnu est conserve plutot que perdu');
  assert.equal(normalizeLangCode(''), '');
});

test('mapOpenSubtitlesEntries falls back to a normalized SubLanguageID', () => {
  const tracks = mapOpenSubtitlesEntries([
    {
      IDSubtitleFile: '1900002',
      SubFileName: 'Some.Release.German.srt',
      SubLanguageID: 'ger',
      SubFormat: 'srt',
      SubDownloadLink: 'https://dl.opensubtitles.org/file/1900002.gz',
    },
  ]);

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].lang, 'de', 'sans ISO639, SubLanguageID doit etre normalise en 639-1');
});

test('both providers reject ass/ssa, unreadable by the WebVTT pipeline', () => {
  const fromShegu = mapSheguEntries({
    subtitles: [
      { id: '1', language: 'fr', url: 'https://example.test/a.ass', type: 'ass', display: 'a.ass', source: 'shegu' },
      { id: '2', language: 'fr', url: 'https://example.test/b.srt', type: 'srt', display: 'b.srt', source: 'shegu' },
    ],
  });
  assert.deepEqual(fromShegu.map(t => t.format), ['srt']);

  const fromLegacy = mapOpenSubtitlesEntries([
    { IDSubtitleFile: '1', SubFileName: 'a.ass', ISO639: 'fr', SubFormat: 'ass', SubDownloadLink: 'https://dl.test/a.gz' },
    { IDSubtitleFile: '2', SubFileName: 'b.srt', ISO639: 'fr', SubFormat: 'srt', SubDownloadLink: 'https://dl.test/b.gz' },
  ]);
  assert.deepEqual(fromLegacy.map(t => t.format), ['srt']);
});

test('mapOpenSubtitlesEntries skips entries without a download link', () => {
  const tracks = mapOpenSubtitlesEntries([
    { IDSubtitleFile: '1', SubFileName: 'a.srt', ISO639: 'fr' },
  ]);
  assert.deepEqual(tracks, []);
});

test('mapOpenSubtitlesEntries tolerates a malformed payload', () => {
  assert.deepEqual(mapOpenSubtitlesEntries(null), []);
  assert.deepEqual(mapOpenSubtitlesEntries({}), []);
});

test('mapOpenSubtitlesEntries rejects unsupported formats and defaults to srt when missing', () => {
  const tracks = mapOpenSubtitlesEntries([
    // Format non supporté (MicroDVD) : doit être rejeté
    {
      IDSubtitleFile: '1',
      SubFileName: 'sub.sub',
      ISO639: 'fr',
      SubFormat: 'sub',
      SubDownloadLink: 'https://example.com/sub.gz',
    },
    // Format absent : doit utiliser 'srt' par défaut
    {
      IDSubtitleFile: '2',
      SubFileName: 'default.srt',
      ISO639: 'en',
      SubDownloadLink: 'https://example.com/default.gz',
    },
    // Format supporté : doit être conservé
    {
      IDSubtitleFile: '3',
      SubFileName: 'valid.srt',
      ISO639: 'es',
      SubFormat: 'srt',
      SubDownloadLink: 'https://example.com/valid.gz',
    },
  ]);

  assert.equal(tracks.length, 2, 'une entree avec format non supporte doit etre rejetee');
  assert.equal(tracks[0].lang, 'en', 'entree sans SubFormat doit venir en premier');
  assert.equal(tracks[0].format, 'srt', 'entree sans SubFormat doit avoir format=srt par defaut');
  assert.equal(tracks[1].lang, 'es', 'entree avec SubFormat supporté vient en second');
  assert.equal(tracks[1].format, 'srt', 'format supporté doit etre conserve');
});

test('opensubtitlesLegacyProvider.search returns [] without an imdb id', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error('should not be called'); }) as typeof fetch;
  try {
    const result = await opensubtitlesLegacyProvider.search(
      { type: 'movie', tmdbId: '550' },
      new AbortController().signal,
    );
    assert.deepEqual(result, []);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SUBTITLE_PROVIDERS registers shegu and opensubtitles', () => {
  assert.deepEqual(SUBTITLE_PROVIDERS.map(p => p.id), ['shegu', 'opensubtitles']);
});

test('searchAll keeps a healthy provider when another one throws', async () => {
  const healthy = fakeProvider('healthy', [track({ id: 'ok', lang: 'fr' })]);
  const broken = fakeProvider('broken', new Error('upstream down'));

  const result = await searchAll(
    { type: 'movie', tmdbId: '550' },
    new AbortController().signal,
    { providers: [healthy, broken], preferredLang: 'fr' },
  );

  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].id, 'ok');
  assert.deepEqual(result.errors, [{ provider: 'broken', message: 'upstream down' }]);
});

test('searchAll dedupes across providers and sorts by preferred language', async () => {
  const a = fakeProvider('a', [
    track({ id: 'shared', lang: 'en', url: 'https://example.test/shared' }),
    track({ id: 'en-only', lang: 'en', url: 'https://example.test/en' }),
  ]);
  const b = fakeProvider('b', [
    track({ id: 'dupe', lang: 'en', url: 'https://example.test/shared' }),
    track({ id: 'fr-one', lang: 'fr', url: 'https://example.test/fr' }),
  ]);

  const result = await searchAll(
    { type: 'movie', tmdbId: '550' },
    new AbortController().signal,
    { providers: [a, b], preferredLang: 'fr' },
  );

  assert.deepEqual(result.tracks.map(t => t.id), ['fr-one', 'shared', 'en-only']);
  assert.deepEqual(result.errors, []);
});

test('searchAll returns an empty result when every provider fails', async () => {
  const result = await searchAll(
    { type: 'movie', tmdbId: '550' },
    new AbortController().signal,
    { providers: [fakeProvider('x', new Error('boom'))] },
  );
  assert.deepEqual(result.tracks, []);
  assert.equal(result.errors.length, 1);
});

test('searchAll keeps a healthy provider when another returns a non-array result', async () => {
  const healthy = fakeProvider('healthy', [track({ id: 'ok', lang: 'fr' })]);
  // Un provider qui retourne une valeur invalide (null au lieu d'un tableau).
  // On contourne le typage pour simuler un bug dans un futur provider.
  const invalid = {
    id: 'invalid',
    label: 'invalid',
    search: async () => null as unknown as any,
  };

  const result = await searchAll(
    { type: 'movie', tmdbId: '550' },
    new AbortController().signal,
    { providers: [healthy, invalid] },
  );

  // Les résultats du provider sain sont préservés, pas d'exception.
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].id, 'ok');
  // Le provider invalide est enregistré comme erreur.
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].provider, 'invalid');
  assert.equal(result.errors[0].message, 'provider returned a non-array result');
});
