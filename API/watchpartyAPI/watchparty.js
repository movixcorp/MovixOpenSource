import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

// --- Config ---
const PORT = Number(process.env.WATCHPARTY_PORT || 25566);

// Origines autorisées par défaut : uniquement le dev local. En production il faut
// renseigner explicitement WATCHPARTY_REST_CORS_ORIGIN / WATCHPARTY_SOCKET_CORS_ORIGIN.
const DEFAULT_CORS_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

// Normalise une entrée en origine CORS (`schéma://hôte[:port]`, sans chemin).
// Accepte aussi un domaine nu : « movix.fun » devient « https://movix.fun ».
function toOrigin(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).origin;
  } catch {
    return null;
  }
}

// Une entrée est une SOURCE distante (et non une origine) si c'est une URL http(s)
// pointant vers un chemin : « https://movix.online/address.json » est une source,
// « https://movix.fun » est une origine.
function isRemoteOriginSource(value) {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const { pathname } = new URL(value);
    return pathname !== '' && pathname !== '/';
  } catch {
    return false;
  }
}

// Valeur acceptée : `*`, `true`, une liste d'origines séparées par des virgules,
// une ou plusieurs URL de liste distante, ou un mélange des deux.
const parseCorsOrigin = (value, fallback) => {
  const raw = String(value ?? '').trim();
  if (!raw) return { wildcard: false, origins: fallback.map(toOrigin).filter(Boolean), sources: [] };
  if (raw === 'true' || raw === '*') return { wildcard: true, origins: [], sources: [] };

  const origins = [];
  const sources = [];
  for (const part of raw.split(',').map((v) => v.trim()).filter(Boolean)) {
    if (isRemoteOriginSource(part)) {
      sources.push(part);
    } else {
      const origin = toOrigin(part);
      if (origin) origins.push(origin);
    }
  }
  return { wildcard: false, origins, sources };
};

const WATCHPARTY_REST_CORS_ORIGIN = parseCorsOrigin(process.env.WATCHPARTY_REST_CORS_ORIGIN, DEFAULT_CORS_ORIGINS);
const WATCHPARTY_SOCKET_CORS_ORIGIN = parseCorsOrigin(process.env.WATCHPARTY_SOCKET_CORS_ORIGIN, DEFAULT_CORS_ORIGINS);
const WATCHPARTY_SOCKET_CORS_METHODS = (process.env.WATCHPARTY_SOCKET_CORS_METHODS || 'GET,POST')
  .split(',')
  .map((method) => method.trim())
  .filter(Boolean);

// `credentials: true` combiné à une origine reflétée (`true`) ou `*` est une
// mauvaise configuration classique : n'importe quel site tiers peut alors appeler
// l'API avec les cookies de la victime. On désactive les credentials dans ce cas.
let WATCHPARTY_CORS_CREDENTIALS = (process.env.WATCHPARTY_CORS_CREDENTIALS || 'true') === 'true';
if (WATCHPARTY_CORS_CREDENTIALS && (WATCHPARTY_REST_CORS_ORIGIN.wildcard || WATCHPARTY_SOCKET_CORS_ORIGIN.wildcard)) {
  console.warn('[Watchparty] CORS: origine ouverte (* ou reflétée) détectée — credentials désactivés de force.');
  WATCHPARTY_CORS_CREDENTIALS = false;
}

// --- Origines chargées à distance (liste de miroirs) ---
// Format attendu, celui de https://movix.online/address.json :
//   { "primary": { "url": "..." }, "active": [ { "url": "..." } ], "blocked": [ ... ] }
// Seules `primary` et `active` sont retenues : un domaine listé dans `blocked`
// ne doit plus être autorisé. Une liste JSON nue et les clés `mirrors`,
// `origins` et `domains` sont aussi acceptées, par tolérance.
const CORS_SOURCE_REFRESH_MS = 10 * 60 * 1000;
const CORS_SOURCE_RETRY_MS = 60 * 1000;
const remoteOriginCache = new Map(); // URL de la source -> tableau d'origines

function parseRemoteOriginList(payload) {
  const found = [];
  const add = (entry) => {
    const origin = toOrigin(entry && typeof entry === 'object' ? entry.url : entry);
    if (origin) found.push(origin);
  };

  if (Array.isArray(payload)) {
    payload.forEach(add);
  } else if (payload && typeof payload === 'object') {
    if (payload.primary) add(payload.primary);
    for (const key of ['active', 'mirrors', 'origins', 'domains']) {
      if (Array.isArray(payload[key])) payload[key].forEach(add);
    }
  }
  return [...new Set(found)];
}

async function refreshRemoteOrigins() {
  const sources = new Set([...WATCHPARTY_REST_CORS_ORIGIN.sources, ...WATCHPARTY_SOCKET_CORS_ORIGIN.sources]);
  let allOk = true;

  for (const source of sources) {
    try {
      const res = await fetch(source, {
        signal: AbortSignal.timeout(8000),
        headers: { accept: 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const origins = parseRemoteOriginList(await res.json());
      if (origins.length === 0) throw new Error('aucune origine exploitable');
      remoteOriginCache.set(source, origins);
      console.log(`[Watchparty] CORS: ${origins.length} origines chargées depuis ${source}`);
    } catch (e) {
      allOk = false;
      const kept = remoteOriginCache.get(source);
      console.warn(
        `[Watchparty] CORS: échec du chargement de ${source} (${e.message})` +
        (kept ? ` — les ${kept.length} origines précédentes restent actives.` : ' — aucune origine en cache pour cette source !')
      );
    }
  }
  return allOk;
}

// En cas d'échec on réessaie vite, pour ne pas rester longtemps sur une liste
// vide ou périmée ; sinon on rafraîchit tranquillement.
function scheduleRemoteOriginRefresh(delay = CORS_SOURCE_REFRESH_MS) {
  setTimeout(async () => {
    const ok = await refreshRemoteOrigins();
    scheduleRemoteOriginRefresh(ok ? CORS_SOURCE_REFRESH_MS : CORS_SOURCE_RETRY_MS);
  }, delay).unref?.();
}

function isOriginAllowed(setting, origin) {
  if (setting.wildcard) return true;
  if (setting.origins.includes(origin)) return true;
  return setting.sources.some((source) => (remoteOriginCache.get(source) || []).includes(origin));
}

// Le paquet `cors` appelle cette fonction avec (origine, callback). Une requête
// sans en-tête `Origin` ne vient pas d'un navigateur : le CORS ne s'y applique
// pas, on la laisse passer (c'est le token de room qui protège l'accès).
function buildCorsOrigin(setting) {
  return (origin, callback) => {
    if (!origin) return callback(null, true);
    return callback(null, isOriginAllowed(setting, origin));
  };
}

// Secret d'administration : protège /api/watchparty/all. Si absent, la route est désactivée.
const WATCHPARTY_ADMIN_SECRET = (process.env.WATCHPARTY_ADMIN_SECRET || '').trim();
if (!WATCHPARTY_ADMIN_SECRET) {
  console.warn('[Watchparty] WATCHPARTY_ADMIN_SECRET non défini — GET /api/watchparty/all est désactivée.');
}

// --- Limites anti-abus ---
const MAX_JSON_BODY = process.env.WATCHPARTY_MAX_BODY || '256kb';
const MAX_ROOMS = Number(process.env.WATCHPARTY_MAX_ROOMS || 500);
const MAX_ROOMS_PER_IP = Number(process.env.WATCHPARTY_MAX_ROOMS_PER_IP || 5);
const MAX_MESSAGES = 100;
const MAX_CHAT_LENGTH = 500;
const MAX_NICKNAME_LENGTH = 32;
const MAX_SOURCES_PER_LIST = 30;
const MAX_STRING_LENGTH = 2048;
const MAX_PARTICIPANTS_CAP = 50;
const MAX_EMOJI_LENGTH = 16;

// Adresse du client réel. La machine n'est pas joignable directement sur son
// port : tout le trafic entre par Cloudflare puis nginx, donc les en-têtes de
// transfert sont posés par notre propre infrastructure.
//
// `CF-Connecting-IP` est essayé en premier car Cloudflare l'écrase à chaque
// requête : un client ne peut pas le falsifier. `X-Forwarded-For` sert de
// repli, puis `req.ip` s'il n'y a aucun en-tête (appel local, tests).
function getClientIp(req) {
  const cfIp = (req.get('cf-connecting-ip') || '').trim();
  if (cfIp) return cfIp;

  const forwarded = (req.get('x-forwarded-for') || '').split(',')[0].trim();
  if (forwarded) return forwarded;

  return req.ip || req.socket?.remoteAddress || 'unknown';
}

const app = express();

app.use(cors({ origin: buildCorsOrigin(WATCHPARTY_REST_CORS_ORIGIN), credentials: WATCHPARTY_CORS_CREDENTIALS }));
app.use(express.json({ limit: MAX_JSON_BODY }));

const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: buildCorsOrigin(WATCHPARTY_SOCKET_CORS_ORIGIN),
    methods: WATCHPARTY_SOCKET_CORS_METHODS,
    credentials: WATCHPARTY_CORS_CREDENTIALS
  }
});

// --- Rate limiting (fenêtre glissante simple, en mémoire, sans dépendance) ---
const rateLimitBuckets = new Map();

function rateLimit({ windowMs, max, key = 'default', message = 'Too many requests.' }) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${key}:${getClientIp(req)}`;
    const hits = (rateLimitBuckets.get(bucketKey) || []).filter((ts) => now - ts < windowMs);
    if (hits.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ success: false, message });
    }
    hits.push(now);
    rateLimitBuckets.set(bucketKey, hits);
    return next();
  };
}

// Purge périodique des compteurs pour éviter que la Map ne grossisse indéfiniment.
setInterval(() => {
  const now = Date.now();
  for (const [bucketKey, hits] of rateLimitBuckets.entries()) {
    const fresh = hits.filter((ts) => now - ts < 60_000);
    if (fresh.length === 0) rateLimitBuckets.delete(bucketKey);
    else rateLimitBuckets.set(bucketKey, fresh);
  }
}, 60_000).unref?.();

function requireAdminSecret(req, res, next) {
  if (!WATCHPARTY_ADMIN_SECRET) {
    return res.status(503).json({ success: false, message: 'Admin endpoint disabled.' });
  }
  const provided = req.get('x-admin-secret') || '';
  if (!safeCompare(provided, WATCHPARTY_ADMIN_SECRET)) {
    return res.status(403).json({ success: false, message: 'Forbidden.' });
  }
  return next();
}

// --- Persistance basique des rooms ---
const CACHE_DIR = path.join(__dirname, 'cache');
const WATCHPARTY_ROOMS_FILE = path.join(CACHE_DIR, 'watchparty-rooms.json');
const watchpartyRooms = new Map();

async function ensureCacheDir() {
  try { await fsp.access(CACHE_DIR); } catch { await fsp.mkdir(CACHE_DIR, { recursive: true }); }
}

async function loadRoomsFromDisk() {
  try {
    await ensureCacheDir();
    const data = await fsp.readFile(WATCHPARTY_ROOMS_FILE, 'utf-8');
    const roomsArray = JSON.parse(data);
    roomsArray.forEach((room) => {
      // Les identifiants de socket ne survivent pas à un redémarrage : toute
      // l'appartenance basée dessus (participants, hôte, co-hosts, ready) est
      // repartie de zéro. Les tokens d'accès, eux, restent valides.
      room.participants = [];
      room.hostId = null;
      room.coHosts = [];
      room.pendingControlRequests = [];
      room.readyState = {};
      room.pauseVote = null;
      watchpartyRooms.set(room.id, room);
    });
    // Optionnel: supprimer le fichier après restauration, comme dans le serveur principal
    try { await fsp.unlink(WATCHPARTY_ROOMS_FILE); } catch { }
    console.log(`[Watchparty] ${roomsArray.length} rooms restaurées depuis le disque.`);
  } catch { }
}

// `pauseVote.timeoutId` est un objet Timeout de Node, dont les champs internes
// `_idlePrev`/`_idleNext` forment une liste chaînée circulaire : le sérialiser
// faisait échouer JSON.stringify et donc perdre TOUTES les rooms au shutdown.
function serializeRoom(room) {
  const { pauseVote, ...rest } = room;
  if (!pauseVote) return { ...rest, pauseVote: null };
  const { timeoutId, ...voteRest } = pauseVote;
  return { ...rest, pauseVote: voteRest };
}

async function saveRoomsToDisk() {
  try {
    await ensureCacheDir();
    const roomsArray = Array.from(watchpartyRooms.values()).map(serializeRoom);
    await fsp.writeFile(WATCHPARTY_ROOMS_FILE, JSON.stringify(roomsArray, null, 2), 'utf-8');
    console.log(`[Watchparty] ${roomsArray.length} rooms sauvegardées sur le disque.`);
  } catch (e) {
    console.error('[Watchparty] Erreur lors de la sauvegarde des rooms:', e);
  }
}

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Watchparty] Signal ${signal} reçu. Sauvegarde des rooms avant arrêt...`);
  await saveRoomsToDisk();
  try { io.close(); } catch { }
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Socket.IO appelle les handlers d'événement dans un `process.nextTick` sans
// try/catch : toute exception synchrone dans un handler devenait un
// `uncaughtException` et tuait le service pour toutes les rooms. Les payloads
// sont désormais validés en amont ; ce filet évite qu'un cas oublié ne coupe le
// service, et laisse le superviseur redémarrer proprement si l'état est douteux.
process.on('uncaughtException', (err) => {
  console.error('[Watchparty] Exception non capturée:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Watchparty] Rejet de promesse non géré:', reason);
});

// --- Helpers ---

// Comparaison à temps constant, tolérante aux longueurs différentes.
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // On compare quand même pour ne pas court-circuiter sur la longueur.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Code de room : CSPRNG. `Math.random()` (xorshift128+) est prédictible à partir
// de quelques tirages, et le code était de surcroît fourni par le client.
function generateRoomCode() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) result += charset[crypto.randomInt(charset.length)];
  return result;
}

function generateUniqueRoomCode() {
  const existing = new Set();
  for (const room of watchpartyRooms.values()) existing.add(room.code);
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateRoomCode();
    if (!existing.has(code)) return code;
  }
  return null;
}

// --- Validation des entrées ---
function sanitizeString(value, maxLength = MAX_STRING_LENGTH) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function sanitizeNickname(value) {
  const cleaned = sanitizeString(value, MAX_NICKNAME_LENGTH).replace(/[\r\n\t]/g, ' ').trim();
  return cleaned || 'Guest';
}

function sanitizeOptionalString(value, maxLength = MAX_STRING_LENGTH) {
  const cleaned = sanitizeString(value, maxLength);
  return cleaned || null;
}

function sanitizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Durée de pause bornée : `duration` arrivait brut du client (NaN, négatif ou
// arbitrairement long) directement dans un calcul d'horodatage.
function clampPauseDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 60;
  return Math.max(5, Math.min(600, Math.round(parsed)));
}

// Chaque objet source est réduit à ses champs connus et borné en taille : sans ça,
// un client pouvait stocker des mégaoctets arbitraires par room.
function sanitizeSourceList(list, fields) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_SOURCES_PER_LIST).map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const out = {};
    for (const field of fields) {
      if (entry[field] === undefined || entry[field] === null) continue;
      out[field] = typeof entry[field] === 'boolean' ? entry[field] : sanitizeString(entry[field]);
    }
    return out;
  }).filter((entry) => entry && Object.keys(entry).length > 0);
}

function sanitizeMedia(media) {
  const src = sanitizeString(media?.src);
  if (!src) return null;
  return {
    src,
    title: sanitizeString(media?.title, 200) || 'Media',
    poster: sanitizeOptionalString(media?.poster),
    mediaType: media?.mediaType === 'tv' ? 'tv' : 'movie',
    mediaId: sanitizeOptionalString(media?.mediaId, 64),
    seasonNumber: sanitizeNumber(media?.seasonNumber),
    episodeNumber: sanitizeNumber(media?.episodeNumber),
    nightflixSources: sanitizeSourceList(media?.nightflixSources, ['src', 'quality', 'language', 'label']),
    nexusSources: sanitizeSourceList(media?.nexusSources, ['url', 'label', 'type']),
    bravoSources: sanitizeSourceList(media?.bravoSources, ['url', 'label', 'language', 'isVip']),
    // `followsRedirect` : le salon en a besoin pour retirer `crossOrigin` sur la
    // source SwiftFlux, dont le CDN répond une 302 qu'une requête CORS refuse
    // de suivre. Sans ce champ dans la liste blanche, le drapeau était perdu au
    // passage par le serveur et les invités repartaient en mode CORS.
    mp4Sources: sanitizeSourceList(media?.mp4Sources, ['url', 'label', 'language', 'isVip', 'followsRedirect']),
    captions: sanitizeSourceList(media?.captions, ['label', 'file']),
    currentNexusSource: sanitizeSourceList([media?.currentNexusSource], ['url', 'label', 'type'])[0] || null,
    currentBravoSource: sanitizeSourceList([media?.currentBravoSource], ['url', 'label', 'language', 'isVip'])[0] || null
  };
}

// Point d'entrée unique pour l'historique du chat : le plafond s'applique aussi
// aux messages système (join/leave/vote), qui grossissaient sans limite et
// étaient rejoués intégralement à chaque nouvel arrivant.
function pushMessage(room, message) {
  room.messages.push(message);
  while (room.messages.length > MAX_MESSAGES) room.messages.shift();
  return message;
}

function systemMessage(room, text) {
  return pushMessage(room, {
    id: uuidv4(),
    senderId: 'system',
    senderNickname: 'System',
    text,
    timestamp: Date.now(),
    type: 'system'
  });
}

// Rôle du porteur d'un token pour une room donnée : 'host', 'member' ou null.
function resolveRoomRole(room, token) {
  if (!room || typeof token !== 'string' || !token) return null;
  if (room.hostToken && safeCompare(token, room.hostToken)) return 'host';
  if (room.accessTokens && Object.prototype.hasOwnProperty.call(room.accessTokens, token)) return 'member';
  return null;
}

function issueAccessToken(room, nickname) {
  const token = generateToken();
  room.accessTokens[token] = { nickname, issuedAt: Date.now() };
  // Borne le nombre de tokens vivants par room (10x la capacité) pour éviter
  // qu'un spam de POST /join ne fasse grossir l'objet indéfiniment.
  const tokens = Object.keys(room.accessTokens);
  const maxTokens = Math.max(50, room.maxParticipants * 10);
  if (tokens.length > maxTokens) {
    tokens
      .sort((a, b) => room.accessTokens[a].issuedAt - room.accessTokens[b].issuedAt)
      .slice(0, tokens.length - maxTokens)
      .forEach((stale) => { delete room.accessTokens[stale]; });
  }
  return token;
}

function extractRequestToken(req) {
  return sanitizeString(req.get('x-watchparty-token') || req.query.token || '', 256);
}

// --- Socket.IO namespace dédié watchparty ---
const watchpartyIO = io.of('/watchparty');
const SYNC_PRO_SCHEDULE_DELAY_MS = 250;

function buildRoomInfo(roomId, room) {
  return {
    id: roomId,
    code: room.code,
    hostId: room.hostId,
    maxParticipants: room.maxParticipants,
    isPublic: !!room.isPublic,
    syncMode: room.syncMode || 'classic',
    chatEnabled: room.chatEnabled !== false,
    controlMode: room.controlMode,
    coHosts: room.coHosts,
    media: room.media,
    createdAt: room.createdAt,
    participants: room.participants
  };
}

function emitRoomInfo(roomId, room) {
  watchpartyIO.to(roomId).emit('room:info', buildRoomInfo(roomId, room));
}

function emitControlState(roomId, room) {
  watchpartyIO.to(roomId).emit('control:state', {
    controlMode: room.controlMode,
    coHosts: room.coHosts,
    pendingRequests: room.pendingControlRequests
  });
}

function buildScheduledPlaybackEvent(playbackUpdate, action) {
  const serverNow = Date.now();
  return {
    action,
    position: playbackUpdate.position,
    scheduledAt: serverNow + SYNC_PRO_SCHEDULE_DELAY_MS,
    serverNow,
    updatedBy: playbackUpdate.updatedBy
  };
}

watchpartyIO.on('connection', (socket) => {
  const roomId = sanitizeString(socket.handshake.query.roomId, 64);
  const nickname = sanitizeNickname(socket.handshake.query.nickname);
  const token = sanitizeString(socket.handshake.query.token, 256);

  if (!roomId || !watchpartyRooms.has(roomId)) {
    socket.emit('error', { message: 'Invalid room ID' });
    socket.disconnect();
    return;
  }

  const room = watchpartyRooms.get(roomId);

  // Un roomId seul ne suffit plus : il faut un token délivré par
  // POST /create (hôte) ou POST /join (membre). Sans ça, toute personne
  // connaissant l'identifiant pouvait entrer dans n'importe quelle room privée.
  const role = resolveRoomRole(room, token);
  if (!role) {
    socket.emit('error', { message: 'Unauthorized: missing or invalid room token' });
    socket.disconnect();
    return;
  }

  // La capacité n'était vérifiée que dans POST /join, donc contournable en se
  // connectant directement au socket.
  if (role !== 'host' && room.participants.length >= room.maxParticipants) {
    socket.emit('error', { message: 'This watch party is full.' });
    socket.disconnect();
    return;
  }

  socket.data.role = role;
  socket.data.token = token;
  socket.join(roomId);

  // L'hôte est celui qui détient le hostToken, plus « le premier socket arrivé » :
  // cette règle permettait de voler la room en se connectant avant son créateur.
  const isHost = role === 'host';
  if (isHost) room.hostId = socket.id;

  const participant = {
    id: socket.id,
    nickname,
    isHost,
    isActive: true,
    joinedAt: Date.now()
  };
  room.participants.push(participant);

  // Emit room info + participants
  emitRoomInfo(roomId, room);
  watchpartyIO.to(roomId).emit('room:participants', room.participants);
  // Send control state and ready state to the new participant
  socket.emit('control:state', {
    controlMode: room.controlMode,
    coHosts: room.coHosts,
    pendingRequests: room.pendingControlRequests
  });
  socket.emit('ready:state', room.readyState);

  // System join message
  const joinMessage = systemMessage(room, `${participant.nickname} a rejoint la Watch Party.`);
  watchpartyIO.to(roomId).emit('room:chat', joinMessage);

  // Send current playback state + chat history + pause timer
  socket.emit('room:playback', room.playbackState);
  if (room.pauseTimer && room.pauseTimer.endTime > Date.now()) {
    socket.emit('pause:timerStarted', room.pauseTimer);
  }
  room.messages.filter(m => !m.deleted).forEach(m => socket.emit('room:chat', m));

  // Chat
  socket.on('chat:message', (data) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (r.chatEnabled === false && socket.id !== r.hostId) return;
    const me = r.participants.find(p => p.id === socket.id);
    if (!me) return;
    const text = sanitizeString(data?.text, MAX_CHAT_LENGTH);
    if (!text) return;
    const msg = pushMessage(r, {
      id: uuidv4(),
      senderId: socket.id,
      senderNickname: me.nickname,
      text,
      timestamp: Date.now(),
      type: 'chat'
    });
    watchpartyIO.to(roomId).emit('room:chat', msg);
  });

  socket.on('playback:update', (data) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    // Check if user can control: host, co-host, or democratic mode
    const canControl = socket.id === r.hostId ||
      r.coHosts.includes(socket.id) ||
      r.controlMode === 'democratic';

    if (canControl) {
      const position = sanitizeNumber(data?.position);
      const playbackUpdate = {
        isPlaying: data?.isPlaying === true,
        position: position === null ? 0 : position,
        updatedAt: Date.now(),
        updatedBy: socket.id
      };
      const reason = ['play', 'pause', 'seek', 'heartbeat', 'ended'].includes(data?.reason)
        ? data.reason
        : 'heartbeat';
      r.playbackState = playbackUpdate;
      // Broadcast aux autres clients (exclure le sender pour éviter la boucle de feedback)
      socket.to(roomId).emit('playback:state', playbackUpdate);
      if (r.syncMode === 'pro' && reason !== 'heartbeat') {
        socket.to(roomId).emit(
          'playback:schedule',
          buildScheduledPlaybackEvent(playbackUpdate, reason === 'ended' ? 'pause' : reason)
        );
      }
    }
  });

  // Control request from participant
  socket.on('control:request', () => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id === r.hostId || r.coHosts.includes(socket.id)) return; // Already has control
    const me = r.participants.find(p => p.id === socket.id);
    if (!me) return;
    // Check if already pending
    if (r.pendingControlRequests.some(req => req.participantId === socket.id)) return;
    r.pendingControlRequests.push({
      participantId: socket.id,
      nickname: me.nickname,
      requestedAt: Date.now()
    });
    // Notify host of request
    const hostSocket = watchpartyIO.sockets.get(r.hostId);
    if (hostSocket) {
      hostSocket.emit('control:requestReceived', { participantId: socket.id, nickname: me.nickname });
    }
    // Broadcast updated control state
    watchpartyIO.to(roomId).emit('control:state', {
      controlMode: r.controlMode,
      coHosts: r.coHosts,
      pendingRequests: r.pendingControlRequests
    });
  });

  // Host approves control request
  socket.on('control:approve', (payload) => {
    const { participantId } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return; // Only host can approve
    // Remove from pending
    r.pendingControlRequests = r.pendingControlRequests.filter(req => req.participantId !== participantId);
    // Add to co-hosts if not already
    if (!r.coHosts.includes(participantId)) {
      r.coHosts.push(participantId);
    }
    // Notify the participant
    const targetSocket = watchpartyIO.sockets.get(participantId);
    if (targetSocket) {
      targetSocket.emit('control:approved');
    }
    // System message
    const participant = r.participants.find(p => p.id === participantId);
    const systemMsg = systemMessage(r, `${participant?.nickname || 'Un participant'} peut maintenant contrôler la lecture.`);
    watchpartyIO.to(roomId).emit('room:chat', systemMsg);
    // Broadcast updated control state
    watchpartyIO.to(roomId).emit('control:state', {
      controlMode: r.controlMode,
      coHosts: r.coHosts,
      pendingRequests: r.pendingControlRequests
    });
  });

  // Host denies control request
  socket.on('control:deny', (payload) => {
    const { participantId } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    r.pendingControlRequests = r.pendingControlRequests.filter(req => req.participantId !== participantId);
    const targetSocket = watchpartyIO.sockets.get(participantId);
    if (targetSocket) {
      targetSocket.emit('control:denied');
    }
    watchpartyIO.to(roomId).emit('control:state', {
      controlMode: r.controlMode,
      coHosts: r.coHosts,
      pendingRequests: r.pendingControlRequests
    });
  });

  // Host revokes control from co-host
  socket.on('control:revoke', (payload) => {
    const { participantId } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    r.coHosts = r.coHosts.filter(id => id !== participantId);
    const targetSocket = watchpartyIO.sockets.get(participantId);
    if (targetSocket) {
      targetSocket.emit('control:revoked');
    }
    watchpartyIO.to(roomId).emit('control:state', {
      controlMode: r.controlMode,
      coHosts: r.coHosts,
      pendingRequests: r.pendingControlRequests
    });
  });

  // Host toggles control mode
  socket.on('control:setMode', (payload) => {
    const { mode } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    if (mode === 'host-only' || mode === 'democratic') {
      r.controlMode = mode;
      const systemMsg = systemMessage(r, mode === 'democratic'
        ? '🎮 Mode démocratique activé - Tout le monde peut contrôler la lecture !'
        : '🔒 Mode hôte activé - Seul l\'hôte contrôle la lecture.');
      watchpartyIO.to(roomId).emit('room:chat', systemMsg);
      watchpartyIO.to(roomId).emit('control:state', {
        controlMode: r.controlMode,
        coHosts: r.coHosts,
        pendingRequests: r.pendingControlRequests
      });
    }
  });

  socket.on('sync:setMode', (payload) => {
    const { mode } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    if (mode !== 'classic' && mode !== 'pro') return;
    if (r.syncMode === mode) return;

    r.syncMode = mode;
    const systemMsg = systemMessage(r, mode === 'pro'
      ? 'Sync Pro activé par l’hôte. La synchronisation avancée est maintenant active.'
      : 'Le mode de synchronisation classique a été réactivé par l’hôte.');
    watchpartyIO.to(roomId).emit('room:chat', systemMsg);
    watchpartyIO.to(roomId).emit('sync:modeChanged', {
      mode,
      changedBy: socket.id
    });
    emitRoomInfo(roomId, r);
  });

  socket.on('sync:probe', (payload) => {
    const { probeId, clientSentAt } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const serverReceivedAt = Date.now();
    socket.emit('sync:probeResult', {
      probeId,
      clientSentAt,
      serverReceivedAt,
      serverSentAt: Date.now()
    });
  });

  socket.on('playback:buffering', (payload) => {
    const { isBuffering, position } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    socket.to(roomId).emit('playback:buffering', {
      participantId: socket.id,
      isBuffering: !!isBuffering,
      position: Number.isFinite(position) ? position : 0
    });
  });

  socket.on('room:setVisibility', (payload) => {
    const { isPublic } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    r.isPublic = isPublic === true;
    emitRoomInfo(roomId, r);
  });

  socket.on('room:toggleChat', (payload) => {
    const { enabled } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    r.chatEnabled = enabled !== false;
    watchpartyIO.to(roomId).emit('room:chatToggled', { enabled: r.chatEnabled });
    emitRoomInfo(roomId, r);
  });

  socket.on('room:setMaxParticipants', (payload) => {
    const { max } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;
    const parsedMax = Math.max(r.participants.length, Math.min(MAX_PARTICIPANTS_CAP, Number(max) || 10));
    r.maxParticipants = parsedMax;
    emitRoomInfo(roomId, r);
  });

  socket.on('media:change', (media) => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId) return;

    const sanitized = sanitizeMedia(media);
    if (!sanitized) return;
    r.media = sanitized;
    r.playbackState = {
      isPlaying: false,
      position: 0,
      updatedAt: Date.now(),
      updatedBy: socket.id
    };

    watchpartyIO.to(roomId).emit('media:updated', r.media);
    watchpartyIO.to(roomId).emit('playback:state', r.playbackState);
    emitRoomInfo(roomId, r);
  });

  // Ready toggle
  socket.on('ready:toggle', () => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    r.readyState[socket.id] = !r.readyState[socket.id];
    watchpartyIO.to(roomId).emit('ready:state', r.readyState);
  });

  // Emoji reaction
  socket.on('reaction:send', (payload) => {
    const { emoji } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    const me = r.participants.find(p => p.id === socket.id);
    if (!me) return;
    const cleanEmoji = sanitizeString(emoji, MAX_EMOJI_LENGTH);
    if (!cleanEmoji) return;
    watchpartyIO.to(roomId).emit('reaction:received', {
      id: uuidv4(),
      emoji: cleanEmoji,
      senderId: socket.id,
      senderNickname: me.nickname,
      timestamp: Date.now()
    });
  });

  // Pause timer start (host or co-host)
  socket.on('pause:start', (payload) => {
    const { duration } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    const canControl = socket.id === r.hostId || r.coHosts.includes(socket.id);
    if (!canControl) return;
    const safeDuration = clampPauseDuration(duration);
    const durationMs = safeDuration * 1000;
    r.pauseTimer = {
      endTime: Date.now() + durationMs,
      startedBy: socket.id,
      duration: safeDuration
    };
    // Pause playback
    r.playbackState.isPlaying = false;
    r.playbackState.updatedAt = Date.now();
    r.playbackState.updatedBy = socket.id;
    watchpartyIO.to(roomId).emit('playback:state', r.playbackState);
    if (r.syncMode === 'pro') {
      watchpartyIO.to(roomId).emit('playback:schedule', buildScheduledPlaybackEvent(r.playbackState, 'pause'));
    }
    watchpartyIO.to(roomId).emit('pause:timerStarted', r.pauseTimer);
    // System message
    const me = r.participants.find(p => p.id === socket.id);
    const systemMsg = systemMessage(r, `⏸️ ${me?.nickname || 'L\'hôte'} a lancé une pause de ${safeDuration} secondes.`);
    watchpartyIO.to(roomId).emit('room:chat', systemMsg);
  });

  // Pause timer cancel
  socket.on('pause:cancel', () => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    const canControl = socket.id === r.hostId || r.coHosts.includes(socket.id);
    if (!canControl) return;
    r.pauseTimer = null;
    watchpartyIO.to(roomId).emit('pause:timerCancelled');
  });

  // Vote request for pause (guests only)
  socket.on('vote:request', (payload) => {
    const { duration } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    // Only non-hosts can request a vote
    if (socket.id === r.hostId || r.coHosts.includes(socket.id)) return;
    // Don't allow vote if one is already in progress
    if (r.pauseVote) return;

    const me = r.participants.find(p => p.id === socket.id);
    if (!me) return;

    const requestedDuration = clampPauseDuration(duration);
    const voteDuration = 20000; // 20 seconds to vote
    r.pauseVote = {
      requestedBy: socket.id,
      requestedByNickname: me.nickname,
      requestedDuration,
      votes: {}, // participantId -> true (yes) or false (no)
      endTime: Date.now() + voteDuration,
      totalParticipants: r.participants.length
    };

    // Auto-resolve after 20 seconds
    r.pauseVote.timeoutId = setTimeout(() => {
      if (watchpartyRooms.has(roomId)) {
        const room = watchpartyRooms.get(roomId);
        if (room.pauseVote) {
          resolveVote(roomId);
        }
      }
    }, voteDuration);

    // Notify everyone about the vote
    watchpartyIO.to(roomId).emit('vote:started', {
      requestedBy: socket.id,
      requestedByNickname: me.nickname,
      requestedDuration,
      endTime: r.pauseVote.endTime,
      totalParticipants: r.participants.length
    });

    // System message
    const voteMsg = systemMessage(r, `${me.nickname} a demandé une pause de ${requestedDuration}s. Vote en cours...`);
    watchpartyIO.to(roomId).emit('room:chat', voteMsg);
  });

  // Cast vote
  socket.on('vote:cast', (payload) => {
    const { vote } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (!r.pauseVote) return;
    // Seuls les participants présents votent.
    if (!r.participants.some(p => p.id === socket.id)) return;

    // Record vote (true = yes, false = no)
    r.pauseVote.votes[socket.id] = vote === true;

    // Broadcast vote update
    const yesVotes = Object.values(r.pauseVote.votes).filter(v => v === true).length;
    const noVotes = Object.values(r.pauseVote.votes).filter(v => v === false).length;
    const totalVotes = Object.keys(r.pauseVote.votes).length;

    watchpartyIO.to(roomId).emit('vote:update', {
      yesVotes,
      noVotes,
      totalVotes,
      totalParticipants: r.pauseVote.totalParticipants
    });

    // Check if everyone has voted
    if (totalVotes >= r.pauseVote.totalParticipants) {
      // Clear the timeout since everyone voted
      if (r.pauseVote.timeoutId) {
        clearTimeout(r.pauseVote.timeoutId);
      }
      resolveVote(roomId);
    }
  });

  // Helper function to resolve vote
  function resolveVote(roomId) {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (!r.pauseVote) return;

    const yesVotes = Object.values(r.pauseVote.votes).filter(v => v === true).length;
    const totalVotes = Object.keys(r.pauseVote.votes).length;
    const majority = Math.ceil(r.pauseVote.totalParticipants / 2);

    const passed = yesVotes >= majority;

    if (passed) {
      // Start the pause timer
      const durationMs = r.pauseVote.requestedDuration * 1000;
      r.pauseTimer = {
        endTime: Date.now() + durationMs,
        startedBy: r.pauseVote.requestedBy,
        duration: r.pauseVote.requestedDuration
      };
      // Pause playback
      r.playbackState.isPlaying = false;
      r.playbackState.updatedAt = Date.now();
      r.playbackState.updatedBy = 'vote';
      watchpartyIO.to(roomId).emit('playback:state', r.playbackState);
      if (r.syncMode === 'pro') {
        watchpartyIO.to(roomId).emit('playback:schedule', buildScheduledPlaybackEvent(r.playbackState, 'pause'));
      }
      watchpartyIO.to(roomId).emit('pause:timerStarted', r.pauseTimer);

      // System message
      const passMsg = systemMessage(r, `✅ Vote accepté (${yesVotes}/${r.pauseVote.totalParticipants}). Pause de ${r.pauseVote.requestedDuration}s lancée.`);
      watchpartyIO.to(roomId).emit('room:chat', passMsg);
    } else {
      // System message
      const failMsg = systemMessage(r, `❌ Vote refusé (${yesVotes}/${r.pauseVote.totalParticipants}). La majorité n'a pas été atteinte.`);
      watchpartyIO.to(roomId).emit('room:chat', failMsg);
    }

    // Notify result and clear vote
    watchpartyIO.to(roomId).emit('vote:ended', {
      passed,
      yesVotes,
      noVotes: totalVotes - yesVotes,
      totalParticipants: r.pauseVote.totalParticipants
    });

    // Clear timeout if it exists
    if (r.pauseVote.timeoutId) {
      clearTimeout(r.pauseVote.timeoutId);
    }
    r.pauseVote = null;
  }

  // Delete message (host only)
  socket.on('message:delete', (payload) => {
    const { messageId } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId || !messageId) return;
    const idx = r.messages.findIndex(m => m.id === messageId);
    if (idx !== -1) {
      r.messages[idx].deleted = true;
      watchpartyIO.to(roomId).emit('message:deleted', { messageId });
    }
  });

  // Kick participant (host only)
  socket.on('participant:kick', (payload) => {
    const { participantId } = payload || {};
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    if (socket.id !== r.hostId || !participantId || participantId === r.hostId) return;
    const target = r.participants.find(p => p.id === participantId);
    if (!target) return;
    const s = watchpartyIO.sockets.get(participantId);
    if (s) {
      // Sans révocation du token, l'exclu se reconnectait immédiatement.
      if (s.data?.token && s.data.role !== 'host') delete r.accessTokens[s.data.token];
      s.emit('room:kicked', { reason: 'You have been removed from the watch party by the host.' });
      s.disconnect(true);
    }
    const kickMessage = systemMessage(r, `${target.nickname} a été retiré de la Watch Party.`);
    watchpartyIO.to(roomId).emit('room:chat', kickMessage);
  });

  // Playback get state
  socket.on('playback:getState', () => {
    const r = watchpartyRooms.get(roomId);
    if (!r) return;

    if (!r.playbackState) {
      r.playbackState = {
        isPlaying: false,
        position: 0,
        updatedAt: Date.now(),
        updatedBy: null,
      };
    }

    socket.emit('playback:state', r.playbackState);
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (!watchpartyRooms.has(roomId)) return;
    const r = watchpartyRooms.get(roomId);
    const idx = r.participants.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const leaving = r.participants[idx];
    r.participants.splice(idx, 1);

    const leaveMessage = systemMessage(r, `${leaving.nickname} a quitté la Watch Party.`);

    // Reassign host if needed. Tous les participants restants sont authentifiés
    // (ils ont présenté un token valide de cette room), la promotion du plus
    // ancien reste donc confinée aux membres légitimes.
    if (socket.id === r.hostId && r.participants.length > 0) {
      const newHost = r.participants.sort((a, b) => a.joinedAt - b.joinedAt)[0];
      r.hostId = newHost.id; newHost.isHost = true;
      const newHostMsg = systemMessage(r, `${newHost.nickname} est maintenant l'hôte de la Watch Party.`);
      watchpartyIO.to(roomId).emit('room:chat', newHostMsg);
    }

    // If empty, auto-clean after 5 min
    if (r.participants.length === 0) {
      setTimeout(() => {
        const still = watchpartyRooms.get(roomId);
        if (still && still.participants.length === 0) {
          watchpartyRooms.delete(roomId);
          console.log(`Room ${roomId} closed due to inactivity`);
        }
      }, 5 * 60 * 1000);
    } else {
      watchpartyIO.to(roomId).emit('room:participants', r.participants);
      watchpartyIO.to(roomId).emit('room:chat', leaveMessage);
      emitRoomInfo(roomId, r);
    }
  });
});

// --- Routes API (mêmes que le serveur principal) ---

// Nombre de rooms actives par IP, pour empêcher qu'un seul client sature la mémoire.
function countRoomsForIp(ip) {
  let count = 0;
  for (const room of watchpartyRooms.values()) {
    if (room.createdByIp === ip) count++;
  }
  return count;
}

app.post(
  '/api/watchparty/create',
  rateLimit({ windowMs: 60_000, max: 10, key: 'create', message: 'Too many watch parties created. Please wait a moment.' }),
  (req, res) => {
    try {
      const { nickname, maxParticipants, media, isPublic, syncMode } = req.body || {};
      const cleanNickname = sanitizeNickname(nickname);
      const cleanMedia = sanitizeMedia(media);
      if (!nickname || !cleanMedia) {
        return res.status(400).json({ success: false, message: 'Missing required fields: nickname, media.src' });
      }

      // Plafonds mémoire : les rooms vivent jusqu'à 12 h et un POST non
      // authentifié suffisait à en créer autant qu'on voulait.
      if (watchpartyRooms.size >= MAX_ROOMS) {
        return res.status(503).json({ success: false, message: 'Server at capacity. Please try again later.' });
      }
      if (countRoomsForIp(getClientIp(req)) >= MAX_ROOMS_PER_IP) {
        return res.status(429).json({ success: false, message: 'Too many active watch parties for this client.' });
      }

      // Le code est généré côté serveur : accepter celui du client permettait de
      // squatter un code et de bloquer sa réutilisation.
      const code = generateUniqueRoomCode();
      if (!code) return res.status(503).json({ success: false, message: 'Could not allocate a room code. Please try again.' });

      const roomId = uuidv4();
      const hostToken = generateToken();
      const position = sanitizeNumber(media?.position);

      const newRoom = {
        id: roomId,
        code,
        hostId: null,
        hostToken,                // secret : ne doit jamais sortir d'ici
        accessTokens: {},         // token -> { nickname, issuedAt }
        createdByIp: getClientIp(req),
        maxParticipants: Math.max(2, Math.min(MAX_PARTICIPANTS_CAP, Number(maxParticipants) || 10)),
        isPublic: isPublic === true,
        syncMode: syncMode === 'pro' ? 'pro' : 'classic',
        chatEnabled: true,
        controlMode: 'host-only', // 'host-only' | 'democratic'
        coHosts: [],              // Array of participant IDs with control
        pendingControlRequests: [], // Array of {participantId, nickname, requestedAt}
        readyState: {},           // Map: participantId -> boolean
        pauseTimer: null,         // {endTime, startedBy, duration} or null
        pauseVote: null,          // {requestedBy, requestedDuration, votes: {participantId: boolean}, endTime, timeoutId}
        media: cleanMedia,
        participants: [],
        messages: [],
        playbackState: {
          isPlaying: false,
          position: position === null ? 0 : position,
          updatedAt: Date.now(),
          updatedBy: 'system'
        },
        createdAt: Date.now()
      };

      watchpartyRooms.set(roomId, newRoom);
      // `hostToken` n'est renvoyé qu'ici, au créateur, et lie l'hôte à la room.
      res.status(200).json({ success: true, roomId, roomCode: code, hostToken, token: hostToken, nickname: cleanNickname });
    } catch (e) {
      console.error('Error creating watch party:', e);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

app.post(
  '/api/watchparty/join',
  rateLimit({ windowMs: 60_000, max: 30, key: 'join', message: 'Too many join attempts. Please slow down.' }),
  (req, res) => {
    try {
      const { roomCode, nickname } = req.body || {};
      const cleanCode = sanitizeString(roomCode, 6).toUpperCase();
      const cleanNickname = sanitizeNickname(nickname);
      if (!cleanCode || !nickname) return res.status(400).json({ success: false, message: 'Missing required fields: roomCode, nickname' });

      let foundRoomId = null; let foundRoom = null;
      for (const [id, room] of watchpartyRooms.entries()) {
        if (room.code === cleanCode) { foundRoomId = id; foundRoom = room; break; }
      }
      if (!foundRoomId) return res.status(404).json({ success: false, message: 'Watch party not found. Please check the room code and try again.' });
      if (foundRoom.participants.length >= foundRoom.maxParticipants) return res.status(400).json({ success: false, message: 'This watch party is full.' });

      const token = issueAccessToken(foundRoom, cleanNickname);
      res.status(200).json({ success: true, roomId: foundRoomId, roomCode: cleanCode, token, nickname: cleanNickname });
    } catch (e) {
      console.error('Error joining watch party:', e);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

app.get('/api/watchparty/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  if (!watchpartyRooms.has(roomId)) return res.status(404).json({ message: 'Room not found' });
  const room = watchpartyRooms.get(roomId);

  // `media` contient les URLs de flux : réservé aux porteurs d'un token de la room.
  const role = resolveRoomRole(room, extractRequestToken(req));
  if (!role) return res.status(403).json({ message: 'Forbidden: missing or invalid room token' });

  res.json({
    room: {
      id: roomId,
      code: room.code,
      hostId: room.hostId,
      maxParticipants: room.maxParticipants,
      isPublic: !!room.isPublic,
      syncMode: room.syncMode || 'classic',
      chatEnabled: room.chatEnabled !== false,
      controlMode: room.controlMode,
      coHosts: room.coHosts,
      media: room.media,
      createdAt: room.createdAt,
      participants: room.participants.map(p => ({ id: p.id, nickname: p.nickname, isHost: p.id === room.hostId, isActive: p.isActive })),
      playbackState: room.playbackState
    }
  });
});

app.get('/api/watchparty/info/:code', rateLimit({ windowMs: 1000, max: 10, key: 'info' }), (req, res) => {
  try {
    const code = sanitizeString(req.params.code, 6).toUpperCase();
    let foundRoom = null;
    for (const room of watchpartyRooms.values()) { if (room.code === code) { foundRoom = room; break; } }
    if (!foundRoom) return res.status(404).json({ success: false, message: 'Watch party not found' });
    res.status(200).json({
      success: true, room: {
        title: foundRoom.media.title,
        mediaType: foundRoom.media.mediaType,
        participantCount: foundRoom.participants.length,
        maxParticipants: foundRoom.maxParticipants,
        isPublic: !!foundRoom.isPublic,
        syncMode: foundRoom.syncMode || 'classic'
      }
    });
  } catch (e) {
    console.error('Error getting watch party info by code:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/watchparty/public', rateLimit({ windowMs: 1000, max: 10, key: 'public' }), (_req, res) => {
  try {
    const publicRooms = [];
    for (const [id, room] of watchpartyRooms.entries()) {
      if (room.isPublic) publicRooms.push({
        id,
        code: room.code,
        title: room.media.title,
        poster: room.media.poster,
        mediaType: room.media.mediaType,
        participantCount: room.participants.length,
        maxParticipants: room.maxParticipants,
        syncMode: room.syncMode || 'classic',
        seasonNumber: room.media.seasonNumber,
        episodeNumber: room.media.episodeNumber,
        createdAt: room.createdAt
      });
    }
    res.status(200).json({ success: true, rooms: publicRooms });
  } catch (e) {
    console.error('Error listing public watch parties:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Route d'administration : elle expose toutes les rooms, y compris privées.
// Elle exige WATCHPARTY_ADMIN_SECRET (header `x-admin-secret`) et est limitée à
// 5 requêtes/seconde. Le front ne l'utilise pas.
app.get(
  '/api/watchparty/all',
  rateLimit({ windowMs: 1000, max: 5, key: 'all' }),
  requireAdminSecret,
  (_req, res) => {
    try {
      const allRooms = Array.from(watchpartyRooms.entries()).map(([id, room]) => ({
        id,
        code: room.code,
        hostId: room.hostId,
        maxParticipants: room.maxParticipants,
        isPublic: room.isPublic,
        syncMode: room.syncMode || 'classic',
        media: room.media,
        participants: room.participants,
        createdAt: room.createdAt,
        playbackState: room.playbackState
      }));
      res.status(200).json({ success: true, rooms: allRooms });
    } catch (e) {
      console.error('Error listing all watch parties:', e);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// Setup watchparty cleanup job (hourly)
setInterval(() => {
  const nowTime = Date.now();
  const expiredRooms = [];

  // Find expired rooms (older than 12 hours or inactive for 3 hours)
  for (const [roomId, room] of watchpartyRooms.entries()) {
    const roomAge = nowTime - room.createdAt;
    const isExpired = roomAge > 12 * 60 * 60 * 1000; // 12 hours
    const isEmpty = room.participants.length === 0;
    const inactiveFor = isEmpty ? nowTime - Math.max(...room.participants.map(p => p.joinedAt), room.createdAt) : 0;
    const isInactive = isEmpty && inactiveFor > 3 * 60 * 60 * 1000; // 3 hours

    if (isExpired || isInactive) {
      expiredRooms.push(roomId);
      // Notify any remaining participants
      watchpartyIO.to(roomId).emit('room:closed', 'The watch party has ended due to inactivity or expiration.');
    }
  }

  // Remove expired rooms
  expiredRooms.forEach(roomId => {
    watchpartyRooms.delete(roomId);
    console.log(`Room ${roomId} closed due to expiration or inactivity`);
  });
}, 60 * 60 * 1000);

// Startup
(async () => {
  await loadRoomsFromDisk();

  // Les listes distantes sont chargées AVANT d'écouter, pour qu'aucune requête
  // ne soit refusée le temps du premier téléchargement.
  const sourceCount = new Set([...WATCHPARTY_REST_CORS_ORIGIN.sources, ...WATCHPARTY_SOCKET_CORS_ORIGIN.sources]).size;
  if (sourceCount > 0) {
    const ok = await refreshRemoteOrigins();
    scheduleRemoteOriginRefresh(ok ? CORS_SOURCE_REFRESH_MS : CORS_SOURCE_RETRY_MS);
  }

  server.listen(PORT, () => console.log(`Watchparty server listening on http://localhost:${PORT}`));
})();
