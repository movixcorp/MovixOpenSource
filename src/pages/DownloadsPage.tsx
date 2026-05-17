import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import {
  ArrowLeft,
  Smartphone,
  Pause,
  Play,
  PlayCircle,
  Trash2,
  XCircle,
  Loader,
  CheckCircle2,
  AlertCircle,
  Film,
  Tv,
  Sparkles,
  Folder,
} from 'lucide-react';
import { toast } from 'sonner';

import { SquareBackground } from '../components/ui/square-background';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import {
  getMovixBridge,
  isMovixApp,
  type MovixDownloadEntry,
  type MovixDownloadStatus,
  type MovixDownloadType,
} from '../utils/appBridge';

interface ProgressTick {
  bytesDownloaded: number;
  bytesTotal: number;
  speedBytesPerSec: number;
}

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatSpeed = (bytesPerSec: number): string => {
  if (!bytesPerSec || bytesPerSec <= 0) return '—';
  return `${formatBytes(bytesPerSec)}/s`;
};

const formatEta = (seconds: number): string => {
  if (!isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
};

const statusColor = (status: MovixDownloadStatus): string => {
  switch (status) {
    case 'running': return 'text-indigo-300';
    case 'queued': return 'text-white/60';
    case 'paused': return 'text-amber-300';
    case 'done': return 'text-green-400';
    case 'failed': return 'text-red-400';
    case 'cancelled': return 'text-white/40';
  }
};

const DownloadCard: React.FC<{
  entry: MovixDownloadEntry;
  tick: ProgressTick | null;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onLaunch: (id: string) => void;
}> = ({ entry, tick, onPause, onResume, onCancel, onDelete, onLaunch }) => {
  const { t } = useTranslation();
  const [pendingDelete, setPendingDelete] = useState(false);

  const downloaded = tick?.bytesDownloaded ?? entry.downloadedBytes;
  const total = tick?.bytesTotal && tick.bytesTotal > 0 ? tick.bytesTotal : entry.totalBytes;
  const speed = tick?.speedBytesPerSec ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  const remaining = total > 0 ? total - downloaded : 0;
  const etaSec = speed > 0 && remaining > 0 ? remaining / speed : 0;

  const isRunning = entry.status === 'running';
  const isPaused = entry.status === 'paused';
  const isQueued = entry.status === 'queued';
  const isDone = entry.status === 'done';

  return (
    <div className="p-4 bg-white/5 rounded-xl border border-white/5 hover:border-white/10 transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-sm font-medium text-white truncate">
              {entry.metadata?.episodeTitle || entry.filename}
            </p>
            {!isDone && (
              <span className={`text-[10px] uppercase tracking-wider ${statusColor(entry.status)}`}>
                {t(`downloads.status.${entry.status}`)}
              </span>
            )}
          </div>
          {entry.metadata?.title && entry.metadata.title !== entry.filename && (
            <p className="text-xs text-white/40 truncate">{entry.metadata.title}</p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {isDone && (
            <button
              onClick={() => onLaunch(entry.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/15 hover:bg-green-500/25 text-green-400 rounded-lg text-xs font-medium transition-colors"
              title={t('downloads.actions.launch')}
            >
              <PlayCircle className="w-3.5 h-3.5" />
              {t('downloads.actions.launch')}
            </button>
          )}
          {isRunning && (
            <button onClick={() => onPause(entry.id)} className="p-1.5 text-amber-300 hover:bg-amber-300/10 rounded-lg" title={t('downloads.actions.pause')}>
              <Pause className="w-4 h-4" />
            </button>
          )}
          {(isPaused || entry.status === 'failed') && (
            <button onClick={() => onResume(entry.id)} className="p-1.5 text-indigo-300 hover:bg-indigo-300/10 rounded-lg" title={t('downloads.actions.resume')}>
              <Play className="w-4 h-4" />
            </button>
          )}
          {(isRunning || isPaused || isQueued) && (
            <button onClick={() => onCancel(entry.id)} className="p-1.5 text-white/60 hover:bg-white/10 rounded-lg" title={t('downloads.actions.cancel')}>
              <XCircle className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => setPendingDelete(true)}
            className="p-1.5 text-red-400 hover:bg-red-400/10 rounded-lg"
            title={t('downloads.actions.delete')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!isDone && (
        <>
          <div className="mt-3 h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                entry.status === 'failed'
                  ? 'bg-red-500'
                  : entry.status === 'paused'
                    ? 'bg-amber-500'
                    : 'bg-indigo-500'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/40">
            <span>{formatBytes(downloaded)} / {total > 0 ? formatBytes(total) : '?'}</span>
            <span>{pct}%</span>
            {isRunning && (
              <>
                <span>{formatSpeed(speed)}</span>
                {etaSec > 0 && <span>{t('downloads.etaPrefix')} {formatEta(etaSec)}</span>}
              </>
            )}
            {entry.status === 'failed' && entry.errorMessage && (
              <span className="text-red-300">{entry.errorMessage}</span>
            )}
          </div>
        </>
      )}

      {pendingDelete && (
        <div className="mt-3 flex items-center justify-between gap-2 p-2.5 bg-red-900/20 border border-red-500/20 rounded-lg">
          <p className="text-xs text-red-300">{t('downloads.deleteConfirmTitle')}</p>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={() => setPendingDelete(false)}
              className="px-2.5 py-1 text-xs text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded-md transition-colors"
            >
              {t('downloads.deleteConfirmCancel')}
            </button>
            <button
              onClick={() => { setPendingDelete(false); onDelete(entry.id); }}
              className="px-2.5 py-1 text-xs text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 rounded-md transition-colors font-medium"
            >
              {t('downloads.deleteConfirmOk')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const TypeIcon: React.FC<{ type: MovixDownloadType | 'misc' }> = ({ type }) => {
  if (type === 'movie') return <Film className="w-5 h-5 text-indigo-400" />;
  if (type === 'series') return <Tv className="w-5 h-5 text-emerald-400" />;
  if (type === 'animes') return <Sparkles className="w-5 h-5 text-pink-400" />;
  return <Folder className="w-5 h-5 text-white/40" />;
};

const DownloadsPage: React.FC = () => {
  const { t } = useTranslation();
  const inApp = isMovixApp();
  const [entries, setEntries] = useState<MovixDownloadEntry[]>([]);
  const [ticks, setTicks] = useState<Record<string, ProgressTick>>({});
  const [loading, setLoading] = useState(true);
  const fetchedOnce = useRef(false);

  const refresh = useCallback(async () => {
    const bridge = getMovixBridge();
    if (!bridge) {
      setLoading(false);
      return;
    }
    try {
      const list = await bridge.download.list();
      setEntries(list ?? []);
    } catch (err) {
      console.warn('[downloads] list failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fetchedOnce.current) return;
    fetchedOnce.current = true;
    refresh();
  }, [refresh]);

  useEffect(() => {
    const bridge = getMovixBridge();
    if (!bridge) return;
    const unsub = bridge.download.subscribe((evt) => {
      if (evt.event === 'progress') {
        setTicks((prev) => ({ ...prev, [evt.payload.id]: evt.payload }));
      } else if (evt.event === 'state') {
        setEntries((prev) => {
          const idx = prev.findIndex((e) => e.id === evt.payload.id);
          if (idx === -1) return [evt.payload, ...prev];
          const next = prev.slice();
          next[idx] = evt.payload;
          return next;
        });
      }
    });
    return unsub;
  }, []);

  const handlePause = useCallback(async (id: string) => {
    const b = getMovixBridge(); if (!b) return;
    try { await b.download.pause(id); } catch (e) { toast.error((e as Error).message); }
  }, []);
  const handleResume = useCallback(async (id: string) => {
    const b = getMovixBridge(); if (!b) return;
    try { await b.download.resume(id); } catch (e) { toast.error((e as Error).message); }
  }, []);
  const handleCancel = useCallback(async (id: string) => {
    const b = getMovixBridge(); if (!b) return;
    try { await b.download.cancel(id); } catch (e) { toast.error((e as Error).message); }
  }, []);
  const handleDelete = useCallback(async (id: string) => {
    const b = getMovixBridge(); if (!b) return;
    try {
      await b.download.delete(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setTicks((prev) => { const n = { ...prev }; delete n[id]; return n; });
    } catch (e) { toast.error((e as Error).message); }
  }, []);
  const handleLaunch = useCallback(async (id: string) => {
    const b = getMovixBridge(); if (!b) return;
    try { await b.download.launch(id); } catch (e) { toast.error((e as Error).message); }
  }, []);

  const grouped = useMemo(() => {
    const groups: Record<'movie' | 'series' | 'animes' | 'misc', MovixDownloadEntry[]> = {
      movie: [],
      series: [],
      animes: [],
      misc: [],
    };
    entries.forEach((e) => {
      const k = (e.metadata?.type ?? 'misc') as keyof typeof groups;
      (groups[k] ?? groups.misc).push(e);
    });
    return groups;
  }, [entries]);

  const activeCount = entries.filter((e) => e.status === 'running' || e.status === 'queued' || e.status === 'paused').length;

  if (!inApp) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(99, 102, 241, 0.10)" className="min-h-screen bg-black text-white">
        <div className="container mx-auto px-6 py-12 relative z-10">
          <Link to="/" className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8">
            <ArrowLeft className="w-5 h-5 mr-2" />
            {t('downloads.backToHome')}
          </Link>
          <div className="max-w-lg mx-auto">
            <AnimatedBorderCard highlightColor="99 102 241" backgroundColor="12 12 12" className="p-8 text-center">
              <Smartphone className="w-12 h-12 text-indigo-400 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-white mb-2">{t('downloads.appOnlyTitle')}</h2>
              <p className="text-white/60 text-sm">{t('downloads.appOnlyDesc')}</p>
            </AnimatedBorderCard>
          </div>
        </div>
      </SquareBackground>
    );
  }

  const renderGroup = (kind: 'movie' | 'series' | 'animes' | 'misc', items: MovixDownloadEntry[]) => {
    if (items.length === 0) return null;

    // Series + animes : grouper par titre puis par saison.
    if (kind === 'series' || kind === 'animes') {
      const byTitle: Record<string, MovixDownloadEntry[]> = {};
      items.forEach((e) => {
        const k = String(e.metadata?.tmdbId ?? e.metadata?.title ?? 'unknown');
        (byTitle[k] ??= []).push(e);
      });
      return (
        <motion.div
          key={kind}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <div className="flex items-center gap-2 px-1">
            <TypeIcon type={kind} />
            <h2 className="text-base font-semibold text-white">{t(`downloads.group.${kind}`)}</h2>
            <span className="text-xs text-white/30 bg-white/5 px-2 py-0.5 rounded-full">{items.length}</span>
          </div>
          {Object.entries(byTitle).map(([titleKey, group]) => {
            const repr = group[0];
            const bySeason: Record<string, MovixDownloadEntry[]> = {};
            group.forEach((e) => {
              const s = e.metadata?.season != null ? String(e.metadata.season) : '?';
              (bySeason[s] ??= []).push(e);
            });
            const seasonKeys = Object.keys(bySeason).sort((a, b) => {
              const an = Number(a); const bn = Number(b);
              if (Number.isNaN(an)) return 1;
              if (Number.isNaN(bn)) return -1;
              return an - bn;
            });
            return (
              <AnimatedBorderCard key={titleKey} highlightColor={kind === 'animes' ? '236 72 153' : '16 185 129'} backgroundColor="12 12 12" className="p-4 space-y-3">
                <div className="flex items-center gap-3">
                  {repr.metadata?.poster && (
                    <img
                      src={`https://image.tmdb.org/t/p/w92${repr.metadata.poster}`}
                      alt=""
                      className="w-10 h-14 object-cover rounded"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <div>
                    <p className="text-white font-medium">{repr.metadata?.title || t('downloads.unknownTitle')}</p>
                    <p className="text-xs text-white/40">{group.length} {t('downloads.fileCountSuffix')}</p>
                  </div>
                </div>
                {seasonKeys.map((s) => (
                  <div key={s} className="space-y-2">
                    <p className="text-xs uppercase tracking-wider text-white/40 pl-1">
                      {s === '?' ? t('downloads.unknownSeason') : t('downloads.seasonLabel', { n: s })}
                    </p>
                    <div className="space-y-2">
                      {bySeason[s]
                        .sort((a, b) => (Number(a.metadata?.episode ?? 0) - Number(b.metadata?.episode ?? 0)))
                        .map((entry) => (
                          <DownloadCard
                            key={entry.id}
                            entry={entry}
                            tick={ticks[entry.id] ?? null}
                            onPause={handlePause}
                            onResume={handleResume}
                            onCancel={handleCancel}
                            onDelete={handleDelete}
                            onLaunch={handleLaunch}
                          />
                        ))}
                    </div>
                  </div>
                ))}
              </AnimatedBorderCard>
            );
          })}
        </motion.div>
      );
    }

    // Movies + misc : plat.
    return (
      <motion.div
        key={kind}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-3"
      >
        <div className="flex items-center gap-2 px-1">
          <TypeIcon type={kind} />
          <h2 className="text-base font-semibold text-white">{t(`downloads.group.${kind}`)}</h2>
          <span className="text-xs text-white/30 bg-white/5 px-2 py-0.5 rounded-full">{items.length}</span>
        </div>
        <div className="space-y-2">
          {items
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((entry) => (
              <DownloadCard
                key={entry.id}
                entry={entry}
                tick={ticks[entry.id] ?? null}
                onPause={handlePause}
                onResume={handleResume}
                onCancel={handleCancel}
                onDelete={handleDelete}
                onLaunch={handleLaunch}
              />
            ))}
        </div>
      </motion.div>
    );
  };

  return (
    <SquareBackground squareSize={48} borderColor="rgba(99, 102, 241, 0.10)" className="min-h-screen bg-black text-white">
      <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 relative z-10">
        <Link to="/" className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-5 h-5 mr-2" />
          {t('downloads.backToHome')}
        </Link>

        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white">{t('downloads.title')}</h1>
              <p className="text-sm text-white/40 mt-1">{t('downloads.subtitle')}</p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-wider text-white/40">{t('downloads.activeLabel')}</p>
              <p className="text-2xl font-bold text-indigo-300">{activeCount}</p>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20 text-white/40">
              <Loader className="w-5 h-5 animate-spin mr-2" /> {t('downloads.loading')}
            </div>
          ) : entries.length === 0 ? (
            <AnimatedBorderCard highlightColor="99 102 241" backgroundColor="12 12 12" className="p-10 text-center">
              <CheckCircle2 className="w-10 h-10 text-white/20 mx-auto mb-3" />
              <p className="text-white/60">{t('downloads.empty')}</p>
              <p className="text-xs text-white/30 mt-1">{t('downloads.emptyHint')}</p>
            </AnimatedBorderCard>
          ) : (
            <AnimatePresence mode="popLayout">
              <div className="space-y-6">
                {renderGroup('movie', grouped.movie)}
                {renderGroup('series', grouped.series)}
                {renderGroup('animes', grouped.animes)}
                {renderGroup('misc', grouped.misc)}
              </div>
            </AnimatePresence>
          )}

          {entries.some((e) => e.status === 'failed') && (
            <div className="mt-6 p-3 bg-red-900/10 border border-red-500/20 rounded-xl flex items-center gap-2 text-xs text-red-300/70">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {t('downloads.failedHint')}
            </div>
          )}
        </div>
      </div>
    </SquareBackground>
  );
};

export default DownloadsPage;
