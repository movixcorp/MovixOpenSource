'use strict';

const crypto = require('crypto');
const axios = require('axios');

const CRYPTOGATE_DEFAULT_BASE_URL = 'https://crypto-gate.cc';
const CRYPTOGATE_WEBHOOK_EVENTS = new Set([
  'payment.confirming',
  'payment.paid',
  'payment.failed'
]);

class CryptoGateProtocolError extends Error {
  constructor(message, code, statusCode = 502) {
    super(message);
    this.name = 'CryptoGateProtocolError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeBaseUrl(value) {
  const candidate = String(value || CRYPTOGATE_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new CryptoGateProtocolError(
      'URL CryptoGate invalide',
      'CRYPTOGATE_BASE_URL_INVALID',
      500
    );
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CryptoGateProtocolError(
      'URL CryptoGate invalide',
      'CRYPTOGATE_BASE_URL_INVALID',
      500
    );
  }

  return candidate;
}

function normalizePaymentInput(input = {}) {
  const amount = Number(input.amount);
  const currency = String(input.currency || '').trim().toUpperCase();
  const email = String(input.email || '').trim().toLowerCase();
  const orderId = String(input.orderId || '').trim();

  if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(?:\.\d{1,2})?$/.test(String(amount))) {
    throw new CryptoGateProtocolError(
      'Montant CryptoGate invalide',
      'CRYPTOGATE_AMOUNT_INVALID',
      400
    );
  }
  if (currency !== 'EUR') {
    throw new CryptoGateProtocolError(
      'Devise CryptoGate invalide',
      'CRYPTOGATE_CURRENCY_INVALID',
      400
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CryptoGateProtocolError(
      'Email CryptoGate invalide',
      'CRYPTOGATE_EMAIL_INVALID',
      400
    );
  }
  if (!/^inv_[a-f0-9]{24}$/.test(orderId)) {
    throw new CryptoGateProtocolError(
      'Identifiant de commande CryptoGate invalide',
      'CRYPTOGATE_ORDER_ID_INVALID',
      400
    );
  }

  return {
    amount,
    currency,
    email,
    orderId,
    ...(input.label ? { label: String(input.label).trim().slice(0, 120) } : {}),
    ...(input.description ? { description: String(input.description).trim().slice(0, 255) } : {})
  };
}

function parsePaymentResponse(data, baseUrl) {
  const paymentId = String(data?.paymentId || '').trim();
  const checkoutUrl = String(data?.checkoutUrl || '').trim();
  let parsedCheckout;
  let parsedBase;

  try {
    parsedCheckout = new URL(checkoutUrl);
    parsedBase = new URL(baseUrl);
  } catch {
    throw new CryptoGateProtocolError(
      'Réponse CryptoGate invalide',
      'CRYPTOGATE_CHECKOUT_URL_INVALID'
    );
  }

  if (
    !paymentId
    || paymentId.length > 128
    || parsedCheckout.protocol !== 'https:'
    || parsedCheckout.origin !== parsedBase.origin
    || !parsedCheckout.pathname.startsWith('/checkout/')
  ) {
    throw new CryptoGateProtocolError(
      'Réponse CryptoGate invalide',
      'CRYPTOGATE_CHECKOUT_URL_INVALID'
    );
  }

  return { paymentId, checkoutUrl: parsedCheckout.toString() };
}

function createCryptoGateClient(options = {}) {
  const apiKey = String(options.apiKey || process.env.VIP_CRYPTOGATE_API_KEY || '').trim();
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.VIP_CRYPTOGATE_BASE_URL);
  const httpClient = options.httpClient || axios;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000));

  return {
    async createPayment(input) {
      if (!apiKey) {
        throw new CryptoGateProtocolError(
          'Clé API CryptoGate manquante',
          'CRYPTOGATE_API_KEY_MISSING',
          503
        );
      }

      const payload = normalizePaymentInput(input);
      let response;
      try {
        response = await httpClient.post(
          `${baseUrl}/api/payment-links`,
          payload,
          {
            timeout: timeoutMs,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            }
          }
        );
      } catch (error) {
        if (error instanceof CryptoGateProtocolError) throw error;
        const upstreamStatus = Number(error?.response?.status);
        const mapped = new CryptoGateProtocolError(
          'Service CryptoGate temporairement indisponible',
          'CRYPTOGATE_REQUEST_FAILED',
          upstreamStatus >= 500 && upstreamStatus <= 599 ? upstreamStatus : 502
        );
        mapped.upstreamStatus = upstreamStatus || null;
        throw mapped;
      }

      return parsePaymentResponse(response?.data, baseUrl);
    }
  };
}

function verifyCryptoGateSignature(rawBody, signature, secret) {
  const safeSecret = String(secret || '').trim();
  const safeSignature = String(signature || '').trim().toLowerCase();
  if (!safeSecret || !Buffer.isBuffer(rawBody) || !/^sha256=[a-f0-9]{64}$/.test(safeSignature)) {
    return false;
  }

  const expected = `sha256=${crypto
    .createHmac('sha256', safeSecret)
    .update(rawBody)
    .digest('hex')}`;
  const receivedBuffer = Buffer.from(safeSignature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return receivedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function parseCryptoGateWebhook(rawBody) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 64 * 1024) {
    throw new CryptoGateProtocolError(
      'Payload webhook CryptoGate invalide',
      'CRYPTOGATE_WEBHOOK_BODY_INVALID',
      400
    );
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new CryptoGateProtocolError(
      'Payload webhook CryptoGate invalide',
      'CRYPTOGATE_WEBHOOK_JSON_INVALID',
      400
    );
  }

  const event = String(body?.event || '').trim();
  if (!CRYPTOGATE_WEBHOOK_EVENTS.has(event)) {
    throw new CryptoGateProtocolError(
      'Événement webhook CryptoGate non supporté',
      'CRYPTOGATE_WEBHOOK_EVENT_UNSUPPORTED',
      400
    );
  }

  const payment = body?.payment;
  const id = String(payment?.id || '').trim();
  const orderId = String(payment?.orderId || '').trim();
  const amount = Number(payment?.amount);
  const currency = String(payment?.currency || '').trim().toUpperCase();
  const status = String(payment?.status || '').trim().toLowerCase();
  const provider = String(payment?.provider || '').trim().slice(0, 64);
  const expectedStatus = event.slice('payment.'.length);

  if (!id || id.length > 128 || !/^inv_[a-f0-9]{24}$/.test(orderId)) {
    throw new CryptoGateProtocolError(
      'Paiement webhook CryptoGate invalide',
      'CRYPTOGATE_WEBHOOK_PAYMENT_INVALID',
      400
    );
  }
  if (!Number.isFinite(amount) || amount <= 0 || currency !== 'EUR') {
    throw new CryptoGateProtocolError(
      'Montant webhook CryptoGate invalide',
      'CRYPTOGATE_WEBHOOK_AMOUNT_INVALID',
      400
    );
  }
  if (status !== expectedStatus) {
    throw new CryptoGateProtocolError(
      'Statut webhook CryptoGate incohérent',
      'CRYPTOGATE_WEBHOOK_STATUS_MISMATCH',
      400
    );
  }

  return {
    event,
    timestamp: String(body?.timestamp || '').trim() || null,
    payment: {
      id,
      orderId,
      amount,
      currency,
      status,
      provider,
      createdAt: String(payment?.createdAt || '').trim() || null
    }
  };
}

module.exports = {
  CRYPTOGATE_DEFAULT_BASE_URL,
  CRYPTOGATE_WEBHOOK_EVENTS,
  CryptoGateProtocolError,
  createCryptoGateClient,
  parseCryptoGateWebhook,
  verifyCryptoGateSignature
};
