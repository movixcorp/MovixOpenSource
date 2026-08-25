import React, { createContext, useContext, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import axios from 'axios';
import i18n from '../i18n';
import { searchIndexedMedia, type IndexedMedia } from '../utils/mediaSearchIndex';
import { getTmdbLanguage } from '../i18n';
import { TmdbKeyword, fetchTmdbMediaKeywordIds, searchTmdbKeywords } from '../utils/tmdbKeywords';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

export interface WatchProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string;
  display_priority: number;
}

export type SortByOption = 'popularity.desc' | 'popularity.asc' | 'vote_average.desc' | 'vote_average.asc' | 'primary_release_date.desc' | 'primary_release_date.asc' | 'revenue.desc' | 'vote_count.desc';

export interface SearchResult { // Added export keyword
  id: number;
  title?: string;
  name?: string;
  media_type: 'movie' | 'tv';
  poster_path: string;
  backdrop_path?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  genre_ids: number[];
  overview?: string;
  original_language?: string;
  origin_country?: string[];
}

interface PersonSuggestion {
  id: number;
  name: string;
  profile_path: string | null;
  known_for_department: string;
  popularity: number;
}

interface Genre {
  id: number;
  name: string;
}

interface SearchContextType {
  query: string;
  setQuery: (query: string) => void;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  genres: Genre[];
  selectedGenres: number[];
  toggleGenre: (genreId: number) => void;
  selectedType: 'all' | 'movie' | 'tv';
  setSelectedType: (type: 'all' | 'movie' | 'tv') => void;
  minRating: number;
  setMinRating: (rating: number) => void;
  hasMore: boolean;
  page: number;
  setPage: (page: number) => void;
  performSearch: (pageNum: number, isNewSearch?: boolean) => Promise<void>;
  loadingGenres: boolean;
  showFilters: boolean;
  setShowFilters: React.Dispatch<React.SetStateAction<boolean>>;
  isLoadingMore: boolean;
  totalPages: number;
  director: string;
  setDirector: (director: string) => void;
  actor: string;
  setActor: (actor: string) => void;
  year: string;
  setYear: (year: string) => void;
  directorSuggestions: PersonSuggestion[];
  actorSuggestions: PersonSuggestion[];
  loadingSuggestions: boolean;
  fetchPeopleSuggestions: (query: string, type: 'director' | 'actor') => Promise<void>;
  selectPerson: (person: PersonSuggestion, type: 'director' | 'actor') => void;
  clearSuggestions: () => void;
  autocompleteSuggestions: SearchResult[];
  loadingAutocomplete: boolean;
  fetchAutocompleteSuggestions: (query: string) => Promise<void>;
  clearAutocompleteSuggestions: () => void;
  selectedKeywords: TmdbKeyword[];
  addKeyword: (keyword: TmdbKeyword) => void;
  removeKeyword: (keywordId: number) => void;
  clearKeywords: () => void;
  keywordSuggestions: TmdbKeyword[];
  loadingKeywordSuggestions: boolean;
  fetchKeywordSuggestions: (query: string) => Promise<void>;
  clearKeywordSuggestions: () => void;
  selectedLanguage: string;
  setSelectedLanguage: (language: string) => void;
  selectedCountry: string;
  setSelectedCountry: (country: string) => void;
  selectedProviders: number[];
  toggleProvider: (providerId: number) => void;
  clearProviders: () => void;
  watchProvidersList: WatchProvider[];
  loadingProviders: boolean;
  sortBy: SortByOption;
  setSortBy: (sortBy: SortByOption) => void;
  /**
   * Déclenche le chargement (une seule fois) des genres + providers TMDB.
   * Appelé par la page Search au montage — perf : ces 4 requêtes ne partent
   * plus au boot de l'app pour tous les visiteurs.
   */
  ensureFiltersLoaded: () => void;
}

const SearchContext = createContext<SearchContextType | null>(null);

export const useSearch = () => {
  const context = useContext(SearchContext);
  if (!context) {
    throw new Error('useSearch must be used within a SearchProvider');
  }
  return context;
};

// Ajout du mapping statique des genres TMDB -> français
const GENRES_FR: Record<number, string> = {
  28: 'Action',
  12: 'Aventure',
  16: 'Animation',
  35: 'Comédie',
  80: 'Crime',
  99: 'Documentaire',
  18: 'Drame',
  10751: 'Famille',
  14: 'Fantastique',
  36: 'Histoire',
  27: 'Horreur',
  10402: 'Musique',
  9648: 'Mystère',
  10749: 'Romance',
  878: 'Science-Fiction',
  10770: 'Téléfilm',
  53: 'Thriller',
  10752: 'Guerre',
  37: 'Western',
  10759: 'Action & Aventure',
  10762: 'Enfants',
  10763: 'Actualités',
  10764: 'Téléréalité',
  10765: 'Science-Fiction & Fantastique',
  10766: 'Feuilleton',
  10767: 'Talk-show',
  10768: 'Guerre & Politique'
};

/** Une entrée du catalogue local, au format des résultats TMDB. */
const toSearchResult = (entry: IndexedMedia): SearchResult => ({
  id: entry.id,
  media_type: entry.mediaType,
  title: entry.mediaType === 'movie' ? entry.title : undefined,
  name: entry.mediaType === 'tv' ? entry.title : undefined,
  poster_path: entry.posterPath || '',
  backdrop_path: entry.backdropPath || undefined,
  release_date: entry.mediaType === 'movie' ? entry.date : undefined,
  first_air_date: entry.mediaType === 'tv' ? entry.date : undefined,
  vote_average: entry.voteAverage ?? 0,
  genre_ids: entry.genreIds ?? [],
  overview: entry.overview,
});

export const SearchProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [selectedGenres, setSelectedGenres] = useState<number[]>([]);
  const [selectedType, setSelectedType] = useState<'all' | 'movie' | 'tv'>('all');
  const [minRating, setMinRating] = useState<number>(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadingGenres, setLoadingGenres] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [director, setDirector] = useState<string>('');
  const [actor, setActor] = useState<string>('');
  const [year, setYear] = useState<string>('');
  const [directorSuggestions, setDirectorSuggestions] = useState<PersonSuggestion[]>([]);
  const [actorSuggestions, setActorSuggestions] = useState<PersonSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<SearchResult[]>([]);
  const [loadingAutocomplete, setLoadingAutocomplete] = useState(false);
  const [selectedKeywords, setSelectedKeywords] = useState<TmdbKeyword[]>([]);
  const [keywordSuggestions, setKeywordSuggestions] = useState<TmdbKeyword[]>([]);
  const [loadingKeywordSuggestions, setLoadingKeywordSuggestions] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('');
  const [selectedCountry, setSelectedCountry] = useState<string>('');
  const [selectedProviders, setSelectedProviders] = useState<number[]>([]);
  const [watchProvidersList, setWatchProvidersList] = useState<WatchProvider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [sortBy, setSortBy] = useState<SortByOption>('popularity.desc');

  const toggleProvider = (providerId: number) => {
    setSelectedProviders(prev =>
      prev.includes(providerId) ? prev.filter(id => id !== providerId) : [...prev, providerId]
    );
  };

  const clearProviders = () => {
    setSelectedProviders([]);
  };

  // Function to fetch people suggestions from TMDB
  const fetchPeopleSuggestions = async (searchQuery: string, type: 'director' | 'actor') => {
    if (!searchQuery || searchQuery.length < 2) {
      if (type === 'director') {
        setDirectorSuggestions([]);
      } else {
        setActorSuggestions([]);
      }
      return;
    }

    setLoadingSuggestions(true);

    try {
      const response = await axios.get(`https://api.themoviedb.org/3/search/person`, {
        params: {
          api_key: TMDB_API_KEY,
          query: searchQuery,
          language: getTmdbLanguage(),
          page: 1,
        }
      });

      const results = response.data.results
        .filter((person: any) => {
          // Vérifier que la personne a des œuvres connues
          if (!person.known_for || person.known_for.length === 0) {
            return false;
          }

          // Vérifier que les œuvres connues sont des films ou séries (pas des personnes)
          const validWorks = person.known_for.filter((work: any) =>
            work.media_type === 'movie' || work.media_type === 'tv'
          );

          if (validWorks.length === 0) {
            return false;
          }

          // Vérifier que la personne a au moins une œuvre avec une note décente ou récente
          const hasRelevantWork = validWorks.some((work: any) => {
            const releaseYear = work.release_date ? new Date(work.release_date).getFullYear() :
              work.first_air_date ? new Date(work.first_air_date).getFullYear() : 0;
            return work.vote_average >= 5.0 || releaseYear >= 2000;
          });

          if (!hasRelevantWork) {
            return false;
          }

          if (type === 'director') {
            return person.known_for_department === 'Directing' ||
              person.known_for_department === 'Production' ||
              person.known_for.some((work: any) => work.job === 'Director');
          } else {
            return person.known_for_department === 'Acting';
          }
        })
        .slice(0, 5); // Limit to 5 suggestions

      if (type === 'director') {
        setDirectorSuggestions(results);
      } else {
        setActorSuggestions(results);
      }
    } catch (error) {
      console.error(`Error fetching ${type} suggestions:`, error);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  // Function to select a person from suggestions
  const selectPerson = (person: PersonSuggestion, type: 'director' | 'actor') => {
    if (type === 'director') {
      setDirector(person.name);
      setDirectorSuggestions([]);
    } else {
      setActor(person.name);
      setActorSuggestions([]);
    }
  };

  // Function to clear all suggestions
  const clearSuggestions = () => {
    setDirectorSuggestions([]);
    setActorSuggestions([]);
  };

  // Function to fetch autocomplete suggestions
  const fetchAutocompleteSuggestions = async (searchQuery: string) => {
    if (!searchQuery || searchQuery.length < 2) {
      setAutocompleteSuggestions([]);
      return;
    }

    setLoadingAutocomplete(true);
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/search/multi`, {
        params: {
          api_key: TMDB_API_KEY,
          query: searchQuery,
          language: getTmdbLanguage(),
          page: 1,
          sort_by: 'popularity.desc'
        }
      });

      const suggestions = response.data.results
        .filter((item: any) => (item.media_type === 'movie' || item.media_type === 'tv') && item.poster_path)
        // Tri par popularité décroissante pour afficher d'abord les plus populaires
        .sort((a: any, b: any) => b.popularity - a.popularity)
        .slice(0, 5); // Limit to 5 suggestions

      setAutocompleteSuggestions(suggestions);
    } catch (error) {
      console.error('Error fetching autocomplete suggestions:', error);
      setAutocompleteSuggestions([]);
    } finally {
      setLoadingAutocomplete(false);
    }
  };

  const clearAutocompleteSuggestions = () => {
    setAutocompleteSuggestions([]);
  };

  const fetchKeywordSuggestions = async (searchQuery: string) => {
    if (!searchQuery || searchQuery.length < 2) {
      setKeywordSuggestions([]);
      return;
    }

    setLoadingKeywordSuggestions(true);

    try {
      const suggestions = await searchTmdbKeywords(searchQuery, getTmdbLanguage());
      setKeywordSuggestions(
        suggestions.filter((keyword) => !selectedKeywords.some((selectedKeyword) => selectedKeyword.id === keyword.id))
      );
    } catch (error) {
      console.error('Error fetching keyword suggestions:', error);
      setKeywordSuggestions([]);
    } finally {
      setLoadingKeywordSuggestions(false);
    }
  };

  const addKeyword = (keyword: TmdbKeyword) => {
    setSelectedKeywords((prev) => (
      prev.some((selectedKeyword) => selectedKeyword.id === keyword.id)
        ? prev
        : [...prev, keyword]
    ));
    setKeywordSuggestions((prev) => prev.filter((suggestion) => suggestion.id !== keyword.id));
  };

  const removeKeyword = (keywordId: number) => {
    setSelectedKeywords((prev) => prev.filter((keyword) => keyword.id !== keywordId));
  };

  const clearKeywords = () => {
    setSelectedKeywords([]);
    setKeywordSuggestions([]);
  };

  const clearKeywordSuggestions = () => {
    setKeywordSuggestions([]);
  };

  const filterResultsByKeywords = async (items: SearchResult[]) => {
    if (selectedKeywords.length === 0 || items.length === 0) {
      return items;
    }

    const selectedKeywordIds = selectedKeywords.map((keyword) => keyword.id);
    const itemMatches = await Promise.all(
      items.map(async (item) => {
        try {
          const itemKeywordIds = await fetchTmdbMediaKeywordIds(item.media_type, item.id);
          return selectedKeywordIds.every((keywordId) => itemKeywordIds.includes(keywordId));
        } catch (error) {
          console.error(`Error fetching keywords for ${item.media_type} ${item.id}:`, error);
          return false;
        }
      })
    );

    return items.filter((_item, index) => itemMatches[index]);
  };

  // TMDB search/* endpoints don't support with_watch_providers, so when a query
  // is combined with provider filters we must filter client-side via per-item
  // /watch/providers calls (region FR).
  const filterResultsByProviders = async (items: SearchResult[]) => {
    if (selectedProviders.length === 0 || items.length === 0) {
      return items;
    }

    const selectedSet = new Set(selectedProviders);
    const itemMatches = await Promise.all(
      items.map(async (item) => {
        try {
          const response = await axios.get(
            `https://api.themoviedb.org/3/${item.media_type}/${item.id}/watch/providers`,
            { params: { api_key: TMDB_API_KEY } }
          );
          const fr = response.data?.results?.FR;
          if (!fr) return false;
          const all = [
            ...(fr.flatrate || []),
            ...(fr.buy || []),
            ...(fr.rent || []),
            ...(fr.free || []),
            ...(fr.ads || []),
          ];
          return all.some((p: any) => selectedSet.has(p.provider_id));
        } catch (error) {
          console.error(`Error fetching providers for ${item.media_type} ${item.id}:`, error);
          return false;
        }
      })
    );

    return items.filter((_item, index) => itemMatches[index]);
  };

  const performSearch = async (pageNum: number, isNewSearch: boolean = false) => {
    // Modifier la définition de isGenreSearch pour ne pas dépendre de query
    const hasFilters = selectedGenres.length > 0 || selectedType !== 'all' || minRating > 0 || director || actor || year || selectedKeywords.length > 0 || selectedLanguage || selectedCountry || selectedProviders.length > 0;
    const isGenreSearch = hasFilters;

    if ((!hasMore && !isNewSearch && !isGenreSearch) || isLoading) return;

    if (!query && selectedGenres.length === 0 && selectedType === 'all' && minRating === 0 && !director && !actor && !year && selectedKeywords.length === 0 && !selectedLanguage && !selectedCountry && selectedProviders.length === 0) return;

    const loadingMore = !isNewSearch && isGenreSearch;

    if (isNewSearch) {
      setLoading(true);
      setPage(1); // Réinitialise la page pour une nouvelle recherche
      // Réinitialise les IDs pour une nouvelle recherche
    } else if (loadingMore) {
      setIsLoadingMore(true);
    }

    setIsLoading(true);
    setError(null);

    try {
      let searchResults: SearchResult[] = [];
      let tmdbInitialResults: any[] = [];
      let currentTotalPages = 0;

      // Get TMDB results first for both movies and TV shows
      if (query) {
        try {
          console.log('Getting initial TMDB results for:', query);

          // Détermine s'il faut utiliser search ou discover (uniquement si pas de requête texte)
          const shouldUseDiscover = !query;

          // Paramètres de base communs
          const baseSearchParams: Record<string, any> = {
            api_key: TMDB_API_KEY,
            query: query,
            language: getTmdbLanguage(),
            page: pageNum,
            sort_by: 'popularity.desc',
          };

          // Ajout de filtres supplémentaires
          // Ajouter les paramètres spécifiques à discover
          if (shouldUseDiscover) {
            if (selectedGenres.length > 0) {
              baseSearchParams.with_genres = selectedGenres.join(',');
            }

            if (minRating > 0) {
              baseSearchParams['vote_average.gte'] = minRating;
            }

            if (director || actor) {
              // Obtenir les IDs est asynchrone, fait plus bas ou déjà fait ?
              // Le code original faisait await getPeopleIds ici, mais c'est mieux de le gérer proprement
            }
          }

          // Gestion spécifique Director/Actor pour discover (déplacé du bloc incorrect précédent)
          if (shouldUseDiscover && (director || actor)) {
            const peopleIds = await getPeopleIds(director, actor);
            if (peopleIds) {
              baseSearchParams.with_people = peopleIds;
            }
          }

          // Filter by language if selected
          if (shouldUseDiscover && selectedLanguage) {
            baseSearchParams.with_original_language = selectedLanguage;
          }

          // Filter by country if selected
          if (shouldUseDiscover && selectedCountry) {
            baseSearchParams.with_origin_country = selectedCountry;
          }

          let tvResults = [];
          let movieResults = [];

          // TV results
          if (selectedType === 'all' || selectedType === 'tv') {
            const tvEndpoint = shouldUseDiscover ? 'discover/tv' : 'search/tv';

            // Pour discover/tv, on ajuste certains paramètres spécifiques
            const tvParams = { ...baseSearchParams };
            if (tvEndpoint === 'discover/tv') {
              if (year) {
                delete tvParams.year; // Année n'est pas compatible avec discover/tv
                tvParams.first_air_date_year = year;
              }
            }

            const tvResponse = await axios.get(`https://api.themoviedb.org/3/${tvEndpoint}`, {
              params: tvParams
            });

            // Format TV results
            tvResults = tvResponse.data.results
              .filter((result: any) => {
                // Ne filtrer côté client que si on n'utilise pas discover
                if (!shouldUseDiscover && selectedGenres.length > 0) {
                  // Vérifier si au moins un des genres du résultat est dans selectedGenres
                  return result.genre_ids && result.genre_ids.some((genreId: number) =>
                    selectedGenres.includes(genreId)
                  );
                }
                return true;
              })
              .map((result: any) => ({
                ...result,
                media_type: 'tv'
              }));

            // Contribution à la pagination
            if (selectedType === 'tv') {
              currentTotalPages = tvResponse.data.total_pages || 0;
            }
          }

          // Movie results
          if (selectedType === 'all' || selectedType === 'movie') {
            const movieEndpoint = shouldUseDiscover ? 'discover/movie' : 'search/movie';

            // Pour discover/movie, on ajuste certains paramètres spécifiques
            const movieParams = { ...baseSearchParams };
            if (movieEndpoint === 'discover/movie') {
              if (year) {
                delete movieParams.year; // Année n'est pas compatible avec discover/movie
                movieParams.primary_release_year = year;
              }
            }

            const movieResponse = await axios.get(`https://api.themoviedb.org/3/${movieEndpoint}`, {
              params: movieParams
            });

            // Format movie results
            movieResults = movieResponse.data.results
              .filter((result: any) => {
                // Ne filtrer côté client que si on n'utilise pas discover
                if (!shouldUseDiscover && selectedGenres.length > 0) {
                  // Vérifier si au moins un des genres du résultat est dans selectedGenres
                  return result.genre_ids && result.genre_ids.some((genreId: number) =>
                    selectedGenres.includes(genreId)
                  );
                }
                return true;
              })
              .map((result: any) => ({
                ...result,
                media_type: 'movie'
              }));

            // Contribution à la pagination
            if (selectedType === 'movie') {
              currentTotalPages = movieResponse.data.total_pages || 0;
            } else if (selectedType === 'all') {
              // Update total pages (using maximum of both results)
              currentTotalPages = Math.max(currentTotalPages, movieResponse.data.total_pages || 0);
            }
          }

          // Mettre à jour le total de pages
          setTotalPages(currentTotalPages);

          // Combine results based on selected type
          if (selectedType === 'all') {
            // Combiner et trier par popularité décroissante
            tmdbInitialResults = [...tvResults, ...movieResults]
              .sort((a, b) => b.popularity - a.popularity);
          } else if (selectedType === 'tv') {
            tmdbInitialResults = tvResults;
          } else {
            tmdbInitialResults = movieResults;
          }

          console.log('Initial TMDB results count:', tmdbInitialResults.length);
        } catch (error) {
          console.error('Error getting initial TMDB results:', error);
        }

        // Filter for valid results and language (client-side filtering for search query)
        tmdbInitialResults = tmdbInitialResults.filter(result => {
          if (!result.poster_path) return false;

          if (query) {
            // Filtrage CLIENT-SIDE complet pour le mode Recherche (Query)

            // Language
            if (selectedLanguage && result.original_language !== selectedLanguage) return false;

            // Genres
            if (selectedGenres.length > 0) {
              if (!result.genre_ids || !result.genre_ids.some((id: number) => selectedGenres.includes(id))) return false;
            }

            // Rating
            if (minRating > 0 && result.vote_average < minRating) return false;

            // Year
            if (year) {
              const date = result.release_date || result.first_air_date;
              if (!date || date.substring(0, 4) !== year) return false;
            }

            // Country
            if (selectedCountry) {
              if (!result.origin_country || !result.origin_country.includes(selectedCountry)) return false;
            }
          }

          return true;
        });

        if (selectedKeywords.length > 0) {
          tmdbInitialResults = await filterResultsByKeywords(tmdbInitialResults);
        }

        if (selectedProviders.length > 0) {
          tmdbInitialResults = await filterResultsByProviders(tmdbInitialResults);
        }
      }

      // Recherche TMDB supplémentaire si nécessaire
      if (query && tmdbInitialResults.length > 0) {
        searchResults = tmdbInitialResults;
      }

      // Recherche par filtres uniquement (sans query)
      if (!query && (selectedGenres.length > 0 || selectedType !== 'all' || minRating > 0 || director || actor || year || selectedKeywords.length > 0 || selectedLanguage || selectedCountry || selectedProviders.length > 0)) {
        const baseParams: any = {
          api_key: TMDB_API_KEY,
          with_genres: selectedGenres.join(','),
          page: isGenreSearch ? pageNum : 1,
          language: getTmdbLanguage(),
          vote_average_gte: minRating,
          sort_by: sortBy
        };
        if (selectedLanguage) {
          baseParams.with_original_language = selectedLanguage;
        }
        if (selectedCountry) {
          baseParams.with_origin_country = selectedCountry;
        }
        if (selectedProviders.length > 0) {
          baseParams.with_watch_providers = selectedProviders.join('|');
          baseParams.watch_region = 'FR';
        }
        if (selectedKeywords.length > 0) {
          baseParams.with_keywords = selectedKeywords.map((keyword) => keyword.id).join(',');
        }
        if (year) {
          if (selectedType === 'movie' || selectedType === 'all') baseParams.primary_release_year = year;
          else if (selectedType === 'tv') baseParams.first_air_date_year = year;
        }
        if (selectedType === 'movie' || selectedType === 'all') baseParams.with_release_type = '2|3';
        if (director || actor) {
          const peopleIds = await getPeopleIds(director, actor);
          if (peopleIds) baseParams.with_people = peopleIds;
        }
        let endpoint = 'search/multi';
        const params: any = { ...baseParams };
        if (!query && isGenreSearch) {
          if (selectedType === 'all') {
            try {
              const tvParams = { ...baseParams };
              if (sortBy.startsWith('primary_release_date')) {
                tvParams.sort_by = sortBy.replace('primary_release_date', 'first_air_date');
              }
              const movieResponse = await axios.get(`https://api.themoviedb.org/3/discover/movie`, { params: { ...baseParams } });
              const tvResponse = await axios.get(`https://api.themoviedb.org/3/discover/tv`, { params: tvParams });
              const movieResults = movieResponse.data.results.map((result: any) => ({ ...result, media_type: 'movie' }));
              const tvResults = tvResponse.data.results.map((result: any) => ({ ...result, media_type: 'tv' }));
              const combinedResults = [...movieResults, ...tvResults].sort((a, b) => b.popularity - a.popularity);
              currentTotalPages = Math.max(movieResponse.data.total_pages || 0, tvResponse.data.total_pages || 0);
              setTotalPages(currentTotalPages);
              searchResults = combinedResults.filter((result: any) => {
                if (!result.poster_path) return false;
                return result.vote_average >= minRating;
              });
            } catch (error) {
              console.error('Error with dual API calls:', error);
              endpoint = 'discover/movie';
            }
          } else {
            endpoint = `discover/${selectedType}`;
          }
        } else if (query && isGenreSearch) {
          endpoint = 'search/multi';
          params.query = query;
          if (searchResults.length >= 20 && selectedType === 'all') {
            setResults(searchResults);
            setPage(pageNum);
            setHasMore(pageNum < currentTotalPages);
            setLoading(false);
            setIsLoading(false);
            setIsLoadingMore(false);
            return;
          }
        } else if (query) {
          endpoint = 'search/multi';
          params.query = query;
        }
        if (endpoint && endpoint.startsWith('discover')) {
          if (endpoint === 'discover/tv' && sortBy.startsWith('primary_release_date')) {
            params.sort_by = sortBy.replace('primary_release_date', 'first_air_date');
          }
          const response = await axios.get(`https://api.themoviedb.org/3/${endpoint}`, { params });
          if (response.data.total_pages && (!currentTotalPages || isGenreSearch)) {
            currentTotalPages = response.data.total_pages;
            setTotalPages(currentTotalPages);
          }
          let tmdbResults = response.data.results.filter((result: any) => {
            if (!result.poster_path) return false;
            if (endpoint.includes('discover')) return result.vote_average >= minRating;
            return (result.media_type === 'movie' || result.media_type === 'tv') && result.vote_average >= minRating;
          });
          if (endpoint === 'discover/movie') tmdbResults = tmdbResults.map((result: any) => ({ ...result, media_type: 'movie' }));
          else if (endpoint === 'discover/tv') tmdbResults = tmdbResults.map((result: any) => ({ ...result, media_type: 'tv' }));
          searchResults = tmdbResults;
        }
      }

      // Le catalogue local prolonge TMDB là où il est aveugle : mots-clés,
      // titres alternatifs, thèmes et personnages des fiches déjà ouvertes.
      // Uniquement en première page, et derrière les résultats de TMDB — ce
      // sont des repêchages, pas des réponses plus pertinentes.
      if (isNewSearch && query) {
        const alreadyThere = new Set(searchResults.map((result) => `${result.media_type}:${result.id}`));
        const fromIndex = searchIndexedMedia(query)
          .filter((entry) => !alreadyThere.has(`${entry.mediaType}:${entry.id}`))
          .filter((entry) => selectedType === 'all' || entry.mediaType === selectedType)
          .filter((entry) => (entry.voteAverage ?? 0) >= minRating)
          .filter((entry) => selectedGenres.length === 0
            || (entry.genreIds ?? []).some((genreId) => selectedGenres.includes(genreId)))
          .map(toSearchResult);
        searchResults = [...searchResults, ...fromIndex];
      }

      if (isNewSearch) {
        setResults(searchResults);
      } else {
        setResults(prev => [...prev, ...searchResults]);
      }
      setPage(pageNum + 1);
      setHasMore(searchResults.length >= 20 || (pageNum < currentTotalPages));
    } catch (error) {
      console.error('Error searching:', error);
      setError(i18n.t('search.searchError'));
    } finally {
      setLoading(false);
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  };

  // Helper function to get people IDs for actors and directors from TMDB
  const getPeopleIds = async (directorName?: string, actorName?: string): Promise<string | undefined> => {
    if (!directorName && !actorName) return undefined;

    try {
      const peopleIds: number[] = [];

      // Search for director
      if (directorName) {
        const directorResponse = await axios.get(`https://api.themoviedb.org/3/search/person`, {
          params: {
            api_key: TMDB_API_KEY,
            query: directorName,
            language: getTmdbLanguage()
          }
        });

        const directors = directorResponse.data.results.filter((person: any) => {
          return person.known_for_department === 'Directing';
        });

        if (directors.length > 0) {
          peopleIds.push(directors[0].id);
        }
      }

      // Search for actor
      if (actorName) {
        const actorResponse = await axios.get(`https://api.themoviedb.org/3/search/person`, {
          params: {
            api_key: TMDB_API_KEY,
            query: actorName,
            language: getTmdbLanguage()
          }
        });

        const actors = actorResponse.data.results.filter((person: any) => {
          return person.known_for_department === 'Acting';
        });

        if (actors.length > 0) {
          peopleIds.push(actors[0].id);
        }
      }

      return peopleIds.length > 0 ? peopleIds.join('|') : undefined;
    } catch (error) {
      console.error('Error searching for people:', error);
      return undefined;
    }
  };

  const handleTypeChange = (newType: 'all' | 'movie' | 'tv') => {
    setSelectedType(newType);
    setPage(1); // Reset page when type changes
    // Reset existing IDs when type changes
    // Ne lance plus la recherche automatiquement
  };

  // Perf : les fetches genres/providers (4 requêtes TMDB) ne partent plus au boot
  // pour tous les visiteurs — ils sont déclenchés à la demande par la page Search
  // via ensureFiltersLoaded().
  const filtersRequestedRef = useRef(false);
  const [filtersRequested, setFiltersRequested] = useState(false);

  const ensureFiltersLoaded = useCallback(() => {
    if (!filtersRequestedRef.current) {
      filtersRequestedRef.current = true;
      setFiltersRequested(true);
    }
  }, []);

  useEffect(() => {
    if (!filtersRequested) return;

    const fetchGenres = async () => {
      setLoadingGenres(true);
      try {
        const [movieGenres, tvGenres] = await Promise.all([
          axios.get('https://api.themoviedb.org/3/genre/movie/list', {
            params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
          }),
          axios.get('https://api.themoviedb.org/3/genre/tv/list', {
            params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() }
          })
        ]);

        const excludedGenreIds = [
          99,
          10759,
          10762,
          10763,
          10764,
          10765,
          10766,
          10767,
          10768
        ];

        let filteredGenres;
        if (selectedType === 'movie') {
          filteredGenres = movieGenres.data.genres;
        } else if (selectedType === 'tv') {
          filteredGenres = tvGenres.data.genres.filter((genre: Genre) =>
            !excludedGenreIds.includes(genre.id)
          );
        } else {
          filteredGenres = Array.from(new Set([
            ...movieGenres.data.genres,
            ...tvGenres.data.genres.filter((genre: Genre) =>
              !excludedGenreIds.includes(genre.id)
            )
          ].map((genre) => JSON.stringify(genre))))
            .map((genre) => JSON.parse(genre));
        }

        // Remplacement des noms par les noms français
        setGenres(filteredGenres.map((genre: Genre) => ({
          ...genre,
          name: genre.name || GENRES_FR[genre.id] || ''
        })));
        setSelectedGenres([]);
      } catch (error) {
        console.error('Error fetching genres:', error);
      } finally {
        setLoadingGenres(false);
      }
    };

    fetchGenres();
  }, [selectedType, filtersRequested]);

  // Fetch watch providers from TMDB — déclenché à la demande (perf)
  useEffect(() => {
    if (!filtersRequested) return;

    const fetchWatchProviders = async () => {
      setLoadingProviders(true);
      try {
        const [movieProviders, tvProviders] = await Promise.all([
          axios.get('https://api.themoviedb.org/3/watch/providers/movie', {
            params: { api_key: TMDB_API_KEY, watch_region: 'FR', language: getTmdbLanguage() }
          }),
          axios.get('https://api.themoviedb.org/3/watch/providers/tv', {
            params: { api_key: TMDB_API_KEY, watch_region: 'FR', language: getTmdbLanguage() }
          })
        ]);

        const providerMap = new Map<number, WatchProvider>();
        const addProviders = (results: any[]) => {
          for (const p of results) {
            if (!providerMap.has(p.provider_id)) {
              providerMap.set(p.provider_id, {
                provider_id: p.provider_id,
                provider_name: p.provider_name,
                logo_path: p.logo_path,
                display_priority: p.display_priorities?.FR ?? p.display_priority ?? 999,
              });
            }
          }
        };

        addProviders(movieProviders.data.results || []);
        addProviders(tvProviders.data.results || []);

        // Priorité manuelle : les plus connues en premier
        const PRIORITY_IDS = [
          8,    // Netflix
          119,  // Amazon Prime Video
          337,  // Disney+
          350,  // Apple TV+
          381,  // Canal+
          1899, // Max
          531,  // Paramount+
          283,  // Crunchyroll
          56,   // OCS
          467,  // ADN
          1716, // TF1+
          234,  // France TV
          324,  // Arte
          236,  // Canal+ Séries
          11,   // MUBI
          15,   // Hulu
          386,  // Peacock
          453,  // Discovery+
          35,   // Rakuten TV
          188,  // YouTube Premium
        ];

        const priorityIndex = new Map(PRIORITY_IDS.map((id, i) => [id, i]));

        const sorted = Array.from(providerMap.values())
          .sort((a, b) => {
            const aPri = priorityIndex.get(a.provider_id);
            const bPri = priorityIndex.get(b.provider_id);
            if (aPri !== undefined && bPri !== undefined) return aPri - bPri;
            if (aPri !== undefined) return -1;
            if (bPri !== undefined) return 1;
            return a.display_priority - b.display_priority;
          });

        setWatchProvidersList(sorted);
      } catch (error) {
        console.error('Error fetching watch providers:', error);
      } finally {
        setLoadingProviders(false);
      }
    };

    fetchWatchProviders();
  }, [filtersRequested]);

  const toggleGenre = (genreId: number) => {
    setSelectedGenres(prev =>
      prev.includes(genreId)
        ? prev.filter(id => id !== genreId)
        : [...prev, genreId]
    );
    // Reset page and existingResultIds when genres change
    setPage(1);

  };

  // Reset page to 1 whenever any search filter changes.
  // Previously this was 7 separate useEffect hooks each calling setPage(1) on
  // a single dep — every keystroke fired both the setQuery render AND a second
  // render from the [query] effect's setPage call, doubling render work in the
  // hot path. Collapsed into one effect with a combined dep array so the same
  // commit triggers at most one extra setPage. — perf
  useEffect(() => {
    setPage(1);
  }, [minRating, query, selectedLanguage, selectedCountry, selectedProviders, sortBy, selectedKeywords]);

  // Memoize the context value with state-only deps. The previous bare object
  // literal here meant every keystroke (which already setStates `query`) also
  // re-rendered Header — a top-level always-mounted consumer that rebuilds
  // i18n nav arrays each render — even though Header only reads `query`.
  // Worse, ANY parent re-render upstream cascaded into all consumers because
  // the value identity changed. The custom callbacks captured here close over
  // current state, so when state listed in deps changes we get a fresh value
  // with fresh closures; when only callback identities change (re-creation
  // each render) we keep the cached value, which is correct since those
  // callbacks would still see the same state. — perf
  const value = useMemo(() => ({
    query,
    setQuery,
    results,
    loading,
    error,
    genres,
    selectedGenres,
    toggleGenre,
    selectedType,
    setSelectedType: handleTypeChange,
    minRating,
    setMinRating,
    hasMore,
    page,
    setPage,
    performSearch,
    loadingGenres,
    showFilters,
    setShowFilters,
    isLoadingMore,
    totalPages,
    director,
    setDirector,
    actor,
    setActor,
    year,
    setYear,
    directorSuggestions,
    actorSuggestions,
    loadingSuggestions,
    fetchPeopleSuggestions,
    selectPerson,
    clearSuggestions,
    autocompleteSuggestions,
    loadingAutocomplete,
    fetchAutocompleteSuggestions,
    clearAutocompleteSuggestions,
    selectedKeywords,
    addKeyword,
    removeKeyword,
    clearKeywords,
    keywordSuggestions,
    loadingKeywordSuggestions,
    fetchKeywordSuggestions,
    clearKeywordSuggestions,
    selectedLanguage,
    setSelectedLanguage,
    selectedCountry,
    setSelectedCountry,
    selectedProviders,
    toggleProvider,
    clearProviders,
    watchProvidersList,
    loadingProviders,
    sortBy,
    setSortBy,
    ensureFiltersLoaded,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    query, results, loading, error, genres, selectedGenres, selectedType,
    minRating, hasMore, page, loadingGenres, showFilters, isLoadingMore,
    totalPages, director, actor, year, directorSuggestions, actorSuggestions,
    loadingSuggestions, autocompleteSuggestions, loadingAutocomplete,
    selectedKeywords, keywordSuggestions, loadingKeywordSuggestions,
    selectedLanguage, selectedCountry, selectedProviders, watchProvidersList,
    loadingProviders, sortBy
  ]);

  return (
    <SearchContext.Provider value={value}>
      {children}
    </SearchContext.Provider>
  );
};
