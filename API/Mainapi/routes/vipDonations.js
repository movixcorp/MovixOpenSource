const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const { getPool } = require('../mysqlPool');
const { isAdmin, getAuthIfValid } = require('../middleware/auth');
const { createRedisRateLimitStore } = require('../utils/redisRateLimitStore');
const { verifyTurnstileFromRequest } = require('../utils/turnstile');
const {
  createVipInvoice,
  handleCryptoGateWebhook,
  handlePaygateCallback,
  fetchInvoiceByPublicId,
  fetchInvoiceByGiftToken,
  getVipInvoiceDetails,
  listUserVipInvoices,
  listVipInvoices,
  refreshInvoiceStatus,
  forceValidateInvoice,
  cancelInvoice,
  serializePublicInvoice,
  serializeAdminInvoice,
  serializeGift,
  unsealGift,
  ensureVipDonationsTables,
  getClientIp
} = require('../utils/vipDonations');

const router = express.Router();

const setNoStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  return next();
};

const canAccessInvoice = (invoice, auth) => {
  if (!invoice) {
    return false;
  }

  return true;
};

const getRateLimitKey = (req) => req.headers['cf-connecting-ip']
  || req.headers['x-forwarded-for']?.split(',')[0].trim()
  || ipKeyGenerator(req.ip);

const getRequestBaseUrl = (req) => {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'https';
  const host = forwardedHost || req.get('host') || '';

  return host ? `${protocol}://${host}`.replace(/\/+$/, '') : '';
};

const createInvoiceRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  store: createRedisRateLimitStore({ prefix: 'rate-limit:vip:create-invoice:' }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getRateLimitKey,
  validate: { xForwardedForHeader: false, ip: false },
  message: {
    success: false,
    error: 'Trop de créations d\'invoice. Réessayez plus tard.'
  }
});

const invoiceCheckRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 180,
  store: createRedisRateLimitStore({ prefix: 'rate-limit:vip:invoice-check:' }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getRateLimitKey,
  validate: { xForwardedForHeader: false, ip: false },
  message: {
    success: false,
    error: 'Trop de vérifications d\'invoice. Réessayez plus tard.'
  }
});

const cryptoGateWebhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  store: createRedisRateLimitStore({ prefix: 'rate-limit:vip:cryptogate-webhook:' }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getRateLimitKey,
  validate: { xForwardedForHeader: false, ip: false },
  message: 'temporary failure'
});

const cryptoGateWebhookBodyParser = express.json({
  limit: '64kb',
  verify(req, res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
});

// Mounted by app.js before the global 8 MB parser, in this exact order.
const cryptoGateWebhookIngress = [
  cryptoGateWebhookRateLimit,
  cryptoGateWebhookBodyParser
];

const giftUnsealRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  store: createRedisRateLimitStore({ prefix: 'rate-limit:vip:gift-unseal:' }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getRateLimitKey,
  validate: { xForwardedForHeader: false, ip: false },
  message: {
    success: false,
    error: 'Trop de tentatives de descellement. Réessayez plus tard.'
  }
});

router.post('/vip/invoices', setNoStore, createInvoiceRateLimit, async (req, res) => {
  try {
    const pool = getPool();
    const turnstileResult = await verifyTurnstileFromRequest(req, req.body?.turnstileToken);
    if (!turnstileResult.valid) {
      return res.status(turnstileResult.status).json({
        success: false,
        error: turnstileResult.error
      });
    }

    const auth = await getAuthIfValid(req);
    const invoice = await createVipInvoice(
      pool,
      {
        packEur: req.body?.pack_eur,
        paymentMethod: req.body?.payment_method,
        coin: req.body?.coin,
        recipientMode: req.body?.recipient_mode,
        payerEmail: req.body?.payer_email
      },
      {
        auth,
        ipAddress: getClientIp(req),
        callbackBaseUrl: getRequestBaseUrl(req)
      }
    );

    return res.status(201).json({
      success: true,
      invoice: serializePublicInvoice(invoice)
    });
  } catch (error) {
    console.error('VIP invoice create error:', error);
    return res.status(error.statusCode || 400).json({
      success: false,
      error: error.message || 'Impossible de créer l\'invoice VIP'
    });
  }
});

router.post('/vip/cryptogate/webhook', setNoStore, async (req, res) => {
  try {
    const pool = getPool();
    await handleCryptoGateWebhook(pool, {
      rawBody: req.rawBody,
      signature: req.headers['x-webhook-signature'],
      webhookId: req.headers['x-webhook-id']
    });
    return res.status(200).type('text/plain').send('ok');
  } catch (error) {
    const statusCode = Number(error?.statusCode);
    const safeStatus = statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
    console.error('VIP CryptoGate webhook rejected', {
      code: error?.code || 'CRYPTOGATE_WEBHOOK_ERROR',
      statusCode: safeStatus
    });
    return res
      .status(safeStatus)
      .type('text/plain')
      .send(safeStatus >= 500 ? 'temporary failure' : 'invalid webhook');
  }
});

router.get('/vip/paygate/callback', setNoStore, async (req, res) => {
  try {
    const pool = getPool();
    await handlePaygateCallback(pool, req.query);
    return res.status(200).type('text/plain').send('ok');
  } catch (error) {
    const statusCode = Number(error?.statusCode);
    const safeStatus = statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
    console.error('VIP PayGate callback rejected', {
      code: error?.code || 'PAYGATE_CALLBACK_ERROR',
      statusCode: safeStatus
    });
    return res
      .status(safeStatus)
      .type('text/plain')
      .send(safeStatus >= 500 ? 'temporary failure' : 'invalid callback');
  }
});

router.get('/vip/invoices/mine', setNoStore, async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth) {
      return res.status(401).json({
        success: false,
        error: 'Authentification requise'
      });
    }

    const pool = getPool();
    const invoices = await listUserVipInvoices(pool, auth, {
      limit: req.query?.limit
    });

    return res.json({
      success: true,
      invoices
    });
  } catch (error) {
    console.error('VIP user invoices list error:', error);
    return res.status(500).json({
      success: false,
      error: 'Impossible de récupérer tes invoices VIP'
    });
  }
});

router.get('/vip/invoices/:publicId', setNoStore, async (req, res) => {
  try {
    const pool = getPool();
    const auth = await getAuthIfValid(req);
    const invoice = await fetchInvoiceByPublicId(pool, req.params.publicId);
    if (!canAccessInvoice(invoice, auth)) {
      return res.status(404).json({
        success: false,
        error: 'Invoice introuvable'
      });
    }

    return res.json({
      success: true,
      invoice: serializePublicInvoice(invoice)
    });
  } catch (error) {
    console.error('VIP invoice fetch error:', error);
    return res.status(500).json({
      success: false,
      error: 'Impossible de récupérer l\'invoice'
    });
  }
});

router.post('/vip/invoices/:publicId/check', setNoStore, invoiceCheckRateLimit, async (req, res) => {
  try {
    const pool = getPool();
    const auth = await getAuthIfValid(req);
    const invoice = await fetchInvoiceByPublicId(pool, req.params.publicId);
    if (!canAccessInvoice(invoice, auth)) {
      return res.status(404).json({
        success: false,
        error: 'Invoice introuvable'
      });
    }

    const refreshedInvoice = await refreshInvoiceStatus(pool, invoice, {
      actorType: 'system',
      actorId: invoice.public_id
    });

    return res.json({
      success: true,
      invoice: serializePublicInvoice(refreshedInvoice)
    });
  } catch (error) {
    console.error('VIP invoice check error:', error);
    const pool = getPool();
    const auth = await getAuthIfValid(req);
    const invoice = await fetchInvoiceByPublicId(pool, req.params.publicId);
    return res.status(502).json({
      success: false,
      error: 'Vérification de paiement indisponible temporairement',
      invoice: canAccessInvoice(invoice, auth) ? serializePublicInvoice(invoice) : null
    });
  }
});

router.get('/vip/gifts/:giftToken', async (req, res) => {
  try {
    const pool = getPool();
    const invoice = await fetchInvoiceByGiftToken(pool, req.params.giftToken);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Cadeau introuvable'
      });
    }

    return res.json({
      success: true,
      gift: serializeGift(invoice)
    });
  } catch (error) {
    console.error('VIP gift fetch error:', error);
    return res.status(500).json({
      success: false,
      error: 'Impossible de récupérer le cadeau'
    });
  }
});

router.post('/vip/gifts/:giftToken/unseal', giftUnsealRateLimit, async (req, res) => {
  try {
    const pool = getPool();
    const turnstileResult = await verifyTurnstileFromRequest(req, req.body?.turnstileToken);
    if (!turnstileResult.valid) {
      return res.status(turnstileResult.status).json({
        success: false,
        error: turnstileResult.error
      });
    }

    const invoice = await fetchInvoiceByGiftToken(pool, req.params.giftToken);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Cadeau introuvable'
      });
    }

    const unsealedInvoice = await unsealGift(
      pool,
      req.params.giftToken,
      getClientIp(req)
    );

    return res.json({
      success: true,
      gift: serializeGift(unsealedInvoice)
    });
  } catch (error) {
    console.error('VIP gift unseal error:', error);
    return res.status(409).json({
      success: false,
      error: error.message || 'Impossible de desceller ce cadeau'
    });
  }
});

router.get('/admin/vip-invoices', isAdmin, async (req, res) => {
  try {
    const pool = getPool();
    const result = await listVipInvoices(pool, {
      status: req.query?.status ? String(req.query.status) : '',
      search: req.query?.search ? String(req.query.search).trim() : '',
      page: req.query?.page,
      limit: req.query?.limit
    });

    return res.json({
      success: true,
      invoices: result.items,
      total: result.total,
      page: result.page,
      limit: result.limit,
      hasMore: result.hasMore
    });
  } catch (error) {
    console.error('VIP admin invoices list error:', error);
    return res.status(500).json({
      success: false,
      error: 'Impossible de récupérer les invoices VIP'
    });
  }
});

router.get('/admin/vip-invoices/:id', setNoStore, isAdmin, async (req, res) => {
  try {
    const pool = getPool();
    const details = await getVipInvoiceDetails(pool, req.params.id);
    if (!details) {
      return res.status(404).json({
        success: false,
        error: 'Invoice introuvable'
      });
    }

    return res.json({
      success: true,
      ...details
    });
  } catch (error) {
    console.error('VIP admin invoice details error:', error);
    return res.status(500).json({
      success: false,
      error: 'Impossible de récupérer cette invoice'
    });
  }
});

router.post('/admin/vip-invoices/:id/check', setNoStore, isAdmin, async (req, res) => {
  try {
    const pool = getPool();
    const refreshedInvoice = await refreshInvoiceStatus(pool, req.params.id, {
      force: true,
      allowPaygateReconciliation: true,
      actorType: 'admin',
      actorId: req.admin?.userId || null
    });

    if (!refreshedInvoice) {
      return res.status(404).json({
        success: false,
        error: 'Invoice introuvable'
      });
    }

    return res.json({
      success: true,
      invoice: serializeAdminInvoice(refreshedInvoice)
    });
  } catch (error) {
    console.error('VIP admin invoice check error:', error);
    return res.status(502).json({
      success: false,
      error: 'Vérification de paiement indisponible temporairement'
    });
  }
});

router.post('/admin/vip-invoices/:id/validate', isAdmin, async (req, res) => {
  try {
    const pool = getPool();
    const invoice = await forceValidateInvoice(pool, req.params.id, req.admin);
    return res.json({
      success: true,
      invoice: serializeAdminInvoice(invoice)
    });
  } catch (error) {
    console.error('VIP admin invoice validate error:', error);
    return res.status(409).json({
      success: false,
      error: error.message || 'Impossible de valider cette invoice'
    });
  }
});

router.post('/admin/vip-invoices/:id/cancel', isAdmin, async (req, res) => {
  try {
    const pool = getPool();
    const invoice = await cancelInvoice(pool, req.params.id, req.admin);
    return res.json({
      success: true,
      invoice: serializeAdminInvoice(invoice)
    });
  } catch (error) {
    console.error('VIP admin invoice cancel error:', error);
    return res.status(409).json({
      success: false,
      error: error.message || 'Impossible d\'annuler cette invoice'
    });
  }
});

module.exports = {
  router,
  ensureVipDonationsTables,
  cryptoGateWebhookIngress
};
