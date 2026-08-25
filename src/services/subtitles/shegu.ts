import { dedupeByUrl } from './filtering.ts';
import type {
  SubtitleFormat,
  SubtitleProvider,
  SubtitleQuery,
  SubtitleTrack,
} from './types.ts';

export const SHEGU_BASE_URL = 'https://subtitles.shegu.st';

const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Formats que le pipeline WebVTT sait reellement convertir.
 *
 * Deux exclusions, pour la meme raison de fond : `subtitleTextToWebVtt` ne
 * comprend que des blocs horodates `HH:MM:SS,mmm --> HH:MM:SS,mmm`.
 * - `sub` (MicroDVD) encode ses timings en numeros de frame et exigerait de
 *   connaitre le framerate de la video.
 * - `ass` / `ssa` porte ses dialogues sur des lignes `Dialogue:` que le
 *   convertisseur ignore : il rendrait un `WEBVTT` sans aucune cue, la piste
 *   serait quand meme activee, et l'utilisateur verrait « sous-titres
 *   actives » avec un ecran vide, sans erreur.
 */
const SUPPORTED_FORMATS = new Set<SubtitleFormat>(['srt', 'vtt']);

interface SheguEntry {
  id?: unknown;
  language?: unknown;
  url?: unknown;
  type?: unknown;
  display?: unknown;
  source?: unknown;
}

export function buildSheguUrl(query: SubtitleQuery): string | null {
  if (!query.tmdbId) return null;
  const tmdb = encodeURIComponent(String(query.tmdbId));

  if (query.type === 'movie') {
    return `${SHEGU_BASE_URL}/subtitles?type=movie&tmdb=${tmdb}`;
  }

  if (!Number.isFinite(query.season) || !Number.isFinite(query.episode)) return null;
  return `${SHEGU_BASE_URL}/subtitles?type=tv&tmdb=${tmdb}`
    + `&season=${encodeURIComponent(String(query.season))}`
    + `&episode=${encodeURIComponent(String(query.episode))}`;
}

export function mapSheguEntries(payload: unknown): SubtitleTrack[] {
  const entries = (payload as { subtitles?: unknown } | null)?.subtitles;
  if (!Array.isArray(entries)) return [];

  const tracks: SubtitleTrack[] = [];
  for (const raw of entries as SheguEntry[]) {
    const url = typeof raw?.url === 'string' ? raw.url : '';
    const lang = typeof raw?.language === 'string' ? raw.language : '';
    const format = typeof raw?.type === 'string' ? raw.type.toLowerCase() : '';
    if (!url || !lang) continue;
    if (!SUPPORTED_FORMATS.has(format as SubtitleFormat)) continue;

    const rawId = typeof raw?.id === 'string' && raw.id ? raw.id : url;
    const label = typeof raw?.display === 'string' && raw.display ? raw.display : url;
    const source = typeof raw?.source === 'string' && raw.source ? raw.source : 'shegu';

    tracks.push({
      id: `shegu:${rawId}`,
      provider: 'shegu',
      source,
      lang,
      label,
      url,
      format: format as SubtitleFormat,
      encoding: 'plain',
    });
  }
  return dedupeByUrl(tracks);
}

export const sheguProvider: SubtitleProvider = {
  id: 'shegu',
  label: 'Shegu',
  async search(query, signal) {
    const url = buildSheguUrl(query);
    if (!url) return [];

    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      throw new Error(`shegu responded ${response.status}`);
    }
    return mapSheguEntries(await response.json());
  },
};
