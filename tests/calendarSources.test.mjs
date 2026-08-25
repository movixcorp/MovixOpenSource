// Lecture des listes locales qui alimentent le calendrier.
//
// Ces listes n'ont pas toutes la même forme, et une lecture qui se trompe
// n'échoue pas : elle renvoie une liste vide, le calendrier affiche moins de
// choses, et rien ne le signale. D'où ces tests, écrits après avoir trouvé
// « Reprendre la lecture » lu comme un tableau alors que c'est un objet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const load = (store) => {
  const js = ts.transpileModule(readFileSync('src/utils/calendarSources.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  globalThis.localStorage = {
    getItem: (k) => (k in store ? JSON.stringify(store[k]) : null),
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
};

test('watchlist : tableau d objets', () => {
  const { readWatchlist } = load({
    watchlist_tv: [
      { id: 1399, type: 'tv', title: 'Game of Thrones', poster_path: '/a.jpg', addedAt: 'x' },
      { id: 1396, type: 'tv', title: 'Breaking Bad', poster_path: null },
    ],
  });
  const items = readWatchlist('tv');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { id: 1399, title: 'Game of Thrones', poster_path: '/a.jpg' });
});

test('watchlist : entrées inexploitables écartées', () => {
  const { readWatchlist } = load({
    watchlist_movie: [{ id: 1 }, null, 'texte', { title: 'sans id' }, { id: 'abc' }],
  });
  assert.equal(readWatchlist('movie').length, 1);
});

test('watchlist absente', () => {
  const { readWatchlist } = load({});
  assert.deepEqual(readWatchlist('tv'), []);
});

test('reprendre la lecture : format courant, objet movies/tv', () => {
  const { readContinueWatchingShows } = load({
    continueWatching: {
      movies: [{ id: 550, lastAccessed: 'x' }],
      tv: [
        { id: 1399, currentEpisode: { season: 2, episode: 3 }, lastAccessed: 'x' },
        { id: 66732, currentEpisode: { season: 1, episode: 1 }, lastAccessed: 'y' },
      ],
    },
  });
  const shows = readContinueWatchingShows();
  assert.equal(shows.length, 2, 'les séries en cours ne sont pas lues');
  assert.deepEqual(shows.map((s) => s.id), [1399, 66732]);
});

test('reprendre la lecture : ancien format, tableau plat', () => {
  const { readContinueWatchingShows } = load({
    continueWatching: [
      { id: 1399, media_type: 'tv' },
      { id: 550, media_type: 'movie' },
      { id: 66732, media_type: 'tv' },
    ],
  });
  assert.deepEqual(readContinueWatchingShows().map((s) => s.id), [1399, 66732]);
});

test('reprendre la lecture : vide ou illisible', () => {
  assert.deepEqual(load({}).readContinueWatchingShows(), []);
  assert.deepEqual(load({ continueWatching: { movies: [] } }).readContinueWatchingShows(), []);
  assert.deepEqual(load({ continueWatching: 42 }).readContinueWatchingShows(), []);
});
