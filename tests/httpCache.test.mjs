// Banc d'essai du cache HTTP client (`src/utils/httpCache.ts`).
//
// Le module est écrit en TypeScript et importe la configuration runtime, qui
// dépend de `import.meta.env` : on le transpile ici à la volée en injectant une
// constante à la place de cet import, plutôt que de tirer toute la chaîne Vite
// dans un test.
//
// Deux choses comptent autant que le fonctionnement nominal :
//   - ce qui ne doit JAMAIS être mis en cache (authentifié, hors catalogue,
//     écritures) ;
//   - le fait que le cache reste hors de `localStorage`. `App.tsx` y remplace
//     `Storage.prototype.setItem` pour la synchronisation du profil, et une
//     boucle de secours relit toutes les clés toutes les deux secondes : y
//     déposer des réponses d'API coûterait plus cher que ce que le cache fait
//     gagner. Le test le verrouille en faisant échouer tout accès.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const axios = require('axios');

const MAIN_API = 'https://api.movix.test';

const makeStorage = () => {
  const store = new Map();
  return {
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    _size: () => store.size,
  };
};

/** Tout accès à `localStorage` fait échouer le test, par construction. */
const forbiddenStorage = new Proxy({}, {
  get(_t, prop) {
    throw new Error(`httpCache ne doit pas toucher localStorage (accès à "${String(prop)}")`);
  },
});

const loadModule = () => {
  const source = readFileSync('src/utils/httpCache.ts', 'utf8')
    .replace(/import \{ MAIN_API \} from '\.\.\/config\/runtime';/, `const MAIN_API = ${JSON.stringify(MAIN_API)};`);
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
};

const setupGlobals = () => {
  const session = makeStorage();
  globalThis.sessionStorage = session;
  globalThis.localStorage = forbiddenStorage;
  return session;
};

/** Instance Axios dont l'« adaptateur réseau » est un compteur d'appels. */
const makeInstance = (installHttpCache, respond) => {
  const state = { calls: 0 };
  const instance = axios.create({
    adapter: (config) => {
      state.calls++;
      return Promise.resolve({
        data: respond ? respond(state.calls, config) : { v: state.calls },
        status: 200, statusText: 'OK', headers: {}, config,
      });
    },
  });
  installHttpCache(instance);
  return { instance, state };
};

const TMDB = 'https://api.themoviedb.org/3/discover/movie';
const CONTENT = `${MAIN_API}/api/content/home`;
const PRIVATE = `${MAIN_API}/api/account/me`;

test('une réponse déjà vue est resservie sans réseau', async () => {
  setupGlobals();
  const { installHttpCache } = loadModule();
  const { instance, state } = makeInstance(installHttpCache);

  const first = await instance.get(TMDB, { params: { with_genres: 35, page: 1 } });
  const second = await instance.get(TMDB, { params: { with_genres: 35, page: 1 } });

  assert.equal(state.calls, 1, 'le second appel a déclenché une requête');
  assert.deepEqual(second.data, first.data);
});

test('des paramètres différents sont des entrées différentes', async () => {
  setupGlobals();
  const { installHttpCache } = loadModule();
  const { instance, state } = makeInstance(installHttpCache);

  await instance.get(TMDB, { params: { page: 1 } });
  await instance.get(TMDB, { params: { page: 2 } });

  assert.equal(state.calls, 2);
});

test('deux appelants ne partagent pas le même objet', async () => {
  setupGlobals();
  const { installHttpCache } = loadModule();
  const { instance } = makeInstance(installHttpCache);

  const a = await instance.get(TMDB, { params: { page: 1 } });
  const b = await instance.get(TMDB, { params: { page: 1 } });
  a.data.mutated = true;

  assert.equal(b.data.mutated, undefined, 'muter une réponse a corrompu le cache');
});

test('les appels simultanés sur la même URL sont mutualisés', async () => {
  setupGlobals();
  const { installHttpCache } = loadModule();
  const { instance, state } = makeInstance(installHttpCache);

  await Promise.all([1, 2, 3, 4].map(() => instance.get(CONTENT)));

  assert.equal(state.calls, 1);
});

test('une URL hors catalogue n\'est jamais mise en cache', async () => {
  setupGlobals();
  const { installHttpCache } = loadModule();
  const { instance, state } = makeInstance(installHttpCache);

  await instance.get(PRIVATE);
  await instance.get(PRIVATE);

  assert.equal(state.calls, 2);
});

test('une requête authentifiée n\'est jamais mise en cache', async () => {
  setupGlobals();
  const { installHttpCache } = loadModule();
  const { instance, state } = makeInstance(installHttpCache);

  await instance.get(CONTENT, { headers: { Authorization: 'Bearer x' } });
  await instance.get(CONTENT, { headers: { Authorization: 'Bearer x' } });

  assert.equal(state.calls, 2);
});

test('les écritures ne sont jamais mises en cache', async () => {
  setupGlobals();
  const { installHttpCache } = loadModule();
  const { instance, state } = makeInstance(installHttpCache);

  await instance.post(CONTENT, {});
  await instance.post(CONTENT, {});

  assert.equal(state.calls, 2);
});

test('une erreur réseau n\'est pas mise en cache', async () => {
  setupGlobals();
  const { installHttpCache } = loadModule();
  let calls = 0;
  const instance = axios.create({
    adapter: () => { calls++; return Promise.reject(new Error('réseau indisponible')); },
  });
  installHttpCache(instance);

  await instance.get(TMDB).catch(() => {});
  await instance.get(TMDB).catch(() => {});

  assert.equal(calls, 2);
});

test('une entrée périmée est resservie tout de suite puis revalidée', async () => {
  const session = setupGlobals();
  const first = loadModule();
  const { instance } = makeInstance(first.installHttpCache, () => ({ v: 'ancien' }));
  await instance.get(TMDB, { params: { page: 1 } });

  // On rembobine l'horodatage au-delà de la fraîcheur, en deçà de la
  // péremption dure : l'entrée devient périmée mais encore servable.
  for (let i = 0; i < session.length; i++) {
    const key = session.key(i);
    const entry = JSON.parse(session.getItem(key));
    entry.ts = Date.now() - 10 * 60 * 1000;
    session.setItem(key, JSON.stringify(entry));
  }

  // Module neuf : le cache mémoire repart vide, seule la couche persistante
  // subsiste — exactement la situation d'une nouvelle page.
  const second = loadModule();
  const { instance: fresh, state } = makeInstance(second.installHttpCache, () => ({ v: 'frais' }));

  const stale = await fresh.get(TMDB, { params: { page: 1 } });
  assert.deepEqual(stale.data, { v: 'ancien' }, 'la réponse en cache n\'a pas été resservie');

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(state.calls, 1, 'aucune revalidation en arrière-plan');

  const revalidated = await fresh.get(TMDB, { params: { page: 1 } });
  assert.deepEqual(revalidated.data, { v: 'frais' });
});

test('le cache reste hors de localStorage', async () => {
  const session = setupGlobals();
  const { installHttpCache, clearHttpCache } = loadModule();
  const { instance } = makeInstance(installHttpCache);

  // Le stub de localStorage lève à la moindre lecture ou écriture : si l'une
  // de ces opérations y touchait, le test échouerait ici.
  await instance.get(TMDB, { params: { page: 1 } });
  await instance.get(TMDB, { params: { page: 1 } });
  clearHttpCache();

  assert.ok(session._size() >= 0);
});
