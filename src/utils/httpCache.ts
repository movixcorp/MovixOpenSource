/**
 * Cache HTTP côté client pour les lectures de catalogue.
 *
 * ## Le problème
 *
 * Chaque page refait ses requêtes à zéro. Revenir sur « Comédie » après un
 * aller-retour, rouvrir une fiche déjà consultée, repasser par l'accueil :
 * à chaque fois le même aller-retour réseau, le même écran de chargement, et
 * une liste qui n'a pourtant pas bougé. C'est ce qui donne cette impression de
 * lenteur alors que le rendu, lui, est rapide.
 *
 * ## La réponse : stale-while-revalidate
 *
 * Une réponse déjà vue est resservie **immédiatement**, sans réseau. Si elle a
 * dépassé sa durée de fraîcheur, elle est quand même resservie tout de suite,
 * et une requête part en arrière-plan pour rafraîchir le cache — la prochaine
 * visite aura la version à jour. L'utilisateur ne voit jamais de spinner pour
 * du contenu qu'il a déjà chargé.
 *
 * S'y ajoute la **déduplication des requêtes en vol** : deux composants qui
 * demandent la même URL au même instant partagent une seule requête réseau au
 * lieu d'en lancer deux (cas courant au montage d'une page, et systématique en
 * `StrictMode` où React monte tout deux fois).
 *
 * ## Ce qui est mis en cache, et ce qui ne l'est jamais
 *
 * Uniquement des `GET` de catalogue public — TMDB et `/api/content` — reconnus
 * par `CACHE_RULES`. Tout le reste passe au travers : compte, VIP, watch party,
 * sources de lecture, écritures. Une requête portant un en-tête
 * `Authorization` est ignorée quoi qu'il arrive : rien de personnel ne doit
 * atterrir dans un cache partagé par onglet.
 *
 * ## Pourquoi `sessionStorage` et surtout pas `localStorage`
 *
 * `App.tsx` remplace `Storage.prototype.setItem` pour alimenter la
 * synchronisation du profil. Le remplacement filtre bien les clés non
 * synchronisables — rien d'ici ne partirait au serveur — mais *après* avoir
 * payé, à chaque écriture : une copie de la valeur gardée en mémoire vive, un
 * `postMessage` de la valeur entière vers les autres onglets, et une
 * comparaison JSON planifiée. Pire, sur les navigateurs sans
 * `BroadcastChannel`, une boucle relit toutes les clés de `localStorage`
 * toutes les deux secondes : y déposer des dizaines de réponses d'API
 * reviendrait à faire relire plusieurs mégaoctets en continu — l'exact
 * contraire du but recherché.
 *
 * `sessionStorage` échappe à tout cela : le remplacement de `setItem` rend la
 * main immédiatement pour tout ce qui n'est pas `localStorage`, et rien dans
 * l'application ne parcourt `sessionStorage`. Le cache ne survit donc pas à
 * l'ouverture d'un nouvel onglet — c'est le prix, assumé, de ne pas peser sur
 * la synchronisation.
 *
 * Le stockage est par ailleurs borné (nombre d'entrées, taille par entrée,
 * péremption dure) et chaque accès est protégé : un quota plein ou un stockage
 * indisponible (navigation privée) dégrade vers le cache mémoire sans jamais
 * faire échouer une requête.
 */
import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { MAIN_API } from '../config/runtime';

/** Préfixe des clés en `sessionStorage`. Le suffixe de version invalide tout d'un coup. */
const STORAGE_PREFIX = 'movix:hcache:v1:';

/** Au-delà, une entrée est jetée même si elle pourrait encore dépanner. */
const HARD_EXPIRY_MS = 6 * 60 * 60 * 1000;

/** Entrées persistées au maximum. Au-delà, les plus anciennes sautent. */
const MAX_PERSISTED_ENTRIES = 40;

/** Une réponse plus grosse que ça reste en mémoire, mais n'est pas persistée. */
const MAX_PERSISTED_BYTES = 96 * 1024;

/** Fraîcheur des listes : elles bougent, mais pas d'une minute à l'autre. */
const LIST_TTL_MS = 5 * 60 * 1000;

/** Fraîcheur des fiches et des métadonnées : quasi immuables. */
const DETAILS_TTL_MS = 30 * 60 * 1000;

interface CacheRule {
  test: (url: string) => boolean;
  ttlMs: number;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TMDB_PREFIX = 'https://api.themoviedb.org/3/';
const CONTENT_RE = MAIN_API
  ? new RegExp(`^${escapeRegExp(MAIN_API)}/api/content/`)
  : null;

/** Fiches, saisons, personnes, genres, collections : longue durée. */
const DETAILS_RE = /\/(movie|tv|person|collection|genres|genre-images|logo|details)\//;

const CACHE_RULES: CacheRule[] = [
  {
    test: (url) => url.startsWith(TMDB_PREFIX),
    ttlMs: LIST_TTL_MS,
  },
  {
    test: (url) => Boolean(CONTENT_RE?.test(url)),
    ttlMs: LIST_TTL_MS,
  },
];

interface CacheEntry {
  /** Corps sérialisé. Stocké en texte pour que chaque lecture rende un objet neuf. */
  body: string;
  status: number;
  /** Date d'écriture (ms). */
  ts: number;
}

/** Cache mémoire : le plus rapide, et le seul disponible sans `sessionStorage`. */
const memory = new Map<string, CacheEntry>();

/** Requêtes en cours, par clé, pour n'en lancer qu'une. */
const inflight = new Map<string, Promise<AxiosResponse>>();

const now = (): number => Date.now();

const readPersisted = (key: string): CacheEntry | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof parsed.body !== 'string' || typeof parsed.ts !== 'number') return null;
    return { body: parsed.body, status: parsed.status ?? 200, ts: parsed.ts };
  } catch {
    return null;
  }
};

/**
 * Fait de la place : les entrées périmées d'abord, puis les plus anciennes.
 * Appelé seulement quand une écriture a échoué, donc jamais sur le chemin
 * chaud.
 */
const evict = (): void => {
  try {
    const entries: Array<{ storageKey: string; ts: number }> = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const storageKey = sessionStorage.key(i);
      if (!storageKey?.startsWith(STORAGE_PREFIX)) continue;
      let ts = 0;
      try {
        ts = (JSON.parse(sessionStorage.getItem(storageKey) || '{}') as { ts?: number }).ts ?? 0;
      } catch {
        /* entrée illisible : ts = 0, elle partira en premier */
      }
      entries.push({ storageKey, ts });
    }

    entries.sort((a, b) => a.ts - b.ts);
    const expiredCount = entries.filter((e) => now() - e.ts >= HARD_EXPIRY_MS).length;
    const overflow = Math.max(0, entries.length - MAX_PERSISTED_ENTRIES);
    // Au moins un quart du cache, pour ne pas re-déclencher une éviction au
    // prochain enregistrement.
    const dropCount = Math.max(expiredCount, overflow, Math.ceil(entries.length / 4));

    for (const entry of entries.slice(0, dropCount)) {
      sessionStorage.removeItem(entry.storageKey);
    }
  } catch {
    /* stockage indisponible : le cache mémoire suffit */
  }
};

const writePersisted = (key: string, entry: CacheEntry): void => {
  if (entry.body.length > MAX_PERSISTED_BYTES) return;
  const payload = JSON.stringify(entry);
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, payload);
  } catch {
    // Quota plein : on fait de la place et on retente une fois. Un second échec
    // n'a rien de grave, l'entrée reste en mémoire.
    evict();
    try {
      sessionStorage.setItem(STORAGE_PREFIX + key, payload);
    } catch {
      /* tant pis */
    }
  }
};

const read = (key: string): CacheEntry | null => {
  const inMemory = memory.get(key);
  const entry = inMemory ?? readPersisted(key);
  if (!entry) return null;

  if (now() - entry.ts >= HARD_EXPIRY_MS) {
    memory.delete(key);
    try {
      sessionStorage.removeItem(STORAGE_PREFIX + key);
    } catch {
      /* stockage indisponible */
    }
    return null;
  }

  if (!inMemory) memory.set(key, entry);
  return entry;
};

const write = (key: string, response: AxiosResponse): void => {
  if (response.status !== 200 || response.data == null) return;
  let body: string;
  try {
    body = JSON.stringify(response.data);
  } catch {
    return; // réponse non sérialisable (blob, stream) : hors sujet ici
  }
  const entry: CacheEntry = { body, status: response.status, ts: now() };
  memory.set(key, entry);
  writePersisted(key, entry);
};

/**
 * Reconstruit une réponse Axios à partir d'une entrée. Le corps est re-parsé à
 * chaque fois : deux appelants ne doivent jamais partager le même objet, sinon
 * l'un qui le modifie corrompt le cache de l'autre.
 */
const toResponse = (entry: CacheEntry, config: InternalAxiosRequestConfig): AxiosResponse => ({
  data: JSON.parse(entry.body),
  status: entry.status,
  statusText: 'OK (cache)',
  headers: {},
  config,
  request: null,
});

const matchRule = (url: string): CacheRule | null =>
  CACHE_RULES.find((rule) => rule.test(url)) ?? null;

const ttlFor = (rule: CacheRule, url: string): number =>
  DETAILS_RE.test(url) ? DETAILS_TTL_MS : rule.ttlMs;

const isCacheableRequest = (config: InternalAxiosRequestConfig): boolean => {
  if ((config.method ?? 'get').toLowerCase() !== 'get') return false;
  // Rien de personnel dans un cache partagé.
  const auth = config.headers?.Authorization ?? config.headers?.authorization;
  if (auth) return false;
  if (config.responseType && config.responseType !== 'json') return false;
  return true;
};

/**
 * Branche le cache sur une instance Axios.
 *
 * L'interception se fait en remplaçant l'`adapter` de la requête plutôt qu'en
 * enveloppant `instance.request` : les raccourcis (`axios.get`, `axios.post`…)
 * de l'export global sont liés au contexte interne d'Axios et ne passent pas
 * par un `request` qu'on aurait redéfini, alors qu'ils honorent tous
 * `config.adapter`.
 */
export const installHttpCache = (instance: AxiosInstance): void => {
  instance.interceptors.request.use((config) => {
    if (!isCacheableRequest(config)) return config;

    let url: string;
    try {
      url = instance.getUri(config);
    } catch {
      return config;
    }

    const rule = matchRule(url);
    if (!rule) return config;

    const key = url;
    const entry = read(key);
    const baseAdapter = axios.getAdapter(config.adapter ?? instance.defaults.adapter ?? axios.defaults.adapter);

    const fetchAndStore = (): Promise<AxiosResponse> => {
      const pending = inflight.get(key);
      if (pending) return pending;

      const request = Promise.resolve(baseAdapter({ ...config, adapter: undefined }))
        .then((response) => {
          write(key, response);
          return response;
        })
        .finally(() => {
          inflight.delete(key);
        });

      inflight.set(key, request);
      return request;
    };

    if (entry && now() - entry.ts < ttlFor(rule, url)) {
      // Frais : aucun réseau.
      config.adapter = () => Promise.resolve(toResponse(entry, config));
      return config;
    }

    if (entry) {
      // Périmé mais exploitable : on répond tout de suite avec ce qu'on a et on
      // rafraîchit en arrière-plan pour la prochaine fois.
      config.adapter = () => {
        void fetchAndStore().catch(() => {
          /* échec de revalidation : l'entrée en cache reste valable */
        });
        return Promise.resolve(toResponse(entry, config));
      };
      return config;
    }

    // Rien en cache : requête normale, mutualisée avec celles déjà en vol.
    config.adapter = () => fetchAndStore();
    return config;
  });
};

/** Vide le cache. Utile après un changement de langue, qui rend tout obsolète. */
export const clearHttpCache = (): void => {
  memory.clear();
  inflight.clear();
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const storageKey = sessionStorage.key(i);
      if (storageKey?.startsWith(STORAGE_PREFIX)) keys.push(storageKey);
    }
    for (const storageKey of keys) sessionStorage.removeItem(storageKey);
  } catch {
    /* stockage indisponible */
  }
};
