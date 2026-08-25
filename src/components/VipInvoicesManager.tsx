import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Gift,
  RefreshCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles
} from 'lucide-react';

import {
  adminCancelVipInvoice,
  adminCheckVipInvoice,
  adminValidateVipInvoice,
  getVipInvoiceDetails,
  listVipInvoices,
  VipAdminInvoice,
  VipInvoiceEvent
} from '../services/vipDonationsService';
import {
  formatVipCrypto,
  formatVipDateTime,
  formatVipFiat,
  getVipDurationLabel,
  getVipPaymentLabel,
  getVipStatusMeta
} from '../utils/vipDonationsUi';
import ReusableModal from './ui/reusable-modal';
import AnimatedBorderCard from './ui/animated-border-card';
import BlurText from './ui/blur-text';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select';
import ShinyText from './ui/shiny-text';

const PAGE_SIZE = 20;

const statusClassMap: Record<string, string> = {
  awaiting_payment: 'bg-yellow-500/15 text-yellow-200 border-yellow-400/35',
  partial_payment: 'bg-orange-500/15 text-orange-200 border-orange-400/35',
  confirming: 'bg-cyan-500/15 text-cyan-100 border-cyan-300/35',
  paid: 'bg-emerald-500/15 text-emerald-100 border-emerald-300/35',
  delivered: 'bg-emerald-500/15 text-emerald-100 border-emerald-300/35',
  expired: 'bg-white/10 text-white/80 border-white/20',
  cancelled: 'bg-red-500/15 text-red-100 border-red-400/35'
};

const statusHighlightMap: Record<string, string> = {
  awaiting_payment: '234 179 8',
  partial_payment: '249 115 22',
  confirming: '56 189 248',
  paid: '34 197 94',
  delivered: '34 197 94',
  expired: '148 163 184',
  cancelled: '239 68 68'
};

type AdminInvoiceAction = 'check' | 'validate' | 'cancel';
type PendingAdminAction = {
  invoice: VipAdminInvoice;
  action: AdminInvoiceAction;
};

const VipInvoicesManager: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [invoices, setInvoices] = useState<VipAdminInvoice[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<VipAdminInvoice | null>(null);
  const [events, setEvents] = useState<VipInvoiceEvent[]>([]);
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAdminAction | null>(null);

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('vipDonations.admin.allStatuses') },
      { value: 'awaiting_payment', label: getVipStatusMeta(t, 'awaiting_payment').label },
      { value: 'partial_payment', label: t('vipDonations.admin.partialShort') },
      { value: 'confirming', label: t('vipDonations.admin.confirmingShort') },
      { value: 'paid', label: getVipStatusMeta(t, 'paid').label },
      { value: 'delivered', label: t('vipDonations.admin.deliveredShort') },
      { value: 'expired', label: t('vipDonations.admin.expiredShort') },
      { value: 'cancelled', label: t('vipDonations.admin.cancelledShort') }
    ],
    [t]
  );

  const filteredLabel = useMemo(
    () => statusOptions.find((option) => option.value === statusFilter)?.label || t('vipDonations.admin.allStatuses'),
    [statusFilter, statusOptions, t]
  );
  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);
  const visiblePages = useMemo(() => {
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    const normalizedStart = Math.max(1, end - 4);

    return Array.from({ length: end - normalizedStart + 1 }, (_, index) => normalizedStart + index);
  }, [page, totalPages]);

  const loadInvoices = useCallback(async (requestedPage: number) => {
    try {
      setIsLoading(true);
      const result = await listVipInvoices({
        status: statusFilter,
        search,
        page: requestedPage,
        limit: PAGE_SIZE
      });

      setInvoices(result.invoices);
      setTotal(result.total);
      setHasMore(result.hasMore);
      setPage(result.page);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('vipDonations.admin.loadError'));
    } finally {
      setIsLoading(false);
    }
  }, [search, statusFilter, t]);

  useEffect(() => {
    void loadInvoices(1);
  }, [loadInvoices, statusFilter]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadInvoices(1);
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [search, loadInvoices]);

  const handleOpenDetails = async (invoice: VipAdminInvoice) => {
    try {
      setSelectedInvoice(invoice);
      setEvents([]);
      setDetailsOpen(true);
      const details = await getVipInvoiceDetails(invoice.id);
      setSelectedInvoice(details.invoice);
      setEvents(details.events);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('vipDonations.admin.detailsError'));
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

  const handleAdminAction = async (invoiceId: number, action: AdminInvoiceAction) => {
    try {
      setProcessingId(invoiceId);
      let updatedInvoice: VipAdminInvoice;

      if (action === 'check') {
        updatedInvoice = await adminCheckVipInvoice(invoiceId);
      } else if (action === 'validate') {
        updatedInvoice = await adminValidateVipInvoice(invoiceId);
      } else {
        updatedInvoice = await adminCancelVipInvoice(invoiceId);
      }

      setInvoices((current) => current.map((invoice) => (
        invoice.id === invoiceId ? updatedInvoice : invoice
      )));

      if (selectedInvoice?.id === invoiceId) {
        const details = await getVipInvoiceDetails(invoiceId);
        setSelectedInvoice(details.invoice);
        setEvents(details.events);
      }

      if (action === 'check') {
        toast.success(t('vipDonations.admin.checkSuccess'));
      } else if (action === 'validate') {
        toast.success(t('vipDonations.admin.validateSuccess'));
      } else {
        toast.success(t('vipDonations.admin.cancelSuccess'));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('vipDonations.admin.actionError'));
    } finally {
      setProcessingId(null);
    }
  };

  const handleAdminActionWithConfirmation = (invoice: VipAdminInvoice, action: AdminInvoiceAction) => {
    if (processingId === invoice.id) {
      return;
    }

    setPendingAction({ invoice, action });
  };

  const handleRefresh = () => {
    void loadInvoices(page);
  };

  const getActionLabel = (action: AdminInvoiceAction) => (
    action === 'check'
      ? t('vipDonations.admin.checkButton')
      : action === 'validate'
        ? t('vipDonations.admin.validateButton')
        : t('vipDonations.admin.cancelButton')
  );

  const getActionConfirmationMessage = (action: AdminInvoiceAction, publicId: string) => (
    action === 'check'
      ? t('vipDonations.admin.checkConfirm', { publicId })
      : action === 'validate'
        ? t('vipDonations.admin.validateConfirm', { publicId })
        : t('vipDonations.admin.cancelConfirm', { publicId })
  );

  const handleConfirmPendingAction = () => {
    if (!pendingAction) {
      return;
    }

    const { invoice, action } = pendingAction;
    setPendingAction(null);
    void handleAdminAction(invoice.id, action);
  };

  return (
    <div className="space-y-6">
      <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="10 10 10" className="p-6 md:p-7">
        <div className="space-y-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-yellow-500/25 bg-yellow-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.22em] text-yellow-200">
                <Sparkles className="h-4 w-4" />
                {t('vipDonations.admin.dashboardTitle')}
              </div>
              <div>
                <ShinyText
                  text={t('vipDonations.admin.dashboardTitle')}
                  speed={2}
                  color="#fbbf24"
                  shineColor="#ffffff"
                  className="text-3xl font-bold"
                />
                <p className="mt-2 text-sm leading-6 text-white/55">{t('vipDonations.admin.dashboardDescription')}</p>
              </div>
            </div>

            <div className="text-right xl:max-w-xs">
              <p className="text-xs uppercase tracking-[0.22em] text-white/30">{filteredLabel}</p>
              <BlurText
                text={t('vipDonations.admin.countSummary', { count: total, label: filteredLabel })}
                delay={40}
                className="mt-2 text-sm font-medium text-white/75"
              />
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1fr_auto]">
            <div className="flex items-center gap-3 rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
          <Search className="h-4 w-4 text-white opacity-[0.35]" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('vipDonations.admin.searchPlaceholder')}
                className="w-full bg-transparent text-sm text-white outline-none placeholder:text-white/25"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-8 w-[180px] rounded-md border-white/10 bg-transparent px-3 text-xs hover:bg-white/10">
                  <span className="truncate">{filteredLabel}</span>
                </SelectTrigger>
                <SelectContent className="rounded-md border-white/10 bg-[#111111]/95">
                  {statusOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={handleRefresh} disabled={isLoading}>
                <RefreshCcw className={`mr-1 h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                {t('vipDonations.admin.refreshButton')}
              </Button>
            </div>
          </div>
        </div>
      </AnimatedBorderCard>

      {isLoading ? (
        <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="10 10 10" className="p-10 text-center">
          <p className="text-white/55">{t('vipDonations.admin.loading')}</p>
        </AnimatedBorderCard>
      ) : invoices.length === 0 ? (
        <AnimatedBorderCard highlightColor="148 163 184" backgroundColor="10 10 10" className="p-10 text-center">
          <p className="text-white/45">{t('vipDonations.admin.empty')}</p>
        </AnimatedBorderCard>
      ) : (
        <div className="space-y-4">
          {invoices.map((invoice) => {
            const statusMeta = getVipStatusMeta(t, invoice.status);
            const paymentLabel = getVipPaymentLabel(t, invoice.paymentMethod, invoice.coin);
            const amountSummary = invoice.paymentMethod === 'cryptogate'
              || invoice.paymentMethod === 'payblis'
              ? formatVipFiat(i18n.language, invoice.amountEur, 'EUR')
              : invoice.paymentMethod === 'paygate_hosted'
                ? `${formatVipFiat(i18n.language, invoice.amountEur, 'EUR')} - ${formatVipFiat(i18n.language, invoice.amountUsd, 'USD')}`
                : `${formatVipFiat(i18n.language, invoice.amountEur, 'EUR')} - ${formatVipCrypto(i18n.language, invoice.amountCryptoExpected || 0)} ${(invoice.coin || '').toUpperCase()}`;
            const addressPreview = (invoice.trackingAddress || invoice.paymentAddress || '-');

            return (
              <AnimatedBorderCard
                key={invoice.id}
                highlightColor={statusHighlightMap[invoice.status] || '234 179 8'}
                backgroundColor="10 10 10"
                className="p-5"
              >
                <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <code className="rounded-2xl bg-white/[0.04] px-3 py-2 text-sm font-semibold text-white">
                        {invoice.publicId}
                      </code>
                      <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${statusClassMap[invoice.status] || 'bg-white/10 text-white/80 border-white/20'}`}>
                        {statusMeta.label}
                      </span>
                      {invoice.recipientMode === 'gift' && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs font-semibold text-cyan-100">
                          <Gift className="h-3.5 w-3.5" />
                          {t('vipDonations.page.giftTitle')}
                        </span>
                      )}
                    </div>

                    <div className="grid gap-3 text-sm text-white/58 md:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <p className="text-white/30">{t('vipDonations.admin.amountLabel')}</p>
                        <p className="font-semibold text-white">{amountSummary}</p>
                      </div>
                      <div>
                        <p className="text-white/30">{t('vipDonations.admin.addressLabel')}</p>
                        <p className="font-semibold text-white">{addressPreview.length > 18 ? `${addressPreview.slice(0, 18)}...` : addressPreview}</p>
                      </div>
                      <div>
                        <p className="text-white/30">{t('vipDonations.admin.paymentMethodLabel')}</p>
                        <p className="font-semibold text-white">{paymentLabel}</p>
                      </div>
                      <div>
                        <p className="text-white/30">{t('vipDonations.admin.createdAtLabel')}</p>
                        <p className="font-semibold text-white">{formatVipDateTime(i18n.language, invoice.createdAt)}</p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 xl:justify-end">
                    <Button size="sm" variant="outline" onClick={() => handleOpenDetails(invoice)}>
                      {t('vipDonations.admin.viewButton')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleAdminActionWithConfirmation(invoice, 'check')}
                      disabled={processingId === invoice.id}
                    >
                      <RefreshCcw className="mr-1 h-3.5 w-3.5" />
                      {t('vipDonations.admin.checkButton')}
                    </Button>
                    <Button
                      size="sm"
                      className="bg-emerald-600 text-white hover:bg-emerald-700"
                      onClick={() => handleAdminActionWithConfirmation(invoice, 'validate')}
                      disabled={processingId === invoice.id || invoice.status === 'delivered' || invoice.status === 'cancelled'}
                    >
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                      {t('vipDonations.admin.validateButton')}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleAdminActionWithConfirmation(invoice, 'cancel')}
                      disabled={processingId === invoice.id || invoice.status === 'delivered' || invoice.status === 'cancelled'}
                    >
                      <ShieldAlert className="mr-1 h-3.5 w-3.5" />
                      {t('vipDonations.admin.cancelButton')}
                    </Button>
                  </div>
                </div>
              </AnimatedBorderCard>
            );
          })}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-white/45">
            {t('vipDonations.admin.pageSummary', {
              page,
              total
            })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1 || isLoading} onClick={() => void loadInvoices(page - 1)}>
              {t('common.previous')}
            </Button>
            {visiblePages.map((pageNumber) => (
              <Button
                key={pageNumber}
                size="sm"
                variant={pageNumber === page ? 'default' : 'outline'}
                className={pageNumber === page ? 'bg-yellow-500 text-black hover:bg-yellow-400' : undefined}
                disabled={isLoading}
                onClick={() => void loadInvoices(pageNumber)}
              >
                {pageNumber}
              </Button>
            ))}
            <Button size="sm" variant="outline" disabled={!hasMore || isLoading || page >= totalPages} onClick={() => void loadInvoices(page + 1)}>
              {t('common.next')}
            </Button>
          </div>
        </div>
      )}

      <ReusableModal
        isOpen={Boolean(pendingAction)}
        onClose={() => setPendingAction(null)}
        title={t('common.confirm')}
        className="max-w-lg"
      >
        {pendingAction ? (
          <div className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-yellow-200">
                  {getActionLabel(pendingAction.action)}
                </span>
                <code className="rounded-xl bg-black/30 px-3 py-1.5 text-xs font-semibold text-white">
                  {pendingAction.invoice.publicId}
                </code>
              </div>
              <p className="mt-4 text-sm leading-6 text-white/70">
                {getActionConfirmationMessage(pendingAction.action, pendingAction.invoice.publicId)}
              </p>
            </div>

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setPendingAction(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleConfirmPendingAction}
                variant={pendingAction.action === 'cancel' ? 'destructive' : 'default'}
                className={pendingAction.action === 'validate' ? 'bg-emerald-600 text-white hover:bg-emerald-700' : undefined}
              >
                {getActionLabel(pendingAction.action)}
              </Button>
            </div>
          </div>
        ) : null}
      </ReusableModal>

      <ReusableModal
        isOpen={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title={selectedInvoice ? t('vipDonations.admin.detailsModalTitle', { publicId: selectedInvoice.publicId }) : t('vipDonations.admin.detailsSectionTitle')}
        className="max-w-5xl"
      >
        {selectedInvoice ? (
          <div className="space-y-6">
            <div className="grid gap-4 lg:grid-cols-[0.52fr_0.48fr]">
              <AnimatedBorderCard highlightColor={statusHighlightMap[selectedInvoice.status] || '234 179 8'} backgroundColor="10 10 10" className="p-5">
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-white">{t('vipDonations.admin.detailsSectionTitle')}</h3>
                  <div className="grid gap-3 text-sm text-white/60 sm:grid-cols-2">
                    <div>
                      <p className="text-white/30">{t('vipDonations.admin.statusLabel')}</p>
                      <p className="font-semibold text-white">{getVipStatusMeta(t, selectedInvoice.status).label}</p>
                    </div>
                    <div>
                      <p className="text-white/30">{t('vipDonations.admin.paymentMethodLabel')}</p>
                      <p className="font-semibold text-white">{getVipPaymentLabel(t, selectedInvoice.paymentMethod, selectedInvoice.coin)}</p>
                    </div>
                    <div>
                      <p className="text-white/30">{t('vipDonations.admin.packLabel')}</p>
                      <p className="font-semibold text-white">{formatVipFiat(i18n.language, selectedInvoice.amountEur, 'EUR')}</p>
                    </div>
                    <div>
                      <p className="text-white/30">{t('vipDonations.admin.vipLabel')}</p>
                      <p className="font-semibold text-yellow-300">{getVipDurationLabel(t, selectedInvoice.vipYears, 'vip')}</p>
                    </div>
                    <div>
                      <p className="text-white/30">{t('vipDonations.admin.txHashLabel')}</p>
                      <p className="break-all font-semibold text-white">{selectedInvoice.paidTxid || selectedInvoice.txHash || '-'}</p>
                    </div>
                    <div>
                      <p className="text-white/30">{t('vipDonations.admin.derivationLabel')}</p>
                      <p className="font-semibold text-white">
                        {selectedInvoice.derivationIndex === null ? '-' : `#${selectedInvoice.derivationIndex}`}
                      </p>
                    </div>
                    <div>
                      <p className="text-white/30">{t('vipDonations.admin.payerEmailLabel')}</p>
                      <p className="break-all font-semibold text-white">{selectedInvoice.payerEmail || '-'}</p>
                    </div>
                    <div>
                      <p className="text-white/30">{t('vipDonations.admin.paidValueLabel')}</p>
                      <p className="font-semibold text-white">
                        {selectedInvoice.paidValue !== null
                          ? `${formatVipFiat(i18n.language, selectedInvoice.paidValue, 'USD')} ${selectedInvoice.paidCoin ? `(${selectedInvoice.paidCoin})` : ''}`.trim()
                          : selectedInvoice.externalAmount !== null
                            ? `${selectedInvoice.externalAmount.toFixed(2)} ${selectedInvoice.externalCurrency || ''}`.trim()
                          : '-'}
                      </p>
                    </div>
                  </div>

                  <div className="border-t border-white/10 pt-4">
                    <p className="text-white/30">{t('vipDonations.admin.addressLabel')}</p>
                    <div className="mt-2 flex items-center gap-2 rounded-2xl bg-white/[0.04] px-4 py-3 ring-1 ring-inset ring-white/10">
                      <code className="min-w-0 flex-1 break-all text-xs text-white">{selectedInvoice.trackingAddress || selectedInvoice.paymentAddress || '-'}</code>
                      <button
                        type="button"
                        onClick={() => void handleCopy(selectedInvoice.trackingAddress || selectedInvoice.paymentAddress || '', t('vipDonations.common.copyAddressSuccess'))}
                        className="rounded-2xl border border-white/10 p-2 text-white/50 transition-colors hover:border-white/20 hover:text-white"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {selectedInvoice.vipKey && (
                    <div className="border-t border-emerald-400/20 pt-4">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-emerald-200" />
                        <p className="text-white/80">{t('vipDonations.admin.deliveredKeyLabel')}</p>
                      </div>
                      <div className="mt-2 flex items-center gap-2 rounded-2xl bg-emerald-400/8 px-4 py-3 ring-1 ring-inset ring-emerald-300/15">
                        <code className="min-w-0 flex-1 break-all text-xs font-semibold text-white">{selectedInvoice.vipKey}</code>
                        <button
                          type="button"
                          onClick={() => void handleCopy(selectedInvoice.vipKey || '', t('vipDonations.common.copyVipKeySuccess'))}
                          className="rounded-2xl border border-white/10 p-2 text-white/50 transition-colors hover:border-white/20 hover:text-white"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </AnimatedBorderCard>

              <AnimatedBorderCard highlightColor="56 189 248" backgroundColor="10 10 10" className="p-5">
                <div className="space-y-4">
                  <h3 className="text-lg font-semibold text-white">{t('vipDonations.admin.publicLinksTitle')}</h3>
                  <div className="divide-y divide-white/10 text-sm text-white/60">
                    <div className="py-4 first:pt-0">
                      <p className="text-white/30">{t('vipDonations.admin.invoiceLabel')}</p>
                      <div className="mt-2 flex items-center gap-2 rounded-2xl bg-white/[0.04] px-4 py-3 ring-1 ring-inset ring-white/10">
                        <code className="min-w-0 flex-1 break-all text-xs text-white">{selectedInvoice.invoiceUrl}</code>
                        <button
                          type="button"
                          onClick={() => void handleCopy(selectedInvoice.invoiceUrl, t('vipDonations.common.copyInvoiceUrlSuccess'))}
                          className="rounded-2xl border border-white/10 p-2 text-white/50 transition-colors hover:border-white/20 hover:text-white"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                        <a
                          href={selectedInvoice.invoiceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-2xl border border-white/10 p-2 text-white/50 transition-colors hover:border-white/20 hover:text-white"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    </div>

                    {selectedInvoice.checkoutUrl && (
                      <div className="py-4">
                        <p className="text-white/30">{t('vipDonations.admin.checkoutLabel')}</p>
                        <div className="mt-2 flex items-center gap-2 rounded-2xl bg-white/[0.04] px-4 py-3 ring-1 ring-inset ring-white/10">
                          <code className="min-w-0 flex-1 break-all text-xs text-white">{selectedInvoice.checkoutUrl}</code>
                          <button
                            type="button"
                            onClick={() => void handleCopy(selectedInvoice.checkoutUrl || '', t('vipDonations.common.copyInvoiceUrlSuccess'))}
                            className="rounded-2xl border border-white/10 p-2 text-white/50 transition-colors hover:border-white/20 hover:text-white"
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                          <a
                            href={selectedInvoice.checkoutUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-2xl border border-white/10 p-2 text-white/50 transition-colors hover:border-white/20 hover:text-white"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </div>
                      </div>
                    )}

                    {selectedInvoice.giftUrl && (
                      <div className="py-4 last:pb-0">
                        <p className="text-white/30">{t('vipDonations.admin.giftLabel')}</p>
                        <div className="mt-2 flex items-center gap-2 rounded-2xl bg-white/[0.04] px-4 py-3 ring-1 ring-inset ring-white/10">
                          <code className="min-w-0 flex-1 break-all text-xs text-white">{selectedInvoice.giftUrl}</code>
                          <button
                            type="button"
                            onClick={() => void handleCopy(selectedInvoice.giftUrl || '', t('vipDonations.common.copyGiftUrlSuccess'))}
                            className="rounded-2xl border border-white/10 p-2 text-white/50 transition-colors hover:border-white/20 hover:text-white"
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                          <a
                            href={selectedInvoice.giftUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-2xl border border-white/10 p-2 text-white/50 transition-colors hover:border-white/20 hover:text-white"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </AnimatedBorderCard>
            </div>

            <AnimatedBorderCard highlightColor="234 179 8" backgroundColor="10 10 10" className="p-5">
              <h3 className="text-lg font-semibold text-white">{t('vipDonations.admin.historyTitle')}</h3>
              <div className="mt-4 space-y-3">
                {events.length === 0 ? (
                  <p className="text-sm text-white/45">{t('vipDonations.admin.noEvents')}</p>
                ) : (
                  events.map((event) => (
                    <div key={event.id} className="border-l-2 border-white/10 pl-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-white">{event.eventType}</p>
                          <p className="text-xs text-white/40">{event.message || t('vipDonations.admin.noMessage')}</p>
                        </div>
                        <p className="text-xs text-white/35">{formatVipDateTime(i18n.language, event.createdAt)}</p>
                      </div>
                      {event.payload && (
                        <pre className="mt-3 overflow-x-auto rounded-2xl bg-[#050505] p-3 text-xs text-white/70 ring-1 ring-inset ring-white/8">
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))
                )}
              </div>
            </AnimatedBorderCard>
          </div>
        ) : (
          <p className="text-sm text-white/45">{t('vipDonations.admin.loadingDetails')}</p>
        )}
      </ReusableModal>
    </div>
  );
};

export default VipInvoicesManager;
