import React, { useState, useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Loader2, Film, Tv2, Play, Crown, ArrowLeft, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isUserVip } from '../../utils/authUtils';
import { MAIN_API } from '../../config/runtime';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface FtvProgram {
  title: string;
  description: string;
  url: string;
  // Jeton signé émis par l'API : c'est lui qu'on transporte, pas l'URL.
  url_token?: string | null;
  thumbnail: string | null;
  type: string;
  channel: string | null;
  category: string | null;
  program_id: string | null;
}

interface FtvVideo {
  title: string;
  titleLeading: string;
  description: string;
  url: string;
  url_token?: string | null;
  thumbnail: string | null;
  type: string;
  channel: string | null;
  category: string | null;
  id: number | null;
  season: string | null;
  episode: string | null;
  csa: string | null;
  caption: string | null;
}

interface SearchResult {
  success: boolean;
  programs: FtvProgram[];
  videos: FtvVideo[];
}

// ─── Sites ──────────────────────────────────────────────────────────────────────

// ─── Channel badge colors ───────────────────────────────────────────────────────

const CHANNEL_COLORS: Record<string, string> = {
  'france-2': 'bg-red-600',
  'france_2': 'bg-red-600',
  'france-3': 'bg-blue-500',
  'france_3': 'bg-blue-500',
  'france-4': 'bg-purple-600',
  'france_4': 'bg-purple-600',
  'france-5': 'bg-green-600',
  'france_5': 'bg-green-600',
  'francetv': 'bg-blue-700',
  'slash': 'bg-yellow-600',
  'okoo': 'bg-orange-500',
};

// ─── CSA badges ─────────────────────────────────────────────────────────────────

const CSA_BADGES: Record<string, { label: string; color: string }> = {
  'TP': { label: 'TP', color: 'bg-green-600' },
  '10': { label: '-10', color: 'bg-yellow-500' },
  '12': { label: '-12', color: 'bg-orange-500' },
  '16': { label: '-16', color: 'bg-red-500' },
  '18': { label: '-18', color: 'bg-red-700' },
};

// ─── Component ──────────────────────────────────────────────────────────────────

const FranceTVBrowse: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isVip = isUserVip();

  // Focus input on mount
  useEffect(() => {
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, []);

  const doSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${MAIN_API}/api/ftv/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery.trim() }),
      });

      if (!res.ok) throw new Error(t('francetv.errorGeneric', { status: res.status }));
      const data: SearchResult = await res.json();
      setResults(data);
    } catch (err: any) {
      setError(err.message || t('francetv.searchError'));
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 500);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    doSearch(query);
  };

  // On navigue avec le jeton signé émis par l'API, jamais avec l'URL : le
  // navigateur transporte une adresse qu'il ne peut ni lire ni remplacer.
  const navigateToInfo = (token?: string | null) => {
    if (token) navigate(`/ftv/info/${token}`);
  };

  const navigateToPlayer = (token?: string | null) => {
    if (token) navigate(`/ftv/watch/${token}`);
  };

  // ─── Search & results screen ──────────────────────────────────────────────

  const totalResults = results ? results.programs.length + results.videos.length : 0;

  return (
    <div className="min-h-screen bg-[#0a0a0f] pt-24 pb-16 px-4">
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-4 mb-8"
        >
          <button
            onClick={() => navigate(-1)}
            className="p-2 rounded-xl bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5 text-zinc-300" />
          </button>
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold text-white"
              style={{ backgroundColor: '#0f4beb' }}
            >
              F
            </div>
            <h2 className="text-2xl font-bold text-white">France.tv</h2>
          </div>
          {!isVip && (
            <div className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-full">
              <Crown className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-amber-400 text-xs font-medium">{t('francetv.vipRequired')}</span>
            </div>
          )}
        </motion.div>

        {/* Search bar */}
        <motion.form
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          onSubmit={handleSubmit}
          className="relative mb-10"
        >
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={handleInputChange}
              placeholder={t('francetv.searchPlaceholder')}
              className="w-full pl-12 pr-12 py-4 bg-zinc-900/80 border border-zinc-700/50 rounded-2xl 
                text-white placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 
                focus:ring-2 focus:ring-blue-500/20 text-lg transition-all"
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); setResults(null); }}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-zinc-700/50 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4 text-zinc-400" />
              </button>
            )}
          </div>
        </motion.form>

        {/* Loading */}
        <AnimatePresence>
          {loading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-center py-20"
            >
              <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error */}
        {error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-10"
          >
            <p className="text-red-400 text-lg">{error}</p>
          </motion.div>
        )}

        {/* Results */}
        {!loading && results && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {/* Result count */}
            <p className="text-zinc-500 text-sm mb-6">
              {t('francetv.resultCount', { count: totalResults, query })}
            </p>

            {/* Programs section */}
            {results.programs.length > 0 && (
              <div className="mb-12">
                <div className="flex items-center gap-2 mb-5">
                  <Tv2 className="w-5 h-5 text-blue-400" />
                  <h3 className="text-xl font-semibold text-white">{t('francetv.programs')}</h3>
                  <span className="text-zinc-500 text-sm">({results.programs.length})</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {results.programs.map((prog, i) => (
                    <motion.div
                      key={`prog-${i}`}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.03 }}
                    >
                      <button
                        onClick={() => navigateToInfo(prog.url_token)}
                        className="group w-full text-left cursor-pointer"
                      >
                        <div className="relative aspect-video rounded-xl overflow-hidden bg-zinc-800 mb-2">
                          {prog.thumbnail ? (
                            <img
                              src={prog.thumbnail}
                              alt={prog.title}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Tv2 className="w-8 h-8 text-zinc-600" />
                            </div>
                          )}
                          {/* Overlay on hover */}
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-300 flex items-center justify-center">
                            <Play className="w-10 h-10 text-white opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                          </div>
                          {/* Channel badge */}
                          {prog.channel && (
                            <span className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-semibold text-white ${CHANNEL_COLORS[prog.channel] || 'bg-zinc-700'}`}>
                              {prog.channel.replace(/_/g, ' ')}
                            </span>
                          )}
                        </div>
                        <h4 className="text-white text-sm font-medium line-clamp-2 group-hover:text-blue-400 transition-colors">
                          {prog.title}
                        </h4>
                        {prog.category && (
                          <p className="text-zinc-500 text-xs mt-0.5">{prog.category}</p>
                        )}
                      </button>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* Videos section */}
            {results.videos.length > 0 && (
              <div className="mb-12">
                <div className="flex items-center gap-2 mb-5">
                  <Film className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-xl font-semibold text-white">{t('francetv.videos')}</h3>
                  <span className="text-zinc-500 text-sm">({results.videos.length})</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {results.videos.map((video, i) => (
                    <motion.div
                      key={`vid-${i}`}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.03 }}
                    >
                      <button
                        onClick={() => navigateToPlayer(video.url_token)}
                        className="group w-full text-left cursor-pointer"
                      >
                        <div className="relative aspect-video rounded-xl overflow-hidden bg-zinc-800 mb-2">
                          {video.thumbnail ? (
                            <img
                              src={video.thumbnail}
                              alt={video.title}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Film className="w-8 h-8 text-zinc-600" />
                            </div>
                          )}
                          {/* Overlay */}
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-300 flex items-center justify-center">
                            <Play className="w-10 h-10 text-white opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                          </div>
                          {/* CSA badge */}
                          {video.csa && CSA_BADGES[video.csa] && (
                            <span className={`absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-bold text-white ${CSA_BADGES[video.csa].color}`}>
                              {CSA_BADGES[video.csa].label}
                            </span>
                          )}
                          {/* Channel badge */}
                          {video.channel && (
                            <span className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-semibold text-white ${CHANNEL_COLORS[video.channel] || 'bg-zinc-700'}`}>
                              {video.channel.replace(/_/g, ' ')}
                            </span>
                          )}
                        </div>
                        <h4 className="text-white text-sm font-medium line-clamp-2 group-hover:text-blue-400 transition-colors">
                          {video.title}
                        </h4>
                        {video.titleLeading && (
                          <p className="text-zinc-500 text-xs mt-0.5">{video.titleLeading}</p>
                        )}
                      </button>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* No results */}
            {totalResults === 0 && !loading && (
              <div className="text-center py-20">
                <Search className="w-12 h-12 text-zinc-600 mx-auto mb-4" />
                <p className="text-zinc-400 text-lg">{t('francetv.noResults')}</p>
                <p className="text-zinc-600 text-sm mt-1">{t('francetv.tryOtherTerms')}</p>
              </div>
            )}
          </motion.div>
        )}

        {/* Empty state - no search yet */}
        {!loading && !results && !error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-center py-20"
          >
            <Search className="w-16 h-16 text-zinc-700 mx-auto mb-4" />
            <p className="text-zinc-500 text-lg">{t('francetv.searchToStart')}</p>
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default FranceTVBrowse;
