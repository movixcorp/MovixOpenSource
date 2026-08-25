/**
 * Contrat commun à toutes les sources de sous-titres externes.
 *
 * `provider` identifie le module qui a produit la piste (utile au diagnostic
 * et à la gestion d'erreur), `source` la sous-source réelle telle que la
 * renvoie l'API : shegu agrège déjà « shegu » et « opensubs » en interne, et
 * c'est cette granularité-là que le filtre de l'interface expose.
 */
export type SubtitleFormat = 'srt' | 'vtt' | 'ass';
export type SubtitleEncoding = 'gzip' | 'plain';

export interface SubtitleTrack {
  /** `${provider}:${identifiant brut}` — stable entre deux recherches. */
  id: string;
  provider: string;
  source: string;
  /** ISO 639-1, tel que renvoyé par la source (non fiable chez shegu). */
  lang: string;
  /** Nom de fichier lisible, affiché tel quel à l'utilisateur. */
  label: string;
  url: string;
  format: SubtitleFormat;
  /** Dicte le chemin de décodage au chargement de la piste. */
  encoding: SubtitleEncoding;
  /** Absent chez shegu, présent chez OpenSubtitles. */
  downloads?: number;
}

export interface SubtitleQuery {
  type: 'movie' | 'tv';
  tmdbId?: string;
  /** Requis par le provider OpenSubtitles legacy uniquement. */
  imdbId?: string;
  season?: number;
  episode?: number;
}

export interface SubtitleProvider {
  id: string;
  /** Libellé affiché dans le filtre « source » du panneau. */
  label: string;
  search(query: SubtitleQuery, signal: AbortSignal): Promise<SubtitleTrack[]>;
}

export interface SubtitleFilters {
  /** Code ISO 639-1, ou 'all'. */
  lang: string;
  /** Nom de source, ou 'all'. */
  source: string;
  /** Recherche libre sur `label`. Chaîne vide = pas de filtre. */
  query: string;
}

export interface FacetOption {
  value: string;
  count: number;
}

export interface SubtitleFacets {
  languages: FacetOption[];
  sources: FacetOption[];
}
