import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { motion } from 'framer-motion';
import { SyncMode, storeRoomToken } from '../utils/watchparty';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Users, Lock, Globe, Film, Tv, Play, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WATCHPARTY_API } from '../config/runtime';
import WatchPartySyncInfoModal from '../components/WatchPartySyncInfoModal';

const MAIN_API = WATCHPARTY_API;

interface NightflixSourceInfo {
  src: string;
  quality?: string;
  language?: string;
  label?: string;
}

interface NexusSourceInfo {
  url: string;
  label: string;
  type: 'hls' | 'file';
}

interface BravoSourceInfo {
  url: string;
  label: string;
  language?: string;
  isVip?: boolean;
}

interface Mp4SourceInfo {
  url: string;
  label: string;
  language?: string;
  isVip?: boolean;
}

interface CaptionInfo {
  label: string;
  file: string;
}

interface MediaInfo {
  src: string;
  position: number;
  title: string;
  poster?: string;
  mediaType: 'movie' | 'tv';
  mediaId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  nightflixSources?: NightflixSourceInfo[];
  nexusSources?: NexusSourceInfo[];
  bravoSources?: BravoSourceInfo[];
  mp4Sources?: Mp4SourceInfo[];
  captions?: CaptionInfo[];
  currentNexusSource?: NexusSourceInfo;
  currentBravoSource?: BravoSourceInfo;
}

type DefaultSourceFamily = 'nightflix' | 'nexus' | 'bravo' | 'mp4';

interface DefaultSourceOption {
  value: string;
  label: string;
}

const buildSourceLabel = (...parts: Array<string | number | undefined>): string =>
  parts
    .filter((part): part is string | number => part !== undefined && part !== '')
    .map(String)
    .join(' • ');

const resolveBravoSources = (mediaInfo: MediaInfo): BravoSourceInfo[] => {
  if (mediaInfo.bravoSources?.length) {
    return mediaInfo.bravoSources;
  }

  return (mediaInfo.mp4Sources || [])
    .filter((source) => {
      const label = source.label?.toLowerCase() || '';
      return label.includes('bravo') || source.url === mediaInfo.currentBravoSource?.url;
    })
    .map((source) => ({
      url: source.url,
      label: source.label,
      language: source.language,
      isVip: source.isVip
    }));
};

const resolveGenericMp4Sources = (mediaInfo: MediaInfo, bravoSources: BravoSourceInfo[]): Mp4SourceInfo[] => {
  const bravoUrls = new Set(bravoSources.map((source) => source.url));
  return (mediaInfo.mp4Sources || []).filter((source) => {
    const label = source.label?.toLowerCase() || '';
    return !bravoUrls.has(source.url) && !label.includes('bravo');
  });
};

const WatchPartyCreate: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [nickname, setNickname] = useState('');
  const [maxParticipants, setMaxParticipants] = useState(10);
  const [isPublic, setIsPublic] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>('classic');
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');
  const [showSyncInfoModal, setShowSyncInfoModal] = useState(false);

  useEffect(() => {
    const storedMediaInfo = sessionStorage.getItem('watchPartyMedia');
    if (!storedMediaInfo) {
      navigate('/');
      return;
    }

    try {
      const parsedMediaInfo = JSON.parse(storedMediaInfo);
      setMediaInfo(parsedMediaInfo);
    } catch (err) {
      console.error('Error parsing media info:', err);
      navigate('/');
    }

    const savedNickname = localStorage.getItem('watchPartyNickname');
    if (savedNickname) {
      setNickname(savedNickname);
    }
  }, [navigate]);

  useEffect(() => {
    if (!mediaInfo) return;
    sessionStorage.setItem('watchPartyMedia', JSON.stringify(mediaInfo));
  }, [mediaInfo]);

  const handleDefaultSourceChange = (family: DefaultSourceFamily, value: string) => {
    setMediaInfo((previousMediaInfo) => {
      if (!previousMediaInfo) return previousMediaInfo;

      if (family === 'nightflix') {
        const selectedNightflixSource = previousMediaInfo.nightflixSources?.find((source) => source.src === value);
        if (!selectedNightflixSource) return previousMediaInfo;
        return {
          ...previousMediaInfo,
          src: selectedNightflixSource.src,
          currentNexusSource: undefined,
          currentBravoSource: undefined
        };
      }

      if (family === 'nexus') {
        const selectedNexusSource = previousMediaInfo.nexusSources?.find((source) => source.url === value);
        if (!selectedNexusSource) return previousMediaInfo;
        return {
          ...previousMediaInfo,
          src: selectedNexusSource.url,
          currentNexusSource: selectedNexusSource,
          currentBravoSource: undefined
        };
      }

      if (family === 'bravo') {
        const selectedBravoSource = resolveBravoSources(previousMediaInfo).find((source) => source.url === value);
        if (!selectedBravoSource) return previousMediaInfo;
        return {
          ...previousMediaInfo,
          src: selectedBravoSource.url,
          currentNexusSource: undefined,
          currentBravoSource: selectedBravoSource
        };
      }

      if (family === 'mp4') {
        const selectedMp4Source = resolveGenericMp4Sources(previousMediaInfo, resolveBravoSources(previousMediaInfo))
          .find((source) => source.url === value);
        if (!selectedMp4Source) return previousMediaInfo;
        return {
          ...previousMediaInfo,
          src: selectedMp4Source.url,
          currentNexusSource: undefined,
          currentBravoSource: undefined
        };
      }

      return previousMediaInfo;
    });
  };

  const handleCreateParty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim() || !mediaInfo) return;

    setIsCreating(true);
    setError('');

    try {
      localStorage.setItem('watchPartyNickname', nickname);

      // Le code de room est généré côté serveur (CSPRNG) : en fournir un depuis
      // le client permettait de squatter un code.
      const response = await axios.post(`${MAIN_API}/api/watchparty/create`, {
        nickname,
        maxParticipants,
        media: mediaInfo,
        isPublic,
        syncMode
      });

      if (response.data.success) {
        // Le hostToken lie l'hôte à la room : sans lui, impossible de reprendre
        // la main dessus après un rafraîchissement.
        storeRoomToken(response.data.roomId, response.data.hostToken);
        navigate(`/watchparty/room/${response.data.roomId}`, {
          state: {
            isHost: true,
            nickname,
            roomCode: response.data.roomCode,
            token: response.data.hostToken
          }
        });
      } else {
        setError(response.data.message || 'Failed to create watch party');
      }
    } catch (err) {
      console.error('Error creating watch party:', err);
      setError('An error occurred while creating watch party');
    } finally {
      setIsCreating(false);
    }
  };

  if (!mediaInfo) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-white">
        <div className="animate-pulse">{t('watchParty.loadingInfo')}</div>
      </div>
    );
  }

  const bravoSources = resolveBravoSources(mediaInfo);
  const mp4Sources = resolveGenericMp4Sources(mediaInfo, bravoSources);
  const activeSourceFamily: DefaultSourceFamily | null =
    (mediaInfo.currentBravoSource?.url || bravoSources.some((source) => source.url === mediaInfo.src)) ? 'bravo' :
      (mediaInfo.currentNexusSource?.url || mediaInfo.nexusSources?.some((source) => source.url === mediaInfo.src)) ? 'nexus' :
        mediaInfo.nightflixSources?.some((source) => source.src === mediaInfo.src) ? 'nightflix' :
            mp4Sources.some((source) => source.url === mediaInfo.src) ? 'mp4' :
              null;

  const sourceGroups: Array<{
    id: DefaultSourceFamily;
    label: string;
    options: DefaultSourceOption[];
    selectedValue: string;
  }> = [
      {
        id: 'nightflix',
        label: 'Nightflix',
        options: (mediaInfo.nightflixSources || []).map((source, index) => ({
          value: source.src,
          label: source.label || buildSourceLabel('Nightflix', source.language, source.quality) || `Nightflix ${index + 1}`
        })),
        selectedValue: mediaInfo.nightflixSources?.find((source) => source.src === mediaInfo.src)?.src || mediaInfo.nightflixSources?.[0]?.src || ''
      },
      {
        id: 'nexus',
        label: 'Nexus',
        options: (mediaInfo.nexusSources || []).map((source, index) => ({
          value: source.url,
          label: buildSourceLabel(source.label, source.type === 'file' ? 'Fichier' : 'HLS') || `Nexus ${index + 1}`
        })),
        selectedValue: mediaInfo.currentNexusSource?.url || mediaInfo.nexusSources?.find((source) => source.url === mediaInfo.src)?.url || mediaInfo.nexusSources?.[0]?.url || ''
      },
      {
        id: 'bravo',
        label: 'Bravo',
        options: bravoSources.map((source, index) => ({
          value: source.url,
          label: source.label || buildSourceLabel('Bravo', source.language, source.isVip ? 'VIP' : undefined) || `Bravo ${index + 1}`
        })),
        selectedValue: mediaInfo.currentBravoSource?.url || bravoSources.find((source) => source.url === mediaInfo.src)?.url || bravoSources[0]?.url || ''
      },
      {
        id: 'mp4',
        label: 'MP4 / Fichier',
        options: mp4Sources.map((source, index) => ({
          value: source.url,
          label: source.label || buildSourceLabel('MP4', source.language, source.isVip ? 'VIP' : undefined) || `MP4 ${index + 1}`
        })),
        selectedValue: mp4Sources.find((source) => source.url === mediaInfo.src)?.url || mp4Sources[0]?.url || ''
      }
    ].filter((group) => group.options.length > 0);

  const activeSourceGroup = sourceGroups.find((group) => group.id === activeSourceFamily) || sourceGroups[0];
  const activeSourceLabel = activeSourceGroup?.options.find((option) => option.value === activeSourceGroup.selectedValue)?.label
    || activeSourceGroup?.options[0]?.label
    || mediaInfo.src;

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Background gradient */}
      <div className="fixed inset-0 h-52 z-0 bg-gradient-to-t from-transparent to-black/50 pointer-events-none" />

      {/* Back link removed */}

      <div className="container px-4 py-20 mx-auto max-w-4xl relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white/5 border border-white/10 rounded-xl overflow-hidden backdrop-blur-sm"
        >
          <div className="p-6 md:p-8">
            <h1 className="text-2xl md:text-3xl font-bold mb-8 text-center flex items-center justify-center gap-3">
              <Users className="h-8 w-8 text-red-500" />
              {t('watchParty.create')}
            </h1>

            <div className="flex flex-col md:flex-row gap-8 mb-8">
              <div className="md:w-1/3 shrink-0">
                {mediaInfo.poster ? (
                  <img
                    src={mediaInfo.poster.startsWith('http')
                      ? mediaInfo.poster
                      : `https://image.tmdb.org/t/p/w500${mediaInfo.poster}`
                    }
                    alt={mediaInfo.title}
                    className="w-full h-auto rounded-lg shadow-2xl border border-white/10"
                  />
                ) : (
                  <div className="w-full h-64 bg-white/10 rounded-lg flex items-center justify-center border border-white/10">
                    <span className="text-white/50">{t('watchParty.noPoster')}</span>
                  </div>
                )}
              </div>

              <div className="md:w-2/3 space-y-6">
                <div>
                  <h2 className="text-2xl font-bold text-white mb-2">{mediaInfo.title}</h2>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-white/60">
                    <Badge variant="default" className="border border-white/20 text-white/80 bg-white/5 hover:bg-white/10">
                      {mediaInfo.mediaType === 'movie' ? (
                        <><Film className="h-3 w-3 mr-1.5" /> {t('watchParty.movieLabel')}</>
                      ) : (
                        <><Tv className="h-3 w-3 mr-1.5" /> {t('watchParty.seriesLabel')}</>
                      )}
                    </Badge>

                    {mediaInfo.mediaType === 'tv' && (
                      <Badge variant="default" className="border border-white/20 text-white/80 bg-white/5 hover:bg-white/10">
                        S{mediaInfo.seasonNumber || 1} E{mediaInfo.episodeNumber || 1}
                      </Badge>
                    )}

                    <span className="text-white/40">•</span>
                    <span>{t('watchParty.startAtLabel')}: {Math.floor(mediaInfo.position / 60)}:{String(Math.floor(mediaInfo.position % 60)).padStart(2, '0')}</span>
                  </div>
                </div>

                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex gap-3 items-start">
                  <Info className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-red-200/80 text-sm">
                    {t('watchParty.syncInfo')}
                  </p>
                </div>

                <form onSubmit={handleCreateParty} className="space-y-6">
                  <div>
                    <label htmlFor="nickname" className="block text-sm font-medium mb-2 text-white/80">
                      {t('watchParty.yourNickname')}
                    </label>
                    <input
                      type="text"
                      id="nickname"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 text-white placeholder-white/30 transition-all font-medium"
                      placeholder={t('watchParty.nicknamePlaceholder')}
                      maxLength={32}
                      required
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label htmlFor="maxParticipants" className="block text-sm font-medium mb-2 text-white/80">
                        {t('watchParty.maxParticipants')}
                      </label>
                      <div className="flex items-center">
                        <button
                          type="button"
                          onClick={() => setMaxParticipants(Math.max(2, maxParticipants - 1))}
                          className="w-10 h-10 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-l-lg border border-white/10 transition-colors"
                        >
                          -
                        </button>
                        <input
                          type="number"
                          id="maxParticipants"
                          value={maxParticipants}
                          onChange={(e) => setMaxParticipants(Math.max(2, Math.min(50, parseInt(e.target.value) || 10)))}
                          className="w-16 h-10 bg-white/5 border-y border-white/10 text-center focus:outline-none text-white appearance-none m-0 font-medium"
                          min="2"
                          max="50"
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setMaxParticipants(Math.min(50, maxParticipants + 1))}
                          className="w-10 h-10 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-r-lg border border-white/10 transition-colors"
                        >
                          +
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-2 text-white/80">
                        {t('watchParty.visibility')}
                      </label>
                      <div className="flex bg-white/5 p-1 rounded-lg border border-white/10">
                        <button
                          type="button"
                          onClick={() => setIsPublic(false)}
                          className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm font-medium transition-colors ${!isPublic
                            ? 'bg-red-600 text-white shadow-lg shadow-red-500/20'
                            : 'text-white/50 hover:text-white hover:bg-white/5'
                            }`}
                        >
                          <Lock className="h-3 w-3" /> {t('watchParty.private')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsPublic(true)}
                          className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md text-sm font-medium transition-colors ${isPublic
                            ? 'bg-red-600 text-white shadow-lg shadow-red-500/20'
                            : 'text-white/50 hover:text-white hover:bg-white/5'
                            }`}
                        >
                          <Globe className="h-3 w-3" /> {t('watchParty.public')}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-white">{t('watchParty.syncModeLabel')}</p>
                        <p className="text-xs text-white/45">{t('watchParty.syncModeDesc')}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowSyncInfoModal(true)}
                        className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 transition-colors hover:bg-white/10 hover:text-white"
                      >
                        <Info className="h-3.5 w-3.5" />
                        {t('watchParty.helpLabel')}
                      </button>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => setSyncMode('classic')}
                        className={`rounded-xl border p-4 text-left transition-all ${syncMode === 'classic'
                          ? 'border-red-500/40 bg-red-500/10 shadow-lg shadow-red-500/10'
                          : 'border-white/10 bg-white/[0.03] hover:bg-white/10'
                          }`}
                      >
                        <p className="mb-1 text-sm font-semibold text-white">{t('watchParty.syncModeClassic')}</p>
                        <p className="text-xs leading-5 text-white/60">{t('watchParty.syncModeClassicDesc')}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => setSyncMode('pro')}
                        className={`rounded-xl border p-4 text-left transition-all ${syncMode === 'pro'
                          ? 'border-red-500/40 bg-red-500/10 shadow-lg shadow-red-500/10'
                          : 'border-white/10 bg-white/[0.03] hover:bg-white/10'
                          }`}
                      >
                        <p className="mb-1 text-sm font-semibold text-white">{t('watchParty.syncModePro')}</p>
                        <p className="text-xs leading-5 text-white/60">{t('watchParty.syncModeProDesc')}</p>
                      </button>
                    </div>
                  </div>

                  {sourceGroups.length > 0 && (
                    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                      <div className="mb-4">
                        <p className="text-sm font-medium text-white">{t('watchParty.defaultSourceLabel')}</p>
                        <p className="mt-1 text-xs text-white/45">{t('watchParty.defaultSourceDesc')}</p>
                      </div>

                      <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3">
                        <p className="text-[11px] uppercase tracking-wider text-white/40">{t('watchParty.defaultSourceCurrent')}</p>
                        <div className="mt-2 flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-white">{activeSourceLabel}</p>
                            <p className="mt-1 text-xs text-white/55">{activeSourceGroup?.label || mediaInfo.title}</p>
                          </div>
                          <Badge variant="default" className="border border-red-500/30 bg-red-500/15 text-red-200 hover:bg-red-500/20">
                            {t('watchParty.defaultSourceActive')}
                          </Badge>
                        </div>
                      </div>

                      <div className="grid gap-3">
                        {sourceGroups.map((group) => (
                          <div
                            key={group.id}
                            className={`rounded-xl border p-4 transition-all ${activeSourceGroup?.id === group.id
                              ? 'border-red-500/30 bg-red-500/8'
                              : 'border-white/10 bg-white/[0.03]'
                              }`}
                          >
                            <div className="mb-3 flex items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-white">{group.label}</p>
                                <p className="mt-1 text-xs text-white/45">{t('watchParty.optionCount', { count: group.options.length })}</p>
                              </div>
                              {activeSourceGroup?.id === group.id && (
                                <Badge variant="default" className="border border-white/15 bg-white/10 text-white/80 hover:bg-white/15">
                                  {t('watchParty.defaultSourceActive')}
                                </Badge>
                              )}
                            </div>

                            <label className="mb-2 block text-xs font-medium text-white/60">
                              {t('watchParty.defaultSourceChoose')}
                            </label>
                            <Select
                              value={group.selectedValue}
                              onValueChange={(value) => handleDefaultSourceChange(group.id, value)}
                            >
                              <SelectTrigger className="h-auto min-h-12 rounded-lg border-white/10 bg-white/5 px-3 py-3 text-sm text-white hover:bg-white/10 focus:ring-red-500/30">
                                <SelectValue
                                  placeholder={
                                    group.options.find((option) => option.value === group.selectedValue)?.label
                                    || group.options[0]?.label
                                  }
                                />
                              </SelectTrigger>
                              <SelectContent className="max-h-72">
                                {group.options.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-white/40">
                    {isPublic
                      ? t('watchParty.publicVisibilityDesc')
                      : t('watchParty.privateVisibilityDesc')}
                  </p>

                  {error && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-center">
                      <p className="text-red-400 text-sm">{error}</p>
                    </div>
                  )}

                  <Button
                    type="submit"
                    disabled={isCreating || !nickname.trim()}
                    className="w-full h-12 text-base bg-red-600 hover:bg-red-700 text-white border-0 transition-all shadow-lg hover:shadow-red-600/20 hover:scale-[1.02]"
                  >
                    {isCreating ? (
                      <>{t('watchParty.creating')}</>
                    ) : (
                      <><Play className="h-4 w-4 mr-2" /> {t('watchParty.create')}</>
                    )}
                  </Button>
                </form>
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      <WatchPartySyncInfoModal
        isOpen={showSyncInfoModal}
        onClose={() => setShowSyncInfoModal(false)}
      />
    </div>
  );
};

export default WatchPartyCreate;
