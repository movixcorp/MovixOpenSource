import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Clock, Film, Tv2, Users, Award, ChevronDown, Loader2, AlertCircle, Crown, Play } from 'lucide-react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isUserVip } from '../../utils/authUtils';
import { MAIN_API } from '../../config/runtime';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui/select';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface VideoInfo {
  success: boolean;
  type: 'video';
  title: string;
  description: string;
  thumbnail: string | null;
  duration: string;
  durationSeconds: number | null;
  director: string;
  channel: string | null;
  csa: string | null;
  program: string | null;
  category: string | null;
  uploadDate?: string;
  expires?: string;
}

interface EpisodeInfo {
  title: string;
  program: string;
  description: string;
  url: string;
  // Jeton signé émis par l'API : c'est lui qu'on transporte, pas l'URL.
  url_token?: string | null;
  thumbnail: string | null;
  season: number | null;
  episode: number | null;
  csa: string | null;
  duration: string | null;
}

interface SeasonInfo {
  name: string;
  number: number;
  episodeCount: number;
  episodes: EpisodeInfo[];
}

interface ProgrammeInfo {
  success: boolean;
  type: 'programme';
  title: string;
  description: string;
  thumbnail: string | null;
  channel: string | null;
  programId: string | null;
  category: string | null;
  director: string | null;
  cast: string | null;
  seasons: SeasonInfo[];
  totalEpisodes: number;
}

type InfoData = (VideoInfo | ProgrammeInfo) & { success: boolean };

// ─── Channel display names ──────────────────────────────────────────────────────

const CHANNEL_NAMES: Record<string, string> = {
  'france-2': 'France 2',
  'france_2': 'France 2',
  'france-3': 'France 3',
  'france_3': 'France 3',
  'france-4': 'France 4',
  'france_4': 'France 4',
  'france-5': 'France 5',
  'france_5': 'France 5',
  'francetv': 'France TV',
  'slash': 'Slash',
  'okoo': 'Okoo',
};

const CSA_INFO: Record<string, { label: string; color: string; desc: string }> = {
  'TP': { label: 'Tout public', color: 'bg-green-600', desc: 'Tous âges' },
  '10': { label: '-10 ans', color: 'bg-yellow-500', desc: 'Déconseillé aux moins de 10 ans' },
  '12': { label: '-12 ans', color: 'bg-orange-500', desc: 'Déconseillé aux moins de 12 ans' },
  '16': { label: '-16 ans', color: 'bg-red-500', desc: 'Déconseillé aux moins de 16 ans' },
  '18': { label: '-18 ans', color: 'bg-red-700', desc: 'Interdit aux moins de 18 ans' },
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}min`;
  return `${m} min`;
}

function formatIsoDuration(iso: string): string {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return iso;
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0');
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}min`;
  return `${m} min`;
}

// ─── Component ──────────────────────────────────────────────────────────────────

const FranceTVInfo: React.FC = () => {
  const { encoded } = useParams<{ encoded: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [info, setInfo] = useState<InfoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeason, setSelectedSeason] = useState(0);
  const [showFullDescription, setShowFullDescription] = useState(false);

  const isVip = isUserVip();

  useEffect(() => {
    if (!encoded) return;
    const fetchInfo = async () => {
      setLoading(true);
      setError(null);
      try {
        // `encoded` est le jeton signé remis par l'API : on le rend tel quel,
        // le serveur y retrouve l'URL qu'il avait lui-même émise.
        const res = await fetch(`${MAIN_API}/api/ftv/info?token=${encodeURIComponent(encoded)}`);
        if (!res.ok) throw new Error(t('francetv.errorGeneric', { status: res.status }));
        const data = await res.json();
        if (!data.success) throw new Error(data.error || t('francetv.dataUnavailable'));
        setInfo(data);
      } catch (err: any) {
        setError(err.message || t('francetv.loadingError'));
      } finally {
        setLoading(false);
      }
    };
    fetchInfo();
  }, [encoded]);

  const navigateToPlayer = (token?: string | null) => {
    if (token) navigate(`/ftv/watch/${token}`);
  };

  // ─── Loading state ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] pt-24 flex items-center justify-center">
        <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
      </div>
    );
  }

  // ─── Error state ──────────────────────────────────────────────────────────

  if (error || !info) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] pt-24 px-4">
        <div className="max-w-2xl mx-auto text-center py-20">
          <AlertCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-white mb-2">{t('common.error')}</h2>
          <p className="text-zinc-400 mb-6">{error || t('francetv.cannotLoadInfo')}</p>
          <button
            onClick={() => navigate(-1)}
            className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-white transition-colors cursor-pointer"
          >
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  // ─── Video/Film page ──────────────────────────────────────────────────────

  if (info.type === 'video') {
    const data = info as VideoInfo;
    const durationDisplay = data.durationSeconds
      ? formatDuration(data.durationSeconds)
      : data.duration
        ? formatIsoDuration(data.duration)
        : null;

    return (
      <div className="min-h-screen bg-[#0a0a0f]">
        {/* Hero backdrop */}
        <div className="relative h-[50vh] md:h-[60vh] overflow-hidden">
          {data.thumbnail && (
            <>
              <img
                src={data.thumbnail}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0f] via-[#0a0a0f]/60 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a0f]/80 to-transparent" />
            </>
          )}

          {/* Back button */}
          <div className="absolute top-24 left-4 z-10">
            <button
              onClick={() => navigate(-1)}
              className="p-2.5 rounded-xl bg-black/40 backdrop-blur-sm hover:bg-black/60 transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5 text-white" />
            </button>
          </div>

          {/* Content over hero */}
          <div className="absolute bottom-0 left-0 right-0 p-6 md:p-12">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-4xl"
            >
              {/* Channel + CSA badges */}
              <div className="flex items-center gap-2 mb-3">
                {data.channel && (
                  <span className="px-3 py-1 rounded-lg bg-blue-600/80 text-white text-xs font-semibold uppercase">
                    {CHANNEL_NAMES[data.channel] || data.channel}
                  </span>
                )}
                {data.csa && CSA_INFO[data.csa] && (
                  <span className={`px-3 py-1 rounded-lg text-white text-xs font-semibold ${CSA_INFO[data.csa].color}`}>
                    {CSA_INFO[data.csa].label}
                  </span>
                )}
                {data.category && (
                  <span className="px-3 py-1 rounded-lg bg-zinc-700/80 text-zinc-300 text-xs font-medium capitalize">
                    {data.category.replace(/_/g, ' ')}
                  </span>
                )}
              </div>

              {/* Title */}
              <h1 className="text-3xl md:text-5xl font-bold text-white mb-3 leading-tight">
                {data.title}
              </h1>

              {/* Meta info */}
              <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-400 mb-4">
                {durationDisplay && (
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-4 h-4" /> {durationDisplay}
                  </span>
                )}
                {data.director && (
                  <span className="flex items-center gap-1.5">
                    <Award className="w-4 h-4" /> {data.director}
                  </span>
                )}
                {data.program && (
                  <span className="flex items-center gap-1.5">
                    <Tv2 className="w-4 h-4" /> {data.program.replace(/_/g, ' ')}
                  </span>
                )}
              </div>

              {/* Watch button */}
              {encoded && (
                <button
                  onClick={() => navigateToPlayer(encoded)}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-white font-semibold transition-colors cursor-pointer"
                >
                  <Play className="w-5 h-5" fill="white" />
                  {t('francetv.watchButton')}
                </button>
              )}
            </motion.div>
          </div>
        </div>

        {/* Description */}
        <div className="max-w-4xl mx-auto px-6 py-10">
          {data.description && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              <h2 className="text-lg font-semibold text-white mb-3">{t('francetv.synopsis')}</h2>
              <div className="relative">
                <p className="text-zinc-400 leading-relaxed text-base">
                  {showFullDescription || data.description.length <= 160
                    ? data.description
                    : `${data.description.substring(0, 160)}...`}
                </p>
                {data.description.length > 160 && (
                  <button
                    onClick={() => setShowFullDescription(!showFullDescription)}
                    className="mt-2 text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors cursor-pointer"
                  >
                    {showFullDescription ? t('francetv.showLess') : t('francetv.readMore')}
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </div>
      </div>
    );
  }

  // ─── Programme/Série page ─────────────────────────────────────────────────

  if (info.type === 'programme') {
    const data = info as ProgrammeInfo;
    const currentSeason = data.seasons[selectedSeason];

    return (
      <div className="min-h-screen bg-[#0a0a0f]">
        {/* Hero backdrop */}
        <div className="relative h-[45vh] md:h-[55vh] overflow-hidden">
          {data.thumbnail && (
            <>
              <img
                src={data.thumbnail}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0f] via-[#0a0a0f]/60 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a0f]/80 to-transparent" />
            </>
          )}

          {/* Back button */}
          <div className="absolute top-24 left-4 z-10">
            <button
              onClick={() => navigate(-1)}
              className="p-2.5 rounded-xl bg-black/40 backdrop-blur-sm hover:bg-black/60 transition-colors cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5 text-white" />
            </button>
          </div>

          {/* Content over hero */}
          <div className="absolute bottom-0 left-0 right-0 p-6 md:p-12">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-4xl"
            >
              {/* Badges */}
              <div className="flex items-center gap-2 mb-3">
                <span className="px-3 py-1 rounded-lg bg-emerald-600/80 text-white text-xs font-semibold">
                  {t('francetv.series')}
                </span>
                {data.channel && (
                  <span className="px-3 py-1 rounded-lg bg-blue-600/80 text-white text-xs font-semibold uppercase">
                    {CHANNEL_NAMES[data.channel] || data.channel}
                  </span>
                )}
                {data.category && (
                  <span className="px-3 py-1 rounded-lg bg-zinc-700/80 text-zinc-300 text-xs font-medium capitalize">
                    {data.category.replace(/_/g, ' ')}
                  </span>
                )}
              </div>

              {/* Title */}
              <h1 className="text-3xl md:text-5xl font-bold text-white mb-3 leading-tight">
                {data.title}
              </h1>

              {/* Meta */}
              <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-400 mb-4">
                <span className="flex items-center gap-1.5">
                  <Tv2 className="w-4 h-4" />
                  {t('francetv.seasons_count', { count: data.seasons.length })} · {t('francetv.episodes_count', { count: data.totalEpisodes })}
                </span>
                {data.director && (
                  <span className="flex items-center gap-1.5">
                    <Award className="w-4 h-4" /> {data.director}
                  </span>
                )}
              </div>

              {/* Cast */}
              {data.cast && (
                <div className="flex items-center gap-1.5 text-sm text-zinc-500">
                  <Users className="w-4 h-4 flex-shrink-0" />
                  <span className="line-clamp-1">{data.cast}</span>
                </div>
              )}
            </motion.div>
          </div>
        </div>

        {/* Description + Episodes */}
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-8">
          {/* Description */}
          {data.description && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mb-10"
            >
              <div className="relative max-w-3xl">
                <p className="text-zinc-400 leading-relaxed text-base">
                  {showFullDescription || data.description.length <= 160
                    ? data.description
                    : `${data.description.substring(0, 160)}...`}
                </p>
                {data.description.length > 160 && (
                  <button
                    onClick={() => setShowFullDescription(!showFullDescription)}
                    className="mt-2 text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors cursor-pointer"
                  >
                    {showFullDescription ? t('francetv.showLess') : t('francetv.readMore')}
                  </button>
                )}
              </div>
            </motion.div>
          )}

          {/* VIP warning */}
          {!isVip && (
            <div className="mb-6 inline-flex items-center gap-2 px-4 py-2 bg-amber-500/10 border border-amber-500/20 rounded-xl">
              <Crown className="w-4 h-4 text-amber-400" />
              <span className="text-amber-400 text-sm font-medium">{t('francetv.vipRequiredEpisodes')}</span>
            </div>
          )}

          {/* Season selector */}
          {data.seasons.length > 1 && (
            <div className="mb-6 w-56">
              <Select
                value={String(selectedSeason)}
                onValueChange={(val) => setSelectedSeason(parseInt(val))}
              >
                <SelectTrigger className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800/80 border border-zinc-700/50 rounded-xl text-white font-medium hover:bg-zinc-700/80 transition-colors cursor-pointer h-auto">
                  <SelectValue placeholder="Saison 1" />
                </SelectTrigger>
                <SelectContent>
                  {data.seasons.map((season, i) => (
                    <SelectItem
                      key={i}
                      value={String(i)}
                    >
                      {season.name} <span className="text-zinc-500 text-xs ml-1">({season.episodeCount} ép.)</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Episodes list */}
          {currentSeason && (
            <motion.div
              key={selectedSeason}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-3"
            >
              {currentSeason.episodes.map((ep, i) => (
                <motion.div
                  key={`ep-${i}`}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="group flex gap-4 p-3 rounded-xl bg-zinc-900/50 border border-zinc-800/50 
                    hover:border-zinc-700/50 hover:bg-zinc-800/50 transition-all cursor-pointer"
                  onClick={() => navigateToPlayer(ep.url_token)}
                >
                  {/* Thumbnail */}
                  <div className="relative flex-shrink-0 w-40 md:w-48 aspect-video rounded-lg overflow-hidden bg-zinc-800">
                    {ep.thumbnail ? (
                      <img
                        src={ep.thumbnail!}
                        alt={ep.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Film className="w-6 h-6 text-zinc-600" />
                      </div>
                    )}
                    {/* Play overlay */}
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-200 flex items-center justify-center">
                      <Play className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    {/* Duration */}
                    {ep.duration && (
                      <span className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/70 rounded text-[10px] text-zinc-300">
                        {ep.duration}
                      </span>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0 py-1">
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-white font-medium text-sm md:text-base group-hover:text-blue-400 transition-colors line-clamp-1">
                        {ep.title}
                      </h4>
                      {ep.csa && (
                        <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold text-white bg-zinc-700">
                          {ep.csa}
                        </span>
                      )}
                    </div>
                    {ep.description && (
                      <p className="text-zinc-500 text-xs md:text-sm mt-1 line-clamp-2">{ep.description}</p>
                    )}
                    {!isVip && (
                      <span className="inline-flex items-center gap-1 mt-2 text-amber-400 text-xs">
                        <Crown className="w-3 h-3" /> VIP
                      </span>
                    )}
                  </div>
                </motion.div>
              ))}
            </motion.div>
          )}

          {/* No episodes */}
          {data.seasons.length === 0 && (
            <div className="text-center py-16">
              <Film className="w-12 h-12 text-zinc-600 mx-auto mb-4" />
              <p className="text-zinc-400">{t('francetv.noEpisodes')}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
};

export default FranceTVInfo;
