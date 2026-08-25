import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PrefetchLink as Link } from '@/routing/PrefetchLink';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  CreditCard,
  Crown,
  ExternalLink,
  Gem,
  Gift,
  KeyRound,
  Loader2,
  Mail,
  ShieldCheck,
  Sparkles,
  Wallet
} from 'lucide-react';
import { toast } from 'sonner';

import TurnstileWidget from '../components/TurnstileWidget';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import BlurText from '../components/ui/blur-text';
import { Button } from '../components/ui/button';
import ShinyText from '../components/ui/shiny-text';
import { SquareBackground } from '../components/ui/square-background';
import { createVipInvoice, VipRecipientMode } from '../services/vipDonationsService';
import {
  TURNSTILE_SITE_KEY,
  VipDisplayedPaymentMethod,
  formatVipFiat,
  getVipDurationLabel,
  getVipPaymentLabel
} from '../utils/vipDonationsUi';
import { rememberVipInvoice } from '../utils/vipInvoiceHistory';

const PACKS = [
  { amount: 5, years: 1, accent: 'from-yellow-500/20 to-transparent' },
  { amount: 7, years: 1.5, accent: 'from-emerald-500/20 to-transparent' },
  { amount: 10, years: 2, accent: 'from-orange-500/20 to-transparent' },
  { amount: 15, years: 3, accent: 'from-amber-400/15 to-transparent' },
  { amount: 20, years: 4, accent: 'from-red-500/15 to-transparent' }
] as const;

const PAYMENT_IMAGES = {
  btc: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Bitcoin.svg/1280px-Bitcoin.svg.png',
  ltc: 'https://upload.wikimedia.org/wikipedia/commons/f/f8/LTC-400.png'
} as const;

const SUPPORT_TELEGRAM_URL = import.meta.env.VITE_SUPPORT_TELEGRAM_URL || 'https://t.me/movix_site';
const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const VipDonatePage: React.FC = () => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [selectedPack, setSelectedPack] = useState<number>(5);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<VipDisplayedPaymentMethod>('btc');
  const [recipientMode, setRecipientMode] = useState<VipRecipientMode>('self');
  const [payerEmail, setPayerEmail] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileResetSignal, setTurnstileResetSignal] = useState(0);

  const activePack = useMemo(
    () => PACKS.find((pack) => pack.amount === selectedPack) || PACKS[0],
    [selectedPack]
  );
  const isCryptoGateSelected = selectedPaymentMethod === 'cryptogate';
  const emailRequiredByMethod = isCryptoGateSelected;
  const nextSteps = useMemo(() => ([
    t('vipDonations.page.nextStep1'),
    t('vipDonations.page.nextStep2'),
    t('vipDonations.page.nextStep3'),
    t('vipDonations.page.nextStep4')
  ]), [t]);

  const paymentMethods = useMemo<Array<{
    value: VipDisplayedPaymentMethod;
    label: string;
    helper: string;
    image?: string;
    ticker: string;
    accentTone: string;
  }>>(() => {
    const methods: Array<{
      value: VipDisplayedPaymentMethod;
      label: string;
      helper: string;
      image?: string;
      ticker: string;
      accentTone: string;
    }> = [
      {
        value: 'btc',
        label: 'Bitcoin',
        helper: t('vipDonations.page.bitcoinPayment'),
        image: PAYMENT_IMAGES.btc,
        ticker: 'BTC',
        accentTone: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300'
      },
      {
        value: 'ltc',
        label: 'Litecoin',
        helper: t('vipDonations.page.litecoinPayment'),
        image: PAYMENT_IMAGES.ltc,
        ticker: 'LTC',
        accentTone: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100'
      },
      {
        value: 'cryptogate',
        label: 'CryptoGate',
        helper: t('vipDonations.page.cryptogatePayment'),
        ticker: t('vipDonations.payment.cryptogateShort'),
        accentTone: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
      }
    ];

    return methods;
  }, [t]);

  const recipientOptions = useMemo<Array<{
    value: VipRecipientMode;
    title: string;
    description: string;
    icon: typeof KeyRound;
    accent: string;
  }>>(
    () => [
      {
        value: 'self',
        title: t('vipDonations.page.selfTitle'),
        description: t('vipDonations.page.selfDescription'),
        icon: KeyRound,
        accent: 'text-yellow-400'
      },
      {
        value: 'gift',
        title: t('vipDonations.page.giftTitle'),
        description: t('vipDonations.page.giftDescription'),
        icon: Gift,
        accent: 'text-cyan-300'
      }
    ],
    [t]
  );

  const canSubmit = !isCreating
    && (!TURNSTILE_SITE_KEY || Boolean(turnstileToken))
    && (!emailRequiredByMethod || isValidEmail(payerEmail));

  const handleCreateInvoice = async () => {
    const invoicePaymentMethod = selectedPaymentMethod;

    if (!canSubmit) {
      if (emailRequiredByMethod && !isValidEmail(payerEmail)) {
        toast.error(t('vipDonations.page.cryptogateEmailError'));
      } else {
        toast.error(t('vipDonations.common.turnstileRequired'));
      }
      return;
    }

    try {
      setIsCreating(true);
      const invoice = await createVipInvoice(
        selectedPack,
        invoicePaymentMethod,
        recipientMode,
        {
          payerEmail: emailRequiredByMethod ? payerEmail.trim() : undefined,
          turnstileToken: TURNSTILE_SITE_KEY ? turnstileToken : undefined
        }
      );
      toast.success(t('vipDonations.page.saveUrlTitle'));
      rememberVipInvoice(invoice.publicId);
      if (invoice.paymentMethod === 'cryptogate' && invoice.checkoutUrl) {
        window.open(invoice.checkoutUrl, '_blank', 'noopener,noreferrer');
      }
      navigate(invoice.invoicePath);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('vipDonations.invoice.loadError'));
      setTurnstileResetSignal((value) => value + 1);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <SquareBackground
      squareSize={48}
      borderColor="rgba(234, 179, 8, 0.12)"
      className="min-h-screen bg-black text-white"
    >
      <div className="container mx-auto px-4 py-8 sm:px-6 sm:py-12 relative z-10">
        <Link to="/vip" className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-5 h-5 mr-2" />
          {t('vipDonations.page.backVip')}
        </Link>

        <div className="max-w-6xl mx-auto space-y-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center space-y-6"
          >
            <div className="inline-flex items-center justify-center p-3 bg-yellow-500/10 rounded-full ring-1 ring-yellow-500/50">
              <Crown className="w-8 h-8 text-yellow-500" />
            </div>

            <div className="space-y-4">
              <BlurText
                text={t('vipDonations.page.heroTitle')}
                delay={220}
                animateBy="words"
                direction="top"
                className="text-4xl md:text-6xl font-bold text-white justify-center"
              />
              <p className="text-base md:text-lg text-white/60 max-w-3xl mx-auto leading-relaxed">
                {t('vipDonations.page.heroDescription', {
                  amount: formatVipFiat(i18n.language, activePack.amount, 'EUR'),
                  duration: getVipDurationLabel(t, activePack.years, 'vip')
                })}
              </p>
              <div className="inline-flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-4 py-2">
                <Sparkles className="h-4 w-4 text-yellow-400" />
                <ShinyText
                  text={t('vipDonations.page.ruleValue', {
                    amount: activePack.amount,
                    duration: getVipDurationLabel(t, activePack.years, 'vip')
                  })}
                  speed={2}
                  color="#fbbf24"
                  shineColor="#ffffff"
                  className="text-sm font-semibold"
                />
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
            className="grid gap-4 md:grid-cols-3"
          >
            {[
              {
                title: t('vipDonations.page.stepForWhomTitle'),
                text: t('vipDonations.page.stepForWhomText')
              },
              {
                title: t('vipDonations.page.stepPaymentTitle'),
                text: t('vipDonations.page.stepPaymentText')
              },
              {
                title: t('vipDonations.page.stepDeliveryTitle'),
                text: t('vipDonations.page.stepDeliveryText')
              }
            ].map((step) => (
              <AnimatedBorderCard
                key={step.title}
                highlightColor="234 179 8"
                backgroundColor="10 10 10"
                className="p-5 backdrop-blur-sm"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-yellow-400/80">
                  {step.title}
                </p>
                <p className="mt-3 text-sm leading-6 text-white/60">{step.text}</p>
              </AnimatedBorderCard>
            ))}
          </motion.div>

          <div className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
            <AnimatedBorderCard
              highlightColor="234 179 8"
              backgroundColor="10 10 10"
              className="p-6 sm:p-8 backdrop-blur-sm"
            >
              <div className="space-y-8">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-yellow-500/10 ring-1 ring-yellow-500/20">
                    <Wallet className="w-6 h-6 text-yellow-500" />
                  </div>
                  <div>
                    <ShinyText
                      text={t('vipDonations.page.packTitle')}
                      speed={2}
                      color="#fbbf24"
                      shineColor="#ffffff"
                      className="text-2xl font-bold"
                    />
                    <p className="text-sm text-white/50 mt-1">{t('vipDonations.page.packDescription')}</p>
                  </div>
                </div>

                <div className="grid grid-cols-[repeat(auto-fit,minmax(185px,1fr))] gap-4">
                  {PACKS.map((pack) => {
                    const isActive = pack.amount === selectedPack;
                    return (
                      <button
                        key={pack.amount}
                        type="button"
                        onClick={() => setSelectedPack(pack.amount)}
                        className={`relative min-h-[228px] min-w-0 overflow-hidden rounded-2xl border p-5 text-left transition-all ${
                          isActive
                            ? 'border-yellow-500/60 bg-yellow-500/10 shadow-[0_20px_45px_rgba(234,179,8,0.18)]'
                            : 'border-white/10 bg-white/[0.03] hover:border-yellow-500/30 hover:bg-white/[0.05]'
                        }`}
                      >
                        <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${pack.accent} opacity-100`} />
                        <div className="relative z-10">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/35">Pack</p>
                          <p className="mt-3 text-[2rem] font-black leading-none text-white sm:text-3xl">
                            {formatVipFiat(i18n.language, pack.amount, 'EUR')}
                          </p>
                          <div className="mt-2">
                            <ShinyText
                              text={getVipDurationLabel(t, pack.years, 'vip')}
                              speed={2}
                              color="#fbbf24"
                              shineColor="#ffffff"
                              className="text-sm font-bold"
                            />
                          </div>
                          <p className="mt-5 text-xs leading-5 text-white/48">
                            {t('vipDonations.page.packFootnote', {
                              duration: getVipDurationLabel(t, pack.years, 'vip')
                            })}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="grid gap-8 lg:grid-cols-2">
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-yellow-500/10">
                        <Gem className="w-5 h-5 text-yellow-500" />
                      </div>
                      <h3 className="text-sm font-semibold uppercase tracking-[0.22em] text-white/40">
                        {t('vipDonations.page.paymentTitle')}
                      </h3>
                    </div>
                    <div className="grid gap-3">
                      {paymentMethods.map((paymentMethod) => {
                        const isActive = paymentMethod.value === selectedPaymentMethod;
                        return (
                          <button
                            key={paymentMethod.value}
                            type="button"
                            onClick={() => setSelectedPaymentMethod(paymentMethod.value)}
                            className={`rounded-2xl border p-4 text-left transition-all ${
                              isActive
                                ? 'border-yellow-500/55 bg-yellow-500/10'
                                : 'border-white/10 bg-white/[0.03] hover:border-yellow-500/30 hover:bg-white/[0.05]'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex min-w-0 items-start gap-3">
                                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[18px] bg-white/[0.04] ring-1 ring-inset ring-white/10">
                                  {paymentMethod.image ? (
                                    <img src={paymentMethod.image} alt={paymentMethod.label} className="h-8 w-8 object-contain" loading="lazy" />
                                  ) : (
                                    <CreditCard className="h-6 w-6 text-emerald-200" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-lg font-semibold leading-tight text-white">{paymentMethod.label}</p>
                                  <p className="mt-1 text-sm leading-6 text-white/45">{paymentMethod.helper}</p>
                                </div>
                              </div>
                              <span
                                className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${paymentMethod.accentTone}`}
                              >
                                {paymentMethod.ticker}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {emailRequiredByMethod && (
                      <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/8 p-4">
                        <div className="flex items-start gap-3">
                          <div className="rounded-xl bg-black/30 p-2.5">
                            <Mail className="h-5 w-5 text-emerald-200" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-white">{t('vipDonations.page.cryptogateEmailTitle')}</p>
                            <p className="mt-1 text-sm leading-6 text-white/55">{t('vipDonations.page.cryptogateEmailDescription')}</p>
                            <input
                              type="email"
                              inputMode="email"
                              autoComplete="email"
                              value={payerEmail}
                              onChange={(event) => setPayerEmail(event.target.value)}
                              placeholder={t('vipDonations.page.cryptogateEmailPlaceholder')}
                              className="mt-4 h-12 w-full rounded-xl border border-white/10 bg-black/30 px-4 text-sm text-white outline-none transition focus:border-emerald-300/50"
                            />
                            <p className="mt-2 text-xs text-white/40">
                              {isValidEmail(payerEmail) || payerEmail.trim() === ''
                                ? t('vipDonations.page.cryptogateEmailHint')
                                : t('vipDonations.page.cryptogateEmailError')}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-cyan-400/10">
                        <Gift className="w-5 h-5 text-cyan-300" />
                      </div>
                      <h3 className="text-sm font-semibold uppercase tracking-[0.22em] text-white/40">
                        {t('vipDonations.page.recipientTitle')}
                      </h3>
                    </div>
                    <div className="grid gap-3">
                      {recipientOptions.map((option) => {
                        const isActive = option.value === recipientMode;
                        const Icon = option.icon;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setRecipientMode(option.value)}
                            className={`rounded-2xl border p-4 text-left transition-all ${
                              isActive
                                ? 'border-cyan-400/55 bg-cyan-400/10'
                                : 'border-white/10 bg-white/[0.03] hover:border-cyan-400/30 hover:bg-white/[0.05]'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <div className="p-2.5 rounded-xl bg-black/30">
                                <Icon className={`h-5 w-5 ${option.accent}`} />
                              </div>
                              <div>
                                <p className="font-semibold text-white">{option.title}</p>
                                <p className="mt-1 text-sm leading-6 text-white/55">{option.description}</p>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="border-t border-white/10 pt-6">
                  <div className="flex items-start gap-3">
                    <div className="bg-yellow-500/15 p-2.5 rounded-xl">
                      <ShieldCheck className="h-5 w-5 text-yellow-300" />
                    </div>
                    <div>
                      <p className="font-semibold text-yellow-100">{t('vipDonations.page.saveUrlTitle')}</p>
                      <p className="mt-2 text-sm leading-6 text-yellow-100/75">{t('vipDonations.page.saveUrlDescription')}</p>
                    </div>
                  </div>
                </div>
              </div>
            </AnimatedBorderCard>

            <div className="space-y-6">
              <AnimatedBorderCard
                highlightColor="234 179 8"
                backgroundColor="10 10 10"
                className="p-6 sm:p-7 backdrop-blur-sm"
              >
                <div className="space-y-5">
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-xl bg-yellow-500/10 ring-1 ring-yellow-500/20">
                      <Crown className="h-6 w-6 text-yellow-500" />
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-white/35">
                        {t('vipDonations.page.summaryTitle')}
                      </p>
                      <ShinyText
                        text={getVipDurationLabel(t, activePack.years, 'vip')}
                        speed={2}
                        color="#fbbf24"
                        shineColor="#ffffff"
                        className="text-2xl font-bold"
                      />
                    </div>
                  </div>

                  <div className="divide-y divide-white/10 text-sm">
                    <div className="flex items-center justify-between py-3 text-white/65 first:pt-0">
                      <span>{t('vipDonations.page.amountLabel')}</span>
                      <span className="font-semibold text-white">{formatVipFiat(i18n.language, activePack.amount, 'EUR')}</span>
                    </div>
                    <div className="flex items-center justify-between py-3 text-white/65">
                      <span>{t('vipDonations.page.paymentLabel')}</span>
                      <span className="font-semibold text-white">
                        {getVipPaymentLabel(t, selectedPaymentMethod)}
                      </span>
                    </div>
                    {emailRequiredByMethod && (
                      <div className="flex items-center justify-between py-3 text-white/65">
                        <span>{t('vipDonations.page.emailLabel')}</span>
                        <span className="max-w-[180px] truncate font-semibold text-white">
                          {payerEmail.trim() || t('vipDonations.page.emailPending')}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between py-3 text-white/65">
                      <span>{t('vipDonations.page.recipientLabel')}</span>
                      <span className="font-semibold text-white">
                        {recipientMode === 'self'
                          ? t('vipDonations.page.recipientSelfShort')
                          : t('vipDonations.page.recipientGiftShort')}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-3 pb-0 text-white/65">
                      <span>{t('vipDonations.page.vipLabel')}</span>
                      <span className="font-semibold text-yellow-300">
                        {getVipDurationLabel(t, activePack.years, 'vip')}
                      </span>
                    </div>
                  </div>

                  {TURNSTILE_SITE_KEY && (
                    <div className="border-t border-white/10 pt-5">
                      <p className="text-sm font-semibold text-white">{t('vipDonations.page.turnstileTitle')}</p>
                      <p className="mt-1 text-xs leading-5 text-white/45">{t('vipDonations.page.turnstileDescription')}</p>
                      <div className="mt-4 flex overflow-x-auto">
                        <TurnstileWidget
                          action="vip_invoice_create"
                          resetSignal={turnstileResetSignal}
                          onTokenChange={setTurnstileToken}
                          className="origin-left scale-[0.9] sm:scale-100"
                        />
                      </div>
                    </div>
                  )}

                  <Button
                    className="h-12 w-full bg-yellow-500 text-black hover:bg-yellow-400"
                    onClick={handleCreateInvoice}
                    disabled={!canSubmit}
                  >
                    {isCreating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t('vipDonations.page.creatingButton')}
                      </>
                    ) : (
                      <>
                        <Wallet className="mr-2 h-4 w-4" />
                        {t('vipDonations.page.createButton')}
                      </>
                    )}
                  </Button>

                  <Link
                    to="/vip/invoices"
                    className="inline-flex h-12 w-full items-center justify-center rounded-lg border border-white/15 bg-transparent px-4 text-sm font-semibold text-white transition-colors hover:bg-white/5"
                  >
                    {t('vipDonations.page.myInvoicesButton')}
                  </Link>

                  <div className="border-t border-white/10 pt-5 text-sm text-white/58">
                    <p className="font-medium text-white/80">{t('vipDonations.page.nextStepsTitle')}</p>
                    <div className="mt-3 space-y-2 leading-6">
                      {nextSteps.map((step) => (
                        <p key={step}>{step}</p>
                      ))}
                    </div>
                  </div>
                </div>
              </AnimatedBorderCard>

              <AnimatedBorderCard
                highlightColor="56 189 248"
                backgroundColor="10 10 10"
                className="p-6 backdrop-blur-sm"
              >
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="p-3 rounded-xl bg-cyan-400/10 ring-1 ring-cyan-400/20">
                      <ExternalLink className="h-5 w-5 text-cyan-300" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-white">{t('vipDonations.page.supportTitle')}</h3>
                      <p className="text-sm text-white/45">{t('vipDonations.page.supportDescription')}</p>
                    </div>
                  </div>

                  <a
                    href={SUPPORT_TELEGRAM_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#229ED9] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#229ED9]/80"
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t('vipDonations.page.supportButton')}
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

export default VipDonatePage;
