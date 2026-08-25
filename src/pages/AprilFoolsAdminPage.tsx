import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { useTranslation } from 'react-i18next';
import {
  Clapperboard,
  KeyRound,
  Link2,
  Plus,
  ShieldCheck,
  Sparkles,
  Sprout,
  Wrench,
  X,
} from 'lucide-react';
import CustomDropdown from '../components/CustomDropdown';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import ShinyText from '../components/ui/shiny-text';
import { SquareBackground } from '../components/ui/square-background';
import { getOverlayPortalRoot } from '@/utils/overlayPortal';

type AdminSection = 'links' | 'vip-keys' | 'vip-invoices' | 'wishboard';
type RickrollAction = 'linkAdd' | 'vipCreate' | 'invoiceValidate' | 'wishboardApprove';
type LinkMediaType = 'movie' | 'series';

interface SectionMeta {
  id: AdminSection;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  highlight: string;
}

const RICKROLL_EMBED_URL = 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1&modestbranding=1';
const RICKROLL_MODAL_DURATION_MS = 300;

const AprilFoolsAdminPage: React.FC = () => {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<AdminSection>('links');
  const [rickrollAction, setRickrollAction] = useState<RickrollAction | null>(null);
  const [isRickrollClosing, setIsRickrollClosing] = useState(false);
  const closeTimeoutRef = useRef<number | null>(null);
  const [linkForm, setLinkForm] = useState({
    mediaType: 'movie' as LinkMediaType,
    tmdbId: '872585',
    season: '1',
    episode: '1',
    iframeUrl: 'https://uqload.is/embed-xxxxx.html',
  });
  const [vipForm, setVipForm] = useState(() => ({
    code: t('aprilAdmin.vipKeys.defaultLabel'),
    duration: '30d',
  }));

  const sections = useMemo<SectionMeta[]>(
    () => [
      {
        id: 'links',
        title: t('aprilAdmin.sections.links.title'),
        description: t('aprilAdmin.sections.links.description'),
        icon: Clapperboard,
        accent: 'text-blue-300',
        highlight: '59 130 246',
      },
      {
        id: 'vip-keys',
        title: t('aprilAdmin.sections.vipKeys.title'),
        description: t('aprilAdmin.sections.vipKeys.description'),
        icon: KeyRound,
        accent: 'text-emerald-300',
        highlight: '16 185 129',
      },
      {
        id: 'vip-invoices',
        title: t('aprilAdmin.sections.vipInvoices.title'),
        description: t('aprilAdmin.sections.vipInvoices.description'),
        icon: Sparkles,
        accent: 'text-yellow-300',
        highlight: '234 179 8',
      },
      {
        id: 'wishboard',
        title: t('aprilAdmin.sections.wishboard.title'),
        description: t('aprilAdmin.sections.wishboard.description'),
        icon: Sprout,
        accent: 'text-red-300',
        highlight: '239 68 68',
      },
    ],
    [t]
  );

  const metrics = useMemo(
    () => [
      { label: t('aprilAdmin.metrics.pendingAdds'), value: '14', tone: 'text-blue-200' },
      { label: t('aprilAdmin.metrics.vipKeys'), value: '38', tone: 'text-emerald-200' },
      { label: t('aprilAdmin.metrics.pendingInvoices'), value: '7', tone: 'text-yellow-200' },
      { label: t('aprilAdmin.metrics.priorityRequests'), value: '5', tone: 'text-red-200' },
    ],
    [t]
  );

  const mediaTypeOptions = useMemo(
    () => [
      { value: 'movie', label: t('aprilAdmin.links.mediaTypes.movie') },
      { value: 'series', label: t('aprilAdmin.links.mediaTypes.series') },
    ],
    [t]
  );

  const vipDurationOptions = useMemo(
    () => [
      { value: '7d', label: t('aprilAdmin.vipKeys.durationOptions.days7') },
      { value: '30d', label: t('aprilAdmin.vipKeys.durationOptions.days30') },
      { value: '90d', label: t('aprilAdmin.vipKeys.durationOptions.days90') },
      { value: '365d', label: t('aprilAdmin.vipKeys.durationOptions.days365') },
      { value: 'lifetime', label: t('aprilAdmin.vipKeys.durationOptions.lifetime') },
    ],
    [t]
  );

  const fakeVipKeys = useMemo(
    () => [
      {
        code: 'VIP-MOVIX-4F2K-Q8AZ',
        pack: t('aprilAdmin.vipKeys.durationOptions.days365'),
        status: t('aprilAdmin.status.available'),
      },
      {
        code: 'VIP-MOVIX-9L1X-R7TP',
        pack: t('aprilAdmin.vipKeys.durationOptions.days30'),
        status: t('aprilAdmin.status.queued'),
      },
      {
        code: 'VIP-MOVIX-7N6C-Z1EF',
        pack: t('aprilAdmin.vipKeys.durationOptions.lifetime'),
        status: t('aprilAdmin.status.delivered'),
      },
    ],
    [t]
  );

  const fakeInvoices = useMemo(
    () => [
      { id: 'vip_8A42R', amount: '49.99 EUR', payer: 'operator@movix.local', status: t('aprilAdmin.status.confirming') },
      { id: 'vip_4P19M', amount: '5.00 EUR', payer: 'gift@movix.local', status: t('aprilAdmin.status.partial') },
      { id: 'vip_7K21Q', amount: '99.00 EUR', payer: 'priority@movix.local', status: t('aprilAdmin.status.readyToValidate') },
    ],
    [t]
  );

  const fakeRequests = useMemo(
    () => [
      { title: t('aprilAdmin.wishboard.sampleRequests.arcane'), votes: '482', state: t('aprilAdmin.status.hot') },
      { title: t('aprilAdmin.wishboard.sampleRequests.interstellar'), votes: '377', state: t('aprilAdmin.status.priority') },
      { title: t('aprilAdmin.wishboard.sampleRequests.breakingBad'), votes: '295', state: t('aprilAdmin.status.pendingReview') },
    ],
    [t]
  );

  const activeSectionMeta = sections.find((section) => section.id === activeSection) ?? sections[0];

  const clearCloseTimer = useCallback(() => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, []);

  const closeRickroll = useCallback(() => {
    if (!rickrollAction || isRickrollClosing) {
      return;
    }

    clearCloseTimer();
    setIsRickrollClosing(true);
    closeTimeoutRef.current = window.setTimeout(() => {
      setRickrollAction(null);
      setIsRickrollClosing(false);
      closeTimeoutRef.current = null;
    }, RICKROLL_MODAL_DURATION_MS);
  }, [clearCloseTimer, isRickrollClosing, rickrollAction]);

  useEffect(() => {
    if (!rickrollAction) {
      return;
    }

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const lenis = (window as Window & { lenis?: { stop: () => void; start: () => void } }).lenis;
    if (lenis) {
      lenis.stop();
    }

    return () => {
      document.body.style.overflow = originalOverflow;
      if (lenis) {
        lenis.start();
      }
    };
  }, [rickrollAction]);

  useEffect(() => {
    if (!rickrollAction) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeRickroll();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [rickrollAction, closeRickroll]);

  useEffect(() => {
    return () => {
      clearCloseTimer();
    };
  }, [clearCloseTimer]);

  const openRickroll = (action: RickrollAction) => {
    clearCloseTimer();
    setIsRickrollClosing(false);
    setRickrollAction(action);
  };

  const handleLinkSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    openRickroll('linkAdd');
  };

  const handleVipSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    openRickroll('vipCreate');
  };

  return (
    <SquareBackground squareSize={48} borderColor="rgba(245, 158, 11, 0.08)" className="min-h-screen bg-black text-white">
      <div className="container mx-auto px-4 py-8 pt-28">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center rounded-full bg-white/5 p-3 ring-1 ring-white/10 mb-4">
            <Wrench className="h-7 w-7 text-white" />
          </div>
          <div className="mb-2 flex justify-center">
            <ShinyText
              text={t('aprilAdmin.dashboardTitle')}
              speed={2}
              color="#ffffff"
              shineColor="#fbbf24"
              className="text-4xl font-bold"
            />
          </div>
          <p className="text-lg text-gray-400">{t('aprilAdmin.dashboardDescription')}</p>
          <div className="mt-5 flex justify-center">
            <Link
              to="/"
              className="inline-flex items-center rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70 transition hover:bg-white/10 hover:text-white"
            >
              {t('aprilAdmin.backToSite')}
            </Link>
          </div>
        </div>

        <div className="mb-8 grid grid-cols-2 gap-4 xl:grid-cols-4">
          {metrics.map((metric) => (
            <div key={metric.label} className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-md">
              <p className="text-xs uppercase tracking-[0.2em] text-white/35">{metric.label}</p>
              <p className={`mt-3 text-3xl font-black ${metric.tone}`}>{metric.value}</p>
            </div>
          ))}
        </div>

        <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          {sections.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;

            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className="text-left"
              >
                <AnimatedBorderCard
                  highlightColor={section.highlight}
                  backgroundColor="10 10 10"
                  className={`h-full p-5 transition-all ${
                    isActive
                      ? 'scale-[1.02] shadow-[0_18px_45px_rgba(0,0,0,0.22)]'
                      : 'opacity-90 hover:opacity-100'
                  }`}
                >
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="rounded-xl bg-white/5 p-3 ring-1 ring-white/10">
                        <Icon className={`h-6 w-6 ${section.accent}`} />
                      </div>
                      {isActive && <span className="inline-flex h-3 w-3 rounded-full bg-white/80" aria-hidden="true" />}
                    </div>
                    <div>
                      <h3 className="text-xl font-semibold text-white">{section.title}</h3>
                      <p className="mt-2 text-sm leading-6 text-white/52">{section.description}</p>
                    </div>
                  </div>
                </AnimatedBorderCard>
              </button>
            );
          })}
        </div>

        <AnimatedBorderCard
          highlightColor={activeSectionMeta.highlight}
          backgroundColor="10 10 10"
          className="p-6 md:p-7"
        >
          {activeSection === 'links' && (
            <div>
              <h2 className="mb-6 flex items-center gap-3 text-2xl font-bold text-white">
                <Clapperboard className="h-6 w-6 text-blue-300" />
                {t('aprilAdmin.links.title')}
              </h2>

              <div className="max-w-3xl">
                <form onSubmit={handleLinkSubmit} className="rounded-3xl border border-white/10 bg-white/5 p-5 space-y-4">
                  <p className="text-sm font-semibold text-white">{t('aprilAdmin.links.formTitle')}</p>
                  <div className="space-y-2">
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">{t('aprilAdmin.links.fields.mediaType')}</p>
                    <CustomDropdown
                      options={mediaTypeOptions}
                      value={linkForm.mediaType}
                      onChange={(value) => setLinkForm((prev) => ({ ...prev, mediaType: value as LinkMediaType }))}
                      placeholder={t('aprilAdmin.links.fields.mediaType')}
                      searchable={false}
                    />
                  </div>
                  <input
                    type="text"
                    value={linkForm.tmdbId}
                    onChange={(event) => setLinkForm((prev) => ({ ...prev, tmdbId: event.target.value }))}
                    placeholder={t('aprilAdmin.links.fields.tmdbId')}
                    className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none transition focus:border-blue-400/40"
                  />
                  {linkForm.mediaType === 'series' && (
                    <div className="grid grid-cols-2 gap-4">
                      <input
                        type="text"
                        value={linkForm.season}
                        onChange={(event) => setLinkForm((prev) => ({ ...prev, season: event.target.value }))}
                        placeholder={t('aprilAdmin.links.fields.season')}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none transition focus:border-blue-400/40"
                      />
                      <input
                        type="text"
                        value={linkForm.episode}
                        onChange={(event) => setLinkForm((prev) => ({ ...prev, episode: event.target.value }))}
                        placeholder={t('aprilAdmin.links.fields.episode')}
                        className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none transition focus:border-blue-400/40"
                      />
                    </div>
                  )}
                  <textarea
                    value={linkForm.iframeUrl}
                    onChange={(event) => setLinkForm((prev) => ({ ...prev, iframeUrl: event.target.value }))}
                    placeholder={t('aprilAdmin.links.fields.iframeUrl')}
                    rows={4}
                    className="w-full resize-none rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-white outline-none transition focus:border-blue-400/40"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-2 rounded-xl bg-blue-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-400"
                  >
                    <Plus className="h-4 w-4" />
                    {t('aprilAdmin.links.addButton')}
                  </button>
                </form>

                <div className="hidden rounded-3xl border border-white/10 bg-white/5 p-5">
                  <p className="mb-4 text-sm font-semibold text-white">{t('aprilAdmin.links.listTitle')}</p>
                  <div className="space-y-3">
                    {[].map((link) => (
                      <div key={link.id} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-base font-semibold text-white">{link.title}</p>
                            <p className="mt-1 text-sm text-white/45">TMDB {link.id} · {link.source}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-medium text-blue-200">{link.quality}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/35">{link.status}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'vip-keys' && (
            <div>
              <h2 className="mb-6 flex items-center gap-3 text-2xl font-bold text-white">
                <KeyRound className="h-6 w-6 text-emerald-300" />
                {t('aprilAdmin.vipKeys.title')}
              </h2>

              <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
                <form onSubmit={handleVipSubmit} className="rounded-3xl border border-white/10 bg-white/5 p-5 space-y-4">
                  <p className="text-sm font-semibold text-white">{t('aprilAdmin.vipKeys.formTitle')}</p>
                  <input
                    type="text"
                    value={vipForm.code}
                    onChange={(event) => setVipForm((prev) => ({ ...prev, code: event.target.value }))}
                    placeholder={t('aprilAdmin.vipKeys.fields.label')}
                    className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 font-mono text-white outline-none transition focus:border-emerald-400/40"
                  />
                  <div className="space-y-2">
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">{t('aprilAdmin.vipKeys.fields.duration')}</p>
                    <CustomDropdown
                      options={vipDurationOptions}
                      value={vipForm.duration}
                      onChange={(value) => setVipForm((prev) => ({ ...prev, duration: value }))}
                      placeholder={t('aprilAdmin.vipKeys.fields.duration')}
                      searchable={false}
                    />
                  </div>
                  <button
                    type="submit"
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-black transition hover:bg-emerald-400"
                  >
                    <Plus className="h-4 w-4" />
                    {t('aprilAdmin.vipKeys.createButton')}
                  </button>
                </form>

                <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <p className="mb-4 text-sm font-semibold text-white">{t('aprilAdmin.vipKeys.listTitle')}</p>
                  <div className="space-y-3">
                    {fakeVipKeys.map((vipKey) => (
                      <div key={vipKey.code} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="font-mono text-sm text-emerald-200">{vipKey.code}</p>
                            <p className="mt-2 text-sm text-white/70">{vipKey.pack}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-xs uppercase tracking-[0.18em] text-white/35">{vipKey.status}</p>
                            <button
                              type="button"
                              onClick={() => openRickroll('vipCreate')}
                              className="mt-3 inline-flex items-center rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
                            >
                              {t('aprilAdmin.vipKeys.regenerateButton')}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'vip-invoices' && (
            <div>
              <h2 className="mb-6 flex items-center gap-3 text-2xl font-bold text-white">
                <ShieldCheck className="h-6 w-6 text-yellow-300" />
                {t('aprilAdmin.vipInvoices.title')}
              </h2>

              <div className="space-y-4">
                {fakeInvoices.map((invoice) => (
                  <div key={invoice.id} className="rounded-3xl border border-white/10 bg-white/5 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <p className="text-lg font-semibold text-white">{invoice.id}</p>
                        <p className="mt-1 text-sm text-white/45">{invoice.payer}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold text-yellow-200">{invoice.amount}</p>
                        <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/35">{invoice.status}</p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => openRickroll('invoiceValidate')}
                        className="rounded-xl bg-yellow-400 px-4 py-2 text-sm font-semibold text-black transition hover:bg-yellow-300"
                      >
                        {t('aprilAdmin.vipInvoices.validateButton')}
                      </button>
                      <button
                        type="button"
                        onClick={() => openRickroll('invoiceValidate')}
                        className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70 transition hover:bg-white/10 hover:text-white"
                      >
                        {t('aprilAdmin.vipInvoices.refreshButton')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'wishboard' && (
            <div>
              <h2 className="mb-6 flex items-center gap-3 text-2xl font-bold text-white">
                <Link2 className="h-6 w-6 text-red-300" />
                {t('aprilAdmin.wishboard.title')}
              </h2>

              <div className="space-y-4">
                {fakeRequests.map((request) => (
                  <div key={request.title} className="rounded-3xl border border-white/10 bg-white/5 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <p className="text-lg font-semibold text-white">{request.title}</p>
                        <p className="mt-1 text-sm text-white/45">{t('aprilAdmin.wishboard.votesLabel', { count: request.votes })}</p>
                      </div>
                      <p className="text-xs uppercase tracking-[0.18em] text-white/35">{request.state}</p>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => openRickroll('wishboardApprove')}
                        className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-400"
                      >
                        {t('aprilAdmin.wishboard.approveButton')}
                      </button>
                      <button
                        type="button"
                        onClick={() => openRickroll('wishboardApprove')}
                        className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70 transition hover:bg-white/10 hover:text-white"
                      >
                        {t('aprilAdmin.wishboard.scheduleButton')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </AnimatedBorderCard>
      </div>

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence mode="wait">
            {rickrollAction && !isRickrollClosing && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: RICKROLL_MODAL_DURATION_MS / 1000 }}
                data-lenis-prevent
                className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/80 p-4"
                onClick={(event) => {
                  if (event.target === event.currentTarget) {
                    closeRickroll();
                  }
                }}
              >
                <motion.div
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.95, opacity: 0 }}
                  transition={{ duration: RICKROLL_MODAL_DURATION_MS / 1000 }}
                  className="relative w-full max-w-4xl overflow-hidden rounded-2xl border border-white/10 bg-[#090909] shadow-2xl"
                >
                  <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
                    <div>
                      <h2 className="text-lg font-semibold leading-none tracking-tight text-white">
                        {t(`aprilAdmin.rickroll.${rickrollAction}.title`)}
                      </h2>
                      <p className="mt-2 text-sm text-white/60">
                        {t(`aprilAdmin.rickroll.${rickrollAction}.description`)}
                      </p>
                    </div>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      type="button"
                      onClick={closeRickroll}
                      className="rounded-lg p-2 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                      aria-label={t('common.close')}
                    >
                      <X className="h-4 w-4" />
                    </motion.button>
                  </div>
                  <div className="p-4 md:p-6">
                    <div className="mb-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100/90">
                      {t('aprilAdmin.rickroll.processingNote')}
                    </div>
                    <div className="overflow-hidden rounded-2xl border border-white/10 bg-black">
                      <iframe
                        key={rickrollAction}
                        src={RICKROLL_EMBED_URL}
                        title={t('aprilAdmin.rickroll.frameTitle')}
                        className="aspect-video w-full"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        referrerPolicy="strict-origin-when-cross-origin"
                        allowFullScreen
                      />
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>,
          getOverlayPortalRoot()
        )}
    </SquareBackground>
  );
};

export default AprilFoolsAdminPage;
