/**
 * Cache des sorties déjà calculées, fenêtre par fenêtre.
 *
 * ## Ce que ça évite
 *
 * Construire un mois de calendrier coûte cher : une requête par série de la
 * watchlist, une deuxième pour la saison en cours, une par film suivi. Le cache
 * HTTP (`utils/httpCache.ts`) évite bien de retélécharger chaque fiche, mais il
 * ne dispense pas de tout réassembler — quarante lectures de cache, un tri et
 * une déduplication — à chaque aller-retour entre deux mois. Ici on garde le
 * résultat fini : revenir sur un mois déjà vu ne coûte plus qu'une lecture.
 *
 * ## Deux âges, pas un
 *
 * - en deçà de `FRESH_MS`, l'entrée est resservie telle quelle et **aucune
 *   requête n'est émise** ;
 * - au-delà, elle reste affichable immédiatement — c'est ce qui remplit l'écran
 *   sans attente — mais une reconstruction part derrière pour la remplacer ;
 * - passé `HARD_EXPIRY_MS`, elle est jetée sans être montrée.
 *
 * ## Pourquoi `sessionStorage`
 *
 * Pour la même raison que le cache HTTP : `App.tsx` remplace
 * `Storage.prototype.setItem` pour la synchronisation du profil, et chaque
 * écriture dans `localStorage` y coûte une copie mémoire, un `postMessage` de
 * la valeur entière vers les autres onglets et une comparaison JSON différée.
 * Un mois de calendrier sérialisé n'a rien à faire sur ce chemin.
 */
import type { CalendarOccurrence, CalendarSource } from '../types/calendar';

/**
 * Préfixe des clés, identifiant de build compris.
 *
 * Le contenu d'une fenêtre dépend du code qui l'a assemblée : sources
 * interrogées, champs portés par chaque événement, dédoublonnage. Or une
 * fenêtre reste servie sans reconstruction pendant `FRESH_MS` — après un
 * déploiement, l'onglet resservait donc pendant une demi-heure un calendrier
 * assemblé par l'ancienne version, avec ses manques. Lier la clé au build rend
 * chaque déploiement auto-invalidant, sans avoir à penser à bumper quoi que ce
 * soit.
 */
const CACHE_ROOT = 'movix:calcache:';
const STORAGE_PREFIX = `${CACHE_ROOT}${import.meta.env.VITE_APP_BUILD_ID || 'dev'}:`;

/**
 * Les entrées d'un autre build ne seront plus jamais lues : l'éviction ne
 * balaie que le préfixe courant, elles resteraient donc à occuper le quota
 * jusqu'à la fermeture de l'onglet. Purge au premier accès.
 */
let purged = false;
const purgeForeignBuilds = (storage: Storage): void => {
  if (purged) return;
  purged = true;
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith(CACHE_ROOT) && !key.startsWith(STORAGE_PREFIX)) stale.push(key);
  }
  for (const key of stale) {
    try { storage.removeItem(key); } catch { /* rien à faire */ }
  }
};

/** En deçà, on ressert sans toucher au réseau. */
export const FRESH_MS = 30 * 60 * 1000;

/** Au-delà, l'entrée n'est plus affichable, même en attendant mieux. */
export const HARD_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Fenêtres conservées. Huit mois de navigation avant/arrière suffisent — et
 * depuis qu'une fenêtre pèse jusqu'à un demi-méga, en garder douze reviendrait
 * à réclamer six mégaoctets de `sessionStorage`, plus que le quota courant.
 */
const MAX_ENTRIES = 8;

/**
 * Une fenêtre plus lourde que ça n'est pas persistée : elle chasserait tout le
 * reste. Le plafond a suivi le contenu : un mois complet compte désormais
 * plusieurs centaines de sorties là où il en comptait quarante, et 192 Ko
 * faisaient silencieusement échouer la mise en cache des mois les plus chargés
 * — ceux qu'il était justement le plus utile de garder.
 */
const MAX_ENTRY_BYTES = 512 * 1024;

interface StoredWindow {
  /** Date d'écriture (ms). */
  ts: number;
  occurrences: CalendarOccurrence[];
}

export interface CachedWindow {
  occurrences: CalendarOccurrence[];
  /** `true` tant que l'entrée dispense de toute requête. */
  fresh: boolean;
}

/**
 * Identifie une fenêtre. Les sources sont triées : cocher A puis B doit tomber
 * sur la même entrée que cocher B puis A. La langue en fait partie — les titres
 * et les noms d'épisodes en dépendent.
 */
export const calendarCacheKey = (
  fromKey: string,
  toKey: string,
  sources: CalendarSource[],
  language: string,
): string => `${STORAGE_PREFIX}${language}:${fromKey}:${toKey}:${[...sources].sort().join(',')}`;

const store = (): Storage | null => {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    purgeForeignBuilds(sessionStorage);
    return sessionStorage;
  } catch {
    // Navigation privée verrouillée, cookies tiers bloqués : on se passe de cache.
    return null;
  }
};

/** Clés du cache, de la plus ancienne à la plus récente. */
const entriesByAge = (storage: Storage): { key: string; ts: number }[] => {
  const found: { key: string; ts: number }[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
    let ts = 0;
    try {
      ts = (JSON.parse(storage.getItem(key) ?? '{}') as StoredWindow).ts ?? 0;
    } catch {
      // Entrée illisible : `ts` reste à 0, elle sortira la première.
    }
    found.push({ key, ts });
  }
  return found.sort((a, b) => a.ts - b.ts);
};

/** Fait de la place : périmés d'abord, puis les plus anciens. */
const evict = (storage: Storage, needed: number): void => {
  const now = Date.now();
  const all = entriesByAge(storage);

  for (const entry of all) {
    if (now - entry.ts <= HARD_EXPIRY_MS) continue;
    try { storage.removeItem(entry.key); } catch { /* rien à faire */ }
  }

  const live = all.filter((entry) => now - entry.ts <= HARD_EXPIRY_MS);
  const excess = live.length + needed - MAX_ENTRIES;
  for (let index = 0; index < excess && index < live.length; index += 1) {
    try { storage.removeItem(live[index].key); } catch { /* rien à faire */ }
  }
};

/** Fenêtre en cache, ou `null` si absente, illisible ou périmée. */
export const readCalendarWindow = (key: string): CachedWindow | null => {
  const storage = store();
  if (!storage) return null;

  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredWindow;
    if (!parsed || typeof parsed.ts !== 'number' || !Array.isArray(parsed.occurrences)) return null;

    const age = Date.now() - parsed.ts;
    // Une horloge reculée donnerait un âge négatif : l'entrée serait alors
    // gardée pour toujours. On la traite comme périmée.
    if (age < 0 || age > HARD_EXPIRY_MS) {
      try { storage.removeItem(key); } catch { /* rien à faire */ }
      return null;
    }

    return { occurrences: parsed.occurrences, fresh: age <= FRESH_MS };
  } catch {
    return null;
  }
};

/** Enregistre une fenêtre reconstruite. Échoue en silence : ce n'est qu'un cache. */
export const writeCalendarWindow = (key: string, occurrences: CalendarOccurrence[]): void => {
  const storage = store();
  if (!storage) return;

  let payload: string;
  try {
    payload = JSON.stringify({ ts: Date.now(), occurrences } satisfies StoredWindow);
  } catch {
    return;
  }
  if (payload.length > MAX_ENTRY_BYTES) return;

  try {
    evict(storage, storage.getItem(key) ? 0 : 1);
    storage.setItem(key, payload);
  } catch {
    // Quota atteint malgré l'éviction : on repasse un coup, puis on abandonne.
    try {
      evict(storage, MAX_ENTRIES);
      storage.setItem(key, payload);
    } catch {
      /* tant pis, la prochaine construction repartira du réseau */
    }
  }
};
