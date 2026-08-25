const crypto = require('crypto');
const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');

const { invalidateVipCache } = require('../checkVip');
const { fetchAddressTxs, fetchTipHeight } = require('./chainExplorer');
const vipPaygate = require('./vipPaygate');
const vipCryptoGate = require('./vipCryptoGate');

bitcoin.initEccLib(ecc);

const bip32 = BIP32Factory(ecc);

const VIP_PACKS = Object.freeze({
  5: { amountEur: 5, vipYears: 1, durationLabel: '1 an' },
  7: { amountEur: 7, vipYears: 1.5, durationLabel: '18 mois' },
  10: { amountEur: 10, vipYears: 2, durationLabel: '2 ans' },
  15: { amountEur: 15, vipYears: 3, durationLabel: '3 ans' },
  20: { amountEur: 20, vipYears: 4, durationLabel: '4 ans' }
});

const VIP_PAYMENT_METHODS = Object.freeze({
  btc: { type: 'crypto', coin: 'btc' },
  ltc: { type: 'crypto', coin: 'ltc' },
  cryptogate: { type: 'cryptogate', coin: null },
  paygate_hosted: { type: 'paygate', coin: null },
  payblis: { type: 'payblis', coin: null }
});
const VIP_PAYMENT_METHOD_ENUM_SQL = "ENUM('btc', 'ltc', 'cryptogate', 'paygate_hosted', 'autobuy', 'payblis')";

const DEFAULT_SUPPORT_TELEGRAM_URL = 'https://t.me/movix_site';
const FINAL_STATUSES = new Set(['delivered', 'cancelled']);
const DEFAULT_EXPIRATION_MINUTES = 210;
const DEFAULT_PAYGATE_MIN_PAID_RATIO = 0.60;
const DEFAULT_PAYGATE_MIN_AMOUNT_EUR = 6.25;
const DEFAULT_PAYGATE_MIN_PACK_EUR = 7;
const SATOSHI_FACTOR = 1e8;
const PAYGATE_USDC_POLYGON_CONTRACT = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const STATUS_REASONS = {
  awaiting_payment: 'Aucun paiement détecté pour le moment.',
  partial_payment: 'Paiement détecté mais montant insuffisant.',
  confirming: 'Paiement détecté, confirmations en cours.',
  paid: 'Paiement confirmé sur la blockchain.',
  delivered: 'Clé VIP livrée.',
  expired: 'Invoice expirée.',
  cancelled: 'Invoice annulée.'
};

const BTC_NETWORK = {
  messagePrefix: '\x18Bitcoin Signed Message:\n',
  bech32: 'bc',
  bip32: {
    public: 0x0488b21e,
    private: 0x0488ade4
  },
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80
};

const LTC_NETWORK = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: {
    public: 0x019da462,
    private: 0x019d9cfe
  },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0
};

const EXTENDED_KEY_FORMATS = {
  btc: {
    xpub: { bip32Public: 0x0488b21e, defaultAddressType: 'legacy' },
    ypub: { bip32Public: 0x049d7cb2, defaultAddressType: 'p2sh-segwit' },
    zpub: { bip32Public: 0x04b24746, defaultAddressType: 'segwit' }
  },
  ltc: {
    xpub: { bip32Public: 0x0488b21e, defaultAddressType: 'legacy' },
    Ltub: { bip32Public: 0x019da462, defaultAddressType: 'legacy' }
  }
};

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundFiat(value) {
  return Number(parseNumber(value).toFixed(2));
}

function roundCrypto(value) {
  return Number(parseNumber(value).toFixed(8));
}

function toSqlDateTime(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function fromSqlDateTime(dateInput) {
  if (!dateInput) return null;
  return new Date(dateInput);
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getSupportTelegramUrl() {
  return process.env.VIP_SUPPORT_TELEGRAM_URL || DEFAULT_SUPPORT_TELEGRAM_URL;
}

function buildFrontendUrl(pathname) {
  const baseUrl = normalizeBaseUrl(process.env.FRONTEND_BASE_URL);
  if (!baseUrl) return pathname;
  return `${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function getInvoicePath(publicId) {
  return `/vip/invoice/${encodeURIComponent(publicId)}`;
}

function getGiftPath(giftToken) {
  return `/vip/cadeau/${encodeURIComponent(giftToken)}`;
}

function hashIp(ipAddress) {
  if (!ipAddress) return null;
  const secret = process.env.JWT_SECRET || 'movix-vip-ip';
  return crypto.createHmac('sha256', secret).update(ipAddress).digest('hex');
}

function getClientIp(req) {
  return req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.ip
    || null;
}

function resolvePack(packEur) {
  const normalizedAmount = parseNumber(packEur);
  return VIP_PACKS[normalizedAmount] || null;
}

function normalizePaymentMethod(method, fallbackCoin = null) {
  const normalized = String(method || '').trim().toLowerCase();
  if (VIP_PAYMENT_METHODS[normalized]) {
    return normalized;
  }

  return normalizeCoin(fallbackCoin);
}

function normalizeCoin(coin) {
  const normalized = String(coin || '').trim().toLowerCase();
  return normalized === 'btc' || normalized === 'ltc' ? normalized : null;
}

function isCryptoPaymentMethod(paymentMethod) {
  return paymentMethod === 'btc' || paymentMethod === 'ltc';
}

function isPaygatePaymentMethod(paymentMethod) {
  return paymentMethod === 'paygate_hosted';
}

function isCryptoGatePaymentMethod(paymentMethod) {
  return paymentMethod === 'cryptogate';
}

function isPayblisPaymentMethod(paymentMethod) {
  return paymentMethod === 'payblis';
}

function isCryptoGateEnabled() {
  const enabled = String(process.env.VIP_CRYPTOGATE_ENABLED || 'false').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(enabled);
}

function isLegacyPaymentCreationEnabled() {
  const enabled = String(
    process.env.VIP_LEGACY_PAYMENT_CREATION_ENABLED || 'false'
  ).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(enabled);
}

function getCryptoGateClient(context = {}) {
  return context.cryptoGateClient || vipCryptoGate.createCryptoGateClient();
}

function isAutoBuyPaymentMethod(paymentMethod) {
  const normalized = String(paymentMethod || '').trim().toLowerCase();
  return normalized === 'autobuy' || normalized === 'autobuy_paypal';
}

function getInvoicePaymentMethod(invoice) {
  if (!invoice) return null;

  const paymentMethod = normalizePaymentMethod(invoice.payment_method, invoice.coin);
  if (paymentMethod) {
    return paymentMethod;
  }

  return null;
}

function normalizeRecipientMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return normalized === 'self' || normalized === 'gift' ? normalized : null;
}

function normalizeEmailAddress(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
  return isValid ? normalized : null;
}

function getCoinEnvPrefix(coin) {
  return coin === 'btc' ? 'BTC' : 'LTC';
}

function normalizeAddressType(addressType, fallback) {
  const normalized = String(addressType || '').trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'segwit' || normalized === 'p2sh-segwit') {
    return normalized;
  }
  return fallback;
}

function getPaygateCheckoutDomain() {
  return String(
    process.env.VIP_PAYGATE_DOMAIN || vipPaygate.PAYGATE_DEFAULT_CHECKOUT_HOST
  ).trim();
}

function getPaygatePayoutWallet() {
  const wallet = String(process.env.VIP_PAYGATE_SETTLEMENT_WALLET || '').trim();
  if (!wallet) {
    return '';
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    throw new Error('VIP_PAYGATE_SETTLEMENT_WALLET invalide: adresse EVM/Polygon attendue');
  }

  if (wallet.toLowerCase() === PAYGATE_USDC_POLYGON_CONTRACT) {
    throw new Error('VIP_PAYGATE_SETTLEMENT_WALLET invalide: utilise ton wallet, pas le contrat USDC Polygon');
  }

  return wallet;
}

function getPaygateMinPaidRatio() {
  const ratio = parseNumber(process.env.VIP_PAYGATE_MIN_PAID_RATIO, DEFAULT_PAYGATE_MIN_PAID_RATIO);
  return Math.min(1, Math.max(0.5, ratio));
}

function getPaygateMinimumAmountEur() {
  return roundFiat(Math.max(
    0,
    parseNumber(process.env.VIP_PAYGATE_MIN_AMOUNT_EUR, DEFAULT_PAYGATE_MIN_AMOUNT_EUR)
  ));
}

function getPaygateCheckoutAmountEur(amountEur) {
  return roundFiat(Math.max(parseNumber(amountEur), getPaygateMinimumAmountEur()));
}

function isPaygatePackAllowed(pack) {
  if (!pack) {
    return false;
  }

  return parseNumber(pack.amountEur, 0) >= parseNumber(
    process.env.VIP_PAYGATE_MIN_PACK_EUR,
    DEFAULT_PAYGATE_MIN_PACK_EUR
  );
}

function getPaygateBranding() {
  return {
    logo: String(process.env.VIP_PAYGATE_LOGO_URL || '').trim(),
    background: String(process.env.VIP_PAYGATE_BACKGROUND || '').trim(),
    theme: String(process.env.VIP_PAYGATE_THEME || '').trim(),
    button: String(process.env.VIP_PAYGATE_BUTTON || '').trim()
  };
}

function getPaygateCallbackBaseUrl(context = {}) {
  const configured = normalizeBaseUrl(process.env.VIP_PAYGATE_CALLBACK_BASE_URL);
  const isProduction = process.env.NODE_ENV === 'production';
  const candidate = configured || (isProduction ? '' : normalizeBaseUrl(context.callbackBaseUrl));
  return vipPaygate.normalizeCallbackBaseUrl(candidate, {
    requireHttps: isProduction
  });
}

function resolvePaygateCheckoutUrl(invoice) {
  return invoice?.paygate_checkout_url || null;
}

function getPaygateClient(overrides = {}) {
  return overrides.paygateClient || vipPaygate.createPaygateClient();
}

function logPaygateFailure(operation, error, reference = null) {
  console.error('VIP PayGate operation failed', {
    operation,
    reference,
    code: error?.code || 'PAYGATE_INTERNAL_ERROR',
    upstreamStatus: error?.upstreamStatus || error?.response?.status || null
  });
}

function mapPaygateServiceError(error, operation, reference = null) {
  logPaygateFailure(operation, error, reference);
  const statusCode = Number(error?.statusCode);
  const mapped = createVipInvoiceError(
    'Service PayGate temporairement indisponible',
    statusCode >= 500 && statusCode <= 599 ? statusCode : 502
  );
  mapped.code = error?.code || 'PAYGATE_INTERNAL_ERROR';
  mapped.upstreamStatus = error?.upstreamStatus || error?.response?.status || null;
  return mapped;
}

function getStartDerivationIndex(coin) {
  const envPrefix = getCoinEnvPrefix(coin);
  return Math.max(0, parseNumber(process.env[`VIP_${envPrefix}_START_INDEX`], 0));
}

function getExtendedKeyFormat(coin, extendedKey) {
  const formats = EXTENDED_KEY_FORMATS[coin] || {};
  return Object.entries(formats).find(([prefix]) => extendedKey.startsWith(prefix)) || null;
}

function derivePaymentAddress(coin, derivationIndex) {
  const envPrefix = getCoinEnvPrefix(coin);
  const xpub = String(process.env[`VIP_${envPrefix}_XPUB`] || '').trim();
  if (!xpub) {
    throw new Error(`VIP_${envPrefix}_XPUB manquant`);
  }

  const formatEntry = getExtendedKeyFormat(coin, xpub);
  if (!formatEntry) {
    throw new Error(`Format de xpub non supporté pour ${coin.toUpperCase()}`);
  }

  const [, format] = formatEntry;
  const baseNetwork = coin === 'btc' ? BTC_NETWORK : LTC_NETWORK;
  const addressType = normalizeAddressType(
    process.env[`VIP_${envPrefix}_ADDRESS_TYPE`],
    format.defaultAddressType
  );

  const parsingNetwork = {
    ...baseNetwork,
    bip32: {
      public: format.bip32Public,
      private: baseNetwork.bip32.private
    }
  };

  const accountNode = bip32.fromBase58(xpub, parsingNetwork);
  const chainIndex = parseNumber(process.env[`VIP_${envPrefix}_CHAIN`], 0);
  const childNode = accountNode.derive(chainIndex).derive(derivationIndex);
  const publicKey = Buffer.from(childNode.publicKey);

  let payment;
  if (addressType === 'segwit') {
    payment = bitcoin.payments.p2wpkh({ pubkey: publicKey, network: baseNetwork });
  } else if (addressType === 'p2sh-segwit') {
    payment = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({ pubkey: publicKey, network: baseNetwork }),
      network: baseNetwork
    });
  } else {
    payment = bitcoin.payments.p2pkh({ pubkey: publicKey, network: baseNetwork });
  }

  if (!payment.address) {
    throw new Error(`Impossible de dériver une adresse ${coin.toUpperCase()}`);
  }

  return {
    address: payment.address,
    addressType,
    derivationIndex
  };
}

async function fetchCoinbaseSpotPrices(coin) {
  const symbol = coin.toUpperCase();
  const [eurResponse, usdResponse] = await Promise.all([
    axios.get(`https://api.coinbase.com/v2/prices/${symbol}-EUR/spot`, { timeout: 15000 }),
    axios.get(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`, { timeout: 15000 })
  ]);

  return {
    eurPricePerCoin: parseNumber(eurResponse.data?.data?.amount),
    usdPricePerCoin: parseNumber(usdResponse.data?.data?.amount)
  };
}

async function fetchCoinGeckoSpotPrices(coin) {
  const coinId = coin === 'btc' ? 'bitcoin' : 'litecoin';
  const response = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price',
    {
      params: {
        ids: coinId,
        vs_currencies: 'eur,usd'
      },
      timeout: 15000
    }
  );

  return {
    eurPricePerCoin: parseNumber(response.data?.[coinId]?.eur),
    usdPricePerCoin: parseNumber(response.data?.[coinId]?.usd)
  };
}

async function buildPricingSnapshot(coin, amountEur) {
  let prices;
  try {
    prices = await fetchCoinbaseSpotPrices(coin);
  } catch (error) {
    prices = await fetchCoinGeckoSpotPrices(coin);
  }

  if (!prices.eurPricePerCoin || !prices.usdPricePerCoin) {
    throw new Error(`Impossible de récupérer le prix ${coin.toUpperCase()}`);
  }

  return {
    amountEur: roundFiat(amountEur),
    amountUsd: roundFiat((amountEur / prices.eurPricePerCoin) * prices.usdPricePerCoin),
    amountCryptoExpected: roundCrypto(amountEur / prices.eurPricePerCoin),
    eurPricePerCoin: roundFiat(prices.eurPricePerCoin),
    usdPricePerCoin: roundFiat(prices.usdPricePerCoin)
  };
}

async function fetchPaygateConvertedUsd(amount, fromCurrency = 'eur') {
  if (String(fromCurrency).trim().toLowerCase() !== 'eur') {
    throw new Error('Conversion PayGate non supportée');
  }
  return vipPaygate.createPaygateClient().convertEurToUsd(amount);
}

function buildQrPayload(coin, address, amountCryptoExpected) {
  const scheme = coin === 'btc' ? 'bitcoin' : 'litecoin';
  return `${scheme}:${address}?amount=${roundCrypto(amountCryptoExpected).toFixed(8)}`;
}

async function reserveDerivationIndex(pool, coin) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT next_index FROM vip_derivation_counters WHERE coin = ? FOR UPDATE',
      [coin]
    );

    const startIndex = getStartDerivationIndex(coin);
    let derivationIndex = startIndex;
    if (rows.length === 0) {
      await connection.execute(
        'INSERT INTO vip_derivation_counters (coin, next_index, created_at, updated_at) VALUES (?, ?, NOW(), NOW())',
        [coin, derivationIndex + 1]
      );
    } else {
      derivationIndex = Math.max(parseNumber(rows[0].next_index, 0), startIndex);
      await connection.execute(
        'UPDATE vip_derivation_counters SET next_index = ?, updated_at = NOW() WHERE coin = ?',
        [derivationIndex + 1, coin]
      );
    }

    await connection.commit();
    return derivationIndex;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function logVipInvoiceEvent(db, invoiceId, eventType, message, payload, actorType = 'system', actorId = null) {
  await db.execute(
    `INSERT INTO vip_invoice_events
      (invoice_id, event_type, actor_type, actor_id, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [
      invoiceId,
      eventType,
      actorType,
      actorId,
      message || null,
      payload ? JSON.stringify(payload) : null
    ]
  );
}

async function expireAwaitingInvoiceIfOverdue(db, invoice) {
  if (!invoice || invoice.status !== 'awaiting_payment') {
    return invoice;
  }

  const expiresAt = fromSqlDateTime(invoice.expires_at);
  if (!expiresAt || expiresAt.getTime() >= Date.now()) {
    return invoice;
  }

  const [updateResult] = await db.execute(
    `UPDATE vip_invoices
      SET status = 'expired',
          next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND),
          updated_at = NOW()
      WHERE id = ?
        AND status = 'awaiting_payment'
        AND expires_at IS NOT NULL
        AND expires_at < NOW()`,
    [invoice.id]
  );

  if (parseNumber(updateResult?.affectedRows, 0) > 0) {
    await logVipInvoiceEvent(
      db,
      invoice.id,
      'invoice_status_updated',
      STATUS_REASONS.expired,
      {
        from: 'awaiting_payment',
        to: 'expired'
      },
      'system',
      invoice.public_id || null
    );
  }

  const [rows] = await db.execute(
    'SELECT * FROM vip_invoices WHERE id = ? LIMIT 1',
    [invoice.id]
  );

  return rows[0] || {
    ...invoice,
    status: 'expired'
  };
}

async function fetchInvoiceByPublicId(pool, publicId) {
  const [rows] = await pool.execute(
    'SELECT * FROM vip_invoices WHERE public_id = ? LIMIT 1',
    [publicId]
  );
  return expireAwaitingInvoiceIfOverdue(pool, rows[0] || null);
}

async function fetchInvoiceById(pool, invoiceId) {
  const [rows] = await pool.execute(
    'SELECT * FROM vip_invoices WHERE id = ? LIMIT 1',
    [invoiceId]
  );
  return rows[0] || null;
}

async function fetchInvoiceByGiftToken(pool, giftToken) {
  const [rows] = await pool.execute(
    'SELECT * FROM vip_invoices WHERE gift_token = ? LIMIT 1',
    [giftToken]
  );
  return expireAwaitingInvoiceIfOverdue(pool, rows[0] || null);
}

async function generateUniqueVipKey(db) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `VIP-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    const [rows] = await db.execute(
      'SELECT key_value FROM access_keys WHERE key_value = ? LIMIT 1',
      [candidate]
    );
    if (rows.length === 0) {
      return candidate;
    }
  }

  throw new Error('Impossible de générer une clé VIP unique');
}

function buildDurationLabel(vipYears) {
  const normalizedYears = parseNumber(vipYears, 1);
  const totalMonths = Math.max(1, Math.round(normalizedYears * 12));

  if (totalMonths % 12 === 0) {
    const totalYears = totalMonths / 12;
    return `${totalYears} ${totalYears > 1 ? 'ans' : 'an'}`;
  }

  return `${totalMonths} mois`;
}

async function deliverInvoiceIfReady(pool, invoiceId, actorType = 'system', actorId = null, reason = 'auto') {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE id = ? FOR UPDATE',
      [invoiceId]
    );

    if (rows.length === 0) {
      throw new Error('Invoice introuvable');
    }

    const invoice = rows[0];
    if (isPaygatePaymentMethod(getInvoicePaymentMethod(invoice))) {
      requireValidPaygateInvoiceAmountUsd(invoice);
    }
    if (invoice.status === 'delivered' && invoice.vip_key_value) {
      await connection.commit();
      return invoice;
    }

    if (invoice.status !== 'paid') {
      await connection.commit();
      return invoice;
    }

    const vipYears = parseNumber(invoice.vip_years, 0);
    const totalMonths = Math.max(1, Math.round(vipYears * 12));
    const durationLabel = buildDurationLabel(vipYears);
    const keyValue = await generateUniqueVipKey(connection);
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + totalMonths);

    await connection.execute(
      `INSERT INTO access_keys
        (key_value, active, used, duree_validite, expires_at, created_at, updated_at)
        VALUES (?, 1, 0, ?, ?, NOW(), NOW())`,
      [keyValue, durationLabel, expiresAt.getTime()]
    );

    await connection.execute(
      `UPDATE vip_invoices
        SET status = 'delivered',
            vip_key_value = ?,
            delivered_at = COALESCE(delivered_at, NOW()),
            paid_at = COALESCE(paid_at, NOW()),
            updated_at = NOW()
        WHERE id = ?`,
      [keyValue, invoiceId]
    );

    await logVipInvoiceEvent(
      connection,
      invoiceId,
      'invoice_delivered',
      'Clé VIP livrée automatiquement.',
      {
        reason,
        vipYears,
        durationMonths: totalMonths,
        durationLabel
      },
      actorType,
      actorId
    );

    await connection.commit();
    invalidateVipCache(keyValue);

    return fetchInvoiceById(pool, invoiceId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function getRequiredConfirmations(coin) {
  const envPrefix = getCoinEnvPrefix(coin);
  return Math.max(1, parseNumber(process.env[`VIP_${envPrefix}_CONFIRMATIONS`], 1));
}

async function fetchAddressActivity(coin, address, options = {}) {
  if (coin !== 'btc' && coin !== 'ltc') {
    throw new Error(`Coin non supporté pour la surveillance: ${coin}`);
  }

  const [txs, tipHeight] = await Promise.all([
    fetchAddressTxs(coin, address),
    fetchTipHeight(coin)
  ]);

  let totalReceived = 0;
  let confirmedReceived = 0;
  let maxConfirmations = 0;
  const txHashes = [];
  const requiredConfirmations = getRequiredConfirmations(coin);
  const ignoreBeforeMs = options.ignoreBefore ? new Date(options.ignoreBefore).getTime() : 0;
  const ignoreBeforeToleranceMs = 1500;

  for (const tx of txs) {
    const status = tx?.status || {};
    const isConfirmed = Boolean(status.confirmed);
    const blockTimeMs = Number.isFinite(status.block_time) ? status.block_time * 1000 : null;

    // Skip confirmed txs mined strictly before the invoice was created.
    // Mempool txs (not yet confirmed) are always considered.
    if (
      ignoreBeforeMs
      && isConfirmed
      && blockTimeMs !== null
      && blockTimeMs < (ignoreBeforeMs - ignoreBeforeToleranceMs)
    ) {
      continue;
    }

    let amountForAddress = 0;
    for (const output of Array.isArray(tx.vout) ? tx.vout : []) {
      if (output && output.scriptpubkey_address === address) {
        amountForAddress += parseNumber(output.value, 0) / SATOSHI_FACTOR;
      }
    }

    if (amountForAddress <= 0) {
      continue;
    }

    const confirmations = isConfirmed
      && Number.isFinite(status.block_height)
      && tipHeight >= status.block_height
      ? (tipHeight - status.block_height + 1)
      : 0;

    totalReceived += amountForAddress;
    if (confirmations >= requiredConfirmations) {
      confirmedReceived += amountForAddress;
    }
    if (confirmations > maxConfirmations) {
      maxConfirmations = confirmations;
    }
    if (tx.txid) {
      txHashes.push(tx.txid);
    }
  }

  return {
    totalReceived: roundCrypto(totalReceived),
    confirmedReceived: roundCrypto(confirmedReceived),
    confirmations: maxConfirmations,
    txHashes
  };
}

function determineInvoiceStatus(invoice, addressActivity) {
  const expected = roundCrypto(parseNumber(invoice.amount_crypto_expected));
  const received = roundCrypto(addressActivity.totalReceived);
  const confirmed = roundCrypto(addressActivity.confirmedReceived);
  const isExpired = fromSqlDateTime(invoice.expires_at)?.getTime() < Date.now();

  if (confirmed >= expected && expected > 0) {
    return 'paid';
  }

  if (received >= expected && expected > 0) {
    return 'confirming';
  }

  if (received > 0) {
    return 'partial_payment';
  }

  if (isExpired) {
    return 'expired';
  }

  return 'awaiting_payment';
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function serializePublicInvoice(invoice) {
  if (!invoice) return null;

  const paymentMethod = getInvoicePaymentMethod(invoice);
  const isCryptoInvoice = isCryptoPaymentMethod(paymentMethod);
  const invoicePath = getInvoicePath(invoice.public_id);
  const giftPath = invoice.gift_token ? getGiftPath(invoice.gift_token) : null;
  const isGiftDelivered = invoice.recipient_mode === 'gift' && invoice.status === 'delivered' && invoice.gift_token;
  const isSelfDelivered = invoice.recipient_mode === 'self' && invoice.status === 'delivered' && invoice.vip_key_value;

  return {
    publicId: invoice.public_id,
    status: invoice.status,
    paymentMethod,
    coin: isCryptoInvoice ? normalizeCoin(invoice.coin) : null,
    packEur: roundFiat(invoice.pack_eur),
    amountEur: roundFiat(invoice.amount_eur),
    amountUsd: roundFiat(invoice.amount_usd),
    amountCryptoExpected: isCryptoInvoice ? roundCrypto(invoice.amount_crypto_expected) : null,
    amountCryptoReceived: isCryptoInvoice ? roundCrypto(invoice.amount_crypto_received) : null,
    vipYears: parseNumber(invoice.vip_years),
    durationLabel: buildDurationLabel(parseNumber(invoice.vip_years)),
    recipientMode: invoice.recipient_mode,
    paymentAddress: isCryptoInvoice ? invoice.payment_address : null,
    trackingAddress: isPaygatePaymentMethod(paymentMethod)
      ? (invoice.paygate_tracking_address || invoice.payment_address || null)
      : null,
    checkoutUrl: isCryptoGatePaymentMethod(paymentMethod)
      ? (invoice.cryptogate_checkout_url || null)
      : isPaygatePaymentMethod(paymentMethod)
        ? resolvePaygateCheckoutUrl(invoice)
        : isPayblisPaymentMethod(paymentMethod)
          ? (invoice.payblis_checkout_url || null)
          : null,
    addressType: isCryptoInvoice ? (invoice.address_type || null) : null,
    confirmations: isCryptoInvoice ? parseNumber(invoice.confirmations) : null,
    requiredConfirmations: isCryptoInvoice ? parseNumber(invoice.required_confirmations) : null,
    expiresAt: fromSqlDateTime(invoice.expires_at)?.toISOString() || null,
    paidAt: fromSqlDateTime(invoice.paid_at)?.toISOString() || null,
    deliveredAt: fromSqlDateTime(invoice.delivered_at)?.toISOString() || null,
    createdAt: fromSqlDateTime(invoice.created_at)?.toISOString() || null,
    qrPayload: isCryptoInvoice ? invoice.qr_payload : null,
    invoicePath,
    invoiceUrl: buildFrontendUrl(invoicePath),
    giftPath: isGiftDelivered ? giftPath : null,
    giftUrl: isGiftDelivered ? buildFrontendUrl(giftPath) : null,
    vipKey: isSelfDelivered ? invoice.vip_key_value : null,
    externalOrderId: null,
    externalGateway: null,
    externalAmount: null,
    externalCurrency: null,
    supportTelegramUrl: getSupportTelegramUrl()
  };
}

function serializeAdminInvoice(invoice) {
  if (!invoice) return null;

  return {
    ...serializePublicInvoice(invoice),
    id: parseNumber(invoice.id),
    callbackUrl: null,
    derivationIndex: parseNumber(invoice.derivation_index, -1) >= 0
      ? parseNumber(invoice.derivation_index)
      : null,
    txHash: invoice.tx_hash || null,
    giftToken: invoice.gift_token || null,
    giftSealed: Boolean(invoice.gift_sealed),
    giftUnsealedAt: fromSqlDateTime(invoice.gift_unsealed_at)?.toISOString() || null,
    giftUnsealCount: parseNumber(invoice.gift_unseal_count),
    createdByUserId: invoice.created_by_user_id || null,
    createdByUserType: invoice.created_by_user_type || null,
    createdBySessionId: invoice.created_by_session_id || null,
    createdIpHash: invoice.created_ip_hash || null,
    payerEmail: invoice.cryptogate_payer_email || invoice.paygate_payer_email || invoice.payblis_payer_email || null,
    temporaryWalletAddress: invoice.paygate_temporary_wallet_address || null,
    paidCoin: invoice.paygate_paid_coin || invoice.cryptogate_provider || null,
    paidValue: invoice.paygate_paid_value !== null && invoice.paygate_paid_value !== undefined
      ? roundFiat(invoice.paygate_paid_value)
      : null,
    paidTxid: invoice.paygate_paid_txid || invoice.payblis_transaction_id || null,
    externalOrderId: invoice.cryptogate_payment_id || invoice.payblis_ref_order || null,
    externalProductId: null,
    externalGateway: invoice.cryptogate_payment_id
      ? 'cryptogate'
      : invoice.payblis_ref_order
        ? 'payblis'
        : null,
    externalCurrency: invoice.cryptogate_paid_currency || invoice.payblis_paid_currency || null,
    externalAmount: invoice.cryptogate_paid_amount !== null && invoice.cryptogate_paid_amount !== undefined
      ? roundFiat(invoice.cryptogate_paid_amount)
      : invoice.payblis_paid_amount !== null && invoice.payblis_paid_amount !== undefined
        ? roundFiat(invoice.payblis_paid_amount)
        : null,
    payblisMethod: invoice.payblis_method || null,
    payblisCustomerName: invoice.payblis_customer_name || null,
    payblisIpnReceivedAt: fromSqlDateTime(invoice.payblis_ipn_received_at)?.toISOString() || null,
    reason: STATUS_REASONS[invoice.status] || null
  };
}

function serializeGift(invoice) {
  if (!invoice || invoice.recipient_mode !== 'gift') {
    return null;
  }

  return {
    giftToken: invoice.gift_token,
    status: invoice.gift_sealed ? 'sealed' : 'unsealed',
    invoiceStatus: invoice.status,
    vipYears: parseNumber(invoice.vip_years),
    durationLabel: buildDurationLabel(parseNumber(invoice.vip_years)),
    createdAt: fromSqlDateTime(invoice.created_at)?.toISOString() || null,
    unsealedAt: fromSqlDateTime(invoice.gift_unsealed_at)?.toISOString() || null,
    vipKey: !invoice.gift_sealed && invoice.status === 'delivered' ? invoice.vip_key_value : null,
    supportTelegramUrl: getSupportTelegramUrl()
  };
}

async function listUserVipInvoices(pool, auth, options = {}) {
  if (!auth?.userId || !auth?.userType) {
    return [];
  }

  const limit = Math.min(100, Math.max(1, parseNumber(options.limit, 30)));
  const [rows] = await pool.execute(
    `SELECT * FROM vip_invoices
      WHERE created_by_user_id = ?
        AND created_by_user_type = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    [auth.userId, auth.userType, limit]
  );

  const normalizedRows = await Promise.all(
    rows.map((invoice) => expireAwaitingInvoiceIfOverdue(pool, invoice))
  );

  return normalizedRows.map(serializePublicInvoice);
}

async function recordPaygateUnpaidReconciliation(
  pool,
  invoiceId,
  expectedIpnToken,
  options = {}
) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE id = ? FOR UPDATE',
      [invoiceId]
    );
    const invoice = rows[0];
    if (!invoice) {
      throw createPaygateCallbackError('PAYGATE_INVOICE_NOT_FOUND', 404);
    }
    const isStillEligible = (
      isPaygatePaymentMethod(getInvoicePaymentMethod(invoice))
      && !FINAL_STATUSES.has(invoice.status)
      && invoice.status !== 'paid'
      && invoice.paygate_ipn_token === expectedIpnToken
    );
    if (!isStillEligible) {
      await connection.commit();
      return invoice;
    }
    requireValidPaygateInvoiceAmountUsd(invoice);

    await logVipInvoiceEvent(
      connection,
      invoice.id,
      'invoice_paygate_admin_reconciliation_unpaid',
      'Réconciliation PayGate administrateur: paiement non détecté.',
      { previousStatus: invoice.status, result: 'unpaid' },
      options.actorType || 'admin',
      options.actorId || null
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return fetchInvoiceById(pool, invoiceId);
}

async function reconcilePaygateInvoiceStatus(pool, invoice, options = {}) {
  if (
    !invoice
    || !isPaygatePaymentMethod(getInvoicePaymentMethod(invoice))
    || FINAL_STATUSES.has(invoice.status)
    || !invoice.paygate_ipn_token
  ) {
    return invoice;
  }

  const paygateClient = getPaygateClient(options);
  const status = await paygateClient.fetchPaymentStatus(invoice.paygate_ipn_token);
  if (status.status === 'unpaid') {
    return recordPaygateUnpaidReconciliation(
      pool,
      invoice.id,
      invoice.paygate_ipn_token,
      options
    );
  }

  const paidUsd = await paygateClient.convertPaymentToUsd({
    coin: status.coin,
    valueCoin: status.valueCoin
  });
  return applyPaygatePaymentObservation(
    pool,
    invoice.id,
    {
      coin: status.coin,
      paidUsd,
      valueCoin: status.valueCoin,
      txidIn: null,
      txidOut: status.txidOut
    },
    {
      source: 'admin_reconciliation',
      eventType: 'invoice_paygate_admin_reconciliation_paid',
      actorType: options.actorType || 'admin',
      actorId: options.actorId || null,
      reason: 'paygate_admin_reconciliation',
      deliverInvoice: options.deliverInvoice
    }
  );
}

async function refreshInvoiceStatus(pool, invoiceInput, options = {}) {
  const invoice = invoiceInput?.id ? invoiceInput : await fetchInvoiceById(pool, invoiceInput);
  if (!invoice) {
    return null;
  }

  if (FINAL_STATUSES.has(invoice.status)) {
    return invoice;
  }

  const now = Date.now();
  const nextCheckAt = invoice.next_check_at ? new Date(invoice.next_check_at).getTime() : 0;
  const force = options.force === true;

  if (!force && nextCheckAt > now) {
    return invoice;
  }

  const paymentMethod = getInvoicePaymentMethod(invoice);
  const rawPaymentMethod = String(invoice.payment_method || '').trim().toLowerCase();

  if (isPayblisPaymentMethod(paymentMethod)) {
    try {
      const status = await require('./vipPayblis').fetchPayblisTransactionStatus(
        invoice.payblis_ref_order,
        {}
      );
      await logVipInvoiceEvent(
        pool,
        invoice.id,
        'invoice_payblis_status_refreshed',
        'Statut Payblis rafraîchi via REST API.',
        { refOrder: invoice.payblis_ref_order, status },
        options.actorType || 'system',
        options.actorId || null
      );
      const mapped = require('./vipPayblis').normalizeIpnStatus(
        status?.data?.status || status?.status || status?.event
      );
      if (mapped === 'success' && invoice.status === 'awaiting_payment') {
        await markPayblisInvoicePaidFromRest(pool, invoice, status);
      }
    } catch (error) {
      // Non-fatal — backup poll, don't escalate.
    }
    return fetchInvoiceById(pool, invoice.id);
  }

  if (isCryptoGatePaymentMethod(paymentMethod)) {
    if (invoice.status === 'paid') {
      const deliver = options.deliverInvoice || deliverInvoiceIfReady;
      return deliver(
        pool,
        invoice.id,
        options.actorType || 'system',
        options.actorId || null,
        'cryptogate_paid_recovery'
      );
    }
    return expireAwaitingInvoiceIfOverdue(pool, invoice);
  }

  if (isPaygatePaymentMethod(paymentMethod)) {
    if (invoice.status === 'paid') {
      const deliver = options.deliverInvoice || deliverInvoiceIfReady;
      return deliver(
        pool,
        invoice.id,
        options.actorType || 'system',
        options.actorId || null,
        'paygate_paid_recovery'
      );
    }

    if (options.allowPaygateReconciliation === true) {
      return reconcilePaygateInvoiceStatus(pool, invoice, options);
    }

    return expireAwaitingInvoiceIfOverdue(pool, invoice);
  }

  if (isAutoBuyPaymentMethod(rawPaymentMethod)) {
    const isExpired = fromSqlDateTime(invoice.expires_at)?.getTime() < Date.now();

    if (invoice.status === 'paid') {
      return deliverInvoiceIfReady(
        pool,
        invoice.id,
        options.actorType || 'system',
        options.actorId || null,
        'legacy_autobuy_paid_invoice'
      );
    }

    if (invoice.status === 'awaiting_payment' && isExpired) {
      await pool.execute(
        `UPDATE vip_invoices
          SET status = 'expired',
              next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND),
              updated_at = NOW()
          WHERE id = ?`,
        [invoice.id]
      );

      await logVipInvoiceEvent(
        pool,
        invoice.id,
        'invoice_status_updated',
        STATUS_REASONS.expired,
        {
          from: invoice.status,
          to: 'expired'
        },
        options.actorType || 'system',
        options.actorId || null
      );
    } else {
      await pool.execute(
        'UPDATE vip_invoices SET next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND), updated_at = NOW() WHERE id = ?',
        [invoice.id]
      );
    }

    const refreshedInvoice = await fetchInvoiceById(pool, invoice.id);
    return refreshedInvoice;
  }

  const addressActivity = await fetchAddressActivity(invoice.coin, invoice.payment_address, {
    ignoreBefore: invoice.created_at
  });
  const newStatus = determineInvoiceStatus(invoice, addressActivity);
  const amountReceived = roundCrypto(addressActivity.totalReceived);
  const txHash = addressActivity.txHashes[0] || invoice.tx_hash || null;
  const shouldMarkPaidAt = newStatus === 'paid' && !invoice.paid_at;
  const hasChanged = newStatus !== invoice.status
    || roundCrypto(parseNumber(invoice.amount_crypto_received)) !== amountReceived
    || parseNumber(invoice.confirmations) !== addressActivity.confirmations
    || txHash !== (invoice.tx_hash || null);

  if (hasChanged) {
    await pool.execute(
      `UPDATE vip_invoices
        SET status = ?,
            amount_crypto_received = ?,
            confirmations = ?,
            tx_hash = ?,
            paid_at = CASE WHEN ? THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
            next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND),
            updated_at = NOW()
        WHERE id = ?`,
      [
        newStatus,
        amountReceived,
        addressActivity.confirmations,
        txHash,
        shouldMarkPaidAt ? 1 : 0,
        invoice.id
      ]
    );

    await logVipInvoiceEvent(
      pool,
      invoice.id,
      'invoice_status_updated',
      STATUS_REASONS[newStatus] || 'Statut d\'invoice mis à jour.',
      {
        from: invoice.status,
        to: newStatus,
        amountCryptoReceived: amountReceived,
        confirmations: addressActivity.confirmations,
        txHash
      },
      options.actorType || 'system',
      options.actorId || null
    );
  } else {
    await pool.execute(
      'UPDATE vip_invoices SET next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND), updated_at = NOW() WHERE id = ?',
      [invoice.id]
    );
  }

  const refreshedInvoice = await fetchInvoiceById(pool, invoice.id);
  if (refreshedInvoice?.status === 'paid') {
    return deliverInvoiceIfReady(
      pool,
      refreshedInvoice.id,
      options.actorType || 'system',
      options.actorId || null,
      'blockchain_confirmed'
    );
  }

  return refreshedInvoice;
}

async function listVipInvoices(pool, options = {}) {
  const page = Math.max(1, parseNumber(options.page, 1));
  const limit = Math.min(100, Math.max(1, parseNumber(options.limit, 30)));
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];

  if (options.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  if (options.search) {
    conditions.push(`(
      public_id LIKE ?
      OR payment_address LIKE ?
      OR COALESCE(tx_hash, '') LIKE ?
      OR COALESCE(vip_key_value, '') LIKE ?
      OR COALESCE(gift_token, '') LIKE ?
      OR COALESCE(paygate_tracking_address, '') LIKE ?
      OR COALESCE(paygate_paid_txid, '') LIKE ?
      OR COALESCE(paygate_payer_email, '') LIKE ?
      OR COALESCE(autobuy_order_id, '') LIKE ?
      OR COALESCE(autobuy_product_id, '') LIKE ?
      OR COALESCE(autobuy_email, '') LIKE ?
    )`);
    const searchTerm = `%${options.search}%`;
    params.push(
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows] = await pool.execute(
    `SELECT * FROM vip_invoices ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM vip_invoices ${whereClause}`,
    params
  );

  const total = parseNumber(countRows[0]?.total, 0);

  return {
    items: rows.map(serializeAdminInvoice),
    total,
    page,
    limit,
    hasMore: offset + rows.length < total
  };
}

async function getVipInvoiceDetails(pool, invoiceId) {
  const invoice = await fetchInvoiceById(pool, invoiceId);
  if (!invoice) {
    return null;
  }

  const [events] = await pool.execute(
    'SELECT * FROM vip_invoice_events WHERE invoice_id = ? ORDER BY created_at DESC, id DESC',
    [invoiceId]
  );

  return {
    invoice: serializeAdminInvoice(invoice),
    events: events.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      actorType: event.actor_type,
      actorId: event.actor_id,
      message: event.message,
      payload: event.payload_json ? safeJsonParse(event.payload_json) : null,
      createdAt: fromSqlDateTime(event.created_at)?.toISOString() || null
    }))
  };
}

function createVipInvoiceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function createCryptoVipInvoice(pool, payload, context = {}) {
  const pack = payload.pack;
  const coin = payload.coin;
  const recipientMode = payload.recipientMode;

  if (!pack || !coin || !recipientMode) {
    throw createVipInvoiceError('Paramètres d\'invoice invalides');
  }

  const pricing = await buildPricingSnapshot(coin, pack.amountEur);
  const derivationIndex = await reserveDerivationIndex(pool, coin);
  const derivedAddress = derivePaymentAddress(coin, derivationIndex);
  const publicId = `inv_${crypto.randomBytes(12).toString('hex')}`;
  const giftToken = recipientMode === 'gift' ? `gift_${crypto.randomBytes(16).toString('hex')}` : null;
  const expiresAt = new Date(Date.now() + (Math.max(1, parseNumber(process.env.VIP_INVOICE_EXPIRATION_MINUTES, DEFAULT_EXPIRATION_MINUTES)) * 60 * 1000));
  const qrPayload = buildQrPayload(coin, derivedAddress.address, pricing.amountCryptoExpected);
  const createdIpHash = hashIp(context.ipAddress);
  const auth = context.auth || null;

  const [insertResult] = await pool.execute(
    `INSERT INTO vip_invoices
      (public_id, payment_method, status, coin, pack_eur, amount_eur, amount_usd, amount_crypto_expected,
       amount_crypto_received, vip_years, recipient_mode, payment_address, address_type,
       derivation_index, confirmations, required_confirmations, tx_hash, qr_payload, gift_token,
       gift_sealed, gift_unsealed_at, gift_unseal_count, gift_unsealed_by_ip_hash,
       vip_key_value, created_by_user_id, created_by_user_type, created_by_session_id,
       created_ip_hash, expires_at, next_check_at, created_at, updated_at)
      VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, 1, NULL, 0, NULL, NULL, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
    [
      publicId,
      coin,
      coin,
      pack.amountEur,
      pricing.amountEur,
      pricing.amountUsd,
      pricing.amountCryptoExpected,
      pack.vipYears,
      recipientMode,
      derivedAddress.address,
      derivedAddress.addressType,
      derivationIndex,
      getRequiredConfirmations(coin),
      qrPayload,
      giftToken,
      auth?.userId || null,
      auth?.userType || null,
      auth?.sessionId || null,
      createdIpHash,
      toSqlDateTime(expiresAt)
    ]
  );

  await logVipInvoiceEvent(
    pool,
    insertResult.insertId,
    'invoice_created',
    'Invoice VIP créée.',
    {
      paymentMethod: coin,
      coin,
      packEur: pack.amountEur,
      amountCryptoExpected: pricing.amountCryptoExpected,
      vipYears: pack.vipYears,
      recipientMode,
      derivationIndex,
      paymentAddress: derivedAddress.address
    },
    auth ? 'user' : 'guest',
    auth?.userId || null
  );

  return fetchInvoiceById(pool, insertResult.insertId);
}

async function createPaygateVipInvoice(pool, payload, context = {}) {
  const pack = payload.pack;
  const recipientMode = payload.recipientMode;
  const normalizedEmail = normalizeEmailAddress(payload.payerEmail);

  if (!pack || !recipientMode || !normalizedEmail) {
    throw createVipInvoiceError('Adresse email invalide pour PayGate');
  }

  const publicId = `inv_${crypto.randomBytes(12).toString('hex')}`;
  const callbackReference = crypto.randomBytes(24).toString('hex');
  const callbackNonce = crypto.randomBytes(24).toString('hex');

  try {
    const callbackUrl = vipPaygate.buildPaygateCallbackUrl({
      baseUrl: getPaygateCallbackBaseUrl(context),
      reference: callbackReference,
      nonce: callbackNonce,
      requireHttps: process.env.NODE_ENV === 'production'
    });
    const checkoutAmountEur = getPaygateCheckoutAmountEur(pack.amountEur);
    const paygateClient = getPaygateClient(context);
    const amountUsd = vipPaygate.normalizePaygateInvoiceUsd(
      await paygateClient.convertEurToUsd(checkoutAmountEur)
    );
    const paygateWallet = await paygateClient.createWallet({
      settlementWallet: getPaygatePayoutWallet(),
      callbackUrl
    });
    const checkoutUrl = vipPaygate.buildPaygateCheckoutUrl({
      checkoutAddress: paygateWallet.checkoutAddress,
      amountEur: checkoutAmountEur,
      payerEmail: normalizedEmail,
      branding: getPaygateBranding(),
      checkoutHost: getPaygateCheckoutDomain()
    });
    const expiresAt = new Date(Date.now() + (
      Math.max(
        1,
        parseNumber(
          process.env.VIP_INVOICE_EXPIRATION_MINUTES,
          DEFAULT_EXPIRATION_MINUTES
        )
      ) * 60 * 1000
    ));
    const giftToken = recipientMode === 'gift'
      ? `gift_${crypto.randomBytes(16).toString('hex')}`
      : null;
    const createdIpHash = hashIp(context.ipAddress);
    const auth = context.auth || null;
    const connection = await pool.getConnection();
    let insertId;

    try {
      await connection.beginTransaction();
      const [insertResult] = await connection.execute(
        `INSERT INTO vip_invoices
          (public_id, payment_method, status, pack_eur, amount_eur, amount_usd,
           amount_crypto_expected, amount_crypto_received, vip_years, recipient_mode,
           payment_address, derivation_index, confirmations, required_confirmations,
           qr_payload, gift_token, gift_sealed, gift_unseal_count,
           created_by_user_id, created_by_user_type, created_by_session_id,
           created_ip_hash, expires_at, next_check_at,
           paygate_callback_reference, paygate_tracking_address,
           paygate_temporary_wallet_address, paygate_callback_url,
           paygate_callback_nonce, paygate_checkout_url, paygate_payer_email,
           paygate_ipn_token, created_at, updated_at)
          VALUES
          (?, 'paygate_hosted', 'awaiting_payment', ?, ?, ?, 0, 0, ?, ?, ?,
           -1, 0, 0, '', ?, 1, 0, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?,
           NOW(), NOW())`,
        [
          publicId,
          pack.amountEur,
          checkoutAmountEur,
          amountUsd,
          pack.vipYears,
          recipientMode,
          paygateWallet.checkoutAddress,
          giftToken,
          auth?.userId || null,
          auth?.userType || null,
          auth?.sessionId || null,
          createdIpHash,
          toSqlDateTime(expiresAt),
          callbackReference,
          paygateWallet.checkoutAddress,
          paygateWallet.temporaryWalletAddress,
          paygateWallet.callbackUrl,
          callbackNonce,
          checkoutUrl,
          normalizedEmail,
          paygateWallet.ipnToken
        ]
      );
      insertId = insertResult.insertId;

      await logVipInvoiceEvent(
        connection,
        insertId,
        'invoice_created',
        'Invoice VIP PayGate créée.',
        {
          paymentMethod: 'paygate_hosted',
          packEur: pack.amountEur,
          checkoutAmountEur,
          amountUsd,
          vipYears: pack.vipYears,
          recipientMode
        },
        auth ? 'user' : 'guest',
        auth?.userId || null
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return fetchInvoiceById(pool, insertId);
  } catch (error) {
    if (error?.message === 'Adresse email invalide pour PayGate') throw error;
    throw mapPaygateServiceError(error, 'create_invoice', callbackReference);
  }
}

async function createCryptoGateVipInvoice(pool, payload, context = {}) {
  const pack = payload.pack;
  const recipientMode = payload.recipientMode;
  const normalizedEmail = normalizeEmailAddress(payload.payerEmail)
    || normalizeEmailAddress(context.auth?.email);

  if (!pack || !recipientMode || !normalizedEmail) {
    throw createVipInvoiceError('Adresse email invalide pour CryptoGate');
  }
  if (!isCryptoGateEnabled()) {
    throw createVipInvoiceError('Paiement CryptoGate indisponible pour le moment', 503);
  }
  if (!String(process.env.VIP_CRYPTOGATE_API_KEY || '').trim()) {
    const error = createVipInvoiceError('Configuration CryptoGate incomplète', 503);
    error.code = 'CRYPTOGATE_API_KEY_MISSING';
    throw error;
  }
  if (!String(process.env.VIP_CRYPTOGATE_WEBHOOK_SECRET || '').trim()) {
    const error = createVipInvoiceError('Configuration CryptoGate incomplète', 503);
    error.code = 'CRYPTOGATE_WEBHOOK_SECRET_MISSING';
    throw error;
  }

  const publicId = `inv_${crypto.randomBytes(12).toString('hex')}`;
  let payment;
  try {
    payment = await getCryptoGateClient(context).createPayment({
      amount: pack.amountEur,
      currency: 'EUR',
      email: normalizedEmail,
      orderId: publicId,
      label: `Movix VIP ${buildDurationLabel(pack.vipYears)}`,
      description: `Pack VIP Movix - ${buildDurationLabel(pack.vipYears)}`
    });
  } catch (error) {
    const mapped = createVipInvoiceError(
      error?.statusCode >= 500 ? 'Service CryptoGate temporairement indisponible' : (error?.message || 'Paiement CryptoGate invalide'),
      error?.statusCode || 502
    );
    mapped.code = error?.code || 'CRYPTOGATE_CREATE_FAILED';
    throw mapped;
  }

  const expirationMinutes = Math.max(
    1,
    parseNumber(process.env.VIP_INVOICE_EXPIRATION_MINUTES, DEFAULT_EXPIRATION_MINUTES)
  );
  const expiresAt = new Date(Date.now() + expirationMinutes * 60 * 1000);
  const giftToken = recipientMode === 'gift'
    ? `gift_${crypto.randomBytes(16).toString('hex')}`
    : null;
  const createdIpHash = hashIp(context.ipAddress);
  const auth = context.auth || null;
  const connection = await pool.getConnection();
  let insertId;

  try {
    await connection.beginTransaction();
    const [insertResult] = await connection.execute(
      `INSERT INTO vip_invoices
        (public_id, payment_method, status, coin, pack_eur, amount_eur, amount_usd,
         amount_crypto_expected, amount_crypto_received, vip_years, recipient_mode,
         payment_address, address_type, derivation_index, confirmations,
         required_confirmations, tx_hash, qr_payload, gift_token, gift_sealed,
         gift_unsealed_at, gift_unseal_count, gift_unsealed_by_ip_hash,
         vip_key_value, created_by_user_id, created_by_user_type,
         created_by_session_id, created_ip_hash, expires_at, next_check_at,
         cryptogate_payment_id, cryptogate_checkout_url, cryptogate_payer_email,
         created_at, updated_at)
        VALUES
        (?, 'cryptogate', 'awaiting_payment', NULL, ?, ?, 0, NULL, 0, ?, ?,
         NULL, NULL, NULL, 0, 0, NULL, NULL, ?, 1, NULL, 0, NULL, NULL,
         ?, ?, ?, ?, ?, NOW(), ?, ?, ?, NOW(), NOW())`,
      [
        publicId,
        pack.amountEur,
        pack.amountEur,
        pack.vipYears,
        recipientMode,
        giftToken,
        auth?.userId || null,
        auth?.userType || null,
        auth?.sessionId || null,
        createdIpHash,
        toSqlDateTime(expiresAt),
        payment.paymentId,
        payment.checkoutUrl,
        normalizedEmail
      ]
    );
    insertId = insertResult.insertId;

    await logVipInvoiceEvent(
      connection,
      insertId,
      'invoice_cryptogate_created',
      'Invoice VIP CryptoGate créée.',
      {
        paymentMethod: 'cryptogate',
        paymentId: payment.paymentId,
        packEur: pack.amountEur,
        vipYears: pack.vipYears,
        recipientMode
      },
      auth ? 'user' : 'guest',
      auth?.userId || null
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return fetchInvoiceById(pool, insertId);
}

async function createPayblisVipInvoice(pool, { pack, recipientMode, payerEmail, auth }, context) {
  const payblisMod = require('./vipPayblis');
  if (!payblisMod.isPayblisEnabled()) {
    throw createVipInvoiceError('Paiement Payblis indisponible pour le moment');
  }

  const merchantKey = payblisMod.getPayblisMerchantKey();
  const secretKey = payblisMod.getPayblisSecretKey();
  if (!merchantKey || !secretKey) {
    throw createVipInvoiceError('Configuration Payblis manquante');
  }

  const normalizedEmail = normalizeEmailAddress(payerEmail) || normalizeEmailAddress(auth?.email);
  if (!normalizedEmail) {
    throw createVipInvoiceError('Email requis pour Payblis');
  }

  const ipnBaseUrl = payblisMod.getPayblisIpnBaseUrl(context);
  if (!ipnBaseUrl) {
    throw createVipInvoiceError('VIP Payblis callback URL introuvable');
  }
  const frontendBaseUrl = payblisMod.getPayblisFrontendBaseUrl();
  if (!frontendBaseUrl) {
    throw createVipInvoiceError('FRONTEND_BASE_URL manquant');
  }

  const publicId = `inv_${crypto.randomBytes(12).toString('hex')}`;
  const refOrder = `mvx_${publicId}`;
  const customerName = payblisMod.derivePseudo({ auth, payerEmail: normalizedEmail });
  const createdIpHash = hashIp(context.ipAddress);
  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRATION_MINUTES * 60 * 1000);
  const amountUsd = await fetchPaygateConvertedUsd(pack.amountEur, 'eur').catch(() => roundFiat(pack.amountEur * 1.08));
  const giftToken = recipientMode === 'gift' ? crypto.randomBytes(16).toString('hex') : null;

  const payload = payblisMod.buildPayblisPayload({
    merchantKey,
    secretKey,
    sandbox: payblisMod.isPayblisSandbox(),
    amountEur: pack.amountEur,
    productName: `Movix VIP ${buildDurationLabel(pack.vipYears)}`,
    refOrder,
    payerEmail: normalizedEmail,
    customerName,
    countryCode: 'FR',
    userIp: context.ipAddress || '',
    lang: context.locale === 'en' ? 'en' : 'fr',
    storeName: payblisMod.getPayblisStoreName(),
    urlOK: `${frontendBaseUrl}/vip/invoice/${encodeURIComponent(publicId)}?payblis=ok`,
    urlKO: `${frontendBaseUrl}/vip/invoice/${encodeURIComponent(publicId)}?payblis=ko`,
    ipnURL: `${ipnBaseUrl}/api/vip/payblis/ipn?publicId=${encodeURIComponent(publicId)}`
  });
  const checkoutUrl = payblisMod.buildPayblisCheckoutUrl(payload);

  const [insertResult] = await pool.execute(
    `INSERT INTO vip_invoices
      (public_id, payment_method, status, coin, pack_eur, amount_eur, amount_usd, amount_crypto_expected,
       amount_crypto_received, vip_years, recipient_mode, payment_address, address_type, derivation_index,
       confirmations, required_confirmations, tx_hash, qr_payload, gift_token, gift_sealed, gift_unsealed_at,
       gift_unseal_count, gift_unsealed_by_ip_hash, vip_key_value, created_by_user_id, created_by_user_type,
       created_by_session_id, created_ip_hash, expires_at, next_check_at,
       payblis_ref_order, payblis_checkout_url, payblis_payer_email, payblis_customer_name,
       created_at, updated_at)
      VALUES (?, 'payblis', 'awaiting_payment', NULL, ?, ?, ?, NULL, 0, ?, ?, NULL, NULL, NULL,
        0, 0, NULL, NULL, ?, 1, NULL, 0, NULL, NULL, ?, ?, ?, ?, ?, NOW(),
        ?, ?, ?, ?, NOW(), NOW())`,
    [
      publicId,
      pack.amountEur,
      pack.amountEur,
      amountUsd,
      pack.vipYears,
      recipientMode,
      giftToken,
      auth?.userId || null,
      auth?.userType || null,
      auth?.sessionId || null,
      createdIpHash,
      toSqlDateTime(expiresAt),
      refOrder,
      checkoutUrl,
      normalizedEmail,
      customerName
    ]
  );

  await logVipInvoiceEvent(
    pool,
    insertResult.insertId,
    'invoice_payblis_created',
    'Invoice VIP Payblis créée.',
    {
      paymentMethod: 'payblis',
      packEur: pack.amountEur,
      amountUsd,
      vipYears: pack.vipYears,
      recipientMode,
      refOrder,
      payerEmail: normalizedEmail,
      customerName,
      sandbox: payblisMod.isPayblisSandbox()
    },
    auth ? 'user' : 'guest',
    auth?.userId || null
  );

  return fetchInvoiceById(pool, insertResult.insertId);
}

function createPaygateCallbackError(code, statusCode) {
  const error = createVipInvoiceError('Callback PayGate invalide', statusCode);
  error.code = code;
  return error;
}

function requireValidPaygateInvoiceAmountUsd(invoice) {
  try {
    return vipPaygate.normalizePaygateInvoiceUsd(invoice?.amount_usd);
  } catch {
    throw createPaygateCallbackError('PAYGATE_INVOICE_AMOUNT_INVALID', 409);
  }
}

async function fetchPaygateInvoiceForCallback(pool, callback) {
  const [rows] = callback.reference
    ? await pool.execute(
      `SELECT * FROM vip_invoices
        WHERE paygate_callback_reference = ?
          AND payment_method = 'paygate_hosted'
        LIMIT 1`,
      [callback.reference]
    )
    : await pool.execute(
      `SELECT * FROM vip_invoices
        WHERE public_id = ?
          AND paygate_callback_reference IS NULL
          AND payment_method = 'paygate_hosted'
        LIMIT 1`,
      [callback.publicId]
    );
  if (!rows[0]) {
    throw createPaygateCallbackError('PAYGATE_CALLBACK_AUTH_FAILED', 403);
  }
  return rows[0];
}

function assertPaygateCallbackBinding(invoice, callback) {
  if (!isPaygatePaymentMethod(getInvoicePaymentMethod(invoice))) {
    throw createPaygateCallbackError('PAYGATE_CALLBACK_METHOD_MISMATCH', 409);
  }
  if (!vipPaygate.safeComparePaygateNonce(
    invoice.paygate_callback_nonce,
    callback.nonce
  )) {
    throw createPaygateCallbackError('PAYGATE_CALLBACK_AUTH_FAILED', 403);
  }
  const expectedAddress = String(
    invoice.paygate_temporary_wallet_address || ''
  ).trim().toLowerCase();
  if (!expectedAddress || expectedAddress !== callback.addressIn) {
    throw createPaygateCallbackError('PAYGATE_CALLBACK_ADDRESS_MISMATCH', 403);
  }
}

const PAYGATE_PAYMENT_NEEDS_PRICING = Symbol('paygate_payment_needs_pricing');

async function applyPaygatePaymentObservation(pool, invoiceId, payment, options = {}) {
  const connection = await pool.getConnection();
  let shouldDeliver = false;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE id = ? FOR UPDATE',
      [invoiceId]
    );
    const invoice = rows[0];
    if (!invoice) {
      throw createPaygateCallbackError('PAYGATE_INVOICE_NOT_FOUND', 404);
    }
    if (typeof options.validateInvoice === 'function') {
      options.validateInvoice(invoice);
    }
    const invoiceAmountUsd = requireValidPaygateInvoiceAmountUsd(invoice);

    const existingTxidIn = String(invoice.paygate_paid_txid_in || '').toLowerCase();
    const existingTxidOut = String(invoice.paygate_paid_txid || '').toLowerCase();
    const existingCoin = String(invoice.paygate_paid_coin || '').toLowerCase();
    if (existingTxidIn && payment.txidIn && existingTxidIn !== payment.txidIn) {
      throw createPaygateCallbackError('PAYGATE_TXID_CHANGED', 409);
    }
    if (existingTxidOut && payment.txidOut && existingTxidOut !== payment.txidOut) {
      throw createPaygateCallbackError('PAYGATE_TXID_OUT_CHANGED', 409);
    }
    if (existingCoin && payment.coin && existingCoin !== payment.coin) {
      throw createPaygateCallbackError('PAYGATE_COIN_CHANGED', 409);
    }
    if (payment.txidIn) {
      const [owners] = await connection.execute(
        `SELECT id FROM vip_invoices
          WHERE paygate_paid_txid_in = ?
            AND id <> ?
          LIMIT 1`,
        [payment.txidIn, invoice.id]
      );
      if (owners.length > 0) {
        throw createPaygateCallbackError('PAYGATE_TXID_ALREADY_USED', 409);
      }
    }

    if (payment.txidIn && !existingTxidIn && invoice.status !== 'cancelled') {
      const [claimResult] = await connection.execute(
        `UPDATE vip_invoices
          SET paygate_paid_txid_in = ?
          WHERE id = ?
            AND paygate_paid_txid_in IS NULL
            AND status <> 'cancelled'`,
        [payment.txidIn, invoice.id]
      );
      if (parseNumber(claimResult?.affectedRows, 0) !== 1) {
        throw createPaygateCallbackError('PAYGATE_STATE_CONFLICT', 409);
      }
      invoice.paygate_paid_txid_in = payment.txidIn;
    }

    if (invoice.status === 'delivered' || invoice.status === 'cancelled') {
      await connection.commit();
      return invoice;
    }

    if (invoice.status === 'paid') {
      shouldDeliver = true;
      await connection.commit();
    } else {
      const allowedStatuses = new Set([
        'awaiting_payment',
        'partial_payment',
        'expired'
      ]);
      if (!allowedStatuses.has(invoice.status)) {
        await connection.commit();
        return invoice;
      }

      const previousValue = parseNumber(invoice.paygate_paid_value, 0);
      const previousValueCoin = roundCrypto(invoice.amount_crypto_received);
      if (previousValue > 0 && previousValueCoin <= 0) {
        throw createPaygateCallbackError('PAYGATE_PAYMENT_BASELINE_MISSING', 409);
      }

      const observedValueCoin = roundCrypto(payment.valueCoin);
      if (observedValueCoin <= previousValueCoin) {
        await connection.commit();
        return invoice;
      }

      if (payment.paidUsd === undefined || payment.paidUsd === null) {
        await connection.commit();
        return PAYGATE_PAYMENT_NEEDS_PRICING;
      }
      const paidUsd = Number(payment.paidUsd);
      if (!Number.isFinite(paidUsd) || paidUsd <= 0) {
        throw createPaygateCallbackError('PAYGATE_CONVERSION_INVALID', 502);
      }
      const nextPaidValue = Math.max(previousValue, paidUsd);
      const minimumPaidAmount = roundFiat(
        invoiceAmountUsd * getPaygateMinPaidRatio()
      );
      const nextStatus = nextPaidValue >= minimumPaidAmount
        ? 'paid'
        : 'partial_payment';
      const shouldMarkPaidAt = nextStatus === 'paid' && !invoice.paid_at;
      const [updateResult] = await connection.execute(
        `UPDATE vip_invoices
          SET status = ?,
              tx_hash = COALESCE(tx_hash, ?),
              paid_at = CASE
                WHEN ? THEN COALESCE(paid_at, NOW())
                ELSE paid_at
              END,
              paygate_paid_coin = ?,
              paygate_paid_value = ?,
              amount_crypto_received = ?,
              paygate_paid_txid_in = COALESCE(paygate_paid_txid_in, ?),
              paygate_paid_txid = COALESCE(paygate_paid_txid, ?),
              next_check_at = CASE
                WHEN ? = 'paid' THEN NULL
                ELSE DATE_ADD(NOW(), INTERVAL 60 SECOND)
              END,
              updated_at = NOW()
          WHERE id = ?
            AND status IN ('awaiting_payment', 'partial_payment', 'expired')`,
        [
          nextStatus,
          payment.txidOut,
          shouldMarkPaidAt ? 1 : 0,
          payment.coin,
          nextPaidValue,
          observedValueCoin,
          payment.txidIn || null,
          payment.txidOut,
          nextStatus,
          invoice.id
        ]
      );
      if (parseNumber(updateResult?.affectedRows, 0) !== 1) {
        throw createPaygateCallbackError('PAYGATE_STATE_CONFLICT', 409);
      }

      await logVipInvoiceEvent(
        connection,
        invoice.id,
        options.eventType || 'invoice_paygate_callback',
        nextStatus === 'paid'
          ? 'Paiement PayGate validé.'
          : 'Paiement PayGate partiel validé.',
        {
          previousStatus: invoice.status,
          nextStatus,
          paidCoin: payment.coin,
          paidValue: nextPaidValue,
          txidIn: payment.txidIn || null,
          txidOut: payment.txidOut,
          minimumPaidAmount,
          source: options.source || 'callback'
        },
        options.actorType || 'gateway',
        options.actorId || 'paygate'
      );
      shouldDeliver = nextStatus === 'paid';
      await connection.commit();
    }
  } catch (error) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY' || Number(error?.errno) === 1062) {
      throw createPaygateCallbackError('PAYGATE_TXID_ALREADY_USED', 409);
    }
    throw error;
  } finally {
    connection.release();
  }

  const refreshed = await fetchInvoiceById(pool, invoiceId);
  if (shouldDeliver && refreshed?.status === 'paid') {
    const deliver = options.deliverInvoice || deliverInvoiceIfReady;
    return deliver(
      pool,
      invoiceId,
      options.actorType || 'gateway',
      options.actorId || 'paygate',
      options.reason || 'paygate_callback'
    );
  }
  return refreshed;
}

async function handlePaygateCallback(pool, payload = {}, deps = {}) {
  const callback = vipPaygate.parsePaygateCallbackPayload(payload);
  const invoice = await fetchPaygateInvoiceForCallback(pool, callback);
  assertPaygateCallbackBinding(invoice, callback);

  const payment = {
    coin: callback.coin,
    valueCoin: callback.valueCoin,
    txidIn: callback.txidIn,
    txidOut: callback.txidOut
  };
  const options = {
    source: 'callback',
    eventType: 'invoice_paygate_callback',
    actorType: 'gateway',
    actorId: 'paygate',
    reason: 'paygate_callback',
    validateInvoice: (lockedInvoice) => {
      assertPaygateCallbackBinding(lockedInvoice, callback);
    },
    deliverInvoice: deps.deliverInvoice
  };
  const preflight = await applyPaygatePaymentObservation(
    pool,
    invoice.id,
    payment,
    options
  );
  if (preflight !== PAYGATE_PAYMENT_NEEDS_PRICING) {
    return preflight;
  }

  const paygateClient = getPaygateClient(deps);
  let paidUsd;
  try {
    paidUsd = await paygateClient.convertPaymentToUsd({
      coin: callback.coin,
      valueCoin: callback.valueCoin
    });
  } catch (error) {
    try {
      const recovered = await applyPaygatePaymentObservation(
        pool,
        invoice.id,
        payment,
        options
      );
      if (recovered !== PAYGATE_PAYMENT_NEEDS_PRICING) {
        return recovered;
      }
    } catch {
      // The pricing failure remains the authoritative fail-closed result.
    }
    throw error;
  }

  return applyPaygatePaymentObservation(
    pool,
    invoice.id,
    {
      ...payment,
      paidUsd
    },
    options
  );
}

async function handlePayblisIpn(pool, { publicId, body, sourceIp, headerSignature }) {
  const payblisMod = require('./vipPayblis');
  const secretKey = payblisMod.getPayblisSecretKey();

  if (!secretKey) {
    const error = createVipInvoiceError('Secret Key Payblis non configurée', 500);
    error.silent = true;
    throw error;
  }

  const safePublicId = String(publicId || '').trim();
  if (!safePublicId) {
    throw createVipInvoiceError('publicId Payblis manquant', 400);
  }

  const { normalized, raw } = payblisMod.normalizeIpnPayload(body);
  const headerSig = typeof headerSignature === 'string' ? headerSignature.trim() : '';
  const providedSignature = headerSig || normalized.signature || null;
  const signatureSource = headerSig
    ? 'header'
    : (normalized.signature ? 'body' : 'none');
  const signatureValid = payblisMod.verifyPayblisIpnSignature(raw, providedSignature, secretKey);

  if (!signatureValid) {
    const [invoiceRows] = await pool.execute(
      "SELECT id FROM vip_invoices WHERE public_id = ? AND payment_method = 'payblis' LIMIT 1",
      [safePublicId]
    );
    const invoiceId = invoiceRows[0]?.id || null;
    if (invoiceId) {
      await logVipInvoiceEvent(
        pool,
        invoiceId,
        'invoice_payblis_ipn_invalid_signature',
        'Signature Payblis invalide rejetée.',
        {
          sourceIp,
          providedSignature: providedSignature || null,
          signatureSource,
          keys: Object.keys(normalized).sort()
        },
        'gateway',
        'payblis'
      );
    }
    throw createVipInvoiceError('Signature Payblis invalide', 401);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      "SELECT * FROM vip_invoices WHERE public_id = ? FOR UPDATE",
      [safePublicId]
    );
    if (rows.length === 0) {
      throw createVipInvoiceError('Invoice Payblis introuvable', 404);
    }
    const invoice = rows[0];
    if (!isPayblisPaymentMethod(getInvoicePaymentMethod(invoice))) {
      throw createVipInvoiceError('Cette invoice n\'utilise pas Payblis', 409);
    }

    const expectedRefOrder = invoice.payblis_ref_order || `mvx_${safePublicId}`;
    if (String(normalized.merchant_reference || normalized.RefOrder || '') !== expectedRefOrder) {
      await logVipInvoiceEvent(
        connection,
        invoice.id,
        'invoice_payblis_ipn_invalid_signature',
        'Ref Order Payblis ne correspond pas.',
        {
          expected: expectedRefOrder,
          received: normalized.merchant_reference || normalized.RefOrder || null
        },
        'gateway',
        'payblis'
      );
      throw createVipInvoiceError('RefOrder Payblis incohérent', 409);
    }

    const reportedAmount = parseNumber(normalized.amount);
    const invoiceAmount = parseNumber(invoice.amount_eur);
    const reportedStatus = payblisMod.normalizeIpnStatus(normalized.status || normalized.event);
    const priorTransactionId = invoice.payblis_transaction_id;
    const receivedTransactionId = String(normalized.transaction_id || '').trim() || null;

    if (priorTransactionId && receivedTransactionId && priorTransactionId !== receivedTransactionId) {
      await logVipInvoiceEvent(
        connection,
        invoice.id,
        'invoice_payblis_tx_mismatch',
        'Transaction_id Payblis diffère d\'un IPN précédent.',
        { priorTransactionId, receivedTransactionId },
        'gateway',
        'payblis'
      );
      throw createVipInvoiceError('Transaction Payblis incohérente', 409);
    }

    // Duplicate: invoice already delivered, acknowledge idempotently.
    if (invoice.status === 'delivered') {
      await logVipInvoiceEvent(
        connection,
        invoice.id,
        'invoice_payblis_ipn_duplicate',
        'IPN Payblis reçu pour une invoice déjà livrée.',
        { reportedStatus, receivedTransactionId },
        'gateway',
        'payblis'
      );
      await connection.commit();
      return fetchInvoiceById(pool, invoice.id);
    }

    // Cancelled invoices: log but don't mutate.
    if (invoice.status === 'cancelled') {
      await logVipInvoiceEvent(
        connection,
        invoice.id,
        'invoice_payblis_ipn',
        'IPN Payblis reçu pour une invoice annulée (ignoré).',
        { reportedStatus, reportedAmount, receivedTransactionId, raw },
        'gateway',
        'payblis'
      );
      await connection.commit();
      return fetchInvoiceById(pool, invoice.id);
    }

    let nextStatus = invoice.status;
    if (reportedStatus === 'success') {
      nextStatus = reportedAmount > 0 && reportedAmount + 1e-6 >= invoiceAmount
        ? 'paid'
        : 'partial_payment';
    } else if (reportedStatus === 'failed') {
      nextStatus = invoice.status; // stay in place, let user retry
    }

    const rawJson = JSON.stringify(raw).slice(0, 65000);
    const shouldMarkPaidAt = nextStatus === 'paid' && !invoice.paid_at;

    await connection.execute(
      `UPDATE vip_invoices
        SET status = ?,
            paid_at = CASE WHEN ? THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
            payblis_method = COALESCE(?, payblis_method),
            payblis_transaction_id = COALESCE(?, payblis_transaction_id),
            payblis_paid_amount = ?,
            payblis_paid_currency = COALESCE(NULLIF(?, ''), payblis_paid_currency),
            payblis_ipn_received_at = COALESCE(payblis_ipn_received_at, NOW()),
            payblis_ipn_raw_payload = ?,
            next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND),
            updated_at = NOW()
        WHERE id = ?`,
      [
        nextStatus,
        shouldMarkPaidAt ? 1 : 0,
        normalized.method || null,
        receivedTransactionId,
        reportedAmount || null,
        String(normalized.currency || ''),
        rawJson,
        invoice.id
      ]
    );

    await logVipInvoiceEvent(
      connection,
      invoice.id,
      reportedStatus === 'failed' ? 'invoice_payblis_ipn_failed' : 'invoice_payblis_ipn',
      reportedStatus === 'success'
        ? 'IPN Payblis validé, invoice marquée comme payée.'
        : `IPN Payblis reçu (${reportedStatus}).`,
      {
        previousStatus: invoice.status,
        nextStatus,
        reportedStatus,
        reportedAmount,
        invoiceAmount,
        receivedTransactionId,
        method: normalized.method || null
      },
      'gateway',
      'payblis'
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const refreshed = await fetchInvoiceByPublicId(pool, safePublicId);
  if (refreshed?.status === 'paid') {
    return deliverInvoiceIfReady(pool, refreshed.id, 'gateway', 'payblis', 'payblis_ipn');
  }
  return refreshed;
}

// Marks a Payblis invoice as paid from a trusted REST `transaction-status` poll.
// The REST endpoint is authenticated via X-Merchant-Key + HTTPS — no IPN
// signature is involved (Payblis does not sign REST responses), so this path
// MUST NOT funnel through handlePayblisIpn (which would always reject).
async function markPayblisInvoicePaidFromRest(pool, invoiceInput, restPayload) {
  const baseInvoice = invoiceInput?.id ? invoiceInput : await fetchInvoiceById(pool, invoiceInput);
  if (!baseInvoice) return null;
  if (FINAL_STATUSES.has(baseInvoice.status)) return baseInvoice;
  if (!isPayblisPaymentMethod(getInvoicePaymentMethod(baseInvoice))) return baseInvoice;

  const data = restPayload?.data || {};
  const reportedRefOrder = String(data.reference || '').trim();
  const expectedRefOrder = baseInvoice.payblis_ref_order || `mvx_${baseInvoice.public_id}`;
  if (reportedRefOrder && reportedRefOrder !== expectedRefOrder) {
    await logVipInvoiceEvent(
      pool,
      baseInvoice.id,
      'invoice_payblis_rest_poll_mismatch',
      'Poll REST Payblis: RefOrder ne correspond pas.',
      { expected: expectedRefOrder, received: reportedRefOrder },
      'system',
      'payblis-rest-poll'
    );
    return baseInvoice;
  }

  const restStatus = String(data.status || '').trim().toLowerCase();
  const isPaid = restStatus === 'paid' || restStatus === 'success' || restStatus === 'completed';
  if (!isPaid) return baseInvoice;

  const reportedAmount = parseNumber(data.amount);
  const invoiceAmount = parseNumber(baseInvoice.amount_eur);
  const nextStatus = reportedAmount > 0 && reportedAmount + 1e-6 >= invoiceAmount
    ? 'paid'
    : 'partial_payment';

  if (baseInvoice.status === nextStatus) {
    if (nextStatus === 'paid') {
      return deliverInvoiceIfReady(pool, baseInvoice.id, 'system', 'payblis-rest-poll', 'payblis_rest_poll');
    }
    return baseInvoice;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE id = ? FOR UPDATE',
      [baseInvoice.id]
    );
    const invoice = rows[0];
    if (!invoice) {
      await connection.rollback();
      return null;
    }
    if (FINAL_STATUSES.has(invoice.status) || invoice.status === nextStatus) {
      await connection.commit();
      if (invoice.status === 'paid') {
        return deliverInvoiceIfReady(pool, invoice.id, 'system', 'payblis-rest-poll', 'payblis_rest_poll');
      }
      return invoice;
    }

    const rawJson = JSON.stringify(restPayload || {}).slice(0, 65000);
    await connection.execute(
      `UPDATE vip_invoices
        SET status = ?,
            paid_at = COALESCE(paid_at, NOW()),
            payblis_paid_amount = ?,
            payblis_paid_currency = COALESCE(NULLIF(payblis_paid_currency, ''), 'EUR'),
            payblis_ipn_received_at = COALESCE(payblis_ipn_received_at, NOW()),
            payblis_ipn_raw_payload = COALESCE(payblis_ipn_raw_payload, ?),
            next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND),
            updated_at = NOW()
        WHERE id = ?`,
      [nextStatus, reportedAmount || null, rawJson, invoice.id]
    );
    await logVipInvoiceEvent(
      connection,
      invoice.id,
      'invoice_payblis_paid_via_rest_poll',
      'Paiement Payblis confirmé via poll REST (X-Merchant-Key auth, sans IPN).',
      {
        previousStatus: invoice.status,
        nextStatus,
        reportedAmount,
        invoiceAmount,
        reference: reportedRefOrder || expectedRefOrder
      },
      'system',
      'payblis-rest-poll'
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const refreshed = await fetchInvoiceById(pool, baseInvoice.id);
  if (refreshed?.status === 'paid') {
    return deliverInvoiceIfReady(pool, refreshed.id, 'system', 'payblis-rest-poll', 'payblis_rest_poll');
  }
  return refreshed;
}

function createCryptoGateWebhookError(code, statusCode, message = 'Webhook CryptoGate invalide') {
  const error = createVipInvoiceError(message, statusCode);
  error.code = code;
  return error;
}

async function handleCryptoGateWebhook(pool, request = {}, deps = {}) {
  const rawBody = request.rawBody;
  const signature = String(request.signature || '').trim();
  const webhookId = String(request.webhookId || '').trim().slice(0, 128) || null;
  const webhookSecret = String(
    deps.webhookSecret || process.env.VIP_CRYPTOGATE_WEBHOOK_SECRET || ''
  ).trim();

  if (!webhookSecret) {
    throw createCryptoGateWebhookError(
      'CRYPTOGATE_WEBHOOK_SECRET_MISSING',
      503,
      'Webhook CryptoGate non configuré'
    );
  }
  if (!vipCryptoGate.verifyCryptoGateSignature(rawBody, signature, webhookSecret)) {
    throw createCryptoGateWebhookError('CRYPTOGATE_WEBHOOK_SIGNATURE_INVALID', 401);
  }

  let webhook;
  try {
    webhook = vipCryptoGate.parseCryptoGateWebhook(rawBody);
  } catch (error) {
    throw createCryptoGateWebhookError(
      error?.code || 'CRYPTOGATE_WEBHOOK_PAYLOAD_INVALID',
      error?.statusCode || 400
    );
  }

  const connection = await pool.getConnection();
  let invoice;
  let shouldDeliver = false;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE public_id = ? FOR UPDATE',
      [webhook.payment.orderId]
    );
    invoice = rows[0] || null;

    if (!invoice) {
      throw createCryptoGateWebhookError('CRYPTOGATE_INVOICE_NOT_FOUND', 404);
    }
    if (!isCryptoGatePaymentMethod(getInvoicePaymentMethod(invoice))) {
      throw createCryptoGateWebhookError('CRYPTOGATE_INVOICE_METHOD_MISMATCH', 409);
    }
    if (String(invoice.cryptogate_payment_id || '') !== webhook.payment.id) {
      throw createCryptoGateWebhookError('CRYPTOGATE_PAYMENT_ID_MISMATCH', 409);
    }
    if (
      roundFiat(invoice.amount_eur) !== roundFiat(webhook.payment.amount)
      || webhook.payment.currency !== 'EUR'
    ) {
      throw createCryptoGateWebhookError('CRYPTOGATE_WEBHOOK_AMOUNT_MISMATCH', 409);
    }

    const alreadyFinal = FINAL_STATUSES.has(invoice.status);
    // payment.id is already bound to this invoice above. CryptoGate recommends
    // deduplicating with payment.id + event; a retry may carry a new delivery id.
    const isExactDuplicate = String(invoice.cryptogate_last_event || '') === webhook.event;

    if (!alreadyFinal && !isExactDuplicate) {
      if (webhook.event === 'payment.paid') {
        await connection.execute(
          `UPDATE vip_invoices
            SET status = 'paid',
                paid_at = COALESCE(paid_at, NOW()),
                cryptogate_provider = ?,
                cryptogate_paid_amount = ?,
                cryptogate_paid_currency = ?,
                cryptogate_last_webhook_id = ?,
                cryptogate_last_event = ?,
                cryptogate_webhook_received_at = NOW(),
                updated_at = NOW()
            WHERE id = ?`,
          [
            webhook.payment.provider || null,
            roundFiat(webhook.payment.amount),
            webhook.payment.currency,
            webhookId,
            webhook.event,
            invoice.id
          ]
        );
        shouldDeliver = true;
      } else if (webhook.event === 'payment.confirming') {
        if (!['paid', 'delivered', 'cancelled'].includes(invoice.status)) {
          await connection.execute(
            `UPDATE vip_invoices
              SET status = 'confirming',
                  cryptogate_provider = ?,
                  cryptogate_last_webhook_id = ?,
                  cryptogate_last_event = ?,
                  cryptogate_webhook_received_at = NOW(),
                  updated_at = NOW()
              WHERE id = ?`,
            [webhook.payment.provider || null, webhookId, webhook.event, invoice.id]
          );
        }
      } else if (!['paid', 'delivered'].includes(invoice.status)) {
        await connection.execute(
          `UPDATE vip_invoices
            SET status = 'cancelled',
                cryptogate_provider = ?,
                cryptogate_last_webhook_id = ?,
                cryptogate_last_event = ?,
                cryptogate_webhook_received_at = NOW(),
                updated_at = NOW()
            WHERE id = ?`,
          [webhook.payment.provider || null, webhookId, webhook.event, invoice.id]
        );
      }

      await logVipInvoiceEvent(
        connection,
        invoice.id,
        `invoice_cryptogate_${webhook.payment.status}`,
        `Webhook CryptoGate ${webhook.event} traité.`,
        {
          paymentId: webhook.payment.id,
          webhookId,
          event: webhook.event,
          amount: webhook.payment.amount,
          currency: webhook.payment.currency,
          provider: webhook.payment.provider || null
        },
        'system',
        'cryptogate-webhook'
      );
    } else if (invoice.status === 'paid') {
      shouldDeliver = true;
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (shouldDeliver) {
    const deliver = deps.deliverInvoice || deliverInvoiceIfReady;
    return deliver(
      pool,
      invoice.id,
      'system',
      'cryptogate-webhook',
      'cryptogate_paid'
    );
  }

  return FINAL_STATUSES.has(invoice.status) ? invoice : fetchInvoiceById(pool, invoice.id);
}

async function createVipInvoice(pool, payload, context = {}) {
  const pack = resolvePack(payload.packEur);
  const paymentMethod = normalizePaymentMethod(payload.paymentMethod, payload.coin);
  const recipientMode = normalizeRecipientMode(payload.recipientMode);

  if (!pack || !paymentMethod || !recipientMode) {
    throw createVipInvoiceError('Paramètres d\'invoice invalides');
  }

  if (
    (isPaygatePaymentMethod(paymentMethod) || isPayblisPaymentMethod(paymentMethod))
    && !isLegacyPaymentCreationEnabled()
  ) {
    const error = createVipInvoiceError(
      'Ce moyen de paiement a été remplacé par CryptoGate',
      410
    );
    error.code = 'VIP_LEGACY_PAYMENT_RETIRED';
    throw error;
  }

  if (isCryptoGatePaymentMethod(paymentMethod)) {
    return createCryptoGateVipInvoice(
      pool,
      {
        pack,
        recipientMode,
        payerEmail: payload.payerEmail
      },
      context
    );
  }

  if (isPaygatePaymentMethod(paymentMethod)) {
    if (!isPaygatePackAllowed(pack)) {
      throw createVipInvoiceError('PayGate est indisponible sur le pack 5 EUR. Utilise BTC/LTC ou choisis le pack 7 EUR.');
    }

    const paygateEnabled = String(process.env.VIP_PAYGATE_ENABLED || 'true').trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(paygateEnabled)) {
      throw createVipInvoiceError('Paiement PayGate indisponible pour le moment');
    }

    return createPaygateVipInvoice(
      pool,
      {
        pack,
        recipientMode,
        payerEmail: payload.payerEmail
      },
      context
    );
  }

  if (isPayblisPaymentMethod(paymentMethod)) {
    return createPayblisVipInvoice(
      pool,
      {
        pack,
        recipientMode,
        payerEmail: payload.payerEmail,
        auth: context.auth
      },
      context
    );
  }

  return createCryptoVipInvoice(
    pool,
    {
      pack,
      coin: paymentMethod,
      recipientMode
    },
    context
  );
}

async function forceValidateInvoice(pool, invoiceId, admin) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE id = ? FOR UPDATE',
      [invoiceId]
    );

    if (rows.length === 0) {
      throw new Error('Invoice introuvable');
    }

    const invoice = rows[0];
    const paymentMethod = getInvoicePaymentMethod(invoice);
    if (isPaygatePaymentMethod(paymentMethod)) {
      requireValidPaygateInvoiceAmountUsd(invoice);
    }
    if (invoice.status === 'cancelled') {
      throw new Error('Cette invoice est annulée');
    }
    if (invoice.status !== 'delivered') {
      await connection.execute(
        `UPDATE vip_invoices
          SET status = 'paid',
              confirmations = CASE
                WHEN ? IN ('paygate_hosted', 'payblis') THEN confirmations
                ELSE GREATEST(confirmations, COALESCE(required_confirmations, 1))
              END,
              amount_crypto_received = CASE
                WHEN ? IN ('paygate_hosted', 'payblis') THEN amount_crypto_received
                WHEN amount_crypto_received < amount_crypto_expected THEN amount_crypto_expected
                ELSE amount_crypto_received
              END,
              paygate_paid_coin = CASE
                WHEN ? = 'paygate_hosted' THEN COALESCE(paygate_paid_coin, 'manual')
                ELSE paygate_paid_coin
              END,
              paygate_paid_value = CASE
                WHEN ? = 'paygate_hosted' THEN COALESCE(paygate_paid_value, amount_usd)
                ELSE paygate_paid_value
              END,
              payblis_paid_amount = CASE
                WHEN ? = 'payblis' THEN COALESCE(payblis_paid_amount, amount_eur)
                ELSE payblis_paid_amount
              END,
              payblis_paid_currency = CASE
                WHEN ? = 'payblis' THEN COALESCE(payblis_paid_currency, 'EUR')
                ELSE payblis_paid_currency
              END,
              paid_at = COALESCE(paid_at, NOW()),
              updated_at = NOW()
          WHERE id = ?`,
        [paymentMethod, paymentMethod, paymentMethod, paymentMethod, paymentMethod, paymentMethod, invoiceId]
      );

      await logVipInvoiceEvent(
        connection,
        invoiceId,
        'invoice_admin_validated',
        'Invoice marquée comme payée par un administrateur.',
        {
          previousStatus: invoice.status,
          adminId: admin?.userId || null
        },
        'admin',
        admin?.userId || null
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return deliverInvoiceIfReady(pool, invoiceId, 'admin', admin?.userId || null, 'admin_override');
}

async function cancelInvoice(pool, invoiceId, admin) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE id = ? FOR UPDATE',
      [invoiceId]
    );

    if (rows.length === 0) {
      throw new Error('Invoice introuvable');
    }

    const invoice = rows[0];
    if (invoice.status === 'paid' || invoice.status === 'delivered') {
      throw new Error('Impossible d\'annuler une invoice déjà payée ou livrée');
    }

    if (invoice.status !== 'cancelled') {
      const [cancelResult] = await connection.execute(
        `UPDATE vip_invoices
          SET status = 'cancelled',
              updated_at = NOW()
          WHERE id = ?
            AND status IN (
              'awaiting_payment',
              'partial_payment',
              'confirming',
              'expired'
            )`,
        [invoiceId]
      );
      if (parseNumber(cancelResult?.affectedRows, 0) !== 1) {
        throw new Error('Invoice modifiée pendant l\'annulation');
      }

      await logVipInvoiceEvent(
        connection,
        invoiceId,
        'invoice_cancelled',
        'Invoice annulée par un administrateur.',
        {
          previousStatus: invoice.status,
          adminId: admin?.userId || null
        },
        'admin',
        admin?.userId || null
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return fetchInvoiceById(pool, invoiceId);
}

async function unsealGift(pool, giftToken, ipAddress) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE gift_token = ? FOR UPDATE',
      [giftToken]
    );

    if (rows.length === 0) {
      throw new Error('Cadeau introuvable');
    }

    const invoice = rows[0];
    if (invoice.recipient_mode !== 'gift') {
      throw new Error('Ce lien ne correspond pas à un cadeau');
    }
    if (invoice.status !== 'delivered' || !invoice.vip_key_value) {
      throw new Error('La clé cadeau n\'est pas encore disponible');
    }

    if (invoice.gift_sealed) {
      await connection.execute(
        `UPDATE vip_invoices
          SET gift_sealed = 0,
              gift_unsealed_at = COALESCE(gift_unsealed_at, NOW()),
              gift_unseal_count = gift_unseal_count + 1,
              gift_unsealed_by_ip_hash = COALESCE(gift_unsealed_by_ip_hash, ?),
              updated_at = NOW()
          WHERE id = ?`,
        [hashIp(ipAddress), invoice.id]
      );

      await logVipInvoiceEvent(
        connection,
        invoice.id,
        'gift_unsealed',
        'Cadeau descellé.',
        {
          giftToken,
          ipHash: hashIp(ipAddress)
        },
        'gift',
        giftToken
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return fetchInvoiceByGiftToken(pool, giftToken);
}

async function ensureColumnExists(pool, tableName, columnName, definitionSql) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [tableName, columnName]
  );

  if (rows.length === 0) {
    await pool.execute(`ALTER TABLE \`${tableName}\` ADD COLUMN ${definitionSql}`);
  }
}

async function ensureIndexExists(pool, tableName, indexName, definitionSql) {
  const [rows] = await pool.execute(
    `SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1`,
    [tableName, indexName]
  );

  if (rows.length === 0) {
    await pool.execute(`ALTER TABLE \`${tableName}\` ADD ${definitionSql}`);
  }
}

async function ensureUniqueSingleColumnIndex(
  pool,
  tableName,
  indexName,
  columnName,
  definitionSql
) {
  const [rows] = await pool.execute(
    `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [tableName, indexName]
  );

  if (rows.length === 0) {
    await pool.execute(`ALTER TABLE \`${tableName}\` ADD ${definitionSql}`);
    return;
  }

  const valid = rows.length === 1
    && Number(rows[0].NON_UNIQUE) === 0
    && rows[0].COLUMN_NAME === columnName
    && Number(rows[0].SEQ_IN_INDEX) === 1;
  if (!valid) {
    throw new Error(`Index de sécurité invalide: ${tableName}.${indexName}`);
  }
}

async function normalizeVipInvoicePaymentMethods(pool) {
  await pool.execute(`
    ALTER TABLE vip_invoices
    MODIFY COLUMN payment_method VARCHAR(64) NULL
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = NULLIF(LOWER(TRIM(payment_method)), '')
    WHERE payment_method IS NOT NULL
  `);

  // payblis_ref_order is written only by createPayblisVipInvoice, so it is the
  // authoritative marker of a Payblis invoice. Pin payment_method to 'payblis'
  // here — both to recover rows a previous migration run mislabelled, and to
  // stop the autobuy catch-all below (which predates the Payblis method) from
  // rewriting them to 'autobuy' on every restart.
  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = 'payblis'
    WHERE payblis_ref_order IS NOT NULL
      AND (payment_method IS NULL OR payment_method <> 'payblis')
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = LOWER(TRIM(coin))
    WHERE payment_method IS NULL
      AND coin IS NOT NULL
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = 'btc'
    WHERE payment_method IN ('bitcoin', 'btc_onchain', 'btc_mainnet')
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = 'ltc'
    WHERE payment_method IN ('litecoin', 'ltc_onchain', 'ltc_mainnet')
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = 'paygate_hosted'
    WHERE payment_method IN ('paygate', 'paygate_checkout', 'hosted', 'hosted_checkout', 'checkout')
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET autobuy_gateway = COALESCE(
          NULLIF(autobuy_gateway, ''),
          CASE
            WHEN payment_method = 'autobuy_paypal' THEN 'paypal'
            ELSE payment_method
          END
        ),
        payment_method = 'autobuy'
    WHERE payment_method IN ('autobuy_paypal', 'paypal', 'card', 'manual', 'other')
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET autobuy_gateway = CASE
          WHEN coin IN ('btc', 'ltc') THEN autobuy_gateway
          ELSE COALESCE(NULLIF(autobuy_gateway, ''), 'crypto')
        END,
        payment_method = CASE
          WHEN coin IN ('btc', 'ltc') THEN coin
          ELSE 'autobuy'
        END
    WHERE payment_method = 'crypto'
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = 'paygate_hosted'
    WHERE payment_method IS NULL
      AND (
        NULLIF(paygate_tracking_address, '') IS NOT NULL
        OR NULLIF(paygate_temporary_wallet_address, '') IS NOT NULL
        OR NULLIF(paygate_callback_url, '') IS NOT NULL
        OR NULLIF(paygate_callback_nonce, '') IS NOT NULL
        OR NULLIF(paygate_callback_reference, '') IS NOT NULL
        OR NULLIF(paygate_ipn_token, '') IS NOT NULL
        OR NULLIF(paygate_checkout_url, '') IS NOT NULL
        OR NULLIF(paygate_payer_email, '') IS NOT NULL
        OR NULLIF(paygate_paid_coin, '') IS NOT NULL
        OR paygate_paid_value IS NOT NULL
        OR NULLIF(paygate_paid_txid, '') IS NOT NULL
        OR NULLIF(paygate_paid_txid_in, '') IS NOT NULL
      )
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = 'autobuy'
    WHERE payment_method IS NULL
      AND (
        NULLIF(autobuy_order_id, '') IS NOT NULL
        OR NULLIF(autobuy_product_id, '') IS NOT NULL
        OR NULLIF(autobuy_email, '') IS NOT NULL
        OR NULLIF(autobuy_checkout_url, '') IS NOT NULL
        OR NULLIF(autobuy_gateway, '') IS NOT NULL
        OR NULLIF(autobuy_currency, '') IS NOT NULL
        OR autobuy_total IS NOT NULL
        OR autobuy_order_created_at IS NOT NULL
      )
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET autobuy_gateway = COALESCE(NULLIF(autobuy_gateway, ''), payment_method),
        payment_method = 'autobuy'
    WHERE payment_method IS NOT NULL
      AND payment_method NOT IN ('btc', 'ltc', 'cryptogate', 'paygate_hosted', 'autobuy', 'payblis')
  `);

  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = CASE
      WHEN coin IN ('btc', 'ltc') THEN coin
      WHEN (
        NULLIF(paygate_tracking_address, '') IS NOT NULL
        OR NULLIF(paygate_temporary_wallet_address, '') IS NOT NULL
        OR NULLIF(paygate_callback_url, '') IS NOT NULL
        OR NULLIF(paygate_callback_nonce, '') IS NOT NULL
        OR NULLIF(paygate_callback_reference, '') IS NOT NULL
        OR NULLIF(paygate_ipn_token, '') IS NOT NULL
        OR NULLIF(paygate_checkout_url, '') IS NOT NULL
        OR NULLIF(paygate_payer_email, '') IS NOT NULL
        OR NULLIF(paygate_paid_coin, '') IS NOT NULL
        OR paygate_paid_value IS NOT NULL
        OR NULLIF(paygate_paid_txid, '') IS NOT NULL
        OR NULLIF(paygate_paid_txid_in, '') IS NOT NULL
      ) THEN 'paygate_hosted'
      ELSE 'autobuy'
    END
    WHERE payment_method IS NULL
  `);
}

async function ensureVipDonationsTables(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS vip_derivation_counters (
      coin ENUM('btc', 'ltc') PRIMARY KEY,
      next_index INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS vip_invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      public_id VARCHAR(64) NOT NULL UNIQUE,
      payment_method ${VIP_PAYMENT_METHOD_ENUM_SQL} NOT NULL,
      status ENUM('awaiting_payment', 'partial_payment', 'confirming', 'paid', 'delivered', 'expired', 'cancelled') NOT NULL DEFAULT 'awaiting_payment',
      coin ENUM('btc', 'ltc') DEFAULT NULL,
      pack_eur DECIMAL(10,2) NOT NULL,
      amount_eur DECIMAL(10,2) NOT NULL,
      amount_usd DECIMAL(10,2) NOT NULL,
      amount_crypto_expected DECIMAL(20,8) NOT NULL,
      amount_crypto_received DECIMAL(20,8) NOT NULL DEFAULT 0,
      vip_years DECIMAL(5,2) NOT NULL,
      recipient_mode ENUM('self', 'gift') NOT NULL,
      payment_address VARCHAR(128) NOT NULL,
      address_type VARCHAR(32) DEFAULT NULL,
      derivation_index INT NOT NULL,
      confirmations INT NOT NULL DEFAULT 0,
      required_confirmations INT NOT NULL DEFAULT 1,
      tx_hash VARCHAR(128) DEFAULT NULL,
      qr_payload TEXT NOT NULL,
      gift_token VARCHAR(64) DEFAULT NULL UNIQUE,
      gift_sealed TINYINT(1) NOT NULL DEFAULT 1,
      gift_unsealed_at DATETIME DEFAULT NULL,
      gift_unseal_count INT NOT NULL DEFAULT 0,
      gift_unsealed_by_ip_hash VARCHAR(128) DEFAULT NULL,
      vip_key_value VARCHAR(255) DEFAULT NULL,
      created_by_user_id VARCHAR(255) DEFAULT NULL,
      created_by_user_type VARCHAR(32) DEFAULT NULL,
      created_by_session_id VARCHAR(255) DEFAULT NULL,
      created_ip_hash VARCHAR(128) DEFAULT NULL,
      expires_at DATETIME NOT NULL,
      paid_at DATETIME DEFAULT NULL,
      delivered_at DATETIME DEFAULT NULL,
      next_check_at DATETIME DEFAULT NULL,
      paygate_callback_reference VARCHAR(64) DEFAULT NULL,
      paygate_tracking_address VARCHAR(255) DEFAULT NULL,
      paygate_temporary_wallet_address VARCHAR(255) DEFAULT NULL,
      paygate_callback_url TEXT DEFAULT NULL,
      paygate_callback_nonce VARCHAR(128) DEFAULT NULL,
      paygate_checkout_url TEXT DEFAULT NULL,
      paygate_payer_email VARCHAR(255) DEFAULT NULL,
      paygate_ipn_token VARCHAR(512) DEFAULT NULL,
      paygate_paid_coin VARCHAR(64) DEFAULT NULL,
      paygate_paid_value DECIMAL(18,8) DEFAULT NULL,
      paygate_paid_txid_in VARCHAR(255) DEFAULT NULL,
      paygate_paid_txid VARCHAR(255) DEFAULT NULL,
      cryptogate_payment_id VARCHAR(128) DEFAULT NULL,
      cryptogate_checkout_url TEXT DEFAULT NULL,
      cryptogate_payer_email VARCHAR(255) DEFAULT NULL,
      cryptogate_provider VARCHAR(64) DEFAULT NULL,
      cryptogate_paid_amount DECIMAL(18,2) DEFAULT NULL,
      cryptogate_paid_currency VARCHAR(16) DEFAULT NULL,
      cryptogate_last_webhook_id VARCHAR(128) DEFAULT NULL,
      cryptogate_last_event VARCHAR(64) DEFAULT NULL,
      cryptogate_webhook_received_at DATETIME DEFAULT NULL,
      autobuy_order_id VARCHAR(128) DEFAULT NULL,
      autobuy_product_id VARCHAR(128) DEFAULT NULL,
      autobuy_email VARCHAR(255) DEFAULT NULL,
      autobuy_checkout_url TEXT DEFAULT NULL,
      autobuy_gateway VARCHAR(64) DEFAULT NULL,
      autobuy_currency VARCHAR(16) DEFAULT NULL,
      autobuy_total DECIMAL(18,8) DEFAULT NULL,
      autobuy_order_created_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_vip_invoices_payment_method (payment_method),
      INDEX idx_vip_invoices_status (status),
      INDEX idx_vip_invoices_coin (coin),
      INDEX idx_vip_invoices_created_at (created_at),
      INDEX idx_vip_invoices_payment_address (payment_address),
      INDEX idx_vip_invoices_vip_key (vip_key_value),
      INDEX idx_vip_invoices_paygate_paid_txid (paygate_paid_txid),
      UNIQUE KEY uniq_vip_invoices_paygate_callback_reference
        (paygate_callback_reference),
      UNIQUE KEY uniq_vip_invoices_paygate_paid_txid_in
        (paygate_paid_txid_in),
      UNIQUE KEY uniq_vip_invoices_cryptogate_payment_id
        (cryptogate_payment_id),
      UNIQUE KEY uniq_vip_invoices_autobuy_order_id (autobuy_order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS vip_invoice_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      actor_type VARCHAR(32) DEFAULT NULL,
      actor_id VARCHAR(255) DEFAULT NULL,
      message VARCHAR(255) DEFAULT NULL,
      payload_json LONGTEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_vip_invoice_events_invoice (invoice_id),
      INDEX idx_vip_invoice_events_type (event_type),
      CONSTRAINT fk_vip_invoice_events_invoice
        FOREIGN KEY (invoice_id) REFERENCES vip_invoices(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(
    `INSERT IGNORE INTO vip_derivation_counters (coin, next_index, created_at, updated_at)
      VALUES ('btc', 0, NOW(), NOW()), ('ltc', 0, NOW(), NOW())`
  );

  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payment_method',
    `\`payment_method\` ${VIP_PAYMENT_METHOD_ENUM_SQL} NULL AFTER \`public_id\``
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_callback_reference',
    "`paygate_callback_reference` VARCHAR(64) DEFAULT NULL AFTER `next_check_at`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_tracking_address',
    "`paygate_tracking_address` VARCHAR(255) DEFAULT NULL AFTER `next_check_at`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_temporary_wallet_address',
    "`paygate_temporary_wallet_address` VARCHAR(255) DEFAULT NULL AFTER `paygate_tracking_address`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_callback_url',
    "`paygate_callback_url` TEXT DEFAULT NULL AFTER `paygate_temporary_wallet_address`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_callback_nonce',
    "`paygate_callback_nonce` VARCHAR(128) DEFAULT NULL AFTER `paygate_callback_url`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_checkout_url',
    "`paygate_checkout_url` TEXT DEFAULT NULL AFTER `paygate_callback_nonce`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_payer_email',
    "`paygate_payer_email` VARCHAR(255) DEFAULT NULL AFTER `paygate_checkout_url`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_ipn_token',
    "`paygate_ipn_token` VARCHAR(512) DEFAULT NULL AFTER `paygate_payer_email`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_paid_coin',
    "`paygate_paid_coin` VARCHAR(64) DEFAULT NULL AFTER `paygate_payer_email`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_paid_value',
    "`paygate_paid_value` DECIMAL(18,8) DEFAULT NULL AFTER `paygate_paid_coin`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_paid_txid_in',
    "`paygate_paid_txid_in` VARCHAR(255) DEFAULT NULL AFTER `paygate_paid_value`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_paid_txid',
    "`paygate_paid_txid` VARCHAR(255) DEFAULT NULL AFTER `paygate_paid_value`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'autobuy_order_id',
    "`autobuy_order_id` VARCHAR(128) DEFAULT NULL AFTER `paygate_paid_txid`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'autobuy_product_id',
    "`autobuy_product_id` VARCHAR(128) DEFAULT NULL AFTER `autobuy_order_id`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'autobuy_email',
    "`autobuy_email` VARCHAR(255) DEFAULT NULL AFTER `autobuy_product_id`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'autobuy_checkout_url',
    "`autobuy_checkout_url` TEXT DEFAULT NULL AFTER `autobuy_email`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'autobuy_gateway',
    "`autobuy_gateway` VARCHAR(64) DEFAULT NULL AFTER `autobuy_checkout_url`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'autobuy_currency',
    "`autobuy_currency` VARCHAR(16) DEFAULT NULL AFTER `autobuy_gateway`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'autobuy_total',
    "`autobuy_total` DECIMAL(18,8) DEFAULT NULL AFTER `autobuy_currency`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'autobuy_order_created_at',
    "`autobuy_order_created_at` DATETIME DEFAULT NULL AFTER `autobuy_total`"
  );

  await ensureColumnExists(
    pool,
    'vip_invoices',
    'cryptogate_payment_id',
    "`cryptogate_payment_id` VARCHAR(128) DEFAULT NULL"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'cryptogate_checkout_url',
    "`cryptogate_checkout_url` TEXT DEFAULT NULL AFTER `cryptogate_payment_id`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'cryptogate_payer_email',
    "`cryptogate_payer_email` VARCHAR(255) DEFAULT NULL AFTER `cryptogate_checkout_url`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'cryptogate_provider',
    "`cryptogate_provider` VARCHAR(64) DEFAULT NULL AFTER `cryptogate_payer_email`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'cryptogate_paid_amount',
    "`cryptogate_paid_amount` DECIMAL(18,2) DEFAULT NULL AFTER `cryptogate_provider`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'cryptogate_paid_currency',
    "`cryptogate_paid_currency` VARCHAR(16) DEFAULT NULL AFTER `cryptogate_paid_amount`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'cryptogate_last_webhook_id',
    "`cryptogate_last_webhook_id` VARCHAR(128) DEFAULT NULL AFTER `cryptogate_paid_currency`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'cryptogate_last_event',
    "`cryptogate_last_event` VARCHAR(64) DEFAULT NULL AFTER `cryptogate_last_webhook_id`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'cryptogate_webhook_received_at',
    "`cryptogate_webhook_received_at` DATETIME DEFAULT NULL AFTER `cryptogate_last_event`"
  );

  // Payblis columns (added 2026-04-21).
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payblis_ref_order',
    "`payblis_ref_order` VARCHAR(128) DEFAULT NULL"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payblis_checkout_url',
    "`payblis_checkout_url` TEXT DEFAULT NULL AFTER `payblis_ref_order`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payblis_payer_email',
    "`payblis_payer_email` VARCHAR(255) DEFAULT NULL AFTER `payblis_checkout_url`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payblis_customer_name',
    "`payblis_customer_name` VARCHAR(255) DEFAULT NULL AFTER `payblis_payer_email`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payblis_method',
    "`payblis_method` VARCHAR(64) DEFAULT NULL AFTER `payblis_customer_name`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payblis_transaction_id',
    "`payblis_transaction_id` VARCHAR(255) DEFAULT NULL AFTER `payblis_method`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payblis_paid_amount',
    "`payblis_paid_amount` DECIMAL(18,2) DEFAULT NULL AFTER `payblis_transaction_id`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payblis_paid_currency',
    "`payblis_paid_currency` VARCHAR(16) DEFAULT NULL AFTER `payblis_paid_amount`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payblis_ipn_received_at',
    "`payblis_ipn_received_at` DATETIME DEFAULT NULL AFTER `payblis_paid_currency`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payblis_ipn_raw_payload',
    "`payblis_ipn_raw_payload` LONGTEXT DEFAULT NULL AFTER `payblis_ipn_received_at`"
  );

  // Unique index on RefOrder (dedup retries at the DB level).
  try {
    await pool.execute(
      "ALTER TABLE vip_invoices ADD UNIQUE KEY uniq_vip_invoices_payblis_ref_order (payblis_ref_order)"
    );
  } catch (error) {
    if (!/duplicate|exists|1061/i.test(String(error?.message || ''))) {
      throw error;
    }
  }

  // Non-unique index for IPN lookups by transaction_id.
  try {
    await pool.execute(
      "ALTER TABLE vip_invoices ADD INDEX idx_vip_invoices_payblis_tx (payblis_transaction_id)"
    );
  } catch (error) {
    if (!/duplicate|exists|1061/i.test(String(error?.message || ''))) {
      throw error;
    }
  }

  // Loosen NOT NULL on crypto-only columns so non-crypto methods (payblis, future)
  // can insert NULL for fields that make no sense for them.
  await pool.execute(
    "ALTER TABLE vip_invoices MODIFY payment_address VARCHAR(128) NULL DEFAULT NULL"
  );
  await pool.execute(
    "ALTER TABLE vip_invoices MODIFY amount_crypto_expected DECIMAL(20,8) NULL DEFAULT NULL"
  );
  await pool.execute(
    "ALTER TABLE vip_invoices MODIFY derivation_index INT NULL DEFAULT NULL"
  );
  await pool.execute(
    "ALTER TABLE vip_invoices MODIFY qr_payload TEXT NULL DEFAULT NULL"
  );

  // Extend the payment_method ENUM to include 'payblis'. Idempotent because
  // MySQL MODIFY COLUMN on an ENUM that already lists the value is a no-op.
  await pool.execute(
    `ALTER TABLE vip_invoices MODIFY payment_method ${VIP_PAYMENT_METHOD_ENUM_SQL} NOT NULL`
  );

  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = coin
    WHERE payment_method IS NULL AND coin IS NOT NULL
  `);

  await pool.execute(`
    ALTER TABLE vip_invoices
    MODIFY COLUMN vip_years DECIMAL(5,2) NOT NULL
  `);
  await normalizeVipInvoicePaymentMethods(pool);
  await pool.execute(`
    ALTER TABLE vip_invoices
    MODIFY COLUMN payment_method ${VIP_PAYMENT_METHOD_ENUM_SQL} NOT NULL
  `);
  await pool.execute(`
    ALTER TABLE vip_invoices
    MODIFY COLUMN coin ENUM('btc', 'ltc') NULL
  `);

  await ensureIndexExists(
    pool,
    'vip_invoices',
    'idx_vip_invoices_payment_method',
    'INDEX `idx_vip_invoices_payment_method` (`payment_method`)'
  );
  await pool.execute(
    `UPDATE vip_invoices
      SET paygate_callback_reference = NULL
      WHERE paygate_callback_reference IS NOT NULL
        AND TRIM(paygate_callback_reference) = ''`
  );
  await pool.execute(
    `UPDATE vip_invoices
      SET paygate_paid_txid_in = NULL
      WHERE paygate_paid_txid_in IS NOT NULL
        AND TRIM(paygate_paid_txid_in) = ''`
  );
  await ensureUniqueSingleColumnIndex(
    pool,
    'vip_invoices',
    'uniq_vip_invoices_paygate_callback_reference',
    'paygate_callback_reference',
    'UNIQUE INDEX `uniq_vip_invoices_paygate_callback_reference` (`paygate_callback_reference`)'
  );
  await ensureUniqueSingleColumnIndex(
    pool,
    'vip_invoices',
    'uniq_vip_invoices_paygate_paid_txid_in',
    'paygate_paid_txid_in',
    'UNIQUE INDEX `uniq_vip_invoices_paygate_paid_txid_in` (`paygate_paid_txid_in`)'
  );
  await ensureIndexExists(
    pool,
    'vip_invoices',
    'idx_vip_invoices_paygate_paid_txid',
    'INDEX `idx_vip_invoices_paygate_paid_txid` (`paygate_paid_txid`)'
  );
  await ensureIndexExists(
    pool,
    'vip_invoices',
    'uniq_vip_invoices_autobuy_order_id',
    'UNIQUE INDEX `uniq_vip_invoices_autobuy_order_id` (`autobuy_order_id`)'
  );
  await ensureUniqueSingleColumnIndex(
    pool,
    'vip_invoices',
    'uniq_vip_invoices_cryptogate_payment_id',
    'cryptogate_payment_id',
    'UNIQUE INDEX `uniq_vip_invoices_cryptogate_payment_id` (`cryptogate_payment_id`)'
  );
}

module.exports = {
  VIP_PACKS,
  STATUS_REASONS,
  DEFAULT_EXPIRATION_MINUTES,
  createVipInvoice,
  handleCryptoGateWebhook,
  handlePaygateCallback,
  handlePayblisIpn,
  markPayblisInvoicePaidFromRest,
  fetchInvoiceByPublicId,
  fetchInvoiceById,
  fetchInvoiceByGiftToken,
  refreshInvoiceStatus,
  forceValidateInvoice,
  cancelInvoice,
  getVipInvoiceDetails,
  listUserVipInvoices,
  listVipInvoices,
  serializePublicInvoice,
  serializeAdminInvoice,
  serializeGift,
  unsealGift,
  ensureVipDonationsTables,
  getClientIp,
  getSupportTelegramUrl,
  parseNumber,
  roundCrypto,
  roundFiat,
  resolvePack,
  normalizePaymentMethod,
  normalizeCoin,
  normalizeRecipientMode,
  buildPricingSnapshot,
  reserveDerivationIndex,
  derivePaymentAddress,
  buildQrPayload,
  logVipInvoiceEvent,
  deliverInvoiceIfReady,
  determineInvoiceStatus,
  fetchAddressActivity,
  getRequiredConfirmations,
  hashIp,
  safeJsonParse,
  buildDurationLabel,
  toSqlDateTime,
  fromSqlDateTime,
  buildFrontendUrl,
  getInvoicePath,
  getGiftPath
};

