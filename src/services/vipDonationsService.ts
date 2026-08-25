import { MAIN_API } from '../config/runtime';

export type VipInvoiceStatus =
  | 'awaiting_payment'
  | 'partial_payment'
  | 'confirming'
  | 'paid'
  | 'delivered'
  | 'expired'
  | 'cancelled';

export type VipPaymentMethod = 'btc' | 'ltc' | 'cryptogate' | 'paygate_hosted' | 'payblis';
export type VipCoin = Extract<VipPaymentMethod, 'btc' | 'ltc'>;
export type VipRecipientMode = 'self' | 'gift';

export interface VipInvoice {
  publicId: string;
  status: VipInvoiceStatus;
  paymentMethod: VipPaymentMethod | null;
  coin: VipCoin | null;
  packEur: number;
  amountEur: number;
  amountUsd: number;
  amountCryptoExpected: number | null;
  amountCryptoReceived: number | null;
  vipYears: number;
  durationLabel: string;
  recipientMode: VipRecipientMode;
  paymentAddress: string | null;
  trackingAddress: string | null;
  checkoutUrl: string | null;
  addressType: string | null;
  confirmations: number | null;
  requiredConfirmations: number | null;
  expiresAt: string | null;
  paidAt: string | null;
  deliveredAt: string | null;
  createdAt: string | null;
  qrPayload: string | null;
  invoicePath: string;
  invoiceUrl: string;
  giftPath: string | null;
  giftUrl: string | null;
  vipKey: string | null;
  externalOrderId: string | null;
  externalGateway: string | null;
  externalAmount: number | null;
  externalCurrency: string | null;
  supportTelegramUrl: string;
}

export interface VipGift {
  giftToken: string;
  status: 'sealed' | 'unsealed';
  invoiceStatus: VipInvoiceStatus;
  vipYears: number;
  durationLabel: string;
  createdAt: string | null;
  unsealedAt: string | null;
  vipKey: string | null;
  supportTelegramUrl: string;
}

export interface VipAdminInvoice extends VipInvoice {
  id: number;
  derivationIndex: number | null;
  txHash: string | null;
  giftToken: string | null;
  giftSealed: boolean;
  giftUnsealedAt: string | null;
  giftUnsealCount: number;
  createdByUserId: string | null;
  createdByUserType: string | null;
  createdBySessionId: string | null;
  createdIpHash: string | null;
  payerEmail: string | null;
  temporaryWalletAddress: string | null;
  callbackUrl: string | null;
  paidCoin: string | null;
  paidValue: number | null;
  paidTxid: string | null;
  externalOrderId: string | null;
  externalProductId: string | null;
  externalGateway: string | null;
  externalCurrency: string | null;
  externalAmount: number | null;
  reason: string | null;
}

export interface VipInvoiceEvent {
  id: number;
  eventType: string;
  actorType: string | null;
  actorId: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string | null;
}

interface JsonResponse<T> {
  success: boolean;
  error?: string;
  invoice?: T;
  gift?: T;
  invoices?: T[];
}

const getAuthToken = () => localStorage.getItem('auth_token');

type ApiError = Error & {
  statusCode?: number;
};

function normalizeVipCoin(value: unknown): VipCoin | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'btc' || normalized === 'ltc' ? normalized : null;
}

function normalizeVipPaymentMethod(value: unknown, fallbackCoin: unknown = null): VipPaymentMethod | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    normalized === 'btc'
    || normalized === 'ltc'
    || normalized === 'cryptogate'
    || normalized === 'paygate_hosted'
    || normalized === 'payblis'
  ) {
    return normalized;
  }

  return normalizeVipCoin(fallbackCoin);
}

function normalizeVipInvoice<T extends VipInvoice>(invoice: T): T {
  const normalizedCoin = normalizeVipCoin(invoice.coin);

  return {
    ...invoice,
    paymentMethod: normalizeVipPaymentMethod(invoice.paymentMethod, normalizedCoin),
    coin: normalizedCoin
  } as T;
}

function mergeRequestHeaders(headers?: HeadersInit, options: { includeAuth?: boolean } = {}) {
  const mergedHeaders = new Headers(headers);
  const token = options.includeAuth ? getAuthToken() : null;

  if (token && !mergedHeaders.has('Authorization')) {
    mergedHeaders.set('Authorization', `Bearer ${token}`);
  }

  return mergedHeaders;
}

function createApiError(message: string, statusCode?: number): ApiError {
  const error = new Error(message) as ApiError;
  if (statusCode !== undefined) {
    error.statusCode = statusCode;
  }
  return error;
}

async function requestJson<T>(path: string, init?: RequestInit, options: { includeAuth?: boolean } = {}): Promise<T> {
  const response = await fetch(`${MAIN_API}${path}`, {
    ...init,
    headers: mergeRequestHeaders(init?.headers, options)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error || 'Erreur réseau');
  }

  return data as T;
}

export async function createVipInvoice(
  packEur: number,
  paymentMethod: VipPaymentMethod,
  recipientMode: VipRecipientMode,
  options: {
    payerEmail?: string;
    turnstileToken?: string;
  } = {}
): Promise<VipInvoice> {
  const token = getAuthToken();
  const data = await requestJson<JsonResponse<VipInvoice>>('/api/vip/invoices', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      pack_eur: packEur,
      payment_method: paymentMethod,
      coin: paymentMethod === 'btc' || paymentMethod === 'ltc' ? paymentMethod : null,
      recipient_mode: recipientMode,
      payer_email: options.payerEmail || null,
      turnstileToken: options.turnstileToken
    })
  });

  if (!data.invoice) {
    throw new Error('Invoice invalide');
  }

  return normalizeVipInvoice(data.invoice);
}

export async function getVipInvoice(publicId: string): Promise<VipInvoice> {
  const data = await requestJson<JsonResponse<VipInvoice>>(
    `/api/vip/invoices/${encodeURIComponent(publicId)}`,
    undefined,
    { includeAuth: true }
  );
  if (!data.invoice) {
    throw createApiError('Invoice introuvable', 404);
  }
  return normalizeVipInvoice(data.invoice);
}

export async function listMyVipInvoices(limit = 30): Promise<VipInvoice[]> {
  const token = getAuthToken();
  if (!token) {
    return [];
  }

  const query = new URLSearchParams({
    limit: String(limit)
  });

  const data = await requestJson<JsonResponse<VipInvoice>>(
    `/api/vip/invoices/mine?${query.toString()}`,
    undefined,
    { includeAuth: true }
  );

  return Array.isArray(data.invoices)
    ? data.invoices.map((invoice) => normalizeVipInvoice(invoice))
    : [];
}

export async function checkVipInvoice(publicId: string): Promise<VipInvoice> {
  const response = await fetch(`${MAIN_API}/api/vip/invoices/${encodeURIComponent(publicId)}/check`, {
    method: 'POST',
    headers: mergeRequestHeaders(undefined, { includeAuth: true })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok && !data?.invoice) {
    throw new Error(data?.error || 'Vérification indisponible');
  }

  if (!data.invoice) {
    throw createApiError('Invoice introuvable', 404);
  }

  return normalizeVipInvoice(data.invoice as VipInvoice);
}

export async function getVipGift(giftToken: string): Promise<VipGift> {
  const data = await requestJson<JsonResponse<VipGift>>(`/api/vip/gifts/${encodeURIComponent(giftToken)}`);
  if (!data.gift) {
    throw new Error('Cadeau introuvable');
  }
  return data.gift;
}

export async function unsealVipGift(giftToken: string, turnstileToken?: string): Promise<VipGift> {
  const data = await requestJson<JsonResponse<VipGift>>(`/api/vip/gifts/${encodeURIComponent(giftToken)}/unseal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      turnstileToken
    })
  });
  if (!data.gift) {
    throw new Error('Cadeau introuvable');
  }
  return data.gift;
}

export async function listVipInvoices(params: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
} = {}): Promise<{
  invoices: VipAdminInvoice[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}> {
  const token = getAuthToken();
  if (!token) {
    throw new Error('Token admin manquant');
  }

  const query = new URLSearchParams();
  if (params.status && params.status !== 'all') query.set('status', params.status);
  if (params.search?.trim()) query.set('search', params.search.trim());
  query.set('page', String(params.page || 1));
  query.set('limit', String(params.limit || 30));

  const data = await requestJson<{
    invoices: VipAdminInvoice[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }>(`/api/admin/vip-invoices?${query.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return {
    ...data,
    invoices: data.invoices.map(normalizeVipInvoice)
  };
}

export async function getVipInvoiceDetails(invoiceId: number): Promise<{
  invoice: VipAdminInvoice;
  events: VipInvoiceEvent[];
}> {
  const token = getAuthToken();
  if (!token) {
    throw new Error('Token admin manquant');
  }

  const data = await requestJson<{
    invoice: VipAdminInvoice;
    events: VipInvoiceEvent[];
  }>(`/api/admin/vip-invoices/${invoiceId}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return {
    ...data,
    invoice: normalizeVipInvoice(data.invoice)
  };
}

export async function adminCheckVipInvoice(invoiceId: number): Promise<VipAdminInvoice> {
  const token = getAuthToken();
  if (!token) {
    throw new Error('Token admin manquant');
  }

  const data = await requestJson<JsonResponse<VipAdminInvoice>>(`/api/admin/vip-invoices/${invoiceId}/check`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!data.invoice) {
    throw new Error('Invoice introuvable');
  }

  return normalizeVipInvoice(data.invoice);
}

export async function adminValidateVipInvoice(invoiceId: number): Promise<VipAdminInvoice> {
  const token = getAuthToken();
  if (!token) {
    throw new Error('Token admin manquant');
  }

  const data = await requestJson<JsonResponse<VipAdminInvoice>>(`/api/admin/vip-invoices/${invoiceId}/validate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!data.invoice) {
    throw new Error('Invoice introuvable');
  }

  return normalizeVipInvoice(data.invoice);
}

export async function adminCancelVipInvoice(invoiceId: number): Promise<VipAdminInvoice> {
  const token = getAuthToken();
  if (!token) {
    throw new Error('Token admin manquant');
  }

  const data = await requestJson<JsonResponse<VipAdminInvoice>>(`/api/admin/vip-invoices/${invoiceId}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!data.invoice) {
    throw new Error('Invoice introuvable');
  }

  return normalizeVipInvoice(data.invoice);
}
