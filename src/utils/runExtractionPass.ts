// src/utils/runExtractionPass.ts
//
// Passe d'extraction m3u8 partagée entre tous les agrégateurs (wiflix, viper,
// coflix, j1f, swiftflow, vox, firebase/custom, anime-sama…).
//
// Historique : chaque agrégateur avait son propre bloc d'extraction écrit à la
// main, avec une couverture partielle et arbitraire des hosters (wiflix ne
// tentait que voe + uqload, vox que voe + vidmoly, j1f et swiftflow rien du
// tout). `extractM3u8OnDetection` sait pourtant router n'importe quelle URL
// vers le bon extracteur via `detectHoster`, en respectant les préférences
// utilisateur et les hosters custom — il n'était simplement jamais appelé
// depuis le SPA.
//
// Ce helper enveloppe cette détection générique et rend directement les deux
// listes attendues par les pages Watch :
//   - `hls`  → `setNexusHlsSources`  (playlists m3u8, lues par hls.js)
//   - `file` → `setNexusFileSources` (fichiers progressifs mp4)
//
// Ajouter un nouvel extracteur dans `extractM3u8.ts` le rend automatiquement
// disponible sur TOUS les agrégateurs, sans toucher aux pages Watch.

import {
  extractM3u8OnDetection,
  type PlayerInfo,
} from './extractM3u8';
import { expandSeekStreamingSources } from './seekStreamingCandidates';
import { HOSTER_LABELS, detectHoster } from './hosterRegistry';
import { getSourcePriorityPrefs } from './sourcePriorityPrefs';
import type {
  PriorityCategory,
  TopLevelSourceId,
  LanguageId,
} from '../types/sourcePriority';

/** Source telle que la rend un agrégateur, avant extraction. */
export interface ExtractionPassSource {
  url: string;
  /** Libellé affiché par l'agrégateur (souvent « <Site> VF - <Hoster> »). */
  label?: string;
  /** Catégorie de langue quand l'agrégateur l'expose (« VF », « VOSTFR »…). */
  category?: string;
  /** Langue quand l'agrégateur la nomme autrement que `category`. */
  language?: string;
  /** Nom du player renvoyé par l'agrégateur, utile pour supervideo/dropload. */
  player?: string;
  /**
   * Données libres recopiées telles quelles sur la source extraite. Sert aux
   * appelants qui doivent retrouver un champ d'origine que le helper ne
   * modélise pas (la langue anime-sama, un identifiant d'épisode…).
   */
  meta?: Record<string, unknown>;
}

/** Source jouable, au format consommé par HLSPlayer via nexusHls/nexusFile. */
export interface ExtractedPlayableSource {
  url: string;
  label: string;
  source: string;
  isDirect?: boolean;
  isVostfr: boolean;
  seekKind?: 'cfNative' | 'source';
  seekGroupKey?: string;
  seekEmbedUrl?: string;
  /** Recopie du `meta` de la source d'origine, si l'appelant en a fourni un. */
  meta?: Record<string, unknown>;
}

export interface ExtractionPassResult {
  /** Playlists HLS → `finalHlsSources`. */
  hls: ExtractedPlayableSource[];
  /** Fichiers progressifs → `finalFileSources`. */
  file: ExtractedPlayableSource[];
}

export interface ExtractionPassOptions {
  /**
   * Identifiant de l'agrégateur d'origine (« wiflix », « j1f »…). Sert à
   * construire le champ `source` (`voe-wiflix`), qui n'est utilisé qu'à des
   * fins de debug/log — le tri, lui, passe par `detectHoster`.
   */
  origin: string;
  /** Contexte de tri par priorité utilisateur, passé à `detectSupportedEmbeds`. */
  context?: { category: PriorityCategory; topLevel?: TopLevelSourceId | LanguageId };
  /**
   * Restreint la passe aux hosters listés. Indispensable pour les catégories
   * dont l'ordre de priorité ne couvre qu'un sous-ensemble : un hoster absent
   * de `hosterOrder` reçoit le rang `MAX_SAFE_INTEGER` dans
   * `sortHostersByPriority`, donc l'extraire ne fait que polluer la liste et
   * désordonner la sélection automatique. Omettre = tous les hosters.
   */
  allowedHosters?: readonly string[];
}

/**
 * Types dont l'extraction rend un fichier progressif (mp4) plutôt qu'une
 * playlist HLS. Ils partent dans `file` sauf si l'extracteur a explicitement
 * renvoyé un `hlsUrl`, auquel cas la playlist gagne.
 */
const PROGRESSIVE_FILE_TYPES = new Set(['uqload', 'doodstream', 'sibnet', 'veev']);

/**
 * Clé de correspondance tolérante aux réécritures de domaine. Les extracteurs
 * normalisent parfois le TLD (uqload.cx → uqload.is, vidmoly.to → vidmoly.net),
 * et l'URL qui revient dans le résultat n'est alors plus strictement celle
 * fournie en entrée. On indexe donc aussi sur « premier label d'hôte + chemin »,
 * ce qui reste stable à travers ces réécritures.
 */
function looseUrlKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '').split('.')[0];
    return `${host.toLowerCase()}${parsed.pathname.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Libellé lisible pour un type d'embed, avec repli sur le type brut. */
function hosterLabel(type: string): string {
  return (HOSTER_LABELS as Record<string, string | undefined>)[type]
    ?? (type.charAt(0).toUpperCase() + type.slice(1));
}

/**
 * Un agrégateur peut annoncer la langue via `label`, `category` ou `language`
 * selon les cas ; on teste les trois de la même façon que les anciens blocs.
 */
function languageOf(source: ExtractionPassSource | undefined): 'vostfr' | 'vf' | null {
  if (!source) return null;
  const haystack = [source.label, source.category, source.language]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (haystack.includes('vostfr')) return 'vostfr';
  // `vf` doit être un mot isolé : `vff` et `vfq` comptent, mais pas le `vf`
  // au milieu d'un nom d'hôte. Sans mention de langue on ne tague rien plutôt
  // que d'annoncer un `VF` inventé (cas des liens custom/Firebase).
  if (/\bvf[fq]?\b/.test(haystack)) return 'vf';
  return null;
}

/**
 * Lance une extraction m3u8 sur toutes les sources d'un agrégateur.
 *
 * Les URLs dont le hoster n'a pas d'extracteur sont simplement ignorées :
 * elles restent jouables en iframe via la source top-level d'origine.
 *
 * @param sources Sources brutes de l'agrégateur.
 * @param MAIN_API Base de l'API principale (requise par certains extracteurs).
 * @param options Origine, contexte de tri et suffixe de libellé.
 */
export async function runExtractionPass(
  sources: readonly ExtractionPassSource[],
  MAIN_API: string,
  options: ExtractionPassOptions,
): Promise<ExtractionPassResult> {
  const empty: ExtractionPassResult = { hls: [], file: [] };
  if (!sources || sources.length === 0) return empty;

  // Dédup des URLs en entrée : un agrégateur peut lister le même lecteur dans
  // plusieurs catégories, et on ne veut pas payer deux fois l'extraction.
  const prefs = getSourcePriorityPrefs();
  const allowed = options.allowedHosters ? new Set(options.allowedHosters) : null;

  const byUrl = new Map<string, ExtractionPassSource>();
  const byLooseUrl = new Map<string, ExtractionPassSource>();
  let skipped = 0;
  for (const source of sources) {
    if (!source || typeof source.url !== 'string' || !source.url) continue;
    if (byUrl.has(source.url)) continue;
    if (allowed) {
      const hoster = detectHoster(source.url, {
        patternOverrides: prefs.patternOverrides,
        customHosters: prefs.customHosters,
      });
      if (!hoster || !allowed.has(hoster)) {
        skipped += 1;
        continue;
      }
    }
    byUrl.set(source.url, source);
    const loose = looseUrlKey(source.url);
    if (loose && !byLooseUrl.has(loose)) byLooseUrl.set(loose, source);
  }
  if (skipped > 0) {
    console.log(
      `[extraction-pass][${options.origin}] ${skipped} lecteur(s) hors périmètre, laissé(s) en embed`,
    );
  }
  if (byUrl.size === 0) return empty;

  /** Retrouve la source d'origine malgré une éventuelle réécriture de domaine. */
  const findOriginal = (url: string): ExtractionPassSource | undefined => {
    const exact = byUrl.get(url);
    if (exact) return exact;
    const loose = looseUrlKey(url);
    return loose ? byLooseUrl.get(loose) : undefined;
  };

  const players: PlayerInfo[] = Array.from(byUrl.values()).map(source => ({
    player: source.player ?? source.label ?? '',
    link: source.url,
    label: source.label,
  }));

  let results;
  try {
    results = await extractM3u8OnDetection(players, MAIN_API, undefined, options.context);
  } catch (error) {
    console.error(`[extraction-pass][${options.origin}] échec global de la passe:`, error);
    return empty;
  }

  const hls: ExtractedPlayableSource[] = [];
  const file: ExtractedPlayableSource[] = [];

  for (const progress of results) {
    if (progress.status !== 'success' || !progress.result?.success) continue;

    if (allowed && !allowed.has(progress.type)) continue;

    const original = findOriginal(progress.url);
    const language = languageOf(original);
    const isVostfr = language === 'vostfr';
    const langTag = language === 'vostfr' ? ' VOSTFR' : (language === 'vf' ? ' VF' : '');
    // Pas de mention de l'agrégateur d'origine dans le libellé : le menu
    // affiche l'hébergeur et la langue, seuls critères de choix côté
    // utilisateur. L'origine reste tracée dans `source` (`voe-wiflix`) pour
    // les logs.
    const base = `${hosterLabel(progress.type)}${langTag}`;

    // SeekStreaming rend plusieurs candidats (cfNative / source) qu'il faut
    // garder groupés : le lecteur bascule de l'un à l'autre en cas de 403.
    if (progress.type === 'seekstreaming') {
      const expanded = expandSeekStreamingSources(progress.result, {
        label: base,
        source: `seekstreaming-${options.origin}`,
        isVostfr,
        seekEmbedUrl: progress.url,
        ...(original?.meta ? { meta: original.meta } : {}),
      });
      for (const candidate of expanded) {
        hls.push({ ...candidate, label: base } as ExtractedPlayableSource);
      }
      continue;
    }

    const playlistUrl = progress.result.hlsUrl;
    const fileUrl = progress.result.m3u8Url;
    const resolved = playlistUrl || fileUrl;
    if (!resolved) continue;

    const isProgressive = !playlistUrl && PROGRESSIVE_FILE_TYPES.has(progress.type);
    const entry: ExtractedPlayableSource = {
      url: resolved,
      label: base,
      source: `${progress.type}-${options.origin}`,
      isVostfr,
      ...(isProgressive ? { isDirect: true } : {}),
      ...(original?.meta ? { meta: original.meta } : {}),
    };

    (isProgressive ? file : hls).push(entry);
  }

  // VF d'abord, VOSTFR ensuite — l'ordre relatif à l'intérieur de chaque groupe
  // reste celui de la détection, déjà trié par `sortHostersByPriority`.
  // Le tri final par priorité hoster est réappliqué par la page appelante.
  const order = (list: ExtractedPlayableSource[]) => {
    const seen = new Set<string>();
    return [...list.filter(s => !s.isVostfr), ...list.filter(s => s.isVostfr)]
      .filter(source => {
        if (seen.has(source.url)) return false;
        seen.add(source.url);
        return true;
      });
  };

  const ordered = { hls: order(hls), file: order(file) };
  console.log(
    `[extraction-pass][${options.origin}] ${byUrl.size} source(s) analysée(s) → `
    + `${ordered.hls.length} HLS, ${ordered.file.length} fichier(s)`,
  );
  return ordered;
}
