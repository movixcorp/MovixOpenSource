import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search as SearchIcon, Loader, Filter, Star, Calendar, User, Film, Award, X, LayoutGrid, List, ExternalLink, Globe, Tag, Sparkles, Tv, ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearch, SortByOption } from '../context/SearchContext';
import { motion, AnimatePresence } from 'framer-motion';
import { SquareBackground } from '../components/ui/square-background';
import ShinyText from '../components/ui/shiny-text';
import CustomDropdown from '../components/CustomDropdown';
import CustomCheckbox from '../components/CustomCheckbox';
import GridSkeleton from '../components/skeletons/GridSkeleton';
import GenreSkeleton from '../components/skeletons/GenreSkeleton';
import { SearchResult } from '../context/SearchContext';
import { encodeId } from '../utils/idEncoder';
import { getLanguages } from '../data/languages';
import { getCountries } from '../data/countries';
import CustomSlider from '../components/CustomSlider';
import { SearchGridCard, SearchListCard } from '../components/SearchCard';
import ReactCountryFlag from 'react-country-flag';
import { useAgeRestrictedContent } from '../hooks/useAgeRestrictedContent';

type ViewType = 'grid' | 'list';

const POSTER_FALLBACK = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="90" height="135" viewBox="0 0 90 135"><rect width="90" height="135" fill="%231a1a1a"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%23ffffff66" font-family="Arial, sans-serif" font-size="10">No Image</text></svg>';

// Pure helpers hoisted out of <Search/> so they aren't recreated each render.
// `isReleased` previously called `new Date()` per item per filter pass — with
// 60 results × 2 filter passes that's 120 Date allocations per keystroke
// flow on top of everything else. — perf
const isReleased = (item: SearchResult) => {
    const dateStr = item.release_date || item.first_air_date;
    if (!dateStr) return false;
    const today = Date.now();
    const releaseDate = new Date(dateStr).getTime();
    return releaseDate <= today;
};

const hasUsefulContent = (item: SearchResult) => {
    return Boolean(item.overview && item.overview.trim().length > 0);
};

// Reusable pagination component
const PaginationBar = ({ currentPage, maxPages, onSelect }: { currentPage: number; maxPages: number; onSelect: (n: number) => void }) => {
    const activePage = Math.max(currentPage > 1 ? currentPage - 1 : 1, 1);
    return (
        <div className="flex justify-center items-center gap-1.5 flex-wrap my-6">
            <motion.button whileTap={{ scale: 0.92 }} onClick={() => onSelect(1)} disabled={activePage <= 1}
                className={`min-w-[40px] h-10 rounded-full text-sm font-medium transition-all ${activePage === 1 ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/10'} disabled:opacity-30`}>
                1
            </motion.button>
            {activePage > 3 && <span className="text-white/20 px-1">...</span>}
            {Array.from({ length: 5 }, (_, i) => {
                const p = Math.max(2, activePage - 2) + i;
                return p > 1 && p < maxPages ? (
                    <motion.button key={p} whileTap={{ scale: 0.92 }} onClick={() => onSelect(p)}
                        className={`min-w-[40px] h-10 rounded-full text-sm font-medium transition-all ${p === activePage ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/10'}`}>
                        {p}
                    </motion.button>
                ) : null;
            })}
            {activePage < maxPages - 3 && <span className="text-white/20 px-1">...</span>}
            {maxPages > 1 && (
                <motion.button whileTap={{ scale: 0.92 }} onClick={() => onSelect(maxPages)} disabled={activePage >= maxPages}
                    className={`min-w-[40px] h-10 rounded-full text-sm font-medium transition-all ${activePage === maxPages ? 'bg-red-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/10'} disabled:opacity-30`}>
                    {maxPages}
                </motion.button>
            )}
        </div>
    );
};

const Search: React.FC = () => {
    const { t, i18n } = useTranslation();
    const [resultsPerRow, setResultsPerRow] = useState<number>(6);
    const [viewType, setViewType] = useState<ViewType>('grid');
    const [showDirectorSuggestions, setShowDirectorSuggestions] = useState<boolean>(false);
    const [showActorSuggestions, setShowActorSuggestions] = useState<boolean>(false);
    const [showAutocomplete, setShowAutocomplete] = useState<boolean>(false);
    const [showKeywordSuggestions, setShowKeywordSuggestions] = useState<boolean>(false);
    const [keywordQuery, setKeywordQuery] = useState('');
    const directorInputRef = useRef<HTMLInputElement>(null);
    const actorInputRef = useRef<HTMLInputElement>(null);
    const keywordInputRef = useRef<HTMLInputElement>(null);
    const directorSuggestionsRef = useRef<HTMLDivElement>(null);
    const actorSuggestionsRef = useRef<HTMLDivElement>(null);
    const keywordSuggestionsRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const autocompleteRef = useRef<HTMLDivElement>(null);
    const searchPerformedRef = useRef<boolean>(false);
    const resultsTopRef = useRef<HTMLDivElement>(null);
    const pendingScrollRef = useRef<boolean>(false);
    // Debounce timers for the typing-driven autocomplete fetches. Previously
    // `fetchAutocompleteSuggestions(value)` ran synchronously inside
    // `onChange`, so typing "interstellar" fired 11 TMDB requests + 11 full
    // Search re-renders. — perf
    const autocompleteDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const keywordDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const peopleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const navigate = useNavigate();
    const location = useLocation();

    const {
        query,
        setQuery,
        selectedType,
        setSelectedType,
        minRating,
        setMinRating,
        genres,
        selectedGenres,
        toggleGenre,
        results,
        loading,
        performSearch,
        showFilters,
        setShowFilters,
        loadingGenres,
        page,
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
    } = useSearch();

    // Perf : les genres + providers TMDB ne sont plus chargés au boot de l'app,
    // mais à la demande au premier montage de la page Search
    useEffect(() => {
        ensureFiltersLoaded();
    }, [ensureFiltersLoaded]);

    // Scroll to results top after page change finishes loading
    useEffect(() => {
        if (!loading && pendingScrollRef.current && resultsTopRef.current) {
            pendingScrollRef.current = false;
            const rect = resultsTopRef.current.getBoundingClientRect();
            // Seulement si le haut des résultats est au-dessus du viewport
            if (rect.top < 0) {
                const offset = 20;
                const top = window.scrollY + rect.top - offset;
                window.scrollTo({ top, behavior: 'smooth' });
            }
        }
    }, [loading]);

    // Extract query and page from URL and trigger search
    useEffect(() => {
        const urlParams = new URLSearchParams(location.search);
        const queryParam = urlParams.get('q');
        const pageParam = parseInt(urlParams.get('page') || '1', 10);

        if (queryParam) {
            if (queryParam !== query) {
                setQuery(queryParam);
                searchPerformedRef.current = false;
            } else if (queryParam === query && !searchPerformedRef.current) {
                performSearch(pageParam, true);
                searchPerformedRef.current = true;
            }
        } else if (query) {
            // URL has no ?q= but context still holds an old query (provider lives at app
            // root and never unmounts). Reset so the input doesn't repopulate after nav.
            setQuery('');
        }
    }, [location.search]);

    // Separate effect to trigger search when query is updated
    useEffect(() => {
        const urlParams = new URLSearchParams(location.search);
        const queryParam = urlParams.get('q');
        const pageParam = parseInt(urlParams.get('page') || '1', 10);

        if (query && queryParam === query && !searchPerformedRef.current) {
            performSearch(pageParam, true);
            searchPerformedRef.current = true;
        }
    }, [query]);

    // Reset ref when location changes
    useEffect(() => {
        searchPerformedRef.current = false;
    }, [location.search]);

    // Limit maximum pages to 500 (TMDB API limitation)
    const maxPages = useMemo(() => Math.min(totalPages, 500), [totalPages]);

    // New filter states
    const [filterUnreleased, setFilterUnreleased] = useState(true);
    const [filterNoContent, setFilterNoContent] = useState(true);

    // isReleased / hasUsefulContent live at module scope below — they don't
    // depend on component state and were previously redeclared every render.

    // Memoized filtered results
    const filteredResults = useMemo(() => {
        let filtered = results;
        if (filterUnreleased) {
            filtered = filtered.filter(isReleased);
        }
        if (filterNoContent) {
            filtered = filtered.filter(hasUsefulContent);
        }
        if (minRating > 0) {
            filtered = filtered.filter(item => typeof item.vote_average === 'number' && !isNaN(item.vote_average) && item.vote_average >= minRating);
        }
        return filtered;
    }, [results, filterUnreleased, filterNoContent, minRating]);

    // Memoized filtered autocomplete suggestions
    const filteredAutocompleteSuggestions = useMemo(() => {
        let filtered = autocompleteSuggestions;
        if (filterUnreleased) {
            filtered = filtered.filter(isReleased);
        }
        if (filterNoContent) {
            filtered = filtered.filter(hasUsefulContent);
        }
        if (minRating > 0) {
            filtered = filtered.filter(item => typeof item.vote_average === 'number' && !isNaN(item.vote_average) && item.vote_average >= minRating);
        }
        return filtered;
    }, [autocompleteSuggestions, filterUnreleased, filterNoContent, minRating]);

    const { items: ageFilteredResults, isFiltering: isFilteringResultsByAge } = useAgeRestrictedContent(filteredResults);
    const { items: ageFilteredAutocomplete } = useAgeRestrictedContent(filteredAutocompleteSuggestions);

    // Handle clicks outside suggestion dropdowns
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (directorSuggestionsRef.current &&
                !directorSuggestionsRef.current.contains(event.target as Node) &&
                directorInputRef.current &&
                !directorInputRef.current.contains(event.target as Node)) {
                setShowDirectorSuggestions(false);
            }

            if (actorSuggestionsRef.current &&
                !actorSuggestionsRef.current.contains(event.target as Node) &&
                actorInputRef.current &&
                !actorInputRef.current.contains(event.target as Node)) {
                setShowActorSuggestions(false);
            }

            if (autocompleteRef.current &&
                !autocompleteRef.current.contains(event.target as Node) &&
                searchInputRef.current &&
                !searchInputRef.current.contains(event.target as Node)) {
                setShowAutocomplete(false);
            }

            if (keywordSuggestionsRef.current &&
                !keywordSuggestionsRef.current.contains(event.target as Node) &&
                keywordInputRef.current &&
                !keywordInputRef.current.contains(event.target as Node)) {
                setShowKeywordSuggestions(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);

    // Handle director input changes
    const handleDirectorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setDirector(value);

        if (peopleDebounceRef.current) clearTimeout(peopleDebounceRef.current);
        if (value.length >= 2) {
            setShowDirectorSuggestions(true);
            peopleDebounceRef.current = setTimeout(() => {
                fetchPeopleSuggestions(value, 'director');
            }, 300);
        } else {
            setShowDirectorSuggestions(false);
        }
    };

    // Handle actor input changes
    const handleActorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setActor(value);

        if (peopleDebounceRef.current) clearTimeout(peopleDebounceRef.current);
        if (value.length >= 2) {
            setShowActorSuggestions(true);
            peopleDebounceRef.current = setTimeout(() => {
                fetchPeopleSuggestions(value, 'actor');
            }, 300);
        } else {
            setShowActorSuggestions(false);
        }
    };

    const handleKeywordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setKeywordQuery(value);

        if (keywordDebounceRef.current) clearTimeout(keywordDebounceRef.current);
        if (value.length >= 2) {
            setShowKeywordSuggestions(true);
            keywordDebounceRef.current = setTimeout(() => {
                fetchKeywordSuggestions(value);
            }, 300);
        } else {
            clearKeywordSuggestions();
            setShowKeywordSuggestions(false);
        }
    };

    // Handle main search input changes for autocomplete
    const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setQuery(value);

        const newUrl = value ? `/search?q=${encodeURIComponent(value)}&page=1` : '/search';
        window.history.replaceState(null, '', newUrl);

        if (autocompleteDebounceRef.current) clearTimeout(autocompleteDebounceRef.current);
        if (value.length >= 2) {
            setShowAutocomplete(true);
            autocompleteDebounceRef.current = setTimeout(() => {
                fetchAutocompleteSuggestions(value);
            }, 300);
        } else {
            clearAutocompleteSuggestions();
            setShowAutocomplete(false);
        }
    };

    // Handle selecting an item from autocomplete
    const handleSelectAutocomplete = (item: SearchResult) => {
        clearAutocompleteSuggestions();
        setShowAutocomplete(false);
        navigate(`/${item.media_type}/${encodeId(item.id)}`);
    };

    // Select a director from suggestions
    const handleSelectDirector = (person: any) => {
        navigate(`/person/${person.id}`);
        setShowDirectorSuggestions(false);
    };

    // Select an actor from suggestions
    const handleSelectActor = (person: any) => {
        navigate(`/person/${person.id}`);
        setShowActorSuggestions(false);
    };

    const handleSelectKeyword = (keyword: { id: number; name: string }) => {
        addKeyword(keyword);
        setKeywordQuery('');
        clearKeywordSuggestions();
        setShowKeywordSuggestions(false);
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (query || selectedGenres.length > 0 || selectedType !== 'all' || minRating > 0 || director || actor || year || selectedKeywords.length > 0 || selectedLanguage || selectedCountry || selectedProviders.length > 0) {
            if (query) {
                const newUrl = `/search?q=${encodeURIComponent(query)}&page=1`;
                if (window.location.pathname + window.location.search !== newUrl) {
                    navigate(newUrl);
                }
            }
            performSearch(1, true);
        }
    };

    // Responsive grid: detect max columns based on screen width
    const [screenCols, setScreenCols] = useState(6);
    useEffect(() => {
        const update = () => {
            const w = window.innerWidth;
            if (w < 640) setScreenCols(2);       // mobile
            else if (w < 768) setScreenCols(3);  // sm
            else if (w < 1024) setScreenCols(4); // md
            else if (w < 1280) setScreenCols(6); // lg
            else setScreenCols(10);               // xl+
        };
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);

    // Clamp resultsPerRow to screenCols
    const effectivePerRow = Math.min(resultsPerRow, screenCols);

    // Grid layout options — only show options that fit the screen
    const allGridOptions = [2, 3, 4, 6, 8, 10];
    const gridOptions = allGridOptions
        .filter(n => n <= screenCols)
        .map(n => ({ value: n, label: `${n} ${t('search.perRow')}` }));

    const getGridClasses = () => {
        switch (effectivePerRow) {
            case 2:
                return "grid-cols-2";
            case 3:
                return "grid-cols-2 sm:grid-cols-3";
            case 4:
                return "grid-cols-2 sm:grid-cols-3 md:grid-cols-4";
            case 8:
                return "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8";
            case 10:
                return "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10";
            case 6:
            default:
                return "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6";
        }
    };

    // Function to handle page selection
    const handlePageSelect = (selectedPage: number) => {
        if (selectedPage > 0 && selectedPage <= maxPages) {
            const currentParams = new URLSearchParams(location.search);
            currentParams.set('page', selectedPage.toString());
            navigate(`/search?${currentParams.toString()}`);
            pendingScrollRef.current = true;
            performSearch(selectedPage, true);
        }
    };

    // Clear all filters
    const clearAllFilters = () => {
        setQuery('');
        setSelectedType('all');
        setMinRating(0);
        setDirector('');
        setActor('');
        setYear('');
        setKeywordQuery('');
        clearKeywords();
        clearKeywordSuggestions();
        setShowKeywordSuggestions(false);
        setSelectedLanguage('');
        setSelectedCountry('');
        clearProviders();
        setSortBy('popularity.desc');
        setActivePreset(null);
        // Drop the ?q= from the URL so browser back/forward can't restore it
        window.history.replaceState(null, '', '/search');
        setTimeout(() => {
            if (selectedGenres.length > 0) {
                selectedGenres.forEach(genreId => toggleGenre(genreId));
            }
        }, 0);
    };

    const [activePreset, setActivePreset] = useState<string | null>(null);

    const CATEGORY_PRESETS = useMemo(() => [
        { id: 'kdrama', label: 'K-Drama', flagCode: 'KR', type: 'tv' as const, country: 'KR', language: 'ko', genres: [18] },
        { id: 'cdrama', label: 'C-Drama', flagCode: 'CN', type: 'tv' as const, country: 'CN', language: 'zh', genres: [18] },
        { id: 'jdrama', label: 'J-Drama', flagCode: 'JP', type: 'tv' as const, country: 'JP', language: 'ja', genres: [18] },
        { id: 'thaï', label: 'Thaï-Drama', flagCode: 'TH', type: 'tv' as const, country: 'TH', language: 'th', genres: [18] },
        { id: 'tdrama', label: 'T-Drama', flagCode: 'TR', type: 'tv' as const, country: 'TR', language: 'tr', genres: [18] },
        { id: 'anime', label: 'Anime', emoji: '🎌', type: 'tv' as const, country: 'JP', language: 'ja', genres: [16] },
        { id: 'anime_film', label: 'Film Anime', emoji: '🎬', type: 'movie' as const, country: 'JP', language: 'ja', genres: [16] },
        { id: 'bollywood', label: 'Bollywood', flagCode: 'IN', type: 'movie' as const, country: 'IN', language: 'hi', genres: [] },
        { id: 'telenovela', label: 'Telenovela', flagCode: 'MX', type: 'tv' as const, country: '', language: 'es', genres: [18] },
        { id: 'british', label: 'Séries UK', flagCode: 'GB', type: 'tv' as const, country: 'GB', language: 'en', genres: [] },
        { id: 'nordic_noir', label: 'Nordic Noir', flagCode: 'SE', type: 'tv' as const, country: '', language: '', genres: [80, 9648], presetCountries: ['SE', 'DK', 'NO', 'FI', 'IS'] },
    ], []);

    const [showAllProviders, setShowAllProviders] = useState(false);
    const PROVIDERS_INITIAL_COUNT = 15;

    const visibleProviders = useMemo(() => {
        if (showAllProviders) return watchProvidersList;
        return watchProvidersList.slice(0, PROVIDERS_INITIAL_COUNT);
    }, [watchProvidersList, showAllProviders]);

    const sortOptions: { value: SortByOption; label: string }[] = useMemo(() => [
        { value: 'popularity.desc', label: t('search.sortPopularityDesc') },
        { value: 'popularity.asc', label: t('search.sortPopularityAsc') },
        { value: 'vote_average.desc', label: t('search.sortRatingDesc') },
        { value: 'vote_average.asc', label: t('search.sortRatingAsc') },
        { value: 'primary_release_date.desc', label: t('search.sortDateDesc') },
        { value: 'primary_release_date.asc', label: t('search.sortDateAsc') },
        { value: 'revenue.desc', label: t('search.sortRevenueDesc') },
        { value: 'vote_count.desc', label: t('search.sortVoteCountDesc') },
    ], [t]);

    const applyPreset = (preset: typeof CATEGORY_PRESETS[number]) => {
        if (activePreset === preset.id) {
            // Désactiver le preset
            setActivePreset(null);
            clearAllFilters();
            return;
        }
        setActivePreset(preset.id);
        setSelectedType(preset.type);
        setSelectedCountry(preset.country);
        setSelectedLanguage(preset.language);
        // Reset genres puis appliquer ceux du preset
        setTimeout(() => {
            selectedGenres.forEach(genreId => toggleGenre(genreId));
            setTimeout(() => {
                preset.genres.forEach(genreId => toggleGenre(genreId));
            }, 0);
        }, 0);
    };

    const [localMinRating, setLocalMinRating] = useState(minRating);

    // Sync local rating with context rating
    useEffect(() => {
        setLocalMinRating(minRating);
    }, [minRating]);

    // Definition of options for dropdowns
    const typeOptions = useMemo(() => [
        { value: 'all', label: t('search.all') },
        { value: 'movie', label: t('search.movies') },
        { value: 'tv', label: t('search.tvShows') }
    ], []);

    const languageOptions = useMemo(() => [
        { value: '', label: t('search.allNationalities') },
        ...getLanguages(i18n.language)
    ], [i18n.language]);

    const countryOptions = useMemo(() => [
        { value: '', label: t('search.allCountries') },
        ...getCountries(i18n.language)
    ], [i18n.language]);

    // Set simple title
    React.useEffect(() => {
        document.title = `${t('search.title')} - Movix`;
    }, []);

    const filtersActive = showFilters || selectedGenres.length > 0 || director || actor || year || selectedKeywords.length > 0 || selectedLanguage || selectedCountry || selectedProviders.length > 0;

    return (
        <SquareBackground squareSize={48} borderColor="rgba(239, 68, 68, 0.10)" className="w-full min-h-screen bg-black text-white">
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="w-full relative z-10"
            >
                {/* Hero section */}
                <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="relative mb-8 w-full overflow-visible transition-all duration-300"
                >
                    <motion.div
                        initial={{ y: 20, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        transition={{ delay: 0.4 }}
                        className="relative w-full px-8 py-8 flex flex-col items-center justify-center"
                    >
                        <motion.h1
                            initial={{ y: 20, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            transition={{ delay: 0.5 }}
                            className="text-3xl md:text-4xl lg:text-5xl font-bold mb-4 text-center transition-all px-4"
                        >
                            <ShinyText text={t('search.searchMoviesAndShows')} speed={3} color="#ffffff" shineColor="#ef4444" className="inline" />
                        </motion.h1>

                        <p className="text-white/40 text-sm mb-8">{t('search.searchHint')}</p>

                        <motion.div
                            initial={{ y: 20, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            transition={{ delay: 0.6 }}
                            className="w-full max-w-4xl"
                        >
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div className="relative">
                                    <div className="flex bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl overflow-hidden">
                        <SearchIcon size={20} className="self-center ml-4 text-white opacity-40 shrink-0" />
                                        <input
                                            ref={searchInputRef}
                                            type="text"
                                            value={query}
                                            onChange={handleQueryChange}
                                            onFocus={() => query.length >= 2 && setShowAutocomplete(true)}
                                            placeholder={t('search.searchPlaceholder')}
                                            className="flex-grow min-w-0 bg-transparent text-white placeholder:text-white/30 focus:outline-none text-lg pl-3 pr-5 py-4"
                                            autoComplete="off"
                                        />
                                        <button
                                            type="submit"
                                            onClick={() => {
                                                clearAutocompleteSuggestions();
                                                setShowAutocomplete(false);
                                            }}
                                            className="px-4 text-white/60 hover:text-white transition-colors md:hidden border-l border-white/10 shrink-0"
                                            aria-label={t('search.searchPlaceholder')}
                                        >
                                            <SearchIcon size={22} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setShowFilters(!showFilters)}
                                            aria-label="Filters"
                                            className={`px-4 transition-all border-l shrink-0 ${filtersActive
                                                ? 'bg-red-600 border-red-500 text-white hover:bg-red-500'
                                                : 'border-white/10 text-white/70 hover:text-white hover:bg-white/5'
                                                }`}
                                        >
                                            <Filter size={22} />
                                        </button>
                                    </div>

                                    {/* Autocomplete Dropdown */}
                                    <AnimatePresence>
                                        {showAutocomplete && ageFilteredAutocomplete.length > 0 && (
                                            <motion.div
                                                ref={autocompleteRef}
                                                initial={{ opacity: 0, y: -10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                exit={{ opacity: 0, y: -10 }}
                                                className="absolute z-50 left-0 right-0 top-full bg-black/90 backdrop-blur-md border border-white/10 rounded-2xl shadow-2xl overflow-hidden mt-2 overflow-y-auto min-h-[200px] max-h-[400px] custom-scrollbar"
                                                style={{ width: searchInputRef.current?.offsetWidth }}
                                            >
                                                {loadingAutocomplete ? (
                                                    <div className="flex items-center justify-center p-4">
                                    <Loader className="w-5 h-5 text-white opacity-40 animate-spin" />
                                                        <span className="ml-2 text-sm text-white/40">{t('search.searching')}</span>
                                                    </div>
                                                ) : (
                                                    <div>
                                                        {ageFilteredAutocomplete.map((item) => (
                                                            <div
                                                                key={`${item.id}-${item.media_type}`}
                                                                onClick={() => handleSelectAutocomplete(item)}
                                                                className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 cursor-pointer transition-colors"
                                                            >
                                                                <img
                                                                    src={`https://image.tmdb.org/t/p/w45${item.poster_path}`}
                                                                    alt={item.title || item.name}
                                                                    className="w-10 h-14 rounded-lg object-cover"
                                                                    onError={(e) => { (e.target as HTMLImageElement).src = POSTER_FALLBACK; }}
                                                                />
                                                                <div>
                                                                    <div className="text-sm font-medium line-clamp-1">{item.title || item.name}</div>
                                                                    <div className="text-xs text-white/40">
                                                                        {item.media_type === 'movie' ? t('search.movieLabel') : t('search.serieLabel')} - {new Date(item.release_date || item.first_air_date || '').getFullYear()}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>

                                {/* Filter Panel */}
                                {showFilters && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -10 }}
                                        className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-6 space-y-6"
                                    >
                                        <div className="flex justify-between items-center">
                                            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">{t('search.searchFilters')}</h2>
                                            <button
                                                type="button"
                                                onClick={clearAllFilters}
                                                className="text-sm text-white/40 hover:text-white transition-colors"
                                            >
                                                {t('search.clearAll')}
                                            </button>
                                        </div>

                                        {/* Type / Rating / Language / Country / Sort */}
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                                            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
                                                <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                    <Film className="w-4 h-4" />
                                                    {t('search.type')}
                                                </h3>
                                                <CustomDropdown
                                                    options={typeOptions}
                                                    value={selectedType}
                                                    onChange={(value) => setSelectedType(value as 'all' | 'movie' | 'tv')}
                                                    placeholder={t('search.selectType')}
                                                    searchable={false}
                                                />
                                            </motion.div>

                                            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
                                                <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                    <Star className="w-4 h-4" />
                                                    {t('search.minRating')}
                                                </h3>
                                                <div className="flex items-center gap-4">
                                                    <CustomSlider
                                                        min={0}
                                                        max={10}
                                                        step={0.5}
                                                        value={localMinRating}
                                                        onChange={setLocalMinRating}
                                                        onCommit={(val) => {
                                                            setLocalMinRating(val);
                                                            setMinRating(val);
                                                        }}
                                                        className="flex-grow"
                                                    />
                                                    <div className="min-w-[3rem] px-2 py-1 bg-white/5 border border-white/10 rounded-xl text-center font-mono text-sm">
                                                        {localMinRating.toFixed(1)}
                                                    </div>
                                                </div>
                                            </motion.div>

                                            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
                                                <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                    <Globe className="w-4 h-4" />
                                                    {t('search.language')}
                                                </h3>
                                                <CustomDropdown
                                                    options={languageOptions}
                                                    value={selectedLanguage}
                                                    onChange={(value) => setSelectedLanguage(value)}
                                                    placeholder={t('search.allLanguages')}
                                                />
                                            </motion.div>

                                            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
                                                <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                    <Globe className="w-4 h-4" />
                                                    {t('search.country')}
                                                </h3>
                                                <CustomDropdown
                                                    options={countryOptions}
                                                    value={selectedCountry}
                                                    onChange={(value) => setSelectedCountry(value)}
                                                    placeholder={t('search.allCountries')}
                                                />
                                            </motion.div>

                                            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22 }}>
                                                <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                    <ArrowUpDown className="w-4 h-4" />
                                                    {t('search.sortBy')}
                                                </h3>
                                                <CustomDropdown
                                                    options={sortOptions.map(o => ({ value: o.value, label: o.label }))}
                                                    value={sortBy}
                                                    onChange={(value) => setSortBy(value as SortByOption)}
                                                    placeholder={t('search.sortBy')}
                                                    searchable={false}
                                                />
                                            </motion.div>
                                        </div>

                                        {/* Checkboxes */}
                                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="flex flex-col md:flex-row gap-4">
                                            <CustomCheckbox
                                                checked={filterUnreleased}
                                                onChange={setFilterUnreleased}
                                                icon={<Calendar className="w-4 h-4 text-red-400" />}
                                                label={t('search.hideUnreleased')}
                                                className="w-full md:w-auto"
                                            />
                                            <CustomCheckbox
                                                checked={filterNoContent}
                                                onChange={setFilterNoContent}
                                                icon={<Star className="w-4 h-4 text-yellow-400" />}
                                                label={t('search.hideNoContent')}
                                                className="w-full md:w-auto"
                                            />
                                        </motion.div>

                                        {/* Category Presets */}
                                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.27 }}>
                                            <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                <Sparkles className="w-4 h-4" />
                                                {t('search.categories')}
                                            </h3>
                                            <div className="flex flex-wrap gap-2">
                                                {CATEGORY_PRESETS.map((preset, index) => (
                                                    <motion.button
                                                        key={preset.id}
                                                        initial={{ opacity: 0, scale: 0.8 }}
                                                        animate={{ opacity: 1, scale: 1 }}
                                                        transition={{ delay: 0.28 + index * 0.03 }}
                                                        type="button"
                                                        onClick={() => applyPreset(preset)}
                                                        className={`px-4 py-2 rounded-full text-sm font-medium transition-all flex items-center gap-1.5 ${activePreset === preset.id
                                                            ? 'bg-red-600 text-white'
                                                            : 'bg-white/5 border border-white/10 text-white/60 hover:text-white hover:border-white/30'
                                                            }`}
                                                    >
                                                        <span>{'flagCode' in preset ? <ReactCountryFlag countryCode={preset.flagCode} svg style={{ width: '1.2em', height: '1.2em', borderRadius: '2px' }} /> : preset.emoji}</span>
                                                        <span>{preset.label}</span>
                                                    </motion.button>
                                                ))}
                                            </div>
                                        </motion.div>

                                        {/* Streaming Platforms */}
                                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.275 }}>
                                            <div className="flex justify-between items-center mb-3">
                                                <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2">
                                                    <Tv className="w-4 h-4" />
                                                    {t('search.streamingPlatforms')}
                                                </h3>
                                                {selectedProviders.length > 0 && (
                                                    <button
                                                        type="button"
                                                        onClick={clearProviders}
                                                        className="text-xs text-white/40 hover:text-white transition-colors"
                                                    >
                                                        {t('search.clearAll')}
                                                    </button>
                                                )}
                                            </div>
                                            {loadingProviders ? (
                                                <div className="flex items-center gap-2 py-4">
                                            <Loader className="w-4 h-4 text-white opacity-40 animate-spin" />
                                                    <span className="text-sm text-white/40">{t('search.searching')}</span>
                                                </div>
                                            ) : (
                                                <>
                                                    <motion.div layout className="flex flex-wrap gap-2">
                                                        <AnimatePresence initial={false}>
                                                            {visibleProviders.map((provider) => (
                                                                <motion.button
                                                                    key={provider.provider_id}
                                                                    layout
                                                                    initial={{ opacity: 0, scale: 0.8 }}
                                                                    animate={{ opacity: 1, scale: 1 }}
                                                                    exit={{ opacity: 0, scale: 0.8 }}
                                                                    transition={{ duration: 0.2 }}
                                                                    type="button"
                                                                    onClick={() => toggleProvider(provider.provider_id)}
                                                                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${selectedProviders.includes(provider.provider_id)
                                                                        ? 'bg-red-600 text-white ring-1 ring-red-500'
                                                                        : 'bg-white/5 border border-white/10 text-white/60 hover:text-white hover:border-white/30'
                                                                        }`}
                                                                >
                                                                    <img
                                                                        src={`https://image.tmdb.org/t/p/w45${provider.logo_path}`}
                                                                        alt={provider.provider_name}
                                                                        className="w-5 h-5 rounded-sm object-cover"
                                                                        loading="lazy"
                                                                    />
                                                                    <span>{provider.provider_name}</span>
                                                                </motion.button>
                                                            ))}
                                                        </AnimatePresence>
                                                    </motion.div>
                                                    {watchProvidersList.length > PROVIDERS_INITIAL_COUNT && (
                                                        <button
                                                            type="button"
                                                            onClick={() => setShowAllProviders(!showAllProviders)}
                                                            className="flex items-center gap-1 mt-3 text-sm text-white/50 hover:text-white transition-colors"
                                                        >
                                                            {showAllProviders ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                                            {showAllProviders
                                                                ? t('search.showLess')
                                                                : t('search.showMore', { count: watchProvidersList.length - PROVIDERS_INITIAL_COUNT })}
                                                        </button>
                                                    )}
                                                </>
                                            )}
                                        </motion.div>

                                        {/* Keywords */}
                                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.28 }} className="relative">
                                            <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                <Tag className="w-4 h-4" />
                                                {t('search.keywords')}
                                            </h3>
                                            <div className="relative">
                                                <input
                                                    type="text"
                                                    ref={keywordInputRef}
                                                    value={keywordQuery}
                                                    onChange={handleKeywordChange}
                                                    onFocus={() => keywordQuery.length >= 2 && setShowKeywordSuggestions(true)}
                                                    placeholder={t('search.keywordPlaceholder')}
                                                    className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:border-red-500/50 transition-colors pr-10"
                                                />
                                                {keywordQuery && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setKeywordQuery('');
                                                            clearKeywordSuggestions();
                                                            setShowKeywordSuggestions(false);
                                                        }}
                                                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/40 hover:text-white"
                                                    >
                                                        <X size={16} />
                                                    </button>
                                                )}

                                                <AnimatePresence>
                                                    {showKeywordSuggestions && (keywordSuggestions.length > 0 || loadingKeywordSuggestions || keywordQuery.length >= 2) && (
                                                        <motion.div
                                                            ref={keywordSuggestionsRef}
                                                            initial={{ opacity: 0, y: -10 }}
                                                            animate={{ opacity: 1, y: 0 }}
                                                            exit={{ opacity: 0, y: -10 }}
                                                            className="absolute z-50 left-0 right-0 mt-1 bg-black/90 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl overflow-y-auto max-h-80 custom-scrollbar"
                                                        >
                                                            {loadingKeywordSuggestions ? (
                                                                <div className="flex items-center justify-center p-4">
                                <Loader className="w-5 h-5 text-white opacity-40 animate-spin" />
                                                                    <span className="ml-2 text-sm text-white/40">{t('search.searching')}</span>
                                                                </div>
                                                            ) : keywordSuggestions.length > 0 ? (
                                                                <div>
                                                                    {keywordSuggestions.map((keyword) => (
                                                                        <button
                                                                            key={keyword.id}
                                                                            type="button"
                                                                            onClick={() => handleSelectKeyword(keyword)}
                                                                            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left"
                                                                        >
                                    <Tag size={16} className="text-white opacity-40" />
                                                                            <span className="text-sm font-medium">{keyword.name}</span>
                                                                        </button>
                                                                    ))}
                                                                </div>
                                                            ) : (
                                                                <div className="px-4 py-3 text-sm text-white/40">
                                                                    {t('search.noKeywordResults')}
                                                                </div>
                                                            )}
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </div>

                                            {selectedKeywords.length > 0 && (
                                                <div className="flex flex-wrap gap-2 mt-3">
                                                    {selectedKeywords.map((keyword) => (
                                                        <button
                                                            key={keyword.id}
                                                            type="button"
                                                            onClick={() => removeKeyword(keyword.id)}
                                                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-600/15 border border-red-500/30 text-sm text-white hover:bg-red-600/25 transition-colors"
                                                        >
                                                            <span>{keyword.name}</span>
                                                            <X size={14} />
                                                        </button>
                                                    ))}
                                                </div>
                                            )}

                                            <p className="text-xs text-white/40 mt-3">
                                                {t('search.keywordHint')}
                                            </p>
                                        </motion.div>

                                        {/* Director / Actor / Year */}
                                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                            <div className="relative">
                                                <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                    <User className="w-4 h-4" />
                                                    {t('search.director')}
                                                </h3>
                                                <div className="relative">
                                                    <input
                                                        type="text"
                                                        ref={directorInputRef}
                                                        value={director}
                                                        onChange={handleDirectorChange}
                                                        onFocus={() => director.length >= 2 && setShowDirectorSuggestions(true)}
                                                        placeholder={t('search.directorPlaceholder')}
                                                        className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:border-red-500/50 transition-colors pr-10"
                                                    />
                                                    {director && (
                                                        <button
                                                            onClick={() => {
                                                                setDirector('');
                                                                setShowDirectorSuggestions(false);
                                                            }}
                                                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/40 hover:text-white"
                                                        >
                                                            <X size={16} />
                                                        </button>
                                                    )}

                                                    <AnimatePresence>
                                                        {showDirectorSuggestions && directorSuggestions.length > 0 && (
                                                            <motion.div
                                                                ref={directorSuggestionsRef}
                                                                initial={{ opacity: 0, y: -10 }}
                                                                animate={{ opacity: 1, y: 0 }}
                                                                exit={{ opacity: 0, y: -10 }}
                                                                className="absolute z-50 left-0 right-0 mt-1 bg-black/90 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl overflow-y-auto max-h-80 custom-scrollbar"
                                                            >
                                                                {loadingSuggestions ? (
                                                                    <div className="flex items-center justify-center p-4">
                                    <Loader className="w-5 h-5 text-white opacity-40 animate-spin" />
                                                                        <span className="ml-2 text-sm text-white/40">{t('search.searching')}</span>
                                                                    </div>
                                                                ) : (
                                                                    <div>
                                                                        {directorSuggestions.map((person) => (
                                                                            <div
                                                                                key={person.id}
                                                                                onClick={() => handleSelectDirector(person)}
                                                                                className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 cursor-pointer transition-colors group"
                                                                                title={t('search.clickToViewPerson')}
                                                                            >
                                                                                {person.profile_path ? (
                                                                                    <img
                                                                                        src={`https://image.tmdb.org/t/p/w45${person.profile_path}`}
                                                                                        alt={person.name}
                                                                                        className="w-8 h-8 rounded-full object-cover"
                                                                                    />
                                                                                ) : (
                                                                                    <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
                                                <User size={16} className="text-white opacity-40" />
                                                                                    </div>
                                                                                )}
                                                                                <div className="flex-1">
                                                                                    <div className="text-sm font-medium">{person.name}</div>
                                                                                    <div className="text-xs text-white/40">{person.known_for_department}</div>
                                                                                </div>
                                                                                <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                                                <ExternalLink size={14} className="text-white opacity-40" />
                                                                                </div>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>
                                            </div>

                                            <div className="relative">
                                                <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                    <User className="w-4 h-4" />
                                                    {t('search.actor')}
                                                </h3>
                                                <div className="relative">
                                                    <input
                                                        type="text"
                                                        ref={actorInputRef}
                                                        value={actor}
                                                        onChange={handleActorChange}
                                                        onFocus={() => actor.length >= 2 && setShowActorSuggestions(true)}
                                                        placeholder={t('search.actorPlaceholder')}
                                                        className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:border-red-500/50 transition-colors pr-10"
                                                    />
                                                    {actor && (
                                                        <button
                                                            onClick={() => {
                                                                setActor('');
                                                                setShowActorSuggestions(false);
                                                            }}
                                                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/40 hover:text-white"
                                                        >
                                                            <X size={16} />
                                                        </button>
                                                    )}

                                                    <AnimatePresence>
                                                        {showActorSuggestions && actorSuggestions.length > 0 && (
                                                            <motion.div
                                                                ref={actorSuggestionsRef}
                                                                initial={{ opacity: 0, y: -10 }}
                                                                animate={{ opacity: 1, y: 0 }}
                                                                exit={{ opacity: 0, y: -10 }}
                                                                className="absolute z-50 left-0 right-0 mt-1 bg-black/90 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl overflow-y-auto max-h-80 custom-scrollbar"
                                                            >
                                                                {loadingSuggestions ? (
                                                                    <div className="flex items-center justify-center p-4">
                                    <Loader className="w-5 h-5 text-white opacity-40 animate-spin" />
                                                                        <span className="ml-2 text-sm text-white/40">{t('search.searching')}</span>
                                                                    </div>
                                                                ) : (
                                                                    <div>
                                                                        {actorSuggestions.map((person) => (
                                                                            <div
                                                                                key={person.id}
                                                                                onClick={() => handleSelectActor(person)}
                                                                                className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 cursor-pointer transition-colors group"
                                                                                title={t('search.clickToViewPerson')}
                                                                            >
                                                                                {person.profile_path ? (
                                                                                    <img
                                                                                        src={`https://image.tmdb.org/t/p/w45${person.profile_path}`}
                                                                                        alt={person.name}
                                                                                        className="w-8 h-8 rounded-full object-cover"
                                                                                    />
                                                                                ) : (
                                                                                    <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
                                                <User size={16} className="text-white opacity-40" />
                                                                                    </div>
                                                                                )}
                                                                                <div className="flex-1">
                                                                                    <div className="text-sm font-medium">{person.name}</div>
                                                                                    <div className="text-xs text-white/40">{person.known_for_department}</div>
                                                                                </div>
                                                                                <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                                                <ExternalLink size={14} className="text-white opacity-40" />
                                                                                </div>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>
                                                </div>
                                            </div>

                                            <div>
                                                <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                    <Calendar className="w-4 h-4" />
                                                    {t('search.year')}
                                                </h3>
                                                <div className="relative">
                                                    <input
                                                        type="text"
                                                        value={year}
                                                        onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, ''))}
                                                        placeholder={t('search.yearPlaceholder')}
                                                        maxLength={4}
                                                        className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:border-red-500/50 transition-colors pr-10"
                                                    />
                                                    {year && (
                                                        <button
                                                            onClick={() => setYear('')}
                                                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/40 hover:text-white"
                                                        >
                                                            <X size={16} />
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        </motion.div>

                                        {/* Genres */}
                                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
                                            <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider flex items-center gap-2 mb-3">
                                                <Award className="w-4 h-4" />
                                                {t('search.genres')}
                                            </h3>
                                            {loadingGenres ? (
                                                <motion.div
                                                    initial={{ opacity: 0 }}
                                                    animate={{ opacity: 1 }}
                                                    exit={{ opacity: 0 }}
                                                    transition={{ duration: 0.3 }}
                                                >
                                                    <GenreSkeleton />
                                                </motion.div>
                                            ) : (
                                                <div className="flex flex-wrap gap-2">
                                                    {genres.map((genre, index) => (
                                                        <motion.button
                                                            key={genre.id}
                                                            initial={{ opacity: 0, scale: 0.8 }}
                                                            animate={{ opacity: 1, scale: 1 }}
                                                            transition={{ delay: 0.4 + index * 0.05 }}
                                                            type="button"
                                                            onClick={() => toggleGenre(genre.id)}
                                                            className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${selectedGenres.includes(genre.id)
                                                                ? 'bg-red-600 text-white'
                                                                : 'bg-white/5 border border-white/10 text-white/60 hover:text-white hover:border-white/30'
                                                                }`}
                                                        >
                                                            {t(`genres.id_${genre.id}`, { defaultValue: genre.name })}
                                                        </motion.button>
                                                    ))}
                                                </div>
                                            )}
                                        </motion.div>

                                        {/* Apply button */}
                                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="flex justify-center">
                                            <motion.button
                                                type="submit"
                                                whileHover={{ scale: 1.02 }}
                                                whileTap={{ scale: 0.98 }}
                                                className="w-full max-w-sm mx-auto py-3 rounded-2xl bg-red-600 hover:bg-red-500 text-white font-semibold flex items-center justify-center gap-2 transition-colors"
                                            >
                                                <SearchIcon size={20} />
                                                <span>{t('search.applyCriteria')}</span>
                                            </motion.button>
                                        </motion.div>
                                    </motion.div>
                                )}
                            </form>
                        </motion.div>
                    </motion.div>
                </motion.div>

                {/* Results area */}
                <motion.div
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.7 }}
                    className="px-4 md:px-6"
                >
                    {loading || isFilteringResultsByAge ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.3 }}
                            className="container mx-auto px-4 py-8"
                        >
                            <GridSkeleton />
                        </motion.div>
                    ) : ageFilteredResults.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20">
                            <Film className="w-16 h-16 text-white opacity-10 mb-4" />
                            <p className="text-white/40">{t('search.noResults')}</p>
                            <p className="text-white/40 text-sm mt-2">{t('search.modifyCriteria')}</p>
                        </div>
                    ) : (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="container mx-auto px-4 py-8"
                        >
                            {maxPages > 0 && (
                                <>
                                    {/* Results controls bar */}
                                    <div className="flex items-center justify-between flex-wrap gap-4 mb-6">
                                        <p className="text-sm text-white/40">
                                            {t('search.pageXOfY', { current: Math.max(page > 1 ? page - 1 : 1, 1), total: maxPages })} ({ageFilteredResults.length} {t('search.results')})
                                            {totalPages > 500 && <span className="text-xs ml-2">({t('search.limitedToPages')})</span>}
                                        </p>

                                        <div className="flex items-center gap-4">
                                            {/* View type toggle */}
                                            <div className="flex items-center gap-1">
                                                <button
                                                    onClick={() => setViewType('grid')}
                                                    className={`p-2 rounded-xl transition-all ${viewType === 'grid' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white hover:bg-white/5'}`}
                                                >
                                                    <LayoutGrid size={18} />
                                                </button>
                                                <button
                                                    onClick={() => setViewType('list')}
                                                    className={`p-2 rounded-xl transition-all ${viewType === 'list' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white hover:bg-white/5'}`}
                                                >
                                                    <List size={18} />
                                                </button>
                                            </div>

                                            {/* Grid size select */}
                                            {viewType === 'grid' && (
                                                <CustomDropdown
                                                    options={gridOptions.map(o => ({ value: String(o.value), label: o.label }))}
                                                    value={String(resultsPerRow)}
                                                    onChange={(v) => setResultsPerRow(Number(v))}
                                                    searchable={false}
                                                    className="w-[140px]"
                                                />
                                            )}
                                        </div>
                                    </div>

                                    <div ref={resultsTopRef} />
                                    {/* Top pagination */}
                                    <PaginationBar currentPage={page} maxPages={maxPages} onSelect={handlePageSelect} />
                                </>
                            )}

                            {/* Grid View */}
                            {viewType === 'grid' && (
                                <div className={`grid ${getGridClasses()} gap-3`}>
                                    {ageFilteredResults.map((item, index) => (
                                        <SearchGridCard
                                            key={`${item.id}-${item.media_type}-${index}`}
                                            item={item}
                                            index={index}
                                            movieLabel={t('search.movieLabel')}
                                            serieLabel={t('search.serieLabel')}
                                        />
                                    ))}
                                </div>
                            )}

                            {/* List View */}
                            {viewType === 'list' && (
                                <div className="flex flex-col gap-3">
                                    {ageFilteredResults.map((item, index) => (
                                        <SearchListCard
                                            key={`${item.id}-${item.media_type}-${index}`}
                                            item={item}
                                            index={index}
                                            movieLabel={t('search.movieLabel')}
                                            serieLabel={t('search.serieLabel')}
                                            watchlistLabel={t('search.watchlist')}
                                            removeLabel={t('search.retirer')}
                                            noDescLabel={t('search.noDescription')}
                                        />
                                    ))}
                                </div>
                            )}

                            {/* Bottom pagination */}
                            {ageFilteredResults.length > 0 && (
                                <div className="mt-8 text-center">
                                    <p className="text-sm text-white/40 mb-2">
                                        {t('search.pageXOfY', { current: Math.max(page > 1 ? page - 1 : 1, 1), total: maxPages })}
                                    </p>
                                    <PaginationBar currentPage={page} maxPages={maxPages} onSelect={handlePageSelect} />
                                </div>
                            )}
                        </motion.div>
                    )}
                </motion.div>
            </motion.div>
        </SquareBackground>
    );
};

export default Search;
