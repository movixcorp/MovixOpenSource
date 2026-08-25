import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useParams, useSearchParams } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CircleDashed,
  Clock3,
  Copy,
  CreditCard,
  Crown,
  ExternalLink,
  Gift,
  KeyRound,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Wallet
} from 'lucide-react';

import AnimatedBorderCard from '../components/ui/animated-border-card';
import BlurText from '../components/ui/blur-text';
import { Button } from '../components/ui/button';
import ShinyText from '../components/ui/shiny-text';
import { SquareBackground } from '../components/ui/square-background';
import { checkVipInvoice, getVipInvoice, VipInvoice } from '../services/vipDonationsService';
import {
  formatVipCrypto,
  formatVipFiat,
  getVipDurationLabel,
  getVipPaymentLabel,
  getVipPaymentShortLabel,
  getVipStatusMeta
} from '../utils/vipDonationsUi';
import { rememberVipInvoice } from '../utils/vipInvoiceHistory';

const STATUS_TONE: Record<VipInvoice['status'], string> = {
  awaiting_payment: 'bg-yellow-500/15 text-yellow-200 border-yellow-400/35',
  partial_payment: 'bg-orange-500/15 text-orange-200 border-orange-400/35',
  confirming: 'bg-cyan-500/15 text-cyan-100 border-cyan-300/35',
  paid: 'bg-emerald-500/15 text-emerald-100 border-emerald-300/35',
  delivered: 'bg-emerald-500/15 text-emerald-100 border-emerald-300/35',
  expired: 'bg-white/10 text-white/80 border-white/20',
  cancelled: 'bg-red-500/15 text-red-100 border-red-400/35'
};

const formatRemaining = (expiresAt: string | null, t: (key: string) => string) => {
  if (!expiresAt) {
    return t('vipDonations.invoice.noExpiration');
  }

  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    return t('vipDonations.invoice.expiredNow');
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
};

const isInvoiceNotFoundError = (error: unknown) => (
  error instanceof Error
  && (
    (typeof (error as { statusCode?: number }).statusCode === 'number' && (error as { statusCode?: number }).statusCode === 404)
    || /invoice introuvable/i.test(error.message)
  )
);

const VipInvoicePage: React.FC = () => {
  const { publicId } = useParams<{ publicId: string }>();
  const { t, i18n } = useTranslation();
  const [invoice, setInvoice] = useState<VipInvoice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isChecking, setIsChecking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isMissingInvoice, setIsMissingInvoice] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [remaining, setRemaining] = useState(t('vipDonations.invoice.noExpiration'));

  const statusMeta = useMemo(
    () => (invoice ? getVipStatusMeta(t, invoice.status) : null),
    [invoice, t]
  );
  const invoiceStatus = invoice?.status;
  const isCryptoGateInvoice = invoice?.paymentMethod === 'cryptogate';
  const isPaygateInvoice = invoice?.paymentMethod === 'paygate_hosted';
  const isPayblisInvoice = invoice?.paymentMethod === 'payblis';
  const isHostedCheckoutInvoice = isCryptoGateInvoice || isPaygateInvoice || isPayblisInvoice;
  const paymentLabel = invoice
    ? getVipPaymentLabel(t, invoice.paymentMethod, invoice.coin)
    : '';
  const paymentShortLabel = invoice
    ? getVipPaymentShortLabel(t, invoice.paymentMethod, invoice.coin)
    : '';
  const isPaygateMinimumApplied = Boolean(
    invoice
    && isPaygateInvoice
    && invoice.amountEur > invoice.packEur
  );
  const invoiceExpiresAt = invoice?.expiresAt || null;
  const showSaveUrlWarning = invoice ? !['delivered', 'expired', 'cancelled'].includes(invoice.status) : false;
  const showLiveChecks = invoice ? ['awaiting_payment', 'partial_payment', 'confirming', 'paid'].includes(invoice.status) : false;
  const showExpiration = invoice ? ['awaiting_payment', 'partial_payment'].includes(invoice.status) : false;
  const showCheckoutButton = Boolean(
    invoice
    && isHostedCheckoutInvoice
    && invoice.checkoutUrl
    && !['delivered', 'expired', 'cancelled'].includes(invoice.status)
  );

  useEffect(() => {
    setRemaining(formatRemaining(invoiceExpiresAt, t));
    if (!invoiceExpiresAt || !showExpiration) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setRemaining(formatRemaining(invoiceExpiresAt, t));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [invoiceExpiresAt, showExpiration, t]);

  useEffect(() => {
    if (!invoice?.qrPayload) {
      setQrCodeUrl('');
      return;
    }

    let cancelled = false;
    (async () => {
      const qrcodeMod = await import('qrcode');
      const QRCode = qrcodeMod.default;
      try {
        const url = await QRCode.toDataURL(invoice.qrPayload, {
          width: 320,
          margin: 1,
          color: {
            dark: '#0a0a0a',
            light: '#ffffff'
          }
        });
        if (!cancelled) setQrCodeUrl(url);
      } catch {
        if (!cancelled) setQrCodeUrl('');
      }
    })();
    return () => { cancelled = true; };
  }, [invoice?.qrPayload]);

  useEffect(() => {
    if (invoice?.publicId) {
      rememberVipInvoice(invoice.publicId);
    }
  }, [invoice?.publicId]);

  const [searchParams, setSearchParams] = useSearchParams();
  const payblisReturn = searchParams.get('payblis');

  useEffect(() => {
    if (!payblisReturn || !invoice?.publicId) return;

    if (payblisReturn === 'ok') {
      toast.success(t('vipDonations.payblis.returnOk'));
      checkVipInvoice(invoice.publicId).then(setInvoice).catch(() => {});
    } else if (payblisReturn === 'ko') {
      const retryUrl = invoice.checkoutUrl;
      toast.error(t('vipDonations.payblis.returnKo'), {
        action: retryUrl
          ? {
              label: t('vipDonations.payblis.retry'),
              onClick: () => window.open(retryUrl, '_blank', 'noopener,noreferrer')
            }
          : undefined
      });
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('payblis');
    setSearchParams(nextParams, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payblisReturn, invoice?.publicId, invoice?.checkoutUrl]);

  useEffect(() => {
    if (!publicId) {
      setInvoice(null);
      setLoadError(null);
      setIsMissingInvoice(true);
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    const load = async () => {
      try {
        if (isMounted) {
          setIsLoading(true);
          setLoadError(null);
          setIsMissingInvoice(false);
        }

        const fetchedInvoice = await checkVipInvoice(publicId).catch(() => getVipInvoice(publicId));
        if (isMounted) {
          setInvoice(fetchedInvoice);
          setLoadError(null);
          setIsMissingInvoice(false);
        }
      } catch (error) {
        if (isMounted) {
          const resolvedMessage = error instanceof Error ? error.message : t('vipDonations.invoice.loadError');
          setInvoice(null);
          setLoadError(isInvoiceNotFoundError(error) ? null : resolvedMessage);
          setIsMissingInvoice(isInvoiceNotFoundError(error));
          toast.error(resolvedMessage);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void load();

    return () => {
      isMounted = false;
    };
  }, [publicId, reloadNonce, t]);

  useEffect(() => {
    if (!publicId) {
      return undefined;
    }

    if (!invoice || loadError || isMissingInvoice) {
      return undefined;
    }

    if (invoiceStatus && ['delivered', 'expired', 'cancelled'].includes(invoiceStatus)) {
      return undefined;
    }

    const interval = window.setInterval(async () => {
      try {
        const refreshedInvoice = await checkVipInvoice(publicId);
        setInvoice(refreshedInvoice);
      } catch (error) {
        console.warn('VIP invoice polling failed:', error);
      }
    }, 30000);

    return () => window.clearInterval(interval);
  }, [invoice, invoiceStatus, isMissingInvoice, loadError, publicId]);

  const handleCheckNow = async () => {
    if (!publicId) {
      return;
    }

    const loadingToastId = toast.loading(t('vipDonations.invoice.checkInProgress'));

    try {
      setIsChecking(true);
      const refreshedInvoice = await checkVipInvoice(publicId);
      setInvoice(refreshedInvoice);
      const refreshedStatusMeta = getVipStatusMeta(t, refreshedInvoice.status);
      toast.success(
        t('vipDonations.invoice.checkStatus', { status: refreshedStatusMeta.label }),
        {
          id: loadingToastId,
          description: refreshedStatusMeta.hint
        }
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('vipDonations.invoice.checkError'), {
        id: loadingToastId
      });
    } finally {
      setIsChecking(false);
    }
  };

  const handleCopy = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(successMessage);
    } catch {
      toast.error(t('vipDonations.common.copyFailed'));
    }
  };

  const handleOpenCheckout = () => {
    if (!invoice?.checkoutUrl) {
      return;
    }

    window.open(invoice.checkoutUrl, '_blank', 'noopener,noreferrer');
  };

  if (isLoading) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(234, 179, 8, 0.12)" className="min-h-screen bg-black text-white">
        <div className="flex min-h-screen items-center justify-center px-4">
          <div className="text-center">
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-yellow-400" />
            <p className="mt-4 text-sm text-white/60">{t('vipDonations.common.loadingInvoice')}</p>
          </div>
        </div>
      </SquareBackground>
    );
  }

  if (!invoice && loadError) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(234, 179, 8, 0.12)" className="min-h-screen bg-black text-white">
        <div className="flex min-h-screen items-center justify-center px-4">
          <AnimatedBorderCard highlightColor="239 68 68" backgroundColor="10 10 10" className="max-w-lg p-8 text-center">
            <h1 className="text-2xl font-bold text-white">{t('vipDonations.invoice.loadError')}</h1>
            <p className="mt-3 text-sm leading-6 text-white/60">{loadError}</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button
                className="bg-yellow-500 text-black hover:bg-yellow-400"
                onClick={() => setReloadNonce((value) => value + 1)}
              >
                <RefreshCcw className="mr-2 h-4 w-4" />
                {t('vipDonations.history.refreshButton')}
              </Button>
              <Link to="/vip/don" className="inline-flex items-center gap-2 text-sm font-semibold text-yellow-300 hover:text-yellow-200">
                <ArrowLeft className="h-4 w-4" />
                {t('vipDonations.invoice.backVip')}
              </Link>
            </div>
          </AnimatedBorderCard>
        </div>
      </SquareBackground>
    );
  }

  if (!invoice && isMissingInvoice) {
    return (
      <SquareBackground squareSize={48} borderColor="rgba(234, 179, 8, 0.12)" className="min-h-screen bg-black text-white">
        <div className="flex min-h-screen items-center justify-center px-4">
          <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="10 10 10" className="max-w-lg p-8 text-center">
            <h1 className="text-2xl font-bold text-white">{t('vipDonations.common.invoiceNotFound')}</h1>
            <p className="mt-3 text-sm leading-6 text-white/60">{t('vipDonations.invoice.notFoundDescription')}</p>
            <Link to="/vip/don" className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-yellow-300 hover:text-yellow-200">
              <ArrowLeft className="h-4 w-4" />
              {t('vipDonations.invoice.backVip')}
            </Link>
          </AnimatedBorderCard>
        </div>
      </SquareBackground>
    );
  }

  if (!invoice) {
    return null;
  }

  return (
    <SquareBackground
      squareSize={48}
      borderColor="rgba(234, 179, 8, 0.12)"
      className="min-h-screen bg-black text-white"
    >
      <div className="container mx-auto px-4 py-8 sm:px-6 sm:py-12 relative z-10">
        <Link to="/vip/don" className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-5 h-5 mr-2" />
          {t('vipDonations.invoice.backVip')}
        </Link>

        <div className="max-w-6xl mx-auto space-y-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center space-y-6"
          >
            <div className="inline-flex items-center justify-center p-3 bg-yellow-500/10 rounded-full ring-1 ring-yellow-500/50">
              <Wallet className="w-8 h-8 text-yellow-500" />
            </div>

            <div className="space-y-4">
              <BlurText
                text={t('vipDonations.invoice.paymentTitle', { coin: paymentLabel })}
                delay={220}
                animateBy="words"
                direction="top"
                className="text-4xl md:text-6xl font-bold text-white justify-center"
              />
              <p className="text-base md:text-lg text-white/60 max-w-3xl mx-auto leading-relaxed">
                {statusMeta?.hint}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <span className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold ${STATUS_TONE[invoice.status]}`}>
                  <BadgeCheck className="h-4 w-4" />
                  {statusMeta?.label}
                </span>
                <span className="inline-flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm font-semibold text-yellow-200">
                  <Sparkles className="h-4 w-4 text-yellow-400" />
                  {getVipDurationLabel(t, invoice.vipYears, 'vip')}
                </span>
              </div>
            </div>
          </motion.div>

          {showSaveUrlWarning && (
            <AnimatedBorderCard
              highlightColor="234 179 8"
              backgroundColor="10 10 10"
              className="p-5 sm:p-6 backdrop-blur-sm"
            >
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl bg-yellow-500/15">
                  <ShieldCheck className="h-5 w-5 text-yellow-300" />
                </div>
                <div>
                  <p className="font-semibold text-yellow-100">{t('vipDonations.invoice.saveUrlTitle')}</p>
                  <p className="mt-2 text-sm leading-6 text-yellow-100/72">{t('vipDonations.invoice.saveUrlDescription')}</p>
                </div>
              </div>
            </AnimatedBorderCard>
          )}

          <div className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-6">
              {!isHostedCheckoutInvoice ? (
                <>
                  <div className="grid gap-6 lg:grid-cols-2">
                    <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="10 10 10" className="p-6">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">
                            {t('vipDonations.invoice.exactAmountTitle')}
                          </p>
                          <p className="mt-1 text-sm text-white/45">{t('vipDonations.invoice.exactAmountDescription')}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleCopy((invoice.amountCryptoExpected || 0).toFixed(8), t('vipDonations.common.copyAmountSuccess'))}
                          className="rounded-2xl border border-white/10 p-2 text-white/50 transition-colors hover:border-white/20 hover:text-white"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="mt-6">
                        <ShinyText
                          text={`${formatVipCrypto(i18n.language, invoice.amountCryptoExpected || 0)} ${(invoice.coin || '').toUpperCase()}`}
                          speed={2}
                          color="#fbbf24"
                          shineColor="#ffffff"
                          className="text-3xl font-black"
                        />
                        <p className="mt-3 text-sm text-white/55">{formatVipFiat(i18n.language, invoice.amountEur, 'EUR')}</p>
                        <p className="text-sm text-white/40">{formatVipFiat(i18n.language, invoice.amountUsd, 'USD')}</p>
                      </div>
                    </AnimatedBorderCard>

                    <AnimatedBorderCard highlightColor="56 189 248" backgroundColor="10 10 10" className="p-6">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">
                        {t('vipDonations.invoice.addressTitle')}
                      </p>
                      <p className="mt-1 text-sm text-white/45">
                        {t('vipDonations.invoice.addressDescription', { coin: (invoice.coin || '').toUpperCase() })}
                      </p>

                      <div className="mt-5 flex items-center gap-2 rounded-2xl bg-white/[0.04] px-4 py-3 ring-1 ring-inset ring-white/10">
                        <code className="min-w-0 flex-1 break-all text-xs text-white/80">{invoice.paymentAddress}</code>
                        <button
                          type="button"
                          onClick={() => handleCopy(invoice.paymentAddress || '', t('vipDonations.common.copyAddressSuccess'))}
                          className="rounded-2xl border border-white/10 p-2 text-white/50 transition-colors hover:border-white/20 hover:text-white"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                    </AnimatedBorderCard>
                  </div>

                  <div className="grid items-start gap-6 lg:grid-cols-[0.58fr_0.42fr]">
                    <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="10 10 10" className="p-6 text-center">
                      {qrCodeUrl ? (
                        <img
                          src={qrCodeUrl}
                          alt={t('vipDonations.invoice.qrAlt')}
                          className="mx-auto w-full max-w-[280px] rounded-2xl bg-white p-3"
                        />
                      ) : (
                        <div className="mx-auto grid h-[280px] max-w-[280px] place-items-center rounded-2xl border border-dashed border-white/10 text-white/35">
                          {t('vipDonations.invoice.qrUnavailable')}
                        </div>
                      )}
                      <p className="mt-4 text-sm font-semibold text-white">
                        {t('vipDonations.invoice.qrScanTitle', { coin: (invoice.coin || '').toUpperCase() })}
                      </p>
                      <p className="mt-1 text-xs text-white/42">{t('vipDonations.invoice.qrScanDescription')}</p>
                    </AnimatedBorderCard>

                    <AnimatedBorderCard highlightColor="56 189 248" backgroundColor="10 10 10" className="self-start p-6">
                      <div className="divide-y divide-white/10">
                        {showLiveChecks && (
                          <div className="flex items-center gap-3 py-4 first:pt-0">
                            <div className="p-2.5 rounded-xl bg-cyan-400/10">
                              <RefreshCcw className="h-5 w-5 text-cyan-300" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-white">{t('vipDonations.invoice.autoCheckTitle')}</p>
                              <p className="text-xs text-white/45">{t('vipDonations.invoice.autoCheckDescription')}</p>
                            </div>
                          </div>
                        )}

                        {showExpiration && (
                          <div className="flex items-center gap-3 py-4">
                            <div className="p-2.5 rounded-xl bg-white/8">
                    <Clock3 className="h-5 w-5 text-white opacity-[0.85]" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-white">{t('vipDonations.invoice.expirationTitle')}</p>
                              <p className="text-xs text-white/45">{remaining}</p>
                            </div>
                          </div>
                        )}

                        <div className="py-4">
                          <p className="text-sm font-semibold text-white">{t('vipDonations.invoice.currentStatusTitle')}</p>
                          <p className="mt-2 text-sm leading-6 text-white/58">{statusMeta?.hint}</p>
                          {(invoice.status === 'confirming' || invoice.status === 'paid') && (
                            <p className="mt-2 text-xs text-cyan-100/80">
                              {t('vipDonations.invoice.confirmationsLabel', {
                                current: invoice.confirmations,
                                required: invoice.requiredConfirmations
                              })}
                            </p>
                          )}
                          {invoice.status === 'partial_payment' && (
                            <p className="mt-2 text-xs text-orange-100/80">
                              {t('vipDonations.invoice.receivedLabel', {
                                amount: (invoice.amountCryptoReceived || 0).toFixed(8),
                                coin: (invoice.coin || '').toUpperCase()
                              })}
                            </p>
                          )}
                        </div>

                        {showLiveChecks && (
                          <div className="pt-4">
                            <Button
                              className="h-12 w-full bg-yellow-500 text-black hover:bg-yellow-400"
                              onClick={handleCheckNow}
                              disabled={isChecking}
                            >
                              {isChecking ? (
                                <>
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  {t('vipDonations.invoice.verifyingButton')}
                                </>
                              ) : (
                                <>
                                  <CircleDashed className="mr-2 h-4 w-4" />
                                  {t('vipDonations.invoice.verifyButton')}
                                </>
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                    </AnimatedBorderCard>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid gap-6 lg:grid-cols-2">
                    <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="10 10 10" className="p-6">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">
                          {t('vipDonations.invoice.checkoutAmountTitle')}
                        </p>
                        <p className="mt-1 text-sm text-white/45">{t('vipDonations.invoice.checkoutAmountDescription', { provider: paymentShortLabel })}</p>
                      </div>

                      <div className="mt-6">
                        <ShinyText
                          text={formatVipFiat(i18n.language, invoice.amountEur, 'EUR')}
                          speed={2}
                          color="#fbbf24"
                          shineColor="#ffffff"
                          className="text-3xl font-black"
                        />
                        {!isCryptoGateInvoice && (
                          <p className="mt-3 text-sm text-white/55">{formatVipFiat(i18n.language, invoice.amountUsd, 'USD')}</p>
                        )}
                        <p className="text-sm text-white/40">{t('vipDonations.invoice.checkoutAmountFootnote', { provider: paymentShortLabel })}</p>
                        {isPaygateMinimumApplied && (
                          <p className="mt-2 text-xs text-yellow-200/80">
                            {t('vipDonations.invoice.paygateMinimumDescription', {
                              originalAmount: formatVipFiat(i18n.language, invoice.packEur, 'EUR'),
                              minimumAmount: formatVipFiat(i18n.language, invoice.amountEur, 'EUR')
                            })}
                          </p>
                        )}
                      </div>
                    </AnimatedBorderCard>

                    <AnimatedBorderCard highlightColor="34 197 94" backgroundColor="10 10 10" className="p-6">
                      <div className="flex items-start gap-3">
                        <div className="rounded-xl bg-emerald-400/10 p-3 ring-1 ring-emerald-400/20">
                          <CreditCard className="h-5 w-5 text-emerald-200" />
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">
                            {t('vipDonations.invoice.checkoutTitle', { provider: paymentShortLabel })}
                          </p>
                          <p className="mt-2 text-sm leading-6 text-white/58">{t('vipDonations.invoice.checkoutDescription')}</p>
                        </div>
                      </div>

                      {isPaygateInvoice && (
                        <div className="mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/8 p-4">
                          <div className="flex items-start gap-3">
                            <div className="rounded-xl bg-black/30 p-2.5">
                              <AlertTriangle className="h-5 w-5 text-amber-200" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-white">{t('vipDonations.invoice.paygateKycTitle')}</p>
                              <p className="mt-1 text-xs leading-6 text-white/58">{t('vipDonations.invoice.paygateKycDescription')}</p>
                            </div>
                          </div>
                        </div>
                      )}

                      {isPaygateMinimumApplied && (
                        <div className="mt-4 rounded-2xl border border-yellow-400/20 bg-yellow-400/8 p-4">
                          <div className="flex items-start gap-3">
                            <div className="rounded-xl bg-black/30 p-2.5">
                              <AlertTriangle className="h-5 w-5 text-yellow-200" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-white">{t('vipDonations.invoice.paygateMinimumTitle')}</p>
                              <p className="mt-1 text-xs leading-6 text-white/58">
                                {t('vipDonations.invoice.paygateMinimumDescription', {
                                  originalAmount: formatVipFiat(i18n.language, invoice.packEur, 'EUR'),
                                  minimumAmount: formatVipFiat(i18n.language, invoice.amountEur, 'EUR')
                                })}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {showCheckoutButton && (
                        <div className="mt-5 space-y-3">
                          <Button
                            className="h-12 w-full bg-emerald-400 text-black hover:bg-emerald-300"
                            onClick={handleOpenCheckout}
                          >
                            <ExternalLink className="mr-2 h-4 w-4" />
                            {t('vipDonations.invoice.openCheckoutButton', { provider: paymentShortLabel })}
                          </Button>
                          <Button
                            variant="outline"
                            className="h-12 w-full border-white/15 bg-transparent text-white hover:bg-white/5"
                            onClick={() => handleCopy(invoice.checkoutUrl || '', t('vipDonations.common.copyInvoiceUrlSuccess'))}
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            {t('vipDonations.invoice.copyCheckoutButton')}
                          </Button>
                        </div>
                      )}
                    </AnimatedBorderCard>
                  </div>

                  <AnimatedBorderCard highlightColor="56 189 248" backgroundColor="10 10 10" className="self-start p-6">
                    <div className="divide-y divide-white/10">
                      {showLiveChecks && (
                        <div className="flex items-center gap-3 py-4 first:pt-0">
                          <div className="p-2.5 rounded-xl bg-cyan-400/10">
                            <RefreshCcw className="h-5 w-5 text-cyan-300" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-white">{t('vipDonations.invoice.autoCheckTitle')}</p>
                            <p className="text-xs text-white/45">{t('vipDonations.invoice.paygateAutoCheckDescription', { provider: paymentShortLabel })}</p>
                          </div>
                        </div>
                      )}

                      {showExpiration && (
                        <div className="flex items-center gap-3 py-4">
                          <div className="p-2.5 rounded-xl bg-white/8">
                  <Clock3 className="h-5 w-5 text-white opacity-[0.85]" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-white">{t('vipDonations.invoice.expirationTitle')}</p>
                            <p className="text-xs text-white/45">{remaining}</p>
                          </div>
                        </div>
                      )}

                      <div className="py-4">
                        <p className="text-sm font-semibold text-white">{t('vipDonations.invoice.currentStatusTitle')}</p>
                        <p className="mt-2 text-sm leading-6 text-white/58">{statusMeta?.hint}</p>
                        {invoice.status === 'partial_payment' && (
                          <p className="mt-2 text-xs text-orange-100/80">
                            {t('vipDonations.invoice.paygatePartialHint', { provider: paymentShortLabel })}
                          </p>
                        )}
                      </div>

                      <div className="pt-4 space-y-3">
                        {showCheckoutButton && (
                          <Button
                            className="h-12 w-full bg-emerald-400 text-black hover:bg-emerald-300"
                            onClick={handleOpenCheckout}
                          >
                            <ExternalLink className="mr-2 h-4 w-4" />
                            {t('vipDonations.invoice.openCheckoutButton', { provider: paymentShortLabel })}
                          </Button>
                        )}
                        {showLiveChecks && (
                          <Button
                            className="h-12 w-full bg-yellow-500 text-black hover:bg-yellow-400"
                            onClick={handleCheckNow}
                            disabled={isChecking}
                          >
                            {isChecking ? (
                              <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                {t('vipDonations.invoice.verifyingButton')}
                              </>
                            ) : (
                              <>
                                <CircleDashed className="mr-2 h-4 w-4" />
                                {t('vipDonations.invoice.refreshButton')}
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  </AnimatedBorderCard>
                </>
              )}

              {invoice.vipKey && (
                <AnimatedBorderCard highlightColor="34 197 94" backgroundColor="10 10 10" className="p-6">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-200/70">
                        {t('vipDonations.invoice.keyEyebrow')}
                      </p>
                      <BlurText
                        text={t('vipDonations.invoice.keyTitle')}
                        delay={60}
                        className="text-2xl font-bold text-white"
                      />
                      <p className="mt-2 text-sm leading-6 text-white/58">{t('vipDonations.invoice.keyDescription')}</p>
                    </div>
                    <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-100">
                      <BadgeCheck className="h-4 w-4" />
                      {getVipDurationLabel(t, invoice.vipYears, 'vip')}
                    </span>
                  </div>

                  <div className="mt-5 flex items-center gap-2 rounded-2xl bg-white/[0.04] px-4 py-3 ring-1 ring-inset ring-white/10">
                    <code className="min-w-0 flex-1 break-all text-base font-semibold text-white">{invoice.vipKey}</code>
                    <button
                      type="button"
                      onClick={() => handleCopy(invoice.vipKey || '', t('vipDonations.common.copyVipKeySuccess'))}
                      className="rounded-2xl border border-white/10 p-3 text-white/55 transition-colors hover:border-white/20 hover:text-white"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </AnimatedBorderCard>
              )}

              {invoice.giftUrl && (
                <AnimatedBorderCard highlightColor="56 189 248" backgroundColor="10 10 10" className="p-6">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-200/70">
                        {t('vipDonations.invoice.giftEyebrow')}
                      </p>
                      <BlurText
                        text={t('vipDonations.invoice.giftTitle')}
                        delay={60}
                        className="text-2xl font-bold text-white"
                      />
                      <p className="mt-2 text-sm leading-6 text-white/58">{t('vipDonations.invoice.giftDescription')}</p>
                    </div>
                    <div className="p-3 rounded-xl bg-cyan-400/10 ring-1 ring-cyan-400/20">
                      <Gift className="h-6 w-6 text-cyan-200" />
                    </div>
                  </div>

                  <div className="mt-5 flex items-center gap-2 rounded-2xl bg-white/[0.04] px-4 py-3 ring-1 ring-inset ring-white/10">
                    <code className="min-w-0 flex-1 break-all text-sm text-white">{invoice.giftUrl}</code>
                    <button
                      type="button"
                      onClick={() => handleCopy(invoice.giftUrl || '', t('vipDonations.common.copyGiftUrlSuccess'))}
                      className="rounded-2xl border border-white/10 p-3 text-white/55 transition-colors hover:border-white/20 hover:text-white"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </AnimatedBorderCard>
              )}
            </div>

            <div className="space-y-6">
              <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="10 10 10" className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-xl bg-yellow-500/10 ring-1 ring-yellow-500/20">
                      <Crown className="h-6 w-6 text-yellow-500" />
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-white/35">{t('vipDonations.invoice.summaryTitle')}</p>
                      <ShinyText
                        text={getVipDurationLabel(t, invoice.vipYears, 'vip')}
                        speed={2}
                        color="#fbbf24"
                        shineColor="#ffffff"
                        className="text-2xl font-bold"
                      />
                    </div>
                  </div>

                  <div className="divide-y divide-white/10 text-sm">
                    <div className="flex items-center justify-between py-3 first:pt-0 text-white/60">
                      <span>{t('vipDonations.page.recipientLabel')}</span>
                      <span className="font-semibold text-white">
                        {invoice.recipientMode === 'self'
                          ? t('vipDonations.invoice.recipientSelf')
                          : t('vipDonations.invoice.recipientGift')}
                        </span>
                    </div>
                    <div className="flex items-center justify-between py-3 text-white/60">
                      <span>{t('vipDonations.page.paymentLabel')}</span>
                      <span className="font-semibold text-white">{paymentShortLabel}</span>
                    </div>
                    <div className="flex items-center justify-between py-3 pb-0 text-white/60">
                      <span>{t('vipDonations.invoice.totalLabel')}</span>
                      <span className="text-lg font-black text-yellow-300">
                        {formatVipFiat(i18n.language, invoice.amountEur, 'EUR')}
                      </span>
                    </div>
                  </div>
                </div>
              </AnimatedBorderCard>

              <AnimatedBorderCard highlightColor="34 197 94" backgroundColor="10 10 10" className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-xl bg-emerald-400/10 ring-1 ring-emerald-400/20">
                      <KeyRound className="h-5 w-5 text-emerald-200" />
                    </div>
                    <div>
                      <p className="font-semibold text-white">{t('vipDonations.invoice.keepPageTitle')}</p>
                      <p className="text-xs text-white/45">{t('vipDonations.invoice.keepPageSubtitle')}</p>
                    </div>
                  </div>

                  <div className="text-sm leading-6 text-white/58">
                    <p>{t('vipDonations.invoice.keepPageText1')}</p>
                    <p className="mt-2">{t('vipDonations.invoice.keepPageText2')}</p>
                  </div>

                  <a
                    href={invoice.supportTelegramUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#229ED9] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#229ED9]/80"
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t('vipDonations.invoice.supportButton')}
                  </a>
                </div>
              </AnimatedBorderCard>
            </div>
          </div>
        </div>
      </div>
    </SquareBackground>
  );
};

export default VipInvoicePage;
