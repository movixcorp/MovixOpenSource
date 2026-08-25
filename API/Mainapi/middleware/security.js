/**
 * Security middleware collection.
 * Extracted from server.js -- security headers, keep-alive, domain restriction,
 * and JSON parse error handler.
 */

// Security headers (minimal set -- replaces Helmet)
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0'); // Disabled per OWASP recommendation (use CSP instead)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

// Middleware pour ajouter les headers Keep-Alive
function keepAliveHeaders(req, res, next) {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=60, max=1000');
  next();
}

// Middleware de restriction de domaine et réponse fake pour route spécifique
function domainRestriction(req, res, next) {
  // Autoriser les endpoints LiveTV pour l'extension
  if (req.path.startsWith('/api/livetv/')) {
    return next();
  }

  // Autoriser les endpoints OAuth pour les clients externes (CORS géré par le routeur OAuth)
  if (req.path.startsWith('/api/oauth/')) {
    return next();
  }

  // Autoriser le callback serveur-à-serveur PayGate sans dépendre d'un Origin/Referer navigateur
  if (
    req.path === '/api/vip/paygate/callback'
    || req.path === '/api/vip/cryptogate/webhook'
  ) {
    return next();
  }

  const allowedDomains = [
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

  const origin = req.get('origin');
  const referer = req.get('referer');

  // Comportement CORS standard : une requête sans Origin ni Referer n'est pas
  // une requête cross-origin navigateur (curl, app mobile, serveur-a-serveur,
  // navigation directe). On la laisse passer -- seuls les Origin/Referer
  // presents et hors whitelist sont refuses.
  if (!origin && !referer) {
    return next();
  }

  let isAllowed = false;

  // Strict domain verification
  const checkDomain = (url) => {
    try {
      if (!url) return false;
      const hostname = new URL(url).hostname;
      // Allow exact matches or subdomains if needed (here we list full domains)
      return allowedDomains.some(domain => {
         // Handle localhost with port special case if needed, or just match hostname
         if (domain.includes(':')) return url.includes(domain);
         return hostname === domain || hostname.endsWith('.' + domain);
      });
    } catch (e) {
      return false;
    }
  };

  if (origin) {
    if (checkDomain(origin)) isAllowed = true;
  } else if (referer) {
    if (checkDomain(referer)) isAllowed = true;
  }

  // Si autorisé, on continue
  if (isAllowed) {
    return next();
  }

  // Si non autorisé
  // Route spécifique accessible mais avec fausse réponse
  if (req.path.startsWith('/api/imdb/movie')) {
    return res.json({
      "iframe_src": "https://movixfakesite.vercel.app/",
      "player_links": [
        {
          "player": "supervideo",
          "link": "https://movixfakesite.vercel.app/",
          "is_hd": false
        },
        {
          "player": "dropload",
          "link": "https://movixfakesite.vercel.app/",
          "is_hd": false
        },
        {
          "player": "mixdrop",
          "link": "https://movixfakesite.vercel.app/",
          "is_hd": false
        }
      ]
    });
  } else if (req.path.startsWith('/api/imdb/tv')) {
    return res.json({
      "type": "tv",
      "series": [
        {
          "title": "Stranger Things - Saison 5",
          "audio_type": "VF",
          "episode_count": 1,
          "release_date": "2016",
          "summary": "Quand un jeune garçon disparaît, une petite ville découvre une affaire mystérieuse, des expériences secrètes, des forces surnaturelles terrifiantes... et une fillette.",
          "tmdb_data": {
            "id": 66732,
            "name": "Stranger Things",
            "overview": "When a young boy vanishes, a small town uncovers a mystery involving secret experiments, terrifying supernatural forces, and one strange little girl.",
            "first_air_date": "2016-07-15",
            "poster_path": "/uOOtwVbSr4QDjAGIifLDwpb2Pdl.jpg",
            "backdrop_path": "/8zbAoryWbtH0DKdev8abFAjdufy.jpg",
            "vote_average": 8.59,
            "match_score": 0.8818181818181817
          },
          "seasons": [
            {
              "number": 1,
              "title": "Saison 1",
              "episodes": [
                {
                  "number": "1",
                  "versions": {
                    "vf": {
                      "title": "Episode 1",
                      "players": [
                        {
                          "name": "Supervideo",
                          "link": "https://movixfakesite.vercel.app/"
                        }
                      ]
                    }
                  }
                }
              ]
            }
          ]
        }
      ]
    });
  }

  // Bloquer toutes les autres routes
  return res.status(404).json({ error: 'Not Found' });
}

// Error handler for JSON parsing errors (malformed requests like URL-encoded form data)
function jsonParseErrorHandler(err, req, res, next) {
  const isCryptoGateWebhook = req.originalUrl?.split('?')[0]
    === '/api/vip/cryptogate/webhook';

  if (err.type === 'entity.too.large') {
    if (isCryptoGateWebhook) {
      return res.status(413).type('text/plain').send('invalid webhook');
    }
    return res.status(413).json({
      success: false,
      error: 'Request body too large'
    });
  }
  if (err.type === 'entity.parse.failed') {
    if (isCryptoGateWebhook) {
      return res.status(400).type('text/plain').send('invalid webhook');
    }
    // Silently handle malformed JSON requests (likely bots or scanners)
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON body'
    });
  }
  next(err);
}

module.exports = {
  securityHeaders,
  keepAliveHeaders,
  domainRestriction,
  jsonParseErrorHandler
};
