// src/utils/sourcePriorityPrefs.ts
import {
  TOP_LEVEL_SOURCE_IDS, BUILTIN_HOSTER_IDS, LANGUAGE_IDS,
  DEPRECATED_SOURCE_IDS, DEPRECATED_HOSTER_IDS,
  type TopLevelSourceId, type HosterId, type LanguageId,
  type SourcePriorityPrefs, type PriorityCategory,
  type MoviesTvPrefs, type AnimePrefs, type CustomHoster,
} from '../types/sourcePriority';

const STORAGE_KEY = 'settings_source_priority_prefs';
const CHANGE_EVENT = 'movix-source-priority-changed';

/**
 * Version du schéma persistée dans localStorage.
 * Incrémenter quand la structure change de façon incompatible ; ajouter un migrator au load.
 *
 * **v1 → v2** (2026-04-24) : `patternOverrides[id]` passe d'une sémantique
 * "append aux built-ins" à une sémantique "replace les built-ins". Le
 * migrator préfixe les built-ins à la liste utilisateur pour préserver
 * le comportement effectif des users qui avaient des patterns perso.
 *
 * **v2 → v3** (2026-05-25) : ordre par défaut des hosters Films/Séries
 * passe `vidzy` avant `uqload` (fstream auto-sélection prio vidzy/VF
 * au lieu de uqload/VOSTFR). Migration n'écrase l'ordre stocké QUE si
 * l'ordre des built-ins matche l'ancien default (= user n'a pas reordré).
 * Les `custom_*` sont préservés à leur position relative.
 */
const SCHEMA_VERSION = 3 as const;
type LegacySourcePriorityPrefs<V extends 1 | 2> = Omit<SourcePriorityPrefs, 'version'> & {
  version: V;
};
type PersistedSourcePriorityPrefs = SourcePriorityPrefs
  | LegacySourcePriorityPrefs<1>
  | LegacySourcePriorityPrefs<2>;

/** Ancien ordre built-in (pré-v3). Sert au comparateur du migrator v2→v3. */
const V2_DEFAULT_BUILTIN_HOSTER_ORDER: readonly string[] = [
  'voe', 'vidmoly', 'uqload', 'sibnet', 'doodstream',
  'seekstreaming', 'smoothpre', 'minochinos', 'vidzy', 'darkibox',
  'supervideo', 'dropload', 'oneupload', 'fsvid',
];

/**
 * Ordre par défaut des sources top-level pour Films/Séries, reflétant la priorité
 * historique hardcodée dans WatchMovie/WatchTv.tsx (rétrocompat 100% : prefs vides →
 * comportement identique à avant). La constante `TOP_LEVEL_SOURCE_IDS` elle-même
 * n'impose pas d'ordre sémantique — c'est ici (dans le builder des défauts) que
 * l'ordre fonctionnel est défini.
 *
 * Ordre legacy : nexus_hls > nexus_file > bravo > mp4 > darkino > fstream > omega >
 * wiflix > viper > coflix > custom > frembed > vox > vostfr.
 *
 * Note design : la spec §3 fusionne Films et Séries en une seule catégorie
 * `moviesTv` alors que les 2 Watch pages avaient historiquement des ordres
 * hardcodés légèrement différents (en TV : omega > wiflix > viper > fstream ;
 * en Movies : fstream > omega > wiflix). Ce default reproduit l'ordre Movies.
 * Les utilisateurs qui préfèrent l'ancien ordre TV peuvent le recomposer
 * manuellement via Settings → Priorité des sources.
 *
 * Les ids `viper`, `vox`, `kisskh`, `bravo` sont présents mais
 * n'ont de sens que pour certaines pages (film vs série vs anime) — ils
 * resteront simplement indisponibles (hasData=false) sur les pages qui ne
 * les fournissent pas.
 */
const DEFAULT_MOVIES_TV_ORDER: readonly TopLevelSourceId[] = [
  'nexus_hls', 'bravo', 'mp4', 'darkino',
  'fstream', 'omega', 'wiflix', 'j1f', 'swiftflow', 'viper', 'coflix',
  'custom', 'frembed', 'vox', 'kisskh', 'vostfr',
];

/**
 * Ordre par défaut des hosters pour la catégorie Animes.
 * Scope volontairement restreint (anime-sama ne renvoie qu'un sous-ensemble) :
 * vidmoly, sibnet, smoothpre, seekstreaming (détection # incluse), minochinos.
 */
const DEFAULT_ANIME_HOSTER_ORDER: readonly HosterId[] = [
  'vidmoly', 'sibnet', 'smoothpre', 'seekstreaming', 'minochinos',
];

export function buildDefaults(): SourcePriorityPrefs {
  // Safety net : si DEFAULT_MOVIES_TV_ORDER oublie un id présent dans
  // TOP_LEVEL_SOURCE_IDS, on l'append à la fin pour préserver la couverture totale.
  const seen = new Set<TopLevelSourceId>(DEFAULT_MOVIES_TV_ORDER);
  const extras = TOP_LEVEL_SOURCE_IDS.filter((id) => !seen.has(id));
  const sourceOrderIds: TopLevelSourceId[] = [...DEFAULT_MOVIES_TV_ORDER, ...extras];

  const moviesTv: MoviesTvPrefs = {
    sourceOrder: sourceOrderIds.map((id) => ({ id, enabled: true })),
    hosterOrder: [...BUILTIN_HOSTER_IDS],
    // Même liste que Anime mais appliquée aux sources films/séries qui ont
    // plusieurs versions (fstream/wiflix/viper). VF + VOSTFR activés par
    // défaut (les autres restent dispo si le backend les renvoie, mais
    // désactivés pour éviter une auto-sélection d'une langue rare).
    languageOrder: LANGUAGE_IDS.map((id) => ({
      id,
      enabled: id === 'vf' || id === 'vostfr',
    })),
    overrides: {},
    pinnedSource: null,
    pinnedHoster: null,
    pinnedLanguage: null,
  };
  const anime: AnimePrefs = {
    languageOrder: LANGUAGE_IDS.map((id) => ({ id, enabled: true })),
    hosterOrder: [...DEFAULT_ANIME_HOSTER_ORDER],
    overrides: {},
    pinnedLanguage: null,
    pinnedHoster: null,
  };
  return {
    version: SCHEMA_VERSION,
    categories: { moviesTv, anime },
    customHosters: [],
    patternOverrides: {},
    updatedAt: Date.now(),
  };
}

export const DEFAULT_SOURCE_PRIORITY_PREFS: SourcePriorityPrefs = buildDefaults();

function isValidPrefs(obj: unknown): obj is PersistedSourcePriorityPrefs {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Partial<Omit<SourcePriorityPrefs, 'version'>> & { version?: unknown };
  const versionOk = p.version === 1 || p.version === 2 || p.version === 3;
  return versionOk
    && !!p.categories
    && !!p.categories.moviesTv
    && !!p.categories.anime
    && Array.isArray(p.categories.moviesTv.sourceOrder)
    && Array.isArray(p.categories.anime.languageOrder);
}

/**
 * Migration v1 → v2 : `patternOverrides[id]` était en append-mode (les
 * built-ins + l'append formaient la liste effective). En v2 on passe en
 * replace-mode (les patterns listés = liste effective). On préfixe donc
 * les built-ins pour que l'utilisateur retrouve son comportement.
 *
 * `BUILTIN_HOSTER_PATTERNS` est importé dynamiquement dans la fonction
 * pour éviter un cycle d'imports (hosterRegistry consomme sourcePriorityPrefs
 * indirectement via les getters).
 */
function migrateV1toV2(
  parsed: LegacySourcePriorityPrefs<1>,
): LegacySourcePriorityPrefs<2> {
  // Import dynamique synchrone : le module est déjà chargé côté runtime.
  // (Le cycle d'imports théorique est rompu en pratique car hosterRegistry
  // n'appelle JAMAIS getSourcePriorityPrefs au import-time.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BUILTIN_HOSTER_PATTERNS } = require('./hosterRegistry') as typeof import('./hosterRegistry');

  const migratedOverrides: SourcePriorityPrefs['patternOverrides'] = {};
  for (const [id, userPatterns] of Object.entries(parsed.patternOverrides ?? {})) {
    if (!userPatterns || userPatterns.length === 0) continue;
    const key = id as keyof typeof BUILTIN_HOSTER_PATTERNS;
    const builtin = BUILTIN_HOSTER_PATTERNS[key] ?? [];
    // Préfixe built-ins puis user patterns, déduplication au passage
    const seen = new Set<string>();
    const combined: string[] = [];
    for (const p of [...builtin, ...userPatterns]) {
      if (seen.has(p)) continue;
      seen.add(p);
      combined.push(p);
    }
    migratedOverrides[key] = combined;
  }

  return {
    ...parsed,
    version: 2,
    patternOverrides: migratedOverrides,
  };
}

/**
 * Migration v2 → v3 : nouvel ordre default pour moviesTv hosters (vidzy avant
 * uqload). Si l'utilisateur n'a JAMAIS reordré ses built-ins (sa liste de
 * built-ins, dans l'ordre, == V2_DEFAULT_BUILTIN_HOSTER_ORDER), on remplace
 * par le nouveau default — les `custom_*` sont préservés et rappendés. Sinon
 * on garde son ordre tel quel.
 */
function migrateV2toV3(
  parsed: LegacySourcePriorityPrefs<2>,
): SourcePriorityPrefs {
  const userOrder = parsed.categories.moviesTv.hosterOrder;
  const builtinsSet = new Set<string>(V2_DEFAULT_BUILTIN_HOSTER_ORDER);
  const builtinsInUserOrder = userOrder.filter((id) => builtinsSet.has(id));
  const customsInUserOrder = userOrder.filter((id) => !builtinsSet.has(id));

  const isUntouched = builtinsInUserOrder.length === V2_DEFAULT_BUILTIN_HOSTER_ORDER.length
    && builtinsInUserOrder.every((id, i) => id === V2_DEFAULT_BUILTIN_HOSTER_ORDER[i]);

  if (!isUntouched) {
    return { ...parsed, version: 3 };
  }

  return {
    ...parsed,
    version: 3,
    categories: {
      ...parsed.categories,
      moviesTv: {
        ...parsed.categories.moviesTv,
        hosterOrder: [...BUILTIN_HOSTER_IDS, ...customsInUserOrder],
      },
    },
  };
}

/** Merge parsed prefs with defaults (forward-compat pour nouveaux ids + purge deprecated). */
function mergeWithDefaults(parsed: PersistedSourcePriorityPrefs): SourcePriorityPrefs {
  const defaults = buildDefaults();

  const deprecatedSources = new Set<string>(DEPRECATED_SOURCE_IDS);
  const deprecatedHosters = new Set<string>(DEPRECATED_HOSTER_IDS);

  // Merge sourceOrder: keep user order, append missing default ids, strip deprecated.
  const mergeOrderedToggle = <T extends string>(
    userList: Array<{ id: T; enabled: boolean }>,
    defaultList: Array<{ id: T; enabled: boolean }>,
    deprecated?: Set<string>,
  ) => {
    const filtered = deprecated
      ? userList.filter((e) => !deprecated.has(e.id))
      : userList;
    const seen = new Set(filtered.map((e) => e.id));
    const extras = defaultList.filter((e) => !seen.has(e.id));
    return [...filtered, ...extras];
  };
  const mergeOrderedList = <T extends string>(
    userList: T[],
    defaultList: T[],
    deprecated?: Set<string>,
  ) => {
    const filtered = deprecated
      ? userList.filter((id) => !deprecated.has(id))
      : userList;
    const seen = new Set(filtered);
    const extras = defaultList.filter((id) => !seen.has(id));
    return [...filtered, ...extras];
  };

  // Purge overrides pointing at deprecated ids.
  const purgeOverrides = <K extends string>(
    overrides: Partial<Record<K, HosterId[]>> | undefined,
  ): Partial<Record<K, HosterId[]>> => {
    if (!overrides) return {};
    const next: Partial<Record<K, HosterId[]>> = {};
    for (const [key, value] of Object.entries(overrides) as Array<[K, HosterId[] | undefined]>) {
      if (!value) continue;
      const cleaned = value.filter((id) => !deprecatedHosters.has(id));
      if (cleaned.length > 0) next[key] = cleaned;
    }
    return next;
  };

  // Purge pinned pointing at a deprecated id (pin orphelin → null).
  const purgePinSource = <T extends string>(
    pin: { id: T; snapshot: Array<{ id: T; enabled: boolean }> } | null,
  ) => (pin && deprecatedSources.has(pin.id) ? null : pin);
  const purgePinHoster = <T extends string>(
    pin: { id: T; snapshot: Array<{ id: T; enabled: boolean }> } | null,
  ) => (pin && deprecatedHosters.has(pin.id) ? null : pin);

  return {
    version: SCHEMA_VERSION,
    categories: {
      moviesTv: {
        sourceOrder: mergeOrderedToggle(
          parsed.categories.moviesTv.sourceOrder,
          defaults.categories.moviesTv.sourceOrder,
          deprecatedSources,
        ),
        hosterOrder: mergeOrderedList(
          parsed.categories.moviesTv.hosterOrder,
          defaults.categories.moviesTv.hosterOrder,
          deprecatedHosters,
        ),
        // languageOrder : fallback sur defaults si absent (pre-v3 users).
        // mergeOrderedToggle append les ids manquants à la fin.
        languageOrder: mergeOrderedToggle(
          parsed.categories.moviesTv.languageOrder ?? defaults.categories.moviesTv.languageOrder,
          defaults.categories.moviesTv.languageOrder,
        ),
        overrides: purgeOverrides<TopLevelSourceId>(parsed.categories.moviesTv.overrides),
        pinnedSource: purgePinSource(parsed.categories.moviesTv.pinnedSource ?? null),
        pinnedHoster: purgePinHoster(parsed.categories.moviesTv.pinnedHoster ?? null),
        pinnedLanguage: parsed.categories.moviesTv.pinnedLanguage ?? null,
      },
      anime: {
        languageOrder: mergeOrderedToggle(
          parsed.categories.anime.languageOrder,
          defaults.categories.anime.languageOrder,
        ),
        hosterOrder: mergeOrderedList(
          parsed.categories.anime.hosterOrder,
          defaults.categories.anime.hosterOrder,
          deprecatedHosters,
        ),
        overrides: purgeOverrides<LanguageId>(parsed.categories.anime.overrides),
        pinnedLanguage: parsed.categories.anime.pinnedLanguage ?? null,
        pinnedHoster: purgePinHoster(parsed.categories.anime.pinnedHoster ?? null),
      },
    },
    customHosters: parsed.customHosters ?? [],
    patternOverrides: parsed.patternOverrides ?? {},
    updatedAt: parsed.updatedAt ?? Date.now(),
  };
}

export function getSourcePriorityPrefs(): SourcePriorityPrefs {
  try {
    if (typeof window === 'undefined') return buildDefaults();
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return buildDefaults();
    const parsed = JSON.parse(raw);
    if (!isValidPrefs(parsed)) return buildDefaults();
    // Migration v1 → v2 (patternOverrides : append → replace)
    const v2 = parsed.version === 1
      ? migrateV1toV2(parsed)
      : parsed;
    // Migration v2 → v3 (default hoster order : vidzy avant uqload)
    const v3 = v2.version === 2
      ? migrateV2toV3(v2)
      : v2;
    return mergeWithDefaults(v3);
  } catch {
    return buildDefaults();
  }
}

export function setSourcePriorityPrefs(next: SourcePriorityPrefs): void {
  if (typeof window === 'undefined') return;
  const toStore: SourcePriorityPrefs = { ...next, version: SCHEMA_VERSION, updatedAt: Date.now() };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    window.dispatchEvent(new CustomEvent<SourcePriorityPrefs>(CHANGE_EVENT, { detail: toStore }));
  } catch (e) {
    console.warn('[sourcePriorityPrefs] setSourcePriorityPrefs failed', e);
  }
}

export function resetSourcePriorityPrefs(): void {
  if (typeof window === 'undefined') return;
  setSourcePriorityPrefs(buildDefaults());
}

export function subscribeToPriorityChanges(cb: (prefs: SourcePriorityPrefs) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<SourcePriorityPrefs>).detail;
    cb(detail || getSourcePriorityPrefs());
  };
  const storageHandler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb(getSourcePriorityPrefs());
  };
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}

/** Push prefs au bridge postMessage extension. No-op si extension absente. */
export async function pushPriorityToExtension(prefs?: SourcePriorityPrefs): Promise<void> {
  const payload = prefs ?? getSourcePriorityPrefs();
  try {
    const { isExtensionAvailable, fetchFromExtension } = await import('./extensionProxy');
    if (!isExtensionAvailable()) return;
    await fetchFromExtension('SET_SOURCE_PRIORITY', { prefs: payload });
  } catch (e) {
    // Extension sans handler → warning silencieux
    console.debug('[sourcePriorityPrefs] push to extension failed (non-fatal):', e);
  }
}

// ===== Helpers ergonomiques =====

export function updateCategory<C extends PriorityCategory>(
  category: C,
  updater: (cat: SourcePriorityPrefs['categories'][C]) => SourcePriorityPrefs['categories'][C],
): void {
  const prefs = getSourcePriorityPrefs();
  const nextCat = updater(prefs.categories[category]);
  setSourcePriorityPrefs({
    ...prefs,
    categories: { ...prefs.categories, [category]: nextCat },
  });
}

// ===== Pin helpers =====
// Milestone 4 — boutons pin cross-UI (player, Settings).
//
// Modèle : chaque pin stocke un `PinSnapshot` = { id, snapshot: ordre_pré_pin }.
// - pin d'un item inactif : promeut l'item à l'index 0, snapshot figé.
// - unpin : restaure le snapshot intégralement, `pinned = null`.
// - pin d'un autre item alors qu'un pin existe : on NE restaure PAS le précédent
//   snapshot (l'ordre actuel — post-lift du précédent pin — devient le nouveau
//   snapshot). Ça évite de "revenir en arrière" visuellement à chaque changement
//   de pin et préserve la dernière expérience utilisateur en cas d'unpin final.
// - drag manuel : `clearPinOnDrag` purge juste le flag `pinned`, l'ordre est
//   la vérité et ne doit pas être écrasé par un restore.

/**
 * Épingle une source top-level (Films/Séries) à la position 0.
 * Snapshot de l'ordre actuel stocké pour restore à l'unpin. Si un autre pin
 * est actif, le snapshot précédent est remplacé (pas de restore cascade).
 */
export function pinSource(id: TopLevelSourceId): void {
  updateCategory('moviesTv', (cat) => {
    const currentOrder = cat.sourceOrder;
    const target = currentOrder.find((e) => e.id === id);
    if (!target) return cat;
    const rest = currentOrder.filter((e) => e.id !== id);
    return {
      ...cat,
      sourceOrder: [target, ...rest],
      pinnedSource: { id, snapshot: currentOrder },
    };
  });
}

/** Retire le pin source actif et restaure l'ordre pré-pin. No-op sans pin. */
export function unpinSource(): void {
  updateCategory('moviesTv', (cat) => {
    if (!cat.pinnedSource) return cat;
    return { ...cat, sourceOrder: cat.pinnedSource.snapshot, pinnedSource: null };
  });
}

/** Épingle une langue d'anime à la position 0. */
export function pinLanguage(id: LanguageId): void {
  updateCategory('anime', (cat) => {
    const target = cat.languageOrder.find((e) => e.id === id);
    if (!target) return cat;
    const rest = cat.languageOrder.filter((e) => e.id !== id);
    return {
      ...cat,
      languageOrder: [target, ...rest],
      pinnedLanguage: { id, snapshot: cat.languageOrder },
    };
  });
}

/** Retire le pin langue actif et restaure l'ordre pré-pin. No-op sans pin. */
export function unpinLanguage(): void {
  updateCategory('anime', (cat) => {
    if (!cat.pinnedLanguage) return cat;
    return {
      ...cat,
      languageOrder: cat.pinnedLanguage.snapshot,
      pinnedLanguage: null,
    };
  });
}

/**
 * Épingle une langue à la position 0 dans MoviesTv. Utile pour forcer
 * VOSTFR en tête sans toucher aux autres langues.
 */
export function pinMovieLanguage(id: LanguageId): void {
  updateCategory('moviesTv', (cat) => {
    const target = cat.languageOrder.find((e) => e.id === id);
    if (!target) return cat;
    const rest = cat.languageOrder.filter((e) => e.id !== id);
    return {
      ...cat,
      languageOrder: [target, ...rest],
      pinnedLanguage: { id, snapshot: cat.languageOrder },
    };
  });
}

/** Retire le pin langue films/séries et restaure l'ordre pré-pin. No-op sans pin. */
export function unpinMovieLanguage(): void {
  updateCategory('moviesTv', (cat) => {
    if (!cat.pinnedLanguage) return cat;
    return {
      ...cat,
      languageOrder: cat.pinnedLanguage.snapshot,
      pinnedLanguage: null,
    };
  });
}

/**
 * Épingle un hoster à la position 0 dans la catégorie spécifiée.
 * Note : `hosterOrder` est un tableau d'ids (pas de enabled/disabled géré ici),
 * le snapshot les wrap en `{ id, enabled: true }` pour matcher `PinSnapshot<HosterId>`.
 */
export function pinHoster(category: PriorityCategory, id: HosterId): void {
  updateCategory(category, (cat) => {
    const list = cat.hosterOrder;
    if (!list.includes(id)) return cat;
    const snapshot = list.map((h) => ({ id: h, enabled: true }));
    return {
      ...cat,
      hosterOrder: [id, ...list.filter((h) => h !== id)],
      pinnedHoster: { id, snapshot },
    } as typeof cat;
  });
}

/** Retire le pin hoster actif et restaure l'ordre pré-pin. No-op sans pin. */
export function unpinHoster(category: PriorityCategory): void {
  updateCategory(category, (cat) => {
    if (!cat.pinnedHoster) return cat;
    return {
      ...cat,
      hosterOrder: cat.pinnedHoster.snapshot.map((e) => e.id),
      pinnedHoster: null,
    } as typeof cat;
  });
}

/**
 * Utilisé par l'UI drag : quand l'utilisateur drag, on lève juste le flag pin
 * (le drag est la vérité, on ne restaure PAS le snapshot). No-op s'il n'y a
 * pas de pin actif du kind demandé.
 */
export function clearPinOnDrag(
  category: PriorityCategory,
  kind: 'source' | 'language' | 'hoster',
): void {
  updateCategory(category, (cat) => {
    if (kind === 'source' && 'pinnedSource' in cat && cat.pinnedSource) {
      return { ...cat, pinnedSource: null };
    }
    if (kind === 'language' && 'pinnedLanguage' in cat && cat.pinnedLanguage) {
      return { ...cat, pinnedLanguage: null };
    }
    if (kind === 'hoster' && cat.pinnedHoster) {
      return { ...cat, pinnedHoster: null };
    }
    return cat;
  });
}

// ===== Reset helpers (Milestone 8) =====
//
// Chaque reset par section retourne le snapshot pré-reset pour permettre un
// undo via le toast Sonner "Annuler" côté UI. Les restore helpers associés
// remplacent simplement la catégorie entière (ou le couple customHosters +
// patternOverrides pour le cas custom).
//
// Choix design — reset hosters avec custom_* préservés :
// Le plan propose `hosterOrder: def.hosterOrder` (BUILTIN_HOSTER_IDS only), ce
// qui retirerait les custom_* de la liste (ils resteraient dans
// `customHosters` mais disparaîtraient de l'ordre, donc invisibles dans le
// panel). Moins disruptif : remettre les built-ins dans leur ordre default
// puis append les custom_* existants à la fin dans leur ordre relatif actuel.
// L'utilisateur peut ensuite les draguer où il veut. Undo restore intégralement.

/** Helper interne : ordre hoster default (built-ins) + custom_* actuels en queue. */
function rebuildHosterOrderPreservingCustoms(current: HosterId[]): HosterId[] {
  const defaultBuiltins = [...BUILTIN_HOSTER_IDS] as HosterId[];
  const currentCustoms = current.filter((id) => !(BUILTIN_HOSTER_IDS as readonly string[]).includes(id));
  return [...defaultBuiltins, ...currentCustoms];
}

/** Reset des sources Films/Séries (sourceOrder + pinnedSource). Retourne le snapshot. */
export function resetMoviesTvSources(): MoviesTvPrefs {
  const snapshot = getSourcePriorityPrefs().categories.moviesTv;
  const def = buildDefaults().categories.moviesTv;
  updateCategory('moviesTv', () => ({
    ...snapshot,
    sourceOrder: def.sourceOrder,
    pinnedSource: null,
  }));
  return snapshot;
}

/** Reset de l'ordre des hosters Films/Séries (conserve les custom_*). Retourne le snapshot. */
export function resetMoviesTvHosters(): MoviesTvPrefs {
  const snapshot = getSourcePriorityPrefs().categories.moviesTv;
  updateCategory('moviesTv', (cat) => ({
    ...cat,
    hosterOrder: rebuildHosterOrderPreservingCustoms(cat.hosterOrder),
    pinnedHoster: null,
  }));
  return snapshot;
}

/** Reset des overrides par source Films/Séries. Retourne le snapshot. */
export function resetMoviesTvOverrides(): MoviesTvPrefs {
  const snapshot = getSourcePriorityPrefs().categories.moviesTv;
  updateCategory('moviesTv', (cat) => ({ ...cat, overrides: {} }));
  return snapshot;
}

/** Reset des langues Animes (languageOrder + pinnedLanguage). Retourne le snapshot. */
export function resetAnimeLanguages(): AnimePrefs {
  const snapshot = getSourcePriorityPrefs().categories.anime;
  const def = buildDefaults().categories.anime;
  updateCategory('anime', () => ({
    ...snapshot,
    languageOrder: def.languageOrder,
    pinnedLanguage: null,
  }));
  return snapshot;
}

/** Reset de l'ordre des hosters Animes (conserve les custom_*). Retourne le snapshot. */
export function resetAnimeHosters(): AnimePrefs {
  const snapshot = getSourcePriorityPrefs().categories.anime;
  updateCategory('anime', (cat) => ({
    ...cat,
    hosterOrder: rebuildHosterOrderPreservingCustoms(cat.hosterOrder),
    pinnedHoster: null,
  }));
  return snapshot;
}

/** Reset des overrides par langue Animes. Retourne le snapshot. */
export function resetAnimeOverrides(): AnimePrefs {
  const snapshot = getSourcePriorityPrefs().categories.anime;
  updateCategory('anime', (cat) => ({ ...cat, overrides: {} }));
  return snapshot;
}

/**
 * Reset des hosters personnalisés et des patternOverrides.
 * Vide `customHosters` + `patternOverrides` et strip les ids `custom_*` de
 * `hosterOrder` des 2 catégories (sinon ils resteraient "fantômes" dans
 * l'ordre, pointant vers un hoster inexistant).
 *
 * Retourne les infos nécessaires au restore (customHosters + patternOverrides
 * pré-reset). Note : le restore NE restaure PAS les ids `custom_*` strippés
 * dans `hosterOrder` — l'utilisateur retrouve les hosters mais peut devoir
 * les ré-ordonner. Trade-off acceptable pour simplifier le restore et éviter
 * une dépendance sur snapshot complet des catégories.
 */
export function resetCustomHostersAndPatterns(): {
  customHosters: CustomHoster[];
  patternOverrides: SourcePriorityPrefs['patternOverrides'];
} {
  const prefs = getSourcePriorityPrefs();
  const snapshot = {
    customHosters: prefs.customHosters,
    patternOverrides: prefs.patternOverrides,
  };
  setSourcePriorityPrefs({
    ...prefs,
    customHosters: [],
    patternOverrides: {},
    categories: {
      moviesTv: {
        ...prefs.categories.moviesTv,
        hosterOrder: prefs.categories.moviesTv.hosterOrder.filter(
          (id) => !id.startsWith('custom_'),
        ),
        pinnedHoster: prefs.categories.moviesTv.pinnedHoster?.id.startsWith('custom_')
          ? null
          : prefs.categories.moviesTv.pinnedHoster,
      },
      anime: {
        ...prefs.categories.anime,
        hosterOrder: prefs.categories.anime.hosterOrder.filter(
          (id) => !id.startsWith('custom_'),
        ),
        pinnedHoster: prefs.categories.anime.pinnedHoster?.id.startsWith('custom_')
          ? null
          : prefs.categories.anime.pinnedHoster,
      },
    },
  });
  return snapshot;
}

/** Restore intégral de la catégorie moviesTv (pour undo toast). */
export function restoreMoviesTv(snapshot: MoviesTvPrefs): void {
  updateCategory('moviesTv', () => snapshot);
}

/** Restore intégral de la catégorie anime (pour undo toast). */
export function restoreAnime(snapshot: AnimePrefs): void {
  updateCategory('anime', () => snapshot);
}

/**
 * Restore customHosters + patternOverrides (pour undo toast).
 * Note : `hosterOrder` des catégories n'est PAS restauré — si l'utilisateur
 * veut retrouver les custom_* dans l'ordre, il doit les ré-ajouter via drag
 * ou accepter leur nouvelle position par défaut. Choix documenté dans
 * `resetCustomHostersAndPatterns`.
 */
export function restoreCustomHostersAndPatterns(
  snapshot: { customHosters: CustomHoster[]; patternOverrides: SourcePriorityPrefs['patternOverrides'] },
): void {
  const prefs = getSourcePriorityPrefs();
  // Ré-append les custom_* à la fin de hosterOrder pour qu'ils soient visibles.
  const restoredCustomIds = snapshot.customHosters.map((c) => c.id);
  const moviesTvOrder = [
    ...prefs.categories.moviesTv.hosterOrder.filter((id) => !restoredCustomIds.includes(id)),
    ...restoredCustomIds.filter((id) => !prefs.categories.moviesTv.hosterOrder.includes(id)),
  ];
  const animeOrder = [
    ...prefs.categories.anime.hosterOrder.filter((id) => !restoredCustomIds.includes(id)),
    ...restoredCustomIds.filter((id) => !prefs.categories.anime.hosterOrder.includes(id)),
  ];
  setSourcePriorityPrefs({
    ...prefs,
    customHosters: snapshot.customHosters,
    patternOverrides: snapshot.patternOverrides,
    categories: {
      moviesTv: { ...prefs.categories.moviesTv, hosterOrder: moviesTvOrder },
      anime: { ...prefs.categories.anime, hosterOrder: animeOrder },
    },
  });
}
