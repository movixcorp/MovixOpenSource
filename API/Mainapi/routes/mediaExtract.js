/**
 * mediaExtract.js — Passerelle VIP vers le service d'extraction proxiesembed.
 *
 * Avant : le frontend appelait directement `proxiesembed` (`/api/extract-*`,
 * `/drm/extract`, `/api/debrid/unlock`). Ces surfaces étaient donc joignables
 * par n'importe qui sur Internet, et `/proxy` acceptait n'importe quelle URL.
 *
 * Maintenant :
 *   frontend --(x-access-key)--> mainapi --(x-internal-key)--> proxiesembed
 *
 * mainapi est le seul à connaître `INTERNAL_API_KEY` ; proxiesembed refuse tout
 * appel d'extraction qui ne la porte pas. Les URLs m3u8 renvoyées sont signées
 * par proxiesembed (HMAC, cf. `utils/mediaSigning.js`), si bien que le client
 * peut les lire mais jamais les repointer ailleurs.
 *
 * L'extraction reste strictement à la demande : une requête = une source
 * (l'épisode que l'utilisateur regarde), jamais un lot préchargé.
 *
 * Monté sur /api/media
 */

const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const { createRedisRateLimitStore } = require('../utils/redisRateLimitStore');
const { requireVip } = require('../checkVip');
const {
    decodeSignedToken,
    internalHeaders,
    internalKeyConfigured,
    isPublicHttpUrl,
    signingConfigured,
} = require('../utils/mediaSigning');

const router = express.Router();

// ---------------------------------------------------------------------------
// Résolution de l'origine proxiesembed
// ---------------------------------------------------------------------------
// PROXIESEMBED_INTERNAL_URL : adresse par laquelle mainapi joint le service
// (souvent une adresse privée ou loopback — d'où l'absence de contrôle
// « adresse publique » ici, contrairement aux URLs cibles).
function resolveProxiesEmbedBase() {
    const candidates = [
        process.env.PROXIESEMBED_INTERNAL_URL,
        process.env.PROXIESEMBED_PUBLIC_URL,
        (process.env.PROXY_SERVER_URL || '').replace(/\/proxy\/?$/, ''),
    ];
    for (const candidate of candidates) {
        const trimmed = (candidate || '').trim().replace(/\/+$/, '');
        if (trimmed) return trimmed;
    }
    return 'http://127.0.0.1:25569';
}

const DRM_TIMEOUT_MS = 60000;
const DEBRID_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const getRateLimitKey = (req) =>
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    ipKeyGenerator(req.ip);

function buildRateLimit({ prefix, windowMs, max, message }) {
    return rateLimit({
        windowMs,
        max,
        store: createRedisRateLimitStore({ prefix, windowMs }),
        passOnStoreError: true,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: getRateLimitKey,
        validate: { xForwardedForHeader: false, ip: false },
        message: { success: false, error: message },
    });
}

// Une extraction = un appel réseau sortant coûteux côté proxiesembed. La limite
// laisse largement passer un binge (une extraction par épisode, plus les
// re-tentatives entre sources) tout en bornant l'abus.
const extractRateLimit = buildRateLimit({
    prefix: 'rate-limit:media:extract:',
    windowMs: 5 * 60 * 1000,
    max: 120,
    message: "Trop d'extractions. Réessayez dans quelques minutes.",
});

const debridRateLimit = buildRateLimit({
    prefix: 'rate-limit:media:debrid:',
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: 'Trop de débridages. Réessayez dans quelques minutes.',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setNoStore(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    next();
}

/**
 * Refuse la requête si le maillon interne n'est pas configuré.
 * Fail-closed : mieux vaut une panne visible qu'une surface ouverte.
 */
function requireInternalWiring(req, res, next) {
    if (!internalKeyConfigured() || !signingConfigured()) {
        console.error(
            '[MEDIA] INTERNAL_API_KEY ou MEDIA_SIGNING_SECRET absent — extraction désactivée'
        );
        return res.status(503).json({
            success: false,
            error: 'Service d\'extraction indisponible',
            code: 'media_gateway_unconfigured',
        });
    }
    return next();
}

/**
 * Relaie une réponse amont en préservant son statut.
 * Le frontend s'appuie sur certains codes (410 DoodStream = fichier supprimé) :
 * les écraser en 500 casserait son message d'erreur.
 */
function relayUpstream(res, error, context) {
    if (error.response) {
        const status = error.response.status;
        const body = error.response.data;
        return res.status(status).json(
            body && typeof body === 'object'
                ? body
                : { success: false, error: 'Extraction échouée', upstream_status: status }
        );
    }

    const timedOut = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    console.warn(`[MEDIA] ${context} — échec amont: ${error.message}`);
    return res.status(timedOut ? 504 : 502).json({
        success: false,
        error: timedOut ? 'Extraction expirée' : 'Service d\'extraction injoignable',
    });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// NOTE — il n'existe plus d'endpoint « extrais-moi cette URL ».
//
// `/api/media/extract/:provider?url=` acceptait une URL choisie par le client.
// Même bordé (VIP, adresse publique, allowlist de providers), il restait une
// cible contrôlable par l'utilisateur. Les m3u8 sont désormais résolues
// exclusivement dans les routes catalogue, à partir des liens que le serveur a
// lui-même scrapés (cf. `utils/embedExtraction.js`), et le navigateur les
// reçoit dans la réponse catalogue.

/**
 * GET /api/media/drm/extract?token=...
 *
 * Le lecteur France.tv ne transmet plus d'adresse : il rend le jeton signé que
 * le catalogue `/api/ftv` lui a remis. mainapi le déballe et retrouve l'URL
 * qu'il avait lui-même émise. Le client transporte, il ne choisit pas — un
 * jeton forgé ou modifié ne passe pas la vérification de signature.
 */
const FTV_TOKEN_ROUTE = 'ftv';

function resolveFtvToken(token) {
    const url = decodeSignedToken(FTV_TOKEN_ROUTE, token);
    if (!url || !isPublicHttpUrl(url)) return null;
    try {
        const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
        return hostname === 'france.tv' || hostname.endsWith('.france.tv') ? url : null;
    } catch {
        return null;
    }
}

router.get(
    '/drm/extract',
    setNoStore,
    requireInternalWiring,
    requireVip,
    extractRateLimit,
    async (req, res) => {
        const rawUrl = resolveFtvToken(req.query.token);
        if (!rawUrl) {
            return res.status(400).json({ success: false, error: 'Jeton France.tv invalide ou expiré' });
        }

        try {
            const upstream = await axios.get(`${resolveProxiesEmbedBase()}/drm/extract`, {
                params: { url: rawUrl },
                headers: internalHeaders({
                    Accept: 'application/json',
                    'x-access-key': req.headers['x-access-key'] || '',
                }),
                timeout: DRM_TIMEOUT_MS,
                validateStatus: (status) => status >= 200 && status < 300,
            });
            return res.json(upstream.data);
        } catch (error) {
            return relayUpstream(res, error, 'drm:extract');
        }
    }
);

/**
 * POST /api/media/debrid/unlock
 * Body: { link, provider, password? }
 */
router.post(
    '/debrid/unlock',
    setNoStore,
    requireInternalWiring,
    requireVip,
    debridRateLimit,
    async (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const link = typeof body.link === 'string' ? body.link.trim() : '';
        if (!isPublicHttpUrl(link)) {
            return res.status(400).json({ status: 'error', error: 'Lien invalide' });
        }

        try {
            const upstream = await axios.post(
                `${resolveProxiesEmbedBase()}/api/debrid/unlock`,
                {
                    link,
                    provider: typeof body.provider === 'string' ? body.provider : 'deepbrid',
                    password: typeof body.password === 'string' ? body.password : '',
                },
                {
                    headers: internalHeaders({
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'x-access-key': req.headers['x-access-key'] || '',
                    }),
                    timeout: DEBRID_TIMEOUT_MS,
                    validateStatus: (status) => status >= 200 && status < 300,
                }
            );
            return res.json(upstream.data);
        } catch (error) {
            return relayUpstream(res, error, 'debrid:unlock');
        }
    }
);

// NOTE — il n'existe volontairement AUCUN endpoint « signe-moi cette URL ».
// Un tel endpoint serait un oracle de signature : n'importe quel porteur de clé
// VIP pourrait faire signer la destination de son choix, ce qui rouvrirait la
// faille que ce module ferme. Les URLs proxifiées sont toujours produites par le
// serveur au moment où il fabrique la réponse (cf. liveTvRoutes.js, purstream,
// kisskh), jamais à la demande du client.

module.exports = router;

