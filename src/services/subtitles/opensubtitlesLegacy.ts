import { dedupeByUrl } from './filtering.ts';
import type {
  SubtitleFormat,
  SubtitleProvider,
  SubtitleQuery,
  SubtitleTrack,
} from './types.ts';

const OPENSUBTITLES_BASE_URL = 'https://rest.opensubtitles.org/search';
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

/**
 * OpenSubtitles renvoie `SubLanguageID` en ISO 639-2 (`fre`, `ger`, `spa`)
 * alors que tout le reste de la chaine — `SubtitleTrack.lang`, le tri par
 * langue preferee, les facettes de l'interface — travaille en ISO 639-1.
 * Sans normalisation, une meme langue apparait deux fois dans le filtre
 * (`fr` et `fre`) et la variante a trois lettres ne correspond jamais a la
 * langue de l'interface.
 *
 * Le champ `ISO639` est prioritaire quand il est present ; cette table ne
 * sert que de repli. Elle couvre les langues courantes, y compris les codes
 * bibliographiques qui ne se devinent pas par troncature (`ger`, `dut`).
 */
const ISO_639_2_TO_1: Readonly<Record<string, string>> = Object.freeze({
  alb: 'sq', ara: 'ar', arm: 'hy', baq: 'eu', bel: 'be', ben: 'bn', bos: 'bs',
  bul: 'bg', bur: 'my', cat: 'ca', chi: 'zh', cze: 'cs', dan: 'da', dut: 'nl',
  eng: 'en', epo: 'eo', est: 'et', fin: 'fi', fre: 'fr', geo: 'ka', ger: 'de',
  gre: 'el', heb: 'he', hin: 'hi', hrv: 'hr', hun: 'hu', ice: 'is', ind: 'id',
  ita: 'it', jpn: 'ja', kor: 'ko', lav: 'lv', lit: 'lt', mac: 'mk', may: 'ms',
  nor: 'no', per: 'fa', pol: 'pl', por: 'pt', rum: 'ro', rus: 'ru', slo: 'sk',
  slv: 'sl', spa: 'es', srp: 'sr', swe: 'sv', tha: 'th', tur: 'tr', ukr: 'uk',
  vie: 'vi',
});

export function normalizeLangCode(value: string): string {
  const code = String(value || '').toLowerCase();
  if (code.length !== 3) return code;
  return ISO_639_2_TO_1[code] ?? code;
}

interface LegacyEntry {
  IDSubtitleFile?: unknown;
  IDSubtitle?: unknown;
  SubFileName?: unknown;
  MovieReleaseName?: unknown;
  SubLanguageID?: unknown;
  ISO639?: unknown;
  SubFormat?: unknown;
  SubDownloadsCnt?: unknown;
  SubDownloadLink?: unknown;
}

/**
 * L'appel sans `sublanguageid` renvoie deja toutes les langues d'un coup.
 * L'ancien second appel filtre par langue devient inutile : la liste unifiee
 * du panneau filtre en local.
 */
export function buildOpenSubtitlesUrl(query: SubtitleQuery): string | null {
  if (!query.imdbId) return null;
  const imdb = encodeURIComponent(String(query.imdbId));

  if (query.type === 'movie') {
    return `${OPENSUBTITLES_BASE_URL}/imdbid-${imdb}`;
  }

  if (!Number.isFinite(query.season) || !Number.isFinite(query.episode)) return null;
  return `${OPENSUBTITLES_BASE_URL}/episode-${encodeURIComponent(String(query.episode))}`
    + `/imdbid-${imdb}`
    + `/season-${encodeURIComponent(String(query.season))}`;
}

export function mapOpenSubtitlesEntries(payload: unknown): SubtitleTrack[] {
  if (!Array.isArray(payload)) return [];

  const tracks: SubtitleTrack[] = [];
  for (const raw of payload as LegacyEntry[]) {
    const url = typeof raw?.SubDownloadLink === 'string' ? raw.SubDownloadLink : '';
    if (!url) continue;

    const rawLang = (typeof raw?.ISO639 === 'string' && raw.ISO639)
      || (typeof raw?.SubLanguageID === 'string' && raw.SubLanguageID)
      || '';
    const lang = normalizeLangCode(rawLang);
    if (!lang) continue;

    const rawFormat = typeof raw?.SubFormat === 'string' ? raw.SubFormat.toLowerCase() : '';
    if (rawFormat && !SUPPORTED_FORMATS.has(rawFormat as SubtitleFormat)) continue;
    const format = SUPPORTED_FORMATS.has(rawFormat as SubtitleFormat)
      ? rawFormat as SubtitleFormat
      : 'srt';

    const rawId = (typeof raw?.IDSubtitleFile === 'string' && raw.IDSubtitleFile)
      || (typeof raw?.IDSubtitle === 'string' && raw.IDSubtitle)
      || url;
    const label = (typeof raw?.SubFileName === 'string' && raw.SubFileName)
      || (typeof raw?.MovieReleaseName === 'string' && raw.MovieReleaseName)
      || url;

    const downloads = Number(raw?.SubDownloadsCnt);

    tracks.push({
      id: `opensubtitles:${rawId}`,
      provider: 'opensubtitles',
      source: 'opensubtitles',
      lang,
      label,
      url,
      format,
      encoding: 'gzip',
      ...(Number.isFinite(downloads) ? { downloads } : {}),
    });
  }
  return dedupeByUrl(tracks);
}

export const opensubtitlesLegacyProvider: SubtitleProvider = {
  id: 'opensubtitles',
  label: 'OpenSubtitles',
  async search(query, signal) {
    const url = buildOpenSubtitlesUrl(query);
    if (!url) return [];

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Movix/1.0' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      throw new Error(`opensubtitles responded ${response.status}`);
    }
    return mapOpenSubtitlesEntries(await response.json());
  },
};
