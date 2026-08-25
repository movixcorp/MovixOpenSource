import React, { useEffect, useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSearchParams } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { ArrowLeft, Crown, Download, Copy, Check, AlertCircle, Loader, Link as LinkIcon, Info, Clock, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

// Unlock icon custom sans la boule à la jonction barre/corps
const CleanUnlock: React.FC<{ className?: string; size?: number }> = ({ className, size = 24 }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" stroke="none" fill="currentColor" fillOpacity="0.15" />
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" fill="none" />
    <path d="M7 11V7a5 5 0 0 1 9.9-1" fill="none" />
  </svg>
);
import { useTranslation } from 'react-i18next';
import { SquareBackground } from '../components/ui/square-background';
import ShinyText from '../components/ui/shiny-text';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import { Button } from '../components/ui/button';
import { BESTDEBRID_API_BASE, MAIN_API } from '../config/runtime';
import { getVipHeaders } from '../utils/vipUtils';

// Hébergeurs non supportés
const unsupportedHosts = [
  'Ddl', 'Dropgalaxy', 'Fileal', 'Filedot', 'Filespace',
  'Gigapeta', 'Isra', 'Katfile', 'Worldbytez',
];

// Hébergeurs supportés pour l'animation glitch
const supportedHosts = [
  '1fichier', 'Uptobox', 'Rapidgator', 'Turbobit', 'Nitroflare',
  'Uploaded', 'Mega', 'Mediafire', 'Doodstream', 'Streamtape',
];

const glitchChars = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`ABCDEFabcdef0123456789';

const GlitchHostText: React.FC = () => {
  const [displayText, setDisplayText] = useState(supportedHosts[0]);
  const [isGlitching, setIsGlitching] = useState(false);
  const indexRef = useRef(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsGlitching(true);
      const nextIndex = (indexRef.current + 1) % supportedHosts.length;
      const current = supportedHosts[indexRef.current];
      const target = supportedHosts[nextIndex];
      const maxLen = Math.max(current.length, target.length);
      let step = 0;
      const totalSteps = maxLen + 4;

      const glitchInterval = setInterval(() => {
        step++;
        const resolved = Math.max(0, step - 4);
        let text = '';
        for (let i = 0; i < target.length; i++) {
          if (i < resolved) {
            text += target[i];
          } else {
            text += glitchChars[Math.floor(Math.random() * glitchChars.length)];
          }
        }
        setDisplayText(text);

        if (step >= totalSteps) {
          clearInterval(glitchInterval);
          setDisplayText(target);
          setIsGlitching(false);
          indexRef.current = nextIndex;
        }
      }, 40);
    }, 2500);

    return () => clearInterval(interval);
  }, []);

  return (
    <span className={`inline-block font-mono text-yellow-400 transition-all ${isGlitching ? 'opacity-90' : 'opacity-100'}`}>
      {displayText}
    </span>
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getStringValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const getNumberValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const parseHumanReadableSize = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return 0;
  }

  const normalized = value.trim().replace(',', '.');
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([KMGTP]?i?B)$/i);
  if (!match) {
    return 0;
  }

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) {
    return 0;
  }

  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
    PB: 1000 ** 5,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    PIB: 1024 ** 5,
  };

  return Math.round(amount * (multipliers[unit] || 0));
};

const getHostnameFromUrl = (value: string): string => {
  try {
    return new URL(value).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
};

const getFilenameFromUrl = (value: string): string => {
  try {
    const pathname = new URL(value).pathname;
    const lastSegment = pathname.split('/').filter(Boolean).pop();
    return lastSegment ? decodeURIComponent(lastSegment) : '';
  } catch {
    return '';
  }
};

const extractDebridErrorMessage = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;

  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }

  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  if (isRecord(payload.error) && typeof payload.error.message === 'string' && payload.error.message.trim()) {
    return payload.error.message.trim();
  }

  return null;
};

const getBestDebridCandidate = (payload: unknown): Record<string, unknown> | null => {
  if (Array.isArray(payload)) {
    return payload.find(isRecord) ?? null;
  }

  if (!isRecord(payload)) {
    return null;
  }

  if (Array.isArray(payload.data)) {
    return payload.data.find(isRecord) ?? null;
  }

  if (isRecord(payload.data)) {
    return payload.data;
  }

  return payload;
};

interface DebridResult {
  link: string;
  filename: string;
  filesize: number;
  host: string;
  provider: DebridProvider;
}

type DebridProvider = 'deepbrid' | 'realdebrid' | 'bestdebrid' | 'debridr';

interface DebridHistoryItem {
  originalLink: string;
  debridedLink: string;
  filename: string;
  filesize: number;
  host: string;
  timestamp: number;
  provider: DebridProvider;
}

const HISTORY_KEY = 'debrid_history';
const MAX_HISTORY = 50;
const DEFAULT_PROVIDER: DebridProvider = 'deepbrid';

const isDebridProvider = (value: string | null | undefined): value is DebridProvider =>
  value === 'deepbrid' || value === 'realdebrid' || value === 'bestdebrid' || value === 'debridr';

const normalizeDebridedLink = (link: string, provider: DebridProvider): string => {
  const trimmed = link.trim();
  if (!trimmed || provider !== 'realdebrid') {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    parsed.protocol = 'https:';
    return parsed.toString();
  } catch {
    return trimmed.replace(/^http:\/\//i, 'https://');
  }
};

const getHistory = (): DebridHistoryItem[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is Omit<DebridHistoryItem, 'provider'> & { provider?: DebridProvider } => (
        !!item &&
        typeof item.originalLink === 'string' &&
        typeof item.debridedLink === 'string' &&
        typeof item.filename === 'string' &&
        typeof item.filesize === 'number' &&
        typeof item.host === 'string' &&
        typeof item.timestamp === 'number'
      ))
      .map((item) => {
        const provider = isDebridProvider(item.provider) ? item.provider : DEFAULT_PROVIDER;

        return {
          ...item,
          provider,
          debridedLink: normalizeDebridedLink(item.debridedLink, provider),
        };
      });
  } catch {
    return [];
  }
};

const saveHistory = (items: DebridHistoryItem[]) => {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)));
};

const DebridPage: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [url, setUrl] = useState('');
  const [provider, setProvider] = useState<DebridProvider>(DEFAULT_PROVIDER);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<DebridResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<DebridHistoryItem[]>(getHistory);
  const [showHistory, setShowHistory] = useState(true);
  const isVip = localStorage.getItem('is_vip') === 'true';
  const hasAutoDebrided = useRef(false);

  const providerOptions: DebridProvider[] = ['deepbrid', 'realdebrid', 'bestdebrid', 'debridr'];
  const isSubmitDisabled = isLoading || !url.trim();

  const fetchBestDebridApiKey = useCallback(async (): Promise<string> => {
    let payload: unknown = null;
    let response: Response;

    try {
      response = await fetch(`${MAIN_API}/api/debrid/bestdebrid-key`, {
        method: 'GET',
        headers: getVipHeaders(),
        cache: 'no-store',
      });
    } catch {
      throw new Error(t('debrid.bestdebridConfigRequestFailed'));
    }

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new Error(extractDebridErrorMessage(payload) || t('debrid.bestdebridConfigRequestFailed'));
    }

    if (!isRecord(payload) || payload.success !== true || typeof payload.apiKey !== 'string' || !payload.apiKey.trim()) {
      throw new Error(t('debrid.bestdebridMissingKey'));
    }

    return payload.apiKey.trim();
  }, [t]);

  const unlockWithBestDebrid = useCallback(async (targetUrl: string): Promise<DebridResult> => {
    const apiKey = await fetchBestDebridApiKey();

    const endpoint = new URL(`${BESTDEBRID_API_BASE}/generateLink`);
    endpoint.searchParams.set('auth', apiKey);
    endpoint.searchParams.set('link', targetUrl);

    let payload: unknown = null;
    let response: Response;

    try {
      response = await fetch(endpoint.toString(), {
        method: 'GET',
        cache: 'no-store',
      });
    } catch {
      throw new Error(t('debrid.bestdebridRequestFailed'));
    }

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new Error(extractDebridErrorMessage(payload) || t('debrid.bestdebridRequestFailed'));
    }

    const candidate = getBestDebridCandidate(payload);
    if (!candidate) {
      throw new Error(t('debrid.bestdebridInvalidResponse'));
    }

    const originalLink = getStringValue(candidate.original_link);
    const sourceLink = getStringValue(candidate.link);
    const directLink = (
      sourceLink &&
      sourceLink !== targetUrl &&
      (!originalLink || sourceLink !== originalLink)
    )
      ? sourceLink
      : getStringValue(candidate.download) || getStringValue(candidate.streammp4);

    if (!directLink) {
      throw new Error(t('debrid.bestdebridInvalidResponse'));
    }

    return {
      link: directLink,
      filename: getStringValue(candidate.filename) || getFilenameFromUrl(directLink) || getFilenameFromUrl(targetUrl) || 'download.bin',
      filesize: getNumberValue(candidate.filesize) || parseHumanReadableSize(candidate.size),
      host: getStringValue(candidate.hoster) || getStringValue(candidate.host) || getHostnameFromUrl(targetUrl) || getHostnameFromUrl(directLink),
      provider: 'bestdebrid',
    };
  }, [fetchBestDebridApiKey, t]);

  const handleDebrid = useCallback(async (linkToDebrid?: string, providerOverride?: DebridProvider) => {
    const targetUrl = (linkToDebrid || url).trim();
    const activeProvider = providerOverride || provider;
    if (!targetUrl) return;

    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const newResult = activeProvider === 'bestdebrid'
        ? await unlockWithBestDebrid(targetUrl)
        : await (async (): Promise<DebridResult> => {
          // Le débridage passe par mainapi : proxiesembed n'accepte plus
          // d'appel direct depuis le navigateur.
          const response = await fetch(`${MAIN_API}/api/media/debrid/unlock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getVipHeaders() },
            body: JSON.stringify({ link: targetUrl, provider: activeProvider }),
          });
          const data: unknown = await response.json().catch(() => null);

          if (isRecord(data) && data.status === 'success' && isRecord(data.data)) {
            return {
              link: getStringValue(data.data.link),
              filename: getStringValue(data.data.filename),
              filesize: getNumberValue(data.data.filesize),
              host: getStringValue(data.data.host),
              provider: activeProvider,
            };
          }

          throw new Error(extractDebridErrorMessage(data) || t('debrid.error'));
        })();

      const normalizedResult: DebridResult = {
        ...newResult,
        link: normalizeDebridedLink(newResult.link, newResult.provider),
      };

      setResult(normalizedResult);

      // Save to history
      const historyItem: DebridHistoryItem = {
        originalLink: targetUrl,
        debridedLink: normalizedResult.link,
        filename: normalizedResult.filename,
        filesize: normalizedResult.filesize,
        host: normalizedResult.host,
        timestamp: Date.now(),
        provider: activeProvider,
      };
      const updated = [
        historyItem,
        ...getHistory().filter((h) => !(h.originalLink === targetUrl && h.provider === activeProvider)),
      ];
      saveHistory(updated);
      setHistory(updated);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('debrid.error'));
    } finally {
      setIsLoading(false);
    }
  }, [provider, t, unlockWithBestDebrid, url]);

  // Read ?link= param on mount and auto-debrid
  useEffect(() => {
    const linkParam = searchParams.get('link');
    const providerParam = searchParams.get('provider');
    const initialProvider = isDebridProvider(providerParam) ? providerParam : DEFAULT_PROVIDER;

    if (linkParam && !hasAutoDebrided.current && isVip) {
      hasAutoDebrided.current = true;
      setUrl(linkParam);
      setProvider(initialProvider);
      // Clean the URL param
      setSearchParams({}, { replace: true });
      handleDebrid(linkParam, initialProvider);
    }
  }, [searchParams, isVip, handleDebrid, setSearchParams]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast.success(t('download.copied'));
    });
  };

  const formatFileSize = (bytes: number): string => {
    if (!bytes || bytes === 0) return '';
    if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  const removeFromHistory = (index: number) => {
    const updated = history.filter((_, i) => i !== index);
    saveHistory(updated);
    setHistory(updated);
  };

  const clearHistory = () => {
    saveHistory([]);
    setHistory([]);
  };

  const formatDate = (ts: number): string => {
    const d = new Date(ts);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.1 } },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <SquareBackground squareSize={48} borderColor="rgba(220, 38, 38, 0.10)" className="min-h-screen bg-black text-white">
      <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 relative z-10 h-full overflow-y-auto">
        {/* Back Button */}
        <Link to="/" className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-5 h-5 mr-2" />
          {t('debrid.backToHome')}
        </Link>

        {/* Hero Section */}
        <div className="max-w-3xl mx-auto text-center mb-12">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mb-6"
          >
            <div className="flex justify-center mb-6">
              <div className="p-4 rounded-2xl bg-yellow-500/10 border border-yellow-500/20">
                <CleanUnlock className="w-10 h-10 text-yellow-400" />
              </div>
            </div>
            <h1 className="text-3xl md:text-5xl font-black tracking-tight mb-4">
              <ShinyText text={t('debrid.title')} speed={3} color="#ffffff" shineColor="#eab308" className="inline" />
            </h1>
          </motion.div>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="text-lg text-white/50 max-w-xl mx-auto"
          >
            {t('debrid.subtitlePrefix')} <GlitchHostText /> {t('debrid.subtitleSuffix')}
          </motion.p>
        </div>

        {/* Main Content */}
        {!isVip ? (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="max-w-lg mx-auto">
            <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="12 12 12" className="p-8 text-center">
              <Crown className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-white mb-2">{t('debrid.vipRequired')}</h2>
              <p className="text-white/50 text-sm mb-6">{t('debrid.vipRequiredDesc')}</p>
              <Link to="/vip">
                <Button className="bg-yellow-600 hover:bg-yellow-700 text-white px-8 h-11 gap-2 rounded-full">
                  <Crown className="w-4 h-4" />
                  {t('debrid.becomeVip')}
                </Button>
              </Link>
            </AnimatedBorderCard>
          </motion.div>
        ) : (
          <motion.div variants={containerVariants} initial="hidden" animate="visible" className="max-w-2xl mx-auto space-y-6">
            {/* Input section */}
            <motion.div variants={itemVariants}>
              <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="12 12 12" className="p-6">
                <div className="flex items-center gap-2 mb-4">
                  <LinkIcon className="w-5 h-5 text-yellow-400" />
                  <h2 className="text-lg font-semibold text-white">{t('debrid.enterLink')}</h2>
                </div>
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {providerOptions.map((option) => {
                      const isActive = provider === option;

                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setProvider(option)}
                          className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                            isActive
                              ? 'border-yellow-500/60 bg-yellow-500/10'
                              : 'border-white/10 bg-white/5 hover:border-white/20'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-semibold text-white">{t(`debrid.providers.${option}.name`)}</span>
                            {isActive && <span className="text-[10px] uppercase tracking-[0.2em] text-yellow-300">{t('debrid.selected')}</span>}
                          </div>
                          <p className="mt-1 text-xs text-white/45">{t(`debrid.providers.${option}.desc`)}</p>
                        </button>
                      );
                    })}
                  </div>
                  {provider === 'bestdebrid' && (
                    <p className="text-xs text-white/40">{t('debrid.bestdebridClientNotice')}</p>
                  )}
                  {provider === 'debridr' && (
                    <p className="text-xs text-white/40">{t('debrid.debridrNotice')}</p>
                  )}
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleDebrid()}
                    placeholder={t('debrid.placeholder')}
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none focus:border-yellow-500/50 transition-colors"
                  />
                  <button
                    onClick={() => handleDebrid()}
                    disabled={isSubmitDisabled}
                    className="w-full px-6 py-3 bg-yellow-600 hover:bg-yellow-700 disabled:bg-yellow-800/50 disabled:cursor-not-allowed rounded-xl text-white font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    {isLoading ? <Loader className="w-5 h-5 animate-spin" /> : <CleanUnlock className="w-5 h-5" />}
                    {t('debrid.debridBtn')}
                  </button>
                </div>
                {/* empty spacer */}
              </AnimatedBorderCard>
            </motion.div>

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                  <div className="p-4 bg-red-900/20 border border-red-500/30 rounded-xl flex items-center gap-3">
                    <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                    <span className="text-red-300 text-sm">{error}</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Result */}
            <AnimatePresence>
              {result && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                  <AnimatedBorderCard highlightColor="34 197 94" backgroundColor="12 12 12" className="p-6">
                    <div className="flex items-center gap-2 mb-4">
                      <Check className="w-5 h-5 text-green-400" />
                      <h3 className="text-lg font-semibold text-white">{t('debrid.success')}</h3>
                    </div>
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <span className="rounded-full border border-yellow-500/20 bg-yellow-500/10 px-2.5 py-1 text-[11px] font-medium text-yellow-300">
                          {t(`debrid.providers.${result.provider}.name`)}
                        </span>
                        {result.host && (
                          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-white/60">
                            {result.host}
                          </span>
                        )}
                      </div>
                      <div>
                        <p className="text-xs text-white/40 mb-1">{t('debrid.filename')}</p>
                        <p className="text-white text-sm break-all">{result.filename}</p>
                      </div>
                      {result.filesize > 0 && (
                        <div>
                          <p className="text-xs text-white/40 mb-1">{t('download.sizeLabel')}</p>
                          <p className="text-white text-sm">{formatFileSize(result.filesize)}</p>
                        </div>
                      )}
                      <div className="flex items-center gap-3 pt-2">
                        <a
                          href={result.link}
                          target="_blank"
                          rel="noreferrer"
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-green-600 hover:bg-green-700 rounded-xl text-white font-medium transition-colors"
                        >
                          <Download className="w-5 h-5" />
                          {t('debrid.downloadBtn')}
                        </a>
                        <button
                          onClick={() => copyToClipboard(result.link)}
                          className="px-4 py-3 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-colors"
                          title={t('download.copyBtn')}
                        >
                          <Copy className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                  </AnimatedBorderCard>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Download History */}
            {history.length > 0 && (
              <motion.div variants={itemVariants}>
                <AnimatedBorderCard highlightColor="99 102 241" backgroundColor="12 12 12" className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Clock className="w-5 h-5 text-indigo-400" />
                      <h3 className="text-lg font-semibold text-white">{t('debrid.history')}</h3>
                      <span className="text-xs text-white/30 bg-white/5 px-2 py-0.5 rounded-full">{history.length}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowHistory(!showHistory)}
                        className="text-xs text-white/40 hover:text-white/70 transition-colors"
                      >
                        {showHistory ? t('debrid.hideHistory') : t('debrid.showHistory')}
                      </button>
                      <button
                        onClick={clearHistory}
                        className="text-xs text-red-400 opacity-60 hover:opacity-100 transition-opacity flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" />
                        {t('debrid.clearHistory')}
                      </button>
                    </div>
                  </div>

                  <AnimatePresence>
                    {showHistory && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                          {history.map((item, index) => (
                            <div
                              key={item.timestamp}
                              className="p-3 bg-white/5 rounded-lg border border-white/5 hover:border-white/10 transition-colors group"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-white truncate font-medium">{item.filename}</p>
                                  <div className="flex items-center gap-3 mt-1 text-xs text-white/30">
                                    <span>{formatDate(item.timestamp)}</span>
                                    {item.filesize > 0 && <span>{formatFileSize(item.filesize)}</span>}
                                    <span className="text-white/45">{t(`debrid.providers.${item.provider}.name`)}</span>
                                    {item.host && <span className="text-yellow-400/50">{item.host}</span>}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  <a
                                    href={item.debridedLink}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="group/btn p-1.5 text-green-400 hover:bg-green-400/10 rounded-lg transition-colors"
                                    title={t('debrid.downloadBtn')}
                                  >
                                    <Download className="w-4 h-4 opacity-60 group-hover/btn:opacity-100 transition-opacity" />
                                  </a>
                                  <button
                                    onClick={() => copyToClipboard(item.debridedLink)}
                                    className="group/btn p-1.5 text-white hover:bg-white/10 rounded-lg transition-colors"
                                    title={t('download.copyBtn')}
                                  >
                                    <Copy className="w-4 h-4 opacity-30 group-hover/btn:opacity-70 transition-opacity" />
                                  </button>
                                  <button
                                    onClick={() => {
                                      setProvider(item.provider);
                                      setUrl(item.originalLink);
                                      handleDebrid(item.originalLink, item.provider);
                                    }}
                                    className="group/btn p-1.5 text-yellow-400 hover:bg-yellow-400/10 rounded-lg transition-colors"
                                    title={t('debrid.reDebrid')}
                                  >
                                    <CleanUnlock className="w-4 h-4 opacity-40 group-hover/btn:opacity-100 transition-opacity" />
                                  </button>
                                  <button
                                    onClick={() => removeFromHistory(index)}
                                    className="group/btn p-1.5 text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                                    title={t('debrid.removeFromHistory')}
                                  >
                                    <Trash2 className="w-3.5 h-3.5 opacity-30 group-hover/btn:opacity-100 transition-opacity" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </AnimatedBorderCard>
              </motion.div>
            )}

            {/* Quotas limités */}
            <motion.div variants={itemVariants}>
              <AnimatedBorderCard highlightColor="220 38 38" backgroundColor="12 12 12" className="p-5">
                <div className="flex items-start gap-3">
                  <Info className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <h4 className="text-white font-semibold mb-2">{t('debrid.unsupportedTitle')}</h4>
                    <p className="text-white/40 text-xs mb-3">{t('debrid.unsupportedDesc')}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {unsupportedHosts.map((host) => (
                        <span key={host} className="text-xs px-2 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-300/70">
                          {host}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </AnimatedBorderCard>
            </motion.div>
          </motion.div>
        )}
      </div>
    </SquareBackground>
  );
};

export default DebridPage;
