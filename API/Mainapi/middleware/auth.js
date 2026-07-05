/**
 * Authentication middleware and helpers.
 * Extracted from server.js -- JWT setup, admin checks, session validation.
 */

const fsp = require('fs').promises;
const path = require('path');
const jwt = require('jsonwebtoken');
const { getPool } = require('../mysqlPool');
const { getUserDataFilePath } = require('../utils/syncPolicy');
const AUTH_METHODS = ['discord', 'google', 'bip39'];
const USER_DATA_DIR = path.join(__dirname, '..', 'data');
const GUESTS_DIR = path.join(USER_DATA_DIR, 'guests');
const USERS_DIR = path.join(USER_DATA_DIR, 'users');

// Lazy pool getter -- avoids requiring the pool at module load time
let _pool = null;
function getDbPool() {
  if (!_pool) _pool = getPool();
  return _pool;
}

// === JWT Setup ===
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not defined in .env");
  process.exit(1);
}

function issueJwt(userType, userId, sessionId, authMethod = null) {
  const payload = { sub: userId, userType, sessionId };
  if (AUTH_METHODS.includes(authMethod)) {
    payload.authMethod = authMethod;
  }
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '24h' });
}

function verifyJwt(token, options = {}) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], ...options });
}

function parseStoredAuth(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function readStoredAccountData(userType, userId) {
  try {
    const filePath = getUserDataFilePath(
      { usersDir: USERS_DIR, guestsDir: GUESTS_DIR },
      userType,
      String(userId)
    );
    const fileContent = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(fileContent);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    console.error('[AUTH] Failed to read stored account data:', error.message || error);
    return undefined;
  }
}

function hasStoredAccountIdentity(userType, userData) {
  if (!userData || typeof userData !== 'object') {
    return false;
  }

  const storedAuth = parseStoredAuth(userData.auth);
  if (storedAuth?.userProfile && typeof storedAuth.userProfile === 'object') {
    return true;
  }

  if (Array.isArray(userData.profiles)) {
    return true;
  }

  if (userType === 'bip39') {
    return userData.bip39_auth === 'true';
  }

  return typeof userData.oauth_provider === 'string' && userData.oauth_provider.trim().length > 0;
}

async function validateBackingAccount(userType, userId) {
  if (!['oauth', 'bip39'].includes(userType) || !userId) {
    return false;
  }

  const userData = await readStoredAccountData(userType, userId);
  if (userData === undefined) {
    return null;
  }

  return hasStoredAccountIdentity(userType, userData);
}

function purgeSessionRecord(sessionId, userId, userType) {
  try {
    const pool = getDbPool();
    if (!pool || !sessionId || !userId || !userType) {
      return;
    }

    pool.execute(
      'DELETE FROM user_sessions WHERE id = ? AND user_id = ? AND user_type = ?',
      [sessionId, userId, userType]
    ).catch((error) => {
      console.error('[AUTH] Failed to purge orphan session:', error.message || error);
    });
  } catch (error) {
    console.error('[AUTH] Failed to schedule orphan session purge:', error.message || error);
  }
}

// === Auth validation ===

async function getAuthIfValid(req) {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null;
    const token = authHeader.split(' ')[1];
    const payload = verifyJwt(token);
    const { userType, sub: userId, sessionId } = payload;
    const authMethod = AUTH_METHODS.includes(payload?.authMethod)
      ? payload.authMethod
      : (userType === 'bip39' ? 'bip39' : null);
    if (!['oauth', 'bip39'].includes(userType) || !userId || !sessionId) return null;

    // Vérification de session via MySQL avec 3 tentatives
    let hasSession = false;
    const pool = getDbPool();

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!pool) {
          console.warn('[AUTH] MySQL pool not ready, attempt', attempt);
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          return null;
        }

        const [rows] = await pool.execute(
          'SELECT id FROM user_sessions WHERE id = ? AND user_id = ? AND user_type = ?',
          [sessionId, userId, userType]
        );
        hasSession = rows.length > 0;

        if (hasSession) {
          break; // Session trouvée, sortir de la boucle
        }

        if (attempt < 3) {
          console.log(`[AUTH] Tentative ${attempt}/3 échouée pour userType=${userType}, userId=${userId}, sessionId=${sessionId} - nouvelle tentative dans 0.5s`);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`[AUTH] Erreur lors de la tentative ${attempt}/3:`, error.message);
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    if (!hasSession) {
      console.warn(`[AUTH] Session manquante après 3 tentatives pour userType=${userType}, userId=${userId}, sessionId=${sessionId}`);
      return null;
    }

    const hasBackingAccount = await validateBackingAccount(userType, userId);
    if (hasBackingAccount === false) {
      console.warn(`[AUTH] Account backing data missing for userType=${userType}, userId=${userId}. Purging session ${sessionId}.`);
      purgeSessionRecord(sessionId, userId, userType);
      return null;
    }

    // Update last access as activity signal (fire-and-forget, pas de await)
    updateSessionAccess(userType, userId, sessionId);
    return { userType, userId, sessionId, authMethod };
  } catch {
    return null;
  }
}

// === Session access updater (fire-and-forget) ===

const updateSessionAccess = async (userType, userId, sessionId) => {
  try {
    const pool = getDbPool();
    if (!pool) {
      return false;
    }

    // Fire-and-forget: ne pas bloquer le flux principal
    pool.execute(
      'UPDATE user_sessions SET accessed_at = NOW() WHERE id = ? AND user_id = ? AND user_type = ?',
      [sessionId, userId, userType]
    ).catch(err => console.error('Error updating session access:', err));

    return true;
  } catch (error) {
    console.error('Error updating session access:', error);
    return false;
  }
};

// === Admin middleware ===

// Middleware pour vérifier si l'utilisateur est admin
async function isAdmin(req, res, next) {
  try {
    const pool = getDbPool();
    // Vérifier si le pool MySQL est initialisé
    if (!pool) {
      console.error('❌ MySQL pool not initialized');
      return res.status(503).json({ success: false, error: 'Service temporairement indisponible - Base de données en cours d\'initialisation' });
    }

    // Vérifier le JWT
    const auth = await getAuthIfValid(req);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'Non autorisé - Token invalide' });
    }

    const { userId, userType } = auth;

    // Vérifier si l'utilisateur est dans la table admins
    const [rows] = await pool.execute(
      'SELECT * FROM admins WHERE user_id = ? AND auth_type = ?',
      [userId, userType === 'bip39' ? 'bip-39' : userType]
    );

    if (rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Accès refusé - Droits admin requis' });
    }

    // Récupérer le rôle (par défaut 'admin' si non défini)
    const role = rows[0].role || 'admin';

    // Ajouter les infos admin à la requête (avec le rôle)
    req.admin = { userId, userType, adminId: rows[0].id, role };
    next();
  } catch (error) {
    console.error('❌ Admin verification error:', error);
    return res.status(500).json({ success: false, error: 'Erreur lors de la vérification admin' });
  }
}

// Middleware pour vérifier si l'utilisateur est uploader ou admin (pour les liens de streaming)
async function isUploaderOrAdmin(req, res, next) {
  try {
    const pool = getDbPool();
    // Vérifier si le pool MySQL est initialisé
    if (!pool) {
      console.error('❌ MySQL pool not initialized');
      return res.status(503).json({ success: false, error: 'Service temporairement indisponible - Base de données en cours d\'initialisation' });
    }

    // Vérifier le JWT
    const auth = await getAuthIfValid(req);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'Non autorisé - Token invalide' });
    }

    const { userId, userType } = auth;

    // Vérifier si l'utilisateur est dans la table admins (admin ou uploader)
    const [rows] = await pool.execute(
      'SELECT * FROM admins WHERE user_id = ? AND auth_type = ?',
      [userId, userType === 'bip39' ? 'bip-39' : userType]
    );

    if (rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Accès refusé - Droits requis' });
    }

    // Récupérer le rôle (par défaut 'admin' si non défini)
    const role = rows[0].role || 'admin';

    // Autoriser les rôles 'admin' et 'uploader'
    if (role !== 'admin' && role !== 'uploader') {
      return res.status(403).json({ success: false, error: 'Accès refusé - Droits insuffisants' });
    }

    // Ajouter les infos admin à la requête (avec le rôle)
    req.admin = { userId, userType, adminId: rows[0].id, role };
    next();
  } catch (error) {
    console.error('❌ Admin/Uploader verification error:', error);
    return res.status(500).json({ success: false, error: 'Erreur lors de la vérification des droits' });
  }
}

module.exports = {
  JWT_SECRET,
  issueJwt,
  verifyJwt,
  isAdmin,
  isUploaderOrAdmin,
  getAuthIfValid,
  updateSessionAccess
};
