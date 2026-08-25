import type {
  FacetOption,
  SubtitleFacets,
  SubtitleFilters,
  SubtitleTrack,
} from './types.ts';

/**
 * Normalise une chaîne pour la recherche libre : minuscules, sans
 * diacritiques. Permet de trouver « Francais » en tapant « français ».
 */
export function normalizeForSearch(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matchesLang(track: SubtitleTrack, lang: string): boolean {
  return lang === 'all' || track.lang === lang;
}

function matchesSource(track: SubtitleTrack, source: string): boolean {
  return source === 'all' || track.source === source;
}

function matchesQuery(track: SubtitleTrack, needle: string): boolean {
  if (!needle) return true;
  return normalizeForSearch(track.label).includes(needle);
}

export function filterTracks(
  tracks: readonly SubtitleTrack[],
  filters: SubtitleFilters,
): SubtitleTrack[] {
  const needle = normalizeForSearch(filters.query).trim();
  return tracks.filter(track => (
    matchesLang(track, filters.lang)
    && matchesSource(track, filters.source)
    && matchesQuery(track, needle)
  ));
}

function countBy(
  tracks: readonly SubtitleTrack[],
  pick: (track: SubtitleTrack) => string,
): FacetOption[] {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    const key = pick(track);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (b.count - a.count) || a.value.localeCompare(b.value));
}

/**
 * Compteurs en facettes : le compteur d'une dimension s'obtient en appliquant
 * tous les *autres* filtres actifs, jamais le sien. Sans cela, sélectionner
 * « fr » ferait tomber à zéro le compteur de toutes les autres langues et
 * l'utilisateur ne pourrait plus voir où basculer.
 */
export function computeFacets(
  tracks: readonly SubtitleTrack[],
  filters: SubtitleFilters,
): SubtitleFacets {
  const forLanguages = filterTracks(tracks, { ...filters, lang: 'all' });
  const forSources = filterTracks(tracks, { ...filters, source: 'all' });

  return {
    languages: [
      { value: 'all', count: forLanguages.length },
      ...countBy(forLanguages, track => track.lang),
    ],
    sources: [
      { value: 'all', count: forSources.length },
      ...countBy(forSources, track => track.source),
    ],
  };
}

export function sortTracks(
  tracks: readonly SubtitleTrack[],
  preferredLang: string,
): SubtitleTrack[] {
  // `map` vers des paires indexées puis tri sur l'index en dernier recours :
  // Array.prototype.sort est stable depuis ES2019, mais l'index rend la
  // stabilité explicite et testable.
  return tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => {
      const aPreferred = a.track.lang === preferredLang ? 0 : 1;
      const bPreferred = b.track.lang === preferredLang ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;

      const aDownloads = a.track.downloads ?? -1;
      const bDownloads = b.track.downloads ?? -1;
      if (aDownloads !== bDownloads) return bDownloads - aDownloads;

      const byLabel = a.track.label.localeCompare(b.track.label);
      if (byLabel !== 0) return byLabel;

      return a.index - b.index;
    })
    .map(entry => entry.track);
}

export function dedupeByUrl(tracks: readonly SubtitleTrack[]): SubtitleTrack[] {
  const seen = new Set<string>();
  const unique: SubtitleTrack[] = [];
  for (const track of tracks) {
    if (seen.has(track.url)) continue;
    seen.add(track.url);
    unique.push(track);
  }
  return unique;
}
