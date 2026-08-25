/**
 * CORS middleware configuration.
 * Extracted from server.js -- restricted origin policy.
 */

const cors = require("cors");
const { getOAuthAllowedCorsOrigins } = require('../utils/oauthClients');

const STATIC_ALLOWED_DOMAINS = [
    'localhost:3000',
    'movix.blog',
    'movix.rodeo',
    'movix.club',
    'movix.site',
    'movix11.pages.dev',
    'nakios.site',
    'cinezo.site',
    'cinezo.online',
    'filmib.cc',
    'movix.llc',
    'movix.cash',
    'movix.tax',
    'movix.cloud',
    'movix.golf',
    'movix.chat',
    'movix.date',
    'movix.show',
    'movix.fun'
];

function isAllowedStaticOrigin(origin) {
  try {
    const parsedOrigin = new URL(origin);
    const hostname = parsedOrigin.hostname;

    return STATIC_ALLOWED_DOMAINS.some((domain) => (
      hostname === domain || hostname.endsWith(`.${domain}`)
    ));
  } catch {
    return false;
  }
}

function isAllowedOAuthOrigin(origin) {
  return getOAuthAllowedCorsOrigins().includes(origin);
}

const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Allow all localhost requests in development only
    if (process.env.NODE_ENV !== 'production' && origin.match(/^https?:\/\/localhost(:[0-9]+)?$/)) {
      return callback(null, true);
    }

    if (isAllowedStaticOrigin(origin) || isAllowedOAuthOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH", "HEAD"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "X-No-Compression",
    "Access-Control-Request-Headers",
    "baggage",
    "sentry-trace",
    "x-profile-id",
    "x-access-key",
    "x-movix-client-id",
  ],
  credentials: true,
  optionsSuccessStatus: 204,
});

module.exports = corsMiddleware;
