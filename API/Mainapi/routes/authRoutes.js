/**
 * Authentication routes.
 * Extracted from server.js -- BIP39, Discord, and Google authentication.
 * Mount point: app.use('/api/auth', router)
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const bip39 = require('bip39');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const { issueJwt, verifyJwt, getAuthIfValid, setAuthCookie, extractJwtFromRequest } = require('../middleware/auth');
const { getPool } = require('../mysqlPool');
const { createRedisRateLimitStore } = require('../utils/redisRateLimitStore');
const { verifyTurnstileFromRequest } = require('../utils/turnstile');
const {
  SUPPORTED_PROVIDERS,
  isSupportedProvider,
  getLinkedTarget,
  getLinksForTarget,
  setLink,
  removeLinksForTargetProvider,
} = require('../utils/accountLinks');

// Rate limiter pour les endpoints d'authentification
// 10 tentatives par IP toutes les 15 minutes
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 requêtes max par fenêtre
  store: createRedisRateLimitStore({ prefix: 'rate-limit:auth:login:' }),
  passOnStoreError: true,
  standardHeaders: true,     // Retourne les headers RateLimit-* standard
  legacyHeaders: false,      // Désactive X-RateLimit-*
  message: {
    success: false,
    error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.'
  },
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || ipKeyGenerator(req.ip),
  validate: { xForwardedForHeader: false, ip: false }
});

// Récupération de la liste de mots française
const frenchWordlist = bip39.wordlists.french;
const DEFAULT_AVATAR = 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';

// Lazy imports from sync module
let _syncModule = null;
function getSyncModule() {
  if (!_syncModule) _syncModule = require('./sync');
  return _syncModule;
}

// === Session helpers ===
const generateDeviceFingerprint = (userAgent, ip) => {
  const fingerprint = crypto.createHash('sha256')
    .update(`${userAgent}-${ip || 'unknown'}-${Date.now()}`)
    .digest('hex')
    .substring(0, 32);
  return fingerprint;
};

const encryptDeviceInfo = (deviceInfo) => {
  const algorithm = 'aes-256-cbc';
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(process.env.JWT_SECRET, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(deviceInfo, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return `${salt.toString('base64')}.${iv.toString('base64')}.${encrypted}`;
};

const createUserSession = async (userType, userId, req) => {
  try {
    const pool = getPool();
    if (!pool) { console.error('MySQL pool not ready for session creation'); return null; }

    const userAgent = req.headers['user-agent'] || 'Unknown';
    const ip = req.ip || req.connection.remoteAddress || 'Unknown';
    const sessionId = uuidv4();
    const deviceInfo = generateDeviceFingerprint(userAgent, ip);
    const encryptedDevice = encryptDeviceInfo(deviceInfo);

    await pool.execute(
      'INSERT INTO user_sessions (id, user_id, user_type, device, user_agent) VALUES (?, ?, ?, ?, ?)',
      [sessionId, userId, userType, encryptedDevice, userAgent]
    );

    console.log(`[SESSION] Created new session ${sessionId} for ${userType}:${userId}`);
    return sessionId;
  } catch (error) {
    console.error('Error creating user session:', error);
    return null;
  }
};

// === Helpers ===

function normalizeMnemonic(mnemonic) {
  return mnemonic.normalize('NFKD').toLowerCase().trim().replace(/\s+/g, ' ');
}

function validateBip39Mnemonic(mnemonic) {
  return bip39.validateMnemonic(mnemonic, frenchWordlist) || bip39.validateMnemonic(mnemonic);
}

function createBip39UserId(normalizedMnemonic) {
  return crypto.createHash('sha256').update(normalizedMnemonic).digest('hex').substring(0, 16);
}

function buildBip39Profile(userId, username, avatar, existingProfile = null) {
  return {
    id: userId,
    username: (username || existingProfile?.username || `Utilisateur-${userId.substring(0, 8)}`).trim(),
    avatar: avatar || existingProfile?.avatar || DEFAULT_AVATAR,
    provider: 'bip39',
    createdAt: existingProfile?.createdAt || new Date().toISOString(),
  };
}

function buildDiscordProfile(user) {
  return {
    id: String(user.id),
    username: user.username || `Discord-${user.id}`,
    avatar: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : DEFAULT_AVATAR,
    provider: 'discord',
    createdAt: new Date().toISOString(),
  };
}

function buildGoogleProfile(user) {
  return {
    id: String(user.sub),
    username: user.name || user.email || `Google-${user.sub}`,
    avatar: user.picture || DEFAULT_AVATAR,
    provider: 'google',
    createdAt: new Date().toISOString(),
  };
}

function parseStoredAuth(userData) {
  if (!userData?.auth || typeof userData.auth !== 'string') return null;
  try {
    const authData = JSON.parse(userData.auth);
    if (authData && authData.userProfile) return authData;
  } catch (error) {
    console.error('Error parsing stored auth data:', error.message);
  }
  return null;
}

async function ensureStoredAuthData(userType, userId, authData, extraFields = {}) {
  const { readUserData, writeUserData } = getSyncModule();
  const userData = await readUserData(userType, userId) || {};
  let shouldWrite = false;

  if (!parseStoredAuth(userData)) {
    userData.auth = JSON.stringify(authData);
    shouldWrite = true;
  }

  for (const [key, value] of Object.entries(extraFields)) {
    if (userData[key] !== value) {
      userData[key] = value;
      shouldWrite = true;
    }
  }

  if (shouldWrite) {
    userData.lastUpdated = Date.now();
    await writeUserData(userType, userId, userData);
  }

  return userData;
}

async function getResolvedAuthData(userType, userId, fallbackProfile, fallbackProvider) {
  const { readUserData } = getSyncModule();
  const userData = await readUserData(userType, userId) || {};
  const storedAuth = parseStoredAuth(userData);

  if (storedAuth?.userProfile) {
    return {
      userData,
      authData: {
        ...storedAuth,
        provider: storedAuth.provider || storedAuth.userProfile.provider || fallbackProvider,
      }
    };
  }

  return {
    userData,
    authData: {
      userProfile: fallbackProfile,
      provider: fallbackProvider,
    }
  };
}

function getProviderLabel(provider) {
  if (provider === 'discord') return 'Discord';
  if (provider === 'google') return 'Google';
  if (provider === 'bip39') return 'BIP39';
  return 'ce moyen de connexion';
}

async function getAccountPrimaryProvider(userType, userId) {
  const fallbackProvider = userType === 'bip39' ? 'bip39' : 'oauth';
  const { userData, authData } = await getResolvedAuthData(
    userType,
    userId,
    { id: String(userId), provider: fallbackProvider },
    fallbackProvider
  );

  const providerCandidates = [
    authData?.userProfile?.provider,
    authData?.provider,
    userData?.oauth_provider,
  ];

  for (const candidate of providerCandidates) {
    if (isSupportedProvider(candidate)) {
      return candidate;
    }
  }

  return userType === 'bip39' ? 'bip39' : null;
}

async function ensureLinkManagementAccess(auth) {
  const accountProvider = await getAccountPrimaryProvider(auth.userType, auth.userId);
  if (!accountProvider) {
    return {
      allowed: false,
      status: 403,
      error: 'Impossible de déterminer le provider principal de ce compte. Reconnectez-vous avec le compte d’origine.',
    };
  }

  if (auth.authMethod !== accountProvider) {
    return {
      allowed: false,
      status: 403,
      error: `Reconnectez-vous avec ${getProviderLabel(accountProvider)} pour gérer les liaisons de ce compte.`,
    };
  }

  return { allowed: true, accountProvider };
}

async function getOrCreateBip39Account({ mnemonic, username = null, avatar = null, overwriteProfile = false }) {
  const normalizedMnemonic = normalizeMnemonic(mnemonic);
  if (!validateBip39Mnemonic(normalizedMnemonic)) {
    return { success: false, error: 'Phrase secrète invalide' };
  }

  const userId = createBip39UserId(normalizedMnemonic);
  const { readUserData, writeUserData } = getSyncModule();
  const userData = await readUserData('bip39', userId) || {};
  const storedAuth = parseStoredAuth(userData);
  const existingProfile = storedAuth?.userProfile || null;

  const shouldWriteProfile = overwriteProfile || !existingProfile;
  const userProfile = buildBip39Profile(userId, username, avatar, existingProfile);

  if (shouldWriteProfile) {
    userData.auth = JSON.stringify({ userProfile, provider: 'bip39' });
    userData.bip39_auth = 'true';
    userData.lastUpdated = Date.now();
    await writeUserData('bip39', userId, userData);
  }

  return { success: true, normalizedMnemonic, userId, userProfile };
}

async function verifyDiscordAccessToken(accessToken) {
  const resp = await axios.get('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10000,
  });

  const user = resp.data;
  if (!user || !user.id) {
    throw new Error('Token Discord invalide');
  }

  return user;
}

async function verifyGoogleAccessToken(accessToken) {
  const resp = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 10000,
  });

  const user = resp.data;
  if (!user || !user.sub) {
    throw new Error('Token Google invalide');
  }

  return user;
}

async function finalizeResolvedSession(req, {
  provider,
  providerUserId,
  fallbackUserType,
  sourceAuthData,
  externalUser,
}) {
  const sourceExtraFields = provider === 'bip39'
    ? { bip39_auth: 'true' }
    : { oauth_provider: provider };

  await ensureStoredAuthData(fallbackUserType, providerUserId, sourceAuthData, sourceExtraFields);

  const linkedTarget = await getLinkedTarget(provider, providerUserId);
  const resolvedUserType = linkedTarget?.targetUserType || fallbackUserType;
  const resolvedUserId = linkedTarget?.targetUserId || String(providerUserId);

  const sessionId = await createUserSession(resolvedUserType, resolvedUserId, req);
  const token = issueJwt(resolvedUserType, resolvedUserId, sessionId, provider);

  const fallbackResolvedProvider = resolvedUserType === 'bip39'
    ? 'bip39'
    : sourceAuthData?.provider || provider;

  const fallbackResolvedProfile = {
    ...(sourceAuthData?.userProfile || {}),
    id: resolvedUserId,
    provider: fallbackResolvedProvider,
  };

  const { authData } = await getResolvedAuthData(
    resolvedUserType,
    resolvedUserId,
    fallbackResolvedProfile,
    fallbackResolvedProvider
  );

  return {
    success: true,
    sessionId,
    token,
    user: externalUser,
    account: {
      userType: resolvedUserType,
      userId: resolvedUserId,
      linked: Boolean(linkedTarget),
      linkProvider: linkedTarget?.provider || null,
    },
    authData,
  };
}

async function resolveProviderIdentity(provider, body) {
  switch (provider) {
    case 'discord': {
      const accessToken = body?.access_token;
      if (!accessToken) {
        return { success: false, status: 400, error: 'access_token requis' };
      }
      const user = await verifyDiscordAccessToken(accessToken);
      return {
        success: true,
        provider,
        providerUserId: String(user.id),
        authData: { userProfile: buildDiscordProfile(user), provider: 'discord' },
        externalUser: user,
      };
    }
    case 'google': {
      const accessToken = body?.access_token;
      if (!accessToken) {
        return { success: false, status: 400, error: 'access_token requis' };
      }
      const user = await verifyGoogleAccessToken(accessToken);
      return {
        success: true,
        provider,
        providerUserId: String(user.sub),
        authData: { userProfile: buildGoogleProfile(user), provider: 'google' },
        externalUser: user,
      };
    }
    case 'bip39': {
      const mnemonic = body?.mnemonic;
      if (!mnemonic) {
        return { success: false, status: 400, error: 'Phrase secrète requise' };
      }
      const account = await getOrCreateBip39Account({ mnemonic });
      if (!account.success) {
        return { success: false, status: 400, error: account.error };
      }
      return {
        success: true,
        provider,
        providerUserId: account.userId,
        authData: { userProfile: account.userProfile, provider: 'bip39' },
        externalUser: {
          id: account.userId,
          username: account.userProfile.username,
          avatar: account.userProfile.avatar,
        },
      };
    }
    default:
      return { success: false, status: 400, error: 'Provider non supporté' };
  }
}

function getProviderStatusMap(records) {
  return SUPPORTED_PROVIDERS.reduce((acc, provider) => {
    const record = records.find((item) => item.provider === provider) || null;
    acc[provider] = record ? {
      linked: true,
      providerUserId: record.providerUserId,
      linkedAt: record.linkedAt,
      updatedAt: record.updatedAt,
    } : {
      linked: false,
      providerUserId: null,
      linkedAt: null,
      updatedAt: null,
    };
    return acc;
  }, {});
}

// === Routes ===

// GET /bip39/generate
router.get('/bip39/generate', (req, res) => {
  try {
    const mnemonic = bip39.generateMnemonic(128, undefined, frenchWordlist);
    res.status(200).json({ success: true, mnemonic });
  } catch (error) {
    console.error('Error generating mnemonic:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la génération de la phrase secrète' });
  }
});

// POST /bip39/create
router.post('/bip39/create', authRateLimit, async (req, res) => {
  try {
    const { mnemonic, username, avatar, turnstileToken } = req.body;
    if (!mnemonic || !username) {
      return res.status(400).json({ success: false, error: 'Phrase secrète et nom d\'utilisateur requis' });
    }

    const turnstileResult = await verifyTurnstileFromRequest(req, turnstileToken);
    if (!turnstileResult.valid) {
      return res.status(turnstileResult.status).json({ success: false, error: turnstileResult.error });
    }

    const account = await getOrCreateBip39Account({
      mnemonic,
      username,
      avatar,
      overwriteProfile: true,
    });

    if (!account.success) {
      return res.status(400).json({ success: false, error: account.error });
    }

    const payload = await finalizeResolvedSession(req, {
      provider: 'bip39',
      providerUserId: account.userId,
      fallbackUserType: 'bip39',
      sourceAuthData: { userProfile: account.userProfile, provider: 'bip39' },
      externalUser: {
        id: account.userId,
        username: account.userProfile.username,
        avatar: account.userProfile.avatar,
      },
    });

    setAuthCookie(res, payload.token);
    return res.status(200).json({
      ...payload,
      userId: payload.account.userId,
      userProfile: payload.authData.userProfile,
      message: 'Compte créé avec succès',
    });
  } catch (error) {
    console.error('Error creating BIP39 account:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la création du compte' });
  }
});

// POST /bip39/login
router.post('/bip39/login', authRateLimit, async (req, res) => {
  try {
    const { mnemonic, turnstileToken } = req.body;
    if (!mnemonic) {
      return res.status(400).json({ success: false, error: 'Phrase secrète requise' });
    }

    const turnstileResult = await verifyTurnstileFromRequest(req, turnstileToken);
    if (!turnstileResult.valid) {
      return res.status(turnstileResult.status).json({ success: false, error: turnstileResult.error });
    }

    const account = await getOrCreateBip39Account({ mnemonic });
    if (!account.success) {
      return res.status(400).json({ success: false, error: account.error });
    }

    const payload = await finalizeResolvedSession(req, {
      provider: 'bip39',
      providerUserId: account.userId,
      fallbackUserType: 'bip39',
      sourceAuthData: { userProfile: account.userProfile, provider: 'bip39' },
      externalUser: {
        id: account.userId,
        username: account.userProfile.username,
        avatar: account.userProfile.avatar,
      },
    });

    setAuthCookie(res, payload.token);
    return res.status(200).json({
      ...payload,
      userId: payload.account.userId,
      userProfile: payload.authData.userProfile,
      message: 'Connexion réussie',
    });
  } catch (error) {
    console.error('Error logging in with BIP39:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la connexion' });
  }
});

// POST /discord/verify
router.post('/discord/verify', authRateLimit, async (req, res) => {
  try {
    const { access_token: accessToken } = req.body || {};
    if (!accessToken) {
      return res.status(400).json({ success: false, error: 'access_token requis' });
    }

    const user = await verifyDiscordAccessToken(accessToken);
    const payload = await finalizeResolvedSession(req, {
      provider: 'discord',
      providerUserId: String(user.id),
      fallbackUserType: 'oauth',
      sourceAuthData: { userProfile: buildDiscordProfile(user), provider: 'discord' },
      externalUser: user,
    });

    setAuthCookie(res, payload.token);
    return res.status(200).json(payload);
  } catch (error) {
    console.error('Discord verify error:', error.response?.status || error.message);
    return res.status(401).json({ success: false, error: 'Échec de la vérification Discord' });
  }
});

// POST /google/verify
router.post('/google/verify', authRateLimit, async (req, res) => {
  try {
    const { access_token: accessToken } = req.body || {};
    if (!accessToken) {
      return res.status(400).json({ success: false, error: 'access_token requis' });
    }

    const user = await verifyGoogleAccessToken(accessToken);
    const payload = await finalizeResolvedSession(req, {
      provider: 'google',
      providerUserId: String(user.sub),
      fallbackUserType: 'oauth',
      sourceAuthData: { userProfile: buildGoogleProfile(user), provider: 'google' },
      externalUser: user,
    });

    setAuthCookie(res, payload.token);
    return res.status(200).json(payload);
  } catch (error) {
    console.error('Google verify error:', error.response?.status || error.message);
    return res.status(401).json({ success: false, error: 'Échec de la vérification Google' });
  }
});

// GET /links
router.get('/links', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth || !['oauth', 'bip39'].includes(auth.userType)) {
      return res.status(401).json({ success: false, error: 'Non autorisé' });
    }

    const records = await getLinksForTarget(auth.userType, auth.userId);
    const fallbackProvider = auth.userType === 'bip39' ? 'bip39' : 'oauth';
    const { authData } = await getResolvedAuthData(
      auth.userType,
      auth.userId,
      { id: String(auth.userId), provider: fallbackProvider },
      fallbackProvider
    );
    const resolvedProviderCandidate = authData?.userProfile?.provider || authData?.provider;
    const accountProvider = await getAccountPrimaryProvider(auth.userType, auth.userId)
      || (isSupportedProvider(resolvedProviderCandidate) ? resolvedProviderCandidate : null)
      || (auth.userType === 'bip39' ? 'bip39' : null);

    return res.status(200).json({
      success: true,
      account: {
        userType: auth.userType,
        userId: auth.userId,
        provider: accountProvider,
        authMethod: isSupportedProvider(auth.authMethod) ? auth.authMethod : null,
        canManageLinks: Boolean(accountProvider && auth.authMethod && auth.authMethod === accountProvider),
        manageWithProvider: accountProvider,
      },
      links: getProviderStatusMap(records),
    });
  } catch (error) {
    console.error('Error getting account links:', error);
    return res.status(500).json({ success: false, error: 'Erreur lors de la récupération des liaisons' });
  }
});

// POST /links/:provider
router.post('/links/:provider', authRateLimit, async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth || !['oauth', 'bip39'].includes(auth.userType)) {
      return res.status(401).json({ success: false, error: 'Non autorisé' });
    }

    const accessCheck = await ensureLinkManagementAccess(auth);
    if (!accessCheck.allowed) {
      return res.status(accessCheck.status || 403).json({ success: false, error: accessCheck.error });
    }

    const provider = String(req.params.provider || '').toLowerCase();
    if (!isSupportedProvider(provider)) {
      return res.status(400).json({ success: false, error: 'Provider non supporté' });
    }

    const resolved = await resolveProviderIdentity(provider, req.body);
    if (!resolved.success) {
      return res.status(resolved.status || 400).json({ success: false, error: resolved.error });
    }

    const isSelfLink =
      ((provider === 'google' || provider === 'discord') && auth.userType === 'oauth' && String(auth.userId) === String(resolved.providerUserId)) ||
      (provider === 'bip39' && auth.userType === 'bip39' && String(auth.userId) === String(resolved.providerUserId));

    if (isSelfLink) {
      return res.status(400).json({
        success: false,
        error: 'Ce moyen de connexion correspond déjà à ce compte.',
      });
    }

    const extraFields = provider === 'bip39'
      ? { bip39_auth: 'true' }
      : { oauth_provider: provider };

    await ensureStoredAuthData(
      provider === 'bip39' ? 'bip39' : 'oauth',
      resolved.providerUserId,
      resolved.authData,
      extraFields
    );

    const link = await setLink({
      provider,
      providerUserId: resolved.providerUserId,
      targetUserType: auth.userType,
      targetUserId: auth.userId,
    });

    return res.status(200).json({
      success: true,
      link: {
        provider: link.provider,
        providerUserId: link.providerUserId,
        linkedAt: link.linkedAt,
        updatedAt: link.updatedAt,
        targetUserType: link.targetUserType,
        targetUserId: link.targetUserId,
      },
      message: 'Compte lié avec succès',
    });
  } catch (error) {
    console.error('Error linking account:', error);
    return res.status(500).json({ success: false, error: 'Erreur lors de la liaison du compte' });
  }
});

// DELETE /links/:provider
router.delete('/links/:provider', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth || !['oauth', 'bip39'].includes(auth.userType)) {
      return res.status(401).json({ success: false, error: 'Non autorisé' });
    }

    const accessCheck = await ensureLinkManagementAccess(auth);
    if (!accessCheck.allowed) {
      return res.status(accessCheck.status || 403).json({ success: false, error: accessCheck.error });
    }

    const provider = String(req.params.provider || '').toLowerCase();
    if (!isSupportedProvider(provider)) {
      return res.status(400).json({ success: false, error: 'Provider non supporté' });
    }

    const removed = await removeLinksForTargetProvider(auth.userType, auth.userId, provider);
    return res.status(200).json({
      success: true,
      removed,
      message: removed
        ? 'Liaison supprimée avec succès'
        : 'Aucune liaison active à supprimer',
    });
  } catch (error) {
    console.error('Error unlinking account:', error);
    return res.status(500).json({ success: false, error: 'Erreur lors de la suppression de la liaison' });
  }
});

/**
 * GET /api/auth/session
 * Retourne les infos de session si le cookie JWT est valide.
 * Permet au frontend de réhydrater le token en mémoire après un reload.
 */
router.get('/session', async (req, res) => {
  try {
    const token = extractJwtFromRequest(req);
    if (!token) {
      return res.status(401).json({ success: false, error: 'Non authentifié' });
    }

    let payload;
    try {
      payload = verifyJwt(token);
    } catch {
      return res.status(401).json({ success: false, error: 'Session expirée' });
    }

    const { userType, sub: userId, sessionId, authMethod } = payload;
    if (!['oauth', 'bip39'].includes(userType) || !userId || !sessionId) {
      return res.status(401).json({ success: false, error: 'Session invalide' });
    }

    // Vérifier en MySQL
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Service indisponible' });
    }

    const [rows] = await pool.execute(
      'SELECT id FROM user_sessions WHERE id = ? AND user_id = ? AND user_type = ?',
      [sessionId, userId, userType]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Session expirée' });
    }

    // Retourner un nouveau token et les infos de session
    const newToken = issueJwt(userType, userId, sessionId, authMethod);
    setAuthCookie(res, newToken);

    return res.json({
      success: true,
      token: newToken,
      session: { userType, userId, sessionId, authMethod },
    });
  } catch (error) {
    console.error('[AUTH] Session error:', error);
    return res.status(500).json({ success: false, error: 'Erreur interne' });
  }
});

module.exports = router;
