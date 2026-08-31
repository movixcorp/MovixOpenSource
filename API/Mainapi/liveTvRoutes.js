/**
 * Live TV Routes - Backend API pour TV en Direct
 *
 * Ce module gère les requêtes vers l'API Stremio TV Direct
 * avec mise en cache et résolution des URLs de streaming.
 */

const express = require("express");
const axios = require("axios");
const path = require("path");
const fsp = require("fs").promises;
const crypto = require("crypto");
const { verifyAccessKey, requireVip } = require("./checkVip");
const {
  appendSignature,
  buildSignedProxyUrl,
  isPublicHttpUrl,
  signingConfigured,
} = require("./utils/mediaSigning");
const {
  VAVOO_GROUPS,
  vavooGroupSlug,
  buildVavooCatalogs,
} = require("./utils/vavooCatalogs");
const {
  createVavooMetadataService,
  findVavooMetadata,
  isHttpsArtworkUrl,
} = require("./utils/vavooMetadata");
const router = express.Router();

// ===========================================================================
//  Proxification signée des flux Live TV
// ===========================================================================
// Le lecteur doit parfois passer par proxiesembed (flux HTTP sur page HTTPS,
// Vavoo, FamilyRestream/TF1…), mais proxiesembed n'accepte plus que des URLs
// signées et le navigateur ne sait pas signer.
//
// Il n'y a délibérément PAS d'endpoint « signe-moi cette URL » : ce serait un
// oracle de signature, un porteur de clé VIP pourrait faire signer la
// destination de son choix. À la place, le serveur joint d'office une
// `proxyUrl` signée à chaque flux qu'il annonce, et le client se contente de
// choisir entre `url` (direct) et `proxyUrl` (proxifié).
//
// Le middleware ci-dessous enveloppe `res.json` une fois pour toutes : il
// couvre les quelque vingt branches qui renvoient des flux, réponses servies
// depuis le cache incluses.

const LIVETV_PROXY_BASE = (
  process.env.PROXIESEMBED_PUBLIC_URL ||
  (process.env.IPTV_STREAM_PROXY || "http://localhost:25569/proxy").replace(/\/proxy\/?$/, "")
).replace(/\/+$/, "");

/** Headers que proxiesembed devra rejouer vers l'amont pour ce flux. */
function proxyHeadersForStream(stream) {
  const headers = {};
  if (typeof stream.referer === "string" && stream.referer) {
    headers.Referer = stream.referer;
    try {
      headers.Origin = new URL(stream.referer).origin;
    } catch {
      // Referer non parsable : on n'ajoute pas d'Origin.
    }
  }
  if (typeof stream.userAgent === "string" && stream.userAgent) {
    headers["User-Agent"] = stream.userAgent;
  }
  return headers;
}

function attachSignedProxyUrls(payload) {
  if (!payload || !Array.isArray(payload.streams) || !signingConfigured()) {
    return payload;
  }

  return {
    ...payload,
    streams: payload.streams.map((stream) => {
      if (!stream || typeof stream !== "object" || stream.proxyUrl) return stream;

      const target = typeof stream.url === "string" ? stream.url : "";
      // Déjà proxifié en amont, ou cible inexploitable : on ne double pas la couche.
      if (!target || target.includes("/proxy?url=") || target.includes("/proxy/")) return stream;
      if (!isPublicHttpUrl(target)) return stream;

      const headers = proxyHeadersForStream(stream);
      const extraParams = Object.keys(headers).length
        ? { headers: JSON.stringify(headers) }
        : {};

      return {
        ...stream,
        proxyUrl: buildSignedProxyUrl(LIVETV_PROXY_BASE, "/proxy", target, { extraParams }),
      };
    }),
  };
}

router.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (payload) => sendJson(attachSignedProxyUrls(payload));
  next();
});

// === CONFIGURATION ===
const TVDIRECT_BASE_URL = "https://tvdirect.ddns.net";
// URL du serveur proxy local (proxiesembed)
const PROXY_SERVER_URL = process.env.PROXY_SERVER_URL;

// Route signée correspondant à PROXY_SERVER_URL. proxiesembed vérifie la
// signature contre `request.path`, donc le chemin de l'endpoint (`/proxy`).
const PROXY_SERVER_ROUTE = (() => {
  try {
    return new URL(PROXY_SERVER_URL).pathname || "/proxy";
  } catch {
    return "/proxy";
  }
})();

/**
 * URL proxifiée SIGNÉE vers PROXY_SERVER_URL.
 *
 * proxiesembed refuse toute URL non signée (403 SIGNATURE_REQUIRED). Le
 * middleware `attachSignedProxyUrls` ne couvre que les payloads JSON : les
 * liens fabriqués à la main — segments réécrits dans une playlist m3u8
 * notamment — doivent porter leur propre `exp`/`sig`, sinon le lecteur reçoit
 * une playlist dont chaque segment est rejeté.
 *
 * `extraParams.headers` attend la chaîne JSON brute : l'encodage est fait ici.
 */
function buildProxyServerUrl(targetUrl, extraParams = {}) {
  if (!PROXY_SERVER_URL) return targetUrl;

  const params = new URLSearchParams({ url: targetUrl });
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const url = `${PROXY_SERVER_URL}?${params.toString()}`;

  if (!signingConfigured()) {
    console.error(
      "[LIVETV] MEDIA_SIGNING_SECRET absent — URL proxy non signée, proxiesembed la refusera",
    );
    return url;
  }

  return appendSignature(url, PROXY_SERVER_ROUTE, targetUrl);
}
/*

  "https://tvmio.gleeze.com/eyJjb3VudHJpZXMiOlsiRlIiXSwiY2F0ZWdvcmllcyI6eyJGUiI6WyJHZW5lcmFsIPCfk7oiLCJTcG9ydHMg4pq9IiwiRG9jdW1lbnRhaXJlcyDwn4yNIiwiRmlsbXMg8J+OrCIsIkluZm9ybWF0aW9ucyDwn5OwIiwiRW5mYW50cyDwn5G2IiwiTXVzaWMg8J+OtSJdfSwiZW5hYmxlU2VhcmNoIjpmYWxzZX0";

  tvmio_general: {
    genre: "FR | General",
    remoteGenre: "General 📺",
    name: "Généraliste 📺",
    emoji: "📺",
  },
  tvmio_sports: {
    genre: "FR | Sports",
    remoteGenre: "Sports ⚽",
    name: "Sports ⚽",
    emoji: "⚽",
  },
  tvmio_documentaires: {
    genre: "FR | Documentaires",
    remoteGenre: "Documentaires 🌍",
    name: "Documentaires 🌍",
    emoji: "🌍",
  },
  tvmio_films: {
    genre: "FR | Films",
    remoteGenre: "Films 🎬",
    name: "Films 🎬",
    emoji: "🎬",
  },
  tvmio_informations: {
    genre: "FR | Informations",
    remoteGenre: "Informations 📰",
    name: "Informations 📰",
    emoji: "📰",
  },
  tvmio_enfants: {
    genre: "FR | Enfants",
    remoteGenre: "Enfants 👶",
    name: "Enfants 👶",
    emoji: "👶",
  },
  tvmio_music: {
    genre: "FR | Musique",
    remoteGenre: "Music 🎵",
    name: "Musique 🎵",
    emoji: "🎵",
  },
};

*/
const TVMIO_CATEGORIES = {};

// FCTV33 / RBTV-style API used for the matches catalog.
// EU endpoint (defra) is used by default for European users.
// Fallback API base — normally auto-resolved at runtime (getFctvApiBase); this
// hardcoded value is used only when the cache is empty / auto-resolve fails.
const FCTV_API_BASE_URL = "https://apis-data-defra10.tcore131ybdf.ru";
// Fallback embed player origin — normally auto-resolved (getFctvPlayerBaseUrl).
// Used for the iframe player + referer when the lookup is unavailable.
const FCTV_PLAYER_BASE_URL = "https://zac07eo.mpipzni2naturally32kistomach.ru";

// --- Native (HLSPlayer) stream tokenisation -------------------------------
// /api/stream/detail (unsigned, with continent/country/digit) returns an
// `rb-session` header + a masked URL that decodes to the proxy m3u8 path.
// The CDN gate is `/token-<T>/` where T = base64( rbSession XOR keystream ) + "a"
// (a fixed RC4-style keystream; recovered from a known token↔rb-session pair).
// The proxy m3u8 + its TS segments are Referer-gated to the player origin, so
// the native stream must be fetched through PROXY_SERVER_URL with that Referer.
const FCTV_STREAM_DIGIT = "seth";
const FCTV_GEO_CONTINENT = "EU";
const FCTV_GEO_COUNTRY = "FR";
// Keystream (hex). Edit this value when upstream rotates its key (native breaks
// with 403/404 → re-capture one token↔rb-session pair and XOR them,
// scripts/fctv_token_crack.cjs).
const FCTV_TOKEN_KEYSTREAM = Buffer.from(
  "15764bab80a419c6abdd5518f3db0ea95bb3b9a2e2b519ce5c159af6917e2000c2d680ae30706a3aba1c9c25786c7c28774eecf20450a3cf414ca17f6472798cfa557c7a8705b7861f06e84f827f8a24676eeab77ce504bfc335b79609b9",
  "hex",
);
const FCTV_LANGUAGE_FR = 6;
const FCTV_DEFAULT_SITE_TYPE = 2001;

// Les logos FCTV ne sont plus proxifies : le proxy partage a ete retire pour
// cause de faille SSRF. On se contente de corriger le domaine mort.
function proxifyFctvImage(url) {
  if (!url) return "";

  // Replace dead domains with the working one
  let fixedUrl = url;
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.startsWith("logos1.")) {
      urlObj.hostname = "logos1.tcore131ybdf.ru";
    }
    fixedUrl = urlObj.toString();
  } catch (e) {
    // fallback if it's not a full URL
    fixedUrl = url.replace(/logos1\.[a-z0-9]+\.(cfd|ru|com)/g, "logos1.tcore131ybdf.ru");
  }

  return fixedUrl;
}

// Sports exposés par l'API FCTV. La table `sportType -> slug` est reprise du
// bundle du site amont (fctv33hd.fun), qui bâtit sa barre de navigation sur
// une constante figée de la même forme :
//
//   {'FTB':['ST_FOOTBALL','football',0x1], 'BSK':['ST_BASKETBALL','basketball',0x2], …}
//
// `sportType` est le paramètre attendu par /api/match/live (0 = tous les
// sports) ; chaque match le renvoie aussi (champ 2), ce qui permet d'étiqueter
// correctement les cartes du catalogue « Tous les sports ». Le 5 est absent en
// amont, le 90 sert de fourre-tout.
const FCTV_SPORTS = [
  { sportType: 1, key: "football", name: "Football", emoji: "⚽" },
  { sportType: 2, key: "basketball", name: "Basketball", emoji: "🏀" },
  { sportType: 3, key: "tennis", name: "Tennis", emoji: "🎾" },
  { sportType: 4, key: "baseball", name: "Baseball", emoji: "⚾" },
  { sportType: 6, key: "cricket", name: "Cricket", emoji: "🏏" },
  { sportType: 7, key: "motorsport", name: "Sports mécaniques", emoji: "🏎️" },
  { sportType: 8, key: "rugby", name: "Rugby", emoji: "🏉" },
  { sportType: 9, key: "american_football", name: "Football américain", emoji: "🏈" },
  { sportType: 10, key: "aussie_rules", name: "Football australien", emoji: "🏉" },
  { sportType: 11, key: "hockey", name: "Hockey", emoji: "🏒" },
  { sportType: 12, key: "badminton", name: "Badminton", emoji: "🏸" },
  { sportType: 13, key: "volleyball", name: "Volley-ball", emoji: "🏐" },
  { sportType: 14, key: "fighting", name: "Sports de combat", emoji: "🥊" },
  { sportType: 15, key: "cycling", name: "Cyclisme", emoji: "🚴" },
  { sportType: 16, key: "handball", name: "Handball", emoji: "🤾" },
  { sportType: 90, key: "others", name: "Autres sports", emoji: "🏟️" },
];

const FCTV_SPORT_BY_TYPE = new Map(
  FCTV_SPORTS.map((sport) => [sport.sportType, sport]),
);

const FCTV_ALL_SPORTS_CATEGORY = {
  name: "Tous les sports",
  emoji: "🏅",
  sportKey: "all",
  sportType: 0,
};

const FCTV_MATCHES_CATEGORIES = {
  matches_all: FCTV_ALL_SPORTS_CATEGORY,
  ...Object.fromEntries(
    FCTV_SPORTS.map((sport) => [
      `matches_${sport.key}`,
      {
        name: sport.name,
        emoji: sport.emoji,
        sportKey: sport.key,
        sportType: sport.sportType,
      },
    ]),
  ),
};
const FCTV_API_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/x-protobuf,application/json,*/*",
  Origin: FCTV_PLAYER_BASE_URL,
  Referer: `${FCTV_PLAYER_BASE_URL}/`,
};

// V mapping: API endpoint paths -> bs code numbers (from upstream client JS)
const FCTV_BS_CODE_MAP = {
  "/api/match/live": 100,
  "/api/match/schedule": 101,
  "/api/match/detail": 102,
  "/api/match/event": 103,
  "/api/match/statistic": 104,
  "/api/match/trend": 105,
  "/api/match/lineup": 106,
  "/api/match/analysis": 107,
  "/api/match/count": 190,
  "/api/league/detail": 200,
  "/api/league/season/list": 210,
  "/api/league/match/list": 220,
  "/api/league/team/total/list": 230,
  "/api/league/player/total/list": 231,
  "/api/league/team/standing/list": 240,
  "/api/odds/list": 300,
};

// In-memory cache for bs keys (from /api/common/bs)
let fctvBsKeysCache = null;
let fctvBsKeysCacheTime = 0;
const FCTV_BS_KEYS_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch body-signature keys from /api/common/bs.
 * These keys are used to build the sfver path prefix required by the upstream API.
 */
async function fetchFctvBsKeys(sportType = 0) {
  // Return cached keys if fresh
  if (fctvBsKeysCache && Date.now() - fctvBsKeysCacheTime < FCTV_BS_KEYS_TTL) {
    return fctvBsKeysCache;
  }

  try {
    const codes = [100, 101, 102, 103, 104, 105, 106, 107];
    const params = new URLSearchParams();
    params.set("stream", "true");
    params.set("sportType", String(sportType));
    codes.forEach((c) => params.append("code", String(c)));

    const apiBase = await getFctvApiBase();
    const response = await axios.get(`${apiBase}/api/common/bs`, {
      params,
      responseType: "arraybuffer",
      headers: FCTV_API_HEADERS,
      timeout: 10000,
    });

    const { body } = parseFctvBody(response.data);
    const kvEntries = fctvAll(body, 1);
    const keys = {};

    for (const entry of kvEntries) {
      const entryFields = fctvFields(entry);
      const code = fctvValue(entryFields, 1);
      const key = fctvString(fctvValue(entryFields, 2));
      if (code != null && key) {
        keys[Number(code)] = key;
      }
    }

    console.log(`[FCTV-BS] Fetched ${Object.keys(keys).length} bs keys`);
    fctvBsKeysCache = keys;
    fctvBsKeysCacheTime = Date.now();
    return keys;
  } catch (error) {
    console.warn(`[FCTV-BS] Error fetching bs keys: ${error.message}`);
    return fctvBsKeysCache || {};
  }
}

/**
 * Build the sfver path prefix for a given API endpoint and params.
 * Format: sfver + MD5(JSON.stringify(sortedParams)).slice(0,6) + bsKey
 */
function buildFctvSfverPrefix(pathname, params, bsKeys) {
  const au = { ...params };
  delete au.usls;
  delete au.cBsDataTep;

  const ap = ['matchId', 'leagueId', 'seasonId', 'sportType', 'language', 'stream'];

  const sortedKeys = Object.keys(au).sort((a, b) => ap.indexOf(a) - ap.indexOf(b));

  const sortedObj = {};
  for (const key of sortedKeys) {
    sortedObj[key] = au[key];
  }

  const jsonStr = JSON.stringify(sortedObj);
  const md5Hash = crypto.createHash("md5").update(jsonStr).digest("hex").slice(0, 6);

  // Try to find the bsCode mapping, but for /api/stream/detail it's missing in some clients so default to bsKeys[102]
  const bsCode = FCTV_BS_CODE_MAP[pathname];
  const bsKey = (bsCode && bsKeys[bsCode]) || bsKeys[102] || bsKeys[100] || "";

  return `sfver${md5Hash}${bsKey}`;
}

// === NORTHLIVE (FREE source — no extension / no VIP) ===================
// northlive exposes ~1100 channels, each with a ready-to-embed `player_url`
// (iframe). The upstream `category` field dumps ~60% of channels in a single
// generic "IPTV" bucket, so we re-classify by channel name into usable content
// categories. Scope: France + DOM-TOM only (per product decision). The full
// list is refreshed hourly (fetchAllNorthlive) and cached to disk.
const NORTHLIVE_BASE = "https://northlive.lol/api/v1/tv";
const NORTHLIVE_API_KEY =
  process.env.SWIFTFLOW_API_KEY || process.env.NORTHLIVE_API_KEY || "";
const NORTHLIVE_REFRESH_MS = 60 * 60 * 1000; // 1h — user requested hourly refresh

// UI categories (catalog id -> label). Order = pill/catalog display order.
const NORTHLIVE_CATEGORIES = {
  northlive_sport: { name: "Sport", emoji: "⚽" },
  northlive_cinema: { name: "Cinéma", emoji: "🎬" },
  northlive_series: { name: "Séries & Films", emoji: "🎞️" },
  northlive_generaliste: { name: "Généraliste", emoji: "📺" },
  northlive_info: { name: "Info", emoji: "📰" },
  northlive_jeunesse: { name: "Jeunesse", emoji: "🧒" },
  northlive_musique: { name: "Musique", emoji: "🎵" },
  northlive_docs: { name: "Découverte & Docs", emoji: "🌍" },
  northlive_divertissement: { name: "Divertissement", emoji: "🎭" },
  northlive_regional: { name: "Régional & Local", emoji: "🏙️" },
  northlive_autres: { name: "Autres", emoji: "📦" },
};

// France métropole + DOM-TOM. The upstream `country` field uses "France",
// "France Martinique", "France GP", "France Guadeloupe", "France MQ", etc. —
// every France-family value starts with "france".
function isNorthliveFrance(country) {
  return typeof country === "string" && country.trim().toLowerCase().startsWith("france");
}

// ponytail: name-keyword classifier (heuristic). The upstream "IPTV" bucket has
// no sub-genre, so we infer it from the channel name. Tune the arrays below if a
// channel lands in the wrong tab. Checked in priority order (first hit wins).
const NORTHLIVE_KEYWORDS = [
  ["northlive_sport", ["SPORT", "BEIN", "RMC SPORT", "DAZN", "EUROSPORT", "LIGUE 1", "LIGUE1", "FOOT", "MULTISPORT", "GOLF", "EQUIDIA", "TENNIS", "KOMBAT", "MOTO GP", "MOTOGP", "ELEVEN", "INFOSPORT", "SKWEEK", "AUTOMOTO", "AUTO MOTO", "AB MOTEURS", "OL TV", "PSG", "MOTOR", "NAUTICAL"]],
  ["northlive_jeunesse", ["GULLI", "CANAL J", "CANAL+ KIDS", "PIWI", "TIJI", "DISNEY", "NICK", "CARTOON", "BOOMERANG", "BOING", "TELETOON", "MANGAS", "GAME ONE", "OKOO", "TOONAMI", "BEYBLADE", "YU-GI-OH", "BOB LEPONGE", "CAILLOU", "MR. BEAN", "KIDZ", "KIDS", "JUNIOR", "SCHTROUMPF", "SUPERTOONS", "J-ONE", "GONG", "BABY TV", "TOONS", "TV PITCHOUN", "XILAM", "BEYBLADE"]],
  ["northlive_cinema", ["CINE", "CINÉ", "CINA", "OCS", "TCM", "BOX OFFICE", "BOXOFFICE", "PARAMOUNT", "GRAND ECRAN", "ALTICE STUDIO", "ACTION", "MOVIE", "FILM", "WILDSIDE", "MOVIESPHERE", "CANAL PLAY"]],
  ["northlive_series", ["SERIE", "SÉRIE", "WARNER", "SUNDANCE", "SYFY", "BBC DRAMA", "BBC SÉRIES", "BBC SERIES", "SONY", "NOVELA", "POLAR", "CRIME", "HOMICIDE", "DRAMA", "SEASON", "DETECTIVE", "COMEDY", "ENQUÊTE", "ENQUETE", "TELENOVELA", "TELE NOVELA"]],
  ["northlive_info", ["INFO", "BFM", "CNEWS", "C NEWS", "C-NEWS", "LCI", "EURONEWS", "I24", "CGTN", "RT FRANCE", "LCP", "PUBLIC SENAT", "PUBLIC SÉNAT", "MONACO INFO", "TECH & CO", "B SMART", "BUSINESS", "LE FIGARO", "20 MINUTES", "FRANCE 24", "AFRICA 24", "FRANCOPHONIE 24", "LE MÉDIA"]],
  ["northlive_musique", ["MUSIC", "MUSIQUE", "MTV", "TRACE", "NRJ", "MCM", "MEZZO", "RFM", "MELODY", "VEVO", "SKYROCK", "DJAZZ", "STINGRAY", "ZOUK", "SALSA", "CUMBIA", "K-POP", "METAL", "JAZZ", "DANCE", "QWEST", "FOLK", "SOUL", "HITS", "TVM 3", "TVM3", "MDL", "DBM"]],
  ["northlive_docs", ["DISCOVERY", "NAT GEO", "NATIONAL GEO", "PLANETE", "PLANÈTE", "USHUAIA", "USHUAÏA", "DECOUVERTE", "DÉCOUVERTE", "HISTOIRE", "SCIENCE", "NATURE", "ANIMAUX", "CHASSE", "PECHE", "PÊCHE", "TREK", "TRAVELXP", "VOYAGE", "TOP GEAR", "INVESTIGATION", "REPORTAGE", "FUTURA", "SORCIER", "IMEARTH", "DESTINATION NATURE", "CAP TERRE", "RMC STORY", "RMC DECOUVERTE", "RMC DÉCOUVERTE", "TOUTE HISTOIRE", "TOUTE L HISTOIRE", "SEASONS", "USHUAIA"]],
  ["northlive_generaliste", ["TF1", "TF 1", "TFI", "TFX", "FRANCE 2", "FRANCE 3", "FRANCE 4", "FRANCE 5", "FRANCE O", "FRANCE Ô", "M6", "C8", "W9", "TMC", "6TER", "NRJ 12", "ARTE", "RTL", "CHERIE 25", "CHÉRIE 25", "NOVO19", "TIPIK", "LA UNE", "LA TROIS", "TV5", "PARIS PREMIERE", "PARIS PREMIÈRE", "TEVA", "RTS", "RTBF"]],
];

// Maps the upstream `category` field to a UI category (used when the name gives
// no signal — mainly the already-tagged non-"IPTV" channels).
const NORTHLIVE_CAT_MAP = {
  Musique: "northlive_musique",
  Info: "northlive_info",
  Cinéma: "northlive_cinema",
  "Séries-Films": "northlive_series",
  Jeunesse: "northlive_jeunesse",
  Généraliste: "northlive_generaliste",
  Genéraliste: "northlive_generaliste",
  Sport: "northlive_sport",
  Régional: "northlive_regional",
  Local: "northlive_regional",
  Documentaires: "northlive_docs",
  Sciences: "northlive_docs",
  Nature: "northlive_docs",
  Reportages: "northlive_docs",
  Divertissement: "northlive_divertissement",
  Culture: "northlive_divertissement",
  "Art de vivre": "northlive_divertissement",
  Sociétal: "northlive_divertissement",
  Economie: "northlive_info",
  Voyage: "northlive_docs",
};

function classifyNorthlive(name, apiCategory) {
  const upper = String(name || "").toUpperCase();
  for (const [cat, words] of NORTHLIVE_KEYWORDS) {
    if (words.some((w) => upper.includes(w))) return cat;
  }
  if (apiCategory && NORTHLIVE_CAT_MAP[apiCategory]) return NORTHLIVE_CAT_MAP[apiCategory];
  return "northlive_autres";
}

// Builds the ready-to-embed iframe URL for a channel slug (deterministic — same
// shape as the upstream `player_url`, so we never need to store it per-channel).
function northliveEmbedUrl(slug) {
  return `${NORTHLIVE_BASE}/${encodeURIComponent(slug)}/player?api_key=${NORTHLIVE_API_KEY}`;
}

// === VAVOO (FREE source — direct HLS, no extension / no proxy / no VIP) ======
// Vavoo exposes IPTV channels grouped by country/region (MediaHubMX API).
// The catalog is a POST (mediahubmx-catalog.json, paginated via `nextCursor`);
// each play URL resolves to a raw .m3u8 (mediahubmx-resolve.json) that the
// client plays as-is (_directPlay) — no proxy, no headers. Groups double as UI
// categories. Refreshed hourly, cached to disk.
//
// L'API vit désormais sur kool.to : vavoo.to renvoie 451 (« Unavailable For
// Legal Reasons ») depuis la plupart des IP, y compris derrière les proxies
// allemands où il n'est que partiellement joignable (mélange 200/451/503).
// kool.to et kool.ws répondent tous deux 200 en direct, sans proxy.
//
// L'URL de lecture envoyée au resolver est une donnée, pas une convention : le
// catalogue la fournit déjà par chaîne dans `item.url`. Ce champ est une
// étiquette, pas un lien — un GET dessus redirige vers kool.ws puis renvoie
// 404, alors que la même chaîne en payload résout parfaitement. Le resolver
// compare simplement le DOMAINE à sa liste de règles : kool.to et vavoo.to y
// figurent, kool.ws non (d'où 500 « No resolver found »), et le segment de
// chemin n'entre pas en jeu. Le préfixe n'est donc jamais reconstruit ni
// configuré : il est lu dans le catalogue, ce qui suit tout seul le prochain
// changement de domaine.
const VAVOO_BASE = process.env.VAVOO_BASE_URL || "https://kool.to";
const VAVOO_PLAY_PREFIX_CACHE_KEY = "vavoo_play_prefix_v1";
const VAVOO_PLAY_PREFIX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VAVOO_CATALOG_URL = `${VAVOO_BASE}/mediahubmx-catalog.json`;
const VAVOO_RESOLVE_URL = `${VAVOO_BASE}/mediahubmx-resolve.json`;
const VAVOO_HEADERS = {
  "User-Agent": "MediaHubMX/2",
  "Content-Type": "application/json",
  Accept: "application/json",
};

// Le pool SOCKS5 allemand ne sert plus que de repli : chaque appel part en
// direct, et ne bascule sur les proxies (avec suivi de santé dédié) que si
// l'origine bloque. Resolve ajoute l'impersonation Chrome via CycleTLS.
// Playback stays direct — the resolved m3u8 is fetched client-side (in-region).
const {
  pickVavooSocks5Proxy,
  markVavooProxyAsHealthy,
  markVavooProxyAsFailed,
  getProxyAgent,
  makeVavooBrowserRequest,
} = require("./utils/proxyManager");

const vavooMetadataService = createVavooMetadataService({
  request: (config) => axios(config),
  readCache: (key, maxAgeMs) => getFromCacheMs(generateCacheKey(key), maxAgeMs),
  writeCache: (key, value) => saveToCache(generateCacheKey(key), value),
});

async function vavooPost(url, payload, options = {}) {
  const timeout = Number(options.timeout) || 4_000;
  const requestHeaders = options.headers && typeof options.headers === "object"
    ? options.headers
    : {};
  let lastErr;

  // Chemin nominal : sans proxy. Les proxies allemands sont plus lents et
  // moins fiables que l'origine, on ne les sollicite qu'en repli.
  try {
    const resp = await axios.post(url, payload, {
      headers: { ...VAVOO_HEADERS, ...requestHeaders },
      timeout,
      proxy: false,
    });
    return resp.data;
  } catch (e) {
    lastErr = e;
  }

  for (let attempt = 0; attempt < 15; attempt++) {
    let proxy = null;
    let agent = null;
    try {
      proxy = await pickVavooSocks5Proxy();
      if (!proxy) break;
      agent = getProxyAgent(proxy);
      if (!agent) {
        markVavooProxyAsFailed(proxy);
        continue;
      }
    } catch (e) {
      lastErr = e;
      if (proxy) markVavooProxyAsFailed(proxy);
      continue;
    }
    try {
      const resp = await axios.post(url, payload, {
        headers: { ...VAVOO_HEADERS, ...requestHeaders },
        timeout,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
      });
      markVavooProxyAsHealthy(proxy);
      return resp.data;
    } catch (e) {
      lastErr = e;
      markVavooProxyAsFailed(proxy, e.response?.status);
    }
  }
  throw lastErr || new Error("[VAVOO] aucun proxy SOCKS5 disponible");
}

const VAVOO_SLUG_TO_GROUP = Object.fromEntries(
  VAVOO_GROUPS.map((g) => [vavooGroupSlug(g), g]),
);

// `item.url` vaut « https://kool.to/kool-iptv/play/<id> » : on n'en garde que
// le préfixe, l'id étant reconstruit à la résolution (les doublons de nom
// portent un suffixe `~n` côté Movix qui n'existe pas en amont).
function extractVavooPlayPrefix(items) {
  for (const item of items) {
    const url = typeof item?.url === "string" ? item.url : "";
    const id = item?.ids?.id;
    if (!id || !url.startsWith("https://") || !url.endsWith(`/${id}`)) continue;
    return url.slice(0, url.length - id.length);
  }
  return null;
}

async function rememberVavooPlayPrefix(items) {
  const prefix = extractVavooPlayPrefix(items);
  if (!prefix) return null;
  await saveToCache(generateCacheKey(VAVOO_PLAY_PREFIX_CACHE_KEY), prefix);
  return prefix;
}

// Préfixe de lecture courant, appris du catalogue. Le cache survit une semaine :
// il couvre le cas où les groupes sont servis depuis le disque, donc sans appel
// amont. À froid (cache vide, aucun catalogue encore lu — deep link juste après
// un déploiement), une page de catalogue suffit à l'apprendre.
async function getVavooPlayPrefix() {
  const cached = await getFromCacheMs(
    generateCacheKey(VAVOO_PLAY_PREFIX_CACHE_KEY),
    VAVOO_PLAY_PREFIX_TTL_MS,
  );
  if (typeof cached === "string" && cached.startsWith("https://")) return cached;

  try {
    const data = await vavooPost(VAVOO_CATALOG_URL, {
      language: "fr", region: "FR", catalogId: "iptv", id: "",
      adult: false, search: "", sort: "name",
      filter: { group: VAVOO_GROUPS[0] },
      cursor: 0,
    });
    return await rememberVavooPlayPrefix(
      Array.isArray(data?.items) ? data.items : [],
    );
  } catch (e) {
    console.warn(`[VAVOO] préfixe de lecture indisponible: ${e.message}`);
    return null;
  }
}

// Fetch one group's full channel list (paginated via nextCursor), cache 1h.
async function fetchVavooGroup(group) {
  const cacheKey = generateCacheKey(`vavoo_group_${group}_v4`);
  const disk = await getFromCache(cacheKey, 1); // 1h
  if (disk && Array.isArray(disk) && disk.length) return disk;
  const metadataIndex = await vavooMetadataService.getIndexForGroup(group);

  const channels = [];
  const seenNameId = new Set();
  const idCounts = new Map();
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    // hard cap: 50 pages guards against a broken nextCursor loop
    let data;
    try {
      const payload = {
        language: "fr", region: "FR", catalogId: "iptv", id: "",
        adult: false, search: "", sort: "name",
        filter: { group },
        cursor: cursor ? Number(cursor) : 0
      };

      data = await vavooPost(VAVOO_CATALOG_URL, payload);
    } catch (e) {
      const failureStatus = e.response?.status || e.code || "unknown";
      console.warn(
        `[VAVOO] group ${group} page ${page} failed; status=${failureStatus}`,
      );
      break;
    }

    const items = Array.isArray(data?.items) ? data.items : [];

    await rememberVavooPlayPrefix(items);

    for (const it of items) {
      const baseId = it?.ids?.id;
      if (!baseId) continue;

      const name = it.name || baseId;
      const dedupKey = `${baseId}~${name}`;

      if (seenNameId.has(dedupKey)) continue;
      seenNameId.add(dedupKey);

      const count = (idCounts.get(baseId) || 0) + 1;
      idCounts.set(baseId, count);

      const uniqueId = count === 1 ? baseId : `${baseId}~${count}`;

      const metadata = findVavooMetadata(metadataIndex, group, name);
      const nativeLogo = isHttpsArtworkUrl(it.logo) ? it.logo : null;
      const artwork = metadata?.logo || nativeLogo;
      channels.push({
        id: `vavoo_${uniqueId}`,
        type: "tv",
        name,
        poster: artwork || null,
        ...(artwork ? { logo: artwork } : {}),
        ...(metadata?.category ? { description: metadata.category } : {}),
      });
    }

    cursor = data?.nextCursor ?? null;
    if (!cursor || items.length === 0) break;
  }

  if (channels.length === 0) {
    // Upstream hiccup — keep serving the last good cache rather than blanking out.
    const stale = await getFromCache(cacheKey, 24 * 365);
    if (stale && Array.isArray(stale) && stale.length) return stale;
    return [];
  }

  await saveToCache(cacheKey, channels);
  return channels;
}

// Channels for a UI category (vavoo_<slug>).
async function getVavooChannels(catalogId) {
  const slug = catalogId.slice("vavoo_".length);
  const group = VAVOO_SLUG_TO_GROUP[slug];
  if (!group) return [];
  return fetchVavooGroup(group);
}

function buildVavooResolveHeaders(id) {
  return {
    Accept: "*/*",
    // CycleTLS ne décompresse ni brotli ni zstd : annoncer autre chose que gzip
    // ramène un corps binaire, JSON.parse échoue et le proxy est marqué en
    // panne à tort (puis mis en quarantaine 10 min).
    "Accept-Encoding": "gzip",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json; charset=utf-8",
    Origin: VAVOO_BASE,
    Pragma: "no-cache",
    Priority: "u=1, i",
    Referer: `${VAVOO_BASE}/watch?live=${id}`,
    "Sec-CH-UA": '"Not=A?Brand";v="99", "Brave";v="151", "Chromium";v="151"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-GPC": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  };
}

// Resolve a channel id to its raw .m3u8 (played client-side as-is).
// Each resolve lands on a random edge: usually https on a rotating domain,
// sometimes plain http on a bare IP — unplayable from the https site (mixed
// content). Re-resolve up to 5 times to get an https URL; if none shows up,
// return the http one as a last resort. Chaque resolve passe par CycleTLS en
// direct, et ne retombe sur le pool SOCKS5 allemand que si l'origine bloque.
async function resolveVavooStream(channelId) {
  let id = channelId.slice("vavoo_".length);
  if (id.includes("~")) {
    id = id.split("~")[0];
  }
  if (!/^[a-z0-9_-]{1,128}$/i.test(id)) return null;
  const playPrefix = await getVavooPlayPrefix();
  if (!playPrefix) return null;
  const playUrl = `${playPrefix}${id}`;
  const headers = buildVavooResolveHeaders(id);
  let httpFallback = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    let data;
    try {
      data = await makeVavooBrowserRequest(
        VAVOO_RESOLVE_URL,
        { language: "de", region: "DE", url: playUrl },
        { timeout: 4, headers },
      );
    } catch (e) {
      // CycleTLS already exhausted the dedicated German proxy candidates.
      const failureStatus = e.response?.status || e.code || "unknown";
      console.warn(`[VAVOO] resolve failed; status=${failureStatus}`);
      break;
    }
    const values = Array.isArray(data) ? data : [];
    const resolvedUrl = values[0]?.url || data?.url || data?.data?.url || null;
    if (!resolvedUrl) continue;
    if (resolvedUrl.startsWith("https://")) return resolvedUrl;
    if (!httpFallback && resolvedUrl.startsWith("http://")) {
      httpFallback = resolvedUrl;
    }
  }

  return httpFallback;
}

const STREAM_PROXY_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LIVE_PAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const CACHE_DIR = path.join(__dirname, "cache", "tvdirect");
const CACHE_EXPIRATION_HOURS = 24; // Cache expire après 24h

// Headers Stremio pour les requêtes (principalement TV Direct)
const STREMIO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Stremio/4.4.162 Chrome/114.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Origin: "https://app.strem.io",
  Referer: "https://app.strem.io/",
  "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
};

// In-memory M3U cache to avoid re-reading/re-parsing on every request
let m3uCache = null;
let m3uCacheTime = 0;
const M3U_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Parse local M3U file (cached)
 */
async function parseM3u() {
  return [];
  // Return cached data if still fresh
  if (m3uCache && Date.now() - m3uCacheTime < M3U_CACHE_TTL) {
    return m3uCache;
  }
  try {
    const content = await fsp.readFile(M3U_PATH, "utf8");
    const lines = content.split(/\r?\n/);
    const channels = [];
    let currentChannel = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("#EXTINF:")) {
        currentChannel = {};
        // Parse attributes
        const attrs = trimmed.match(/([a-zA-Z0-9-]+)="([^"]*)"/g);
        if (attrs) {
          for (const attr of attrs) {
            const [key, val] = attr.split("=");
            const value = val.replace(/"/g, "");
            if (key === "tvg-id") currentChannel.id = value;
            if (key === "tvg-name") currentChannel.name = value;
            if (key === "tvg-logo") currentChannel.logo = value;
            if (key === "tvg-poster") currentChannel.poster = value;
            if (key === "group-title") currentChannel.group = value;
            if (key === "tvg-back") currentChannel.background = value;
          }
        }

        // Name after comma
        const commaIndex = trimmed.lastIndexOf(",");
        if (commaIndex !== -1) {
          currentChannel.title = trimmed.substring(commaIndex + 1).trim();
        } else {
          currentChannel.title = currentChannel.name || "Unknown";
        }
      } else if (!trimmed.startsWith("#") && currentChannel) {
        currentChannel.stream = trimmed;
        // If no ID, generate one from title
        if (!currentChannel.id) {
          currentChannel.id = currentChannel.title.replace(/[^a-zA-Z0-9]/g, "");
        }
        channels.push(currentChannel);
        currentChannel = null; // Reset for next channel
      }
    }
    // Cache the parsed result
    m3uCache = channels;
    m3uCacheTime = Date.now();
    return channels;
  } catch (error) {
    console.error("[M3U] Error parsing france.m3u:", error.message);
    return [];
  }
}

function normalizeTvmioImageKey(value) {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.(fr|be|ch|ca|uk|us)$/g, " ")
    .replace(/\b(fr|fhd|uhd|hd|sd|4k)\b/g, " ")
    .replace(/[|_\-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchTvmioCatalogMetas(catalogId) {
  const cacheKey = generateCacheKey(`tvmio_remote_catalog_v2_${catalogId}`);
  const cached = await getFromCache(cacheKey, 24);
  if (cached) return cached;

  try {
    const categoryConfig = TVMIO_CATEGORIES[catalogId];
    if (!categoryConfig?.remoteGenre) {
      return [];
    }

    const encodedGenre = encodeURIComponent(categoryConfig.remoteGenre);
    const url = `${TVMIO_BASE_URL}/catalog/tv/tvmio-fr/genre=${encodedGenre}.json`;
    const response = await axios.get(url, {
      headers: STREMIO_HEADERS,
      timeout: 12000,
    });

    const metas = Array.isArray(response.data?.metas)
      ? response.data.metas
      : [];
    await saveToCache(cacheKey, metas);
    return metas;
  } catch (error) {
    console.warn(
      `[TVMIO] Unable to fetch remote catalog images for ${catalogId}: ${error.message}`,
    );
    return [];
  }
}

function buildTvmioImagesMap(remoteMetas) {
  const imageMap = new Map();

  for (const meta of remoteMetas) {
    const imageData = {
      poster: meta?.poster || null,
      logo: meta?.logo || null,
      background: meta?.background || null,
    };

    const normalizedId = normalizeTvmioImageKey(meta?.id);
    const normalizedName = normalizeTvmioImageKey(meta?.name);

    if (normalizedId) imageMap.set(`id:${normalizedId}`, imageData);
    if (normalizedName) imageMap.set(`name:${normalizedName}`, imageData);
  }

  return imageMap;
}

function getTvmioRemoteImages(channel, imageMap) {
  const idRaw = channel?.id || "";
  const titleRaw = channel?.title || channel?.name || "";

  const idNormalized = normalizeTvmioImageKey(idRaw);
  const idBaseNormalized = normalizeTvmioImageKey(idRaw.split(".")[0]);
  const titleNormalized = normalizeTvmioImageKey(titleRaw);

  return (
    imageMap.get(`id:${idNormalized}`) ||
    imageMap.get(`id:${idBaseNormalized}`) ||
    imageMap.get(`name:${titleNormalized}`) || {
      poster: null,
      logo: null,
      background: null,
    }
  );
}

// === UTILITAIRES DE CACHE ===

// Créer le dossier de cache s'il n'existe pas
(async () => {
  try {
    await fsp.access(CACHE_DIR);
  } catch {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    console.log("✅ Live TV cache directory created");
  }
})();

/**
 * Génère une clé de cache MD5 basée sur les paramètres
 */
function generateCacheKey(params) {
  const stringParams =
    typeof params === "string" ? params : JSON.stringify(params);
  return crypto.createHash("md5").update(stringParams).digest("hex");
}

/**
 * Récupère des données du cache avec vérification d'expiration
 */
async function getFromCache(key, expirationHours = CACHE_EXPIRATION_HOURS) {
  try {
    const cacheFilePath = path.join(CACHE_DIR, `${key}.json`);
    const stats = await fsp.stat(cacheFilePath);
    const now = Date.now();
    const fileTime = stats.mtime.getTime();
    const expirationTime = expirationHours * 60 * 60 * 1000;

    if (now - fileTime > expirationTime) {
      return null; // Cache expiré
    }

    const cacheData = JSON.parse(await fsp.readFile(cacheFilePath, "utf8"));
    return cacheData;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    console.error(`[LIVETV CACHE] Erreur lecture cache ${key}:`, error.message);
    return null;
  }
}

/**
 * Récupère des données du cache avec expiration en millisecondes
 */
async function getFromCacheMs(key, expirationMs = 30000) {
  try {
    const cacheFilePath = path.join(CACHE_DIR, `${key}.json`);
    const stats = await fsp.stat(cacheFilePath);
    const now = Date.now();
    const fileTime = stats.mtime.getTime();

    if (now - fileTime > expirationMs) {
      return null; // Cache expiré
    }

    const cacheData = JSON.parse(await fsp.readFile(cacheFilePath, "utf8"));
    return cacheData;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    console.error(`[LIVETV CACHE] Erreur lecture cache ${key}:`, error.message);
    return null;
  }
}

/**
 * Sauvegarde des données en cache
 */
async function saveToCache(key, data) {
  try {
    const cacheFilePath = path.join(CACHE_DIR, `${key}.json`);
    await fsp.writeFile(cacheFilePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (error) {
    console.error(
      `[LIVETV CACHE] Erreur sauvegarde cache ${key}:`,
      error.message,
    );
    return false;
  }
}

/**
 * Résout l'URL de lecture pour obtenir le lien m3u8 final
 * Suit les redirections et récupère le header Location
 */
async function resolvePlayUrl(playUrl) {
  try {
    const response = await axios.get(playUrl, {
      headers: STREMIO_HEADERS,
      timeout: 10000,
      maxRedirects: 0, // Ne pas suivre les redirections automatiquement
      validateStatus: (status) => status >= 200 && status < 400, // Accepter 2xx et 3xx
    });

    // Si c'est une redirection (302, 301), récupérer le header Location
    if (response.status === 302 || response.status === 301) {
      return response.headers.location || null;
    }

    // Sinon retourner l'URL originale (peut-être déjà un m3u8)
    return playUrl;
  } catch (error) {
    // Si erreur avec response (ex: 302), essayer de récupérer Location
    if (
      error.response &&
      (error.response.status === 302 || error.response.status === 301)
    ) {
      return error.response.headers.location || null;
    }
    console.error(`[LIVETV] Erreur résolution URL ${playUrl}:`, error.message);
    return null;
  }
}

function readFctvVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = buffer[cursor++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, offset: cursor };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error("Invalid protobuf varint");
    }
  }

  throw new Error("Unexpected protobuf EOF");
}

function fctvNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return value;
}

function fctvLooksText(value) {
  if (!value) return false;
  let printable = 0;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 32 && code <= 126) || code >= 160) printable++;
  }
  return printable / value.length > 0.7;
}

function decodeFctvProtoMessage(input, depth = 0) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const fields = [];
  let offset = 0;

  while (offset < buffer.length) {
    const tag = readFctvVarint(buffer, offset);
    offset = tag.offset;

    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    const entry = { field, wireType };

    if (wireType === 0) {
      const parsed = readFctvVarint(buffer, offset);
      offset = parsed.offset;
      entry.value = fctvNumber(parsed.value);
    } else if (wireType === 1) {
      entry.value = buffer.subarray(offset, offset + 8).toString("hex");
      offset += 8;
    } else if (wireType === 2) {
      const parsedLength = readFctvVarint(buffer, offset);
      offset = parsedLength.offset;
      const length = Number(parsedLength.value);
      const bytes = buffer.subarray(offset, offset + length);
      offset += length;

      const text = bytes.toString("utf8");
      if (fctvLooksText(text)) entry.value = text;

      if (depth < 6 && bytes.length > 0) {
        try {
          const children = decodeFctvProtoMessage(bytes, depth + 1);
          if (children.length > 0) entry.children = children;
        } catch {
          // Plain strings are also length-delimited; ignore decode failures.
        }
      }
    } else if (wireType === 5) {
      entry.value = buffer.subarray(offset, offset + 4).toString("hex");
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }

    fields.push(entry);
  }

  return fields;
}

function fctvFields(input) {
  return Array.isArray(input) ? input : input?.children || [];
}

function fctvFirst(input, field) {
  return fctvFields(input).find((entry) => entry.field === field);
}

function fctvAll(input, field) {
  return fctvFields(input).filter((entry) => entry.field === field);
}

function fctvValue(input, field) {
  return fctvFirst(input, field)?.value;
}

function fctvChildren(input, field) {
  return fctvFirst(input, field)?.children || [];
}

function fctvString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseFctvBody(data) {
  const root = decodeFctvProtoMessage(Buffer.from(data || []));
  return {
    status: fctvString(fctvValue(root, 3)),
    body: fctvChildren(root, 10),
  };
}

async function fetchFctvApi(pathname, params, options = {}) {
  // Build sfver prefix if bs keys are available
  const apiBase = await getFctvApiBase();
  let url = `${apiBase}${pathname}`;
  if (!options.skipSfver) {
    try {
      const bsKeys = await fetchFctvBsKeys(params?.sportType || 0);
      const sfver = buildFctvSfverPrefix(pathname, params, bsKeys);
      if (sfver) {
        url = `${apiBase}/${sfver}${pathname}`;
      }
    } catch (err) {
      console.warn(`[FCTV] sfver prefix failed, using direct path: ${err.message}`);
    }
  }

  return axios.get(url, {
    params,
    responseType: "arraybuffer",
    headers: FCTV_API_HEADERS,
    timeout: 15000,
  });
}

function parseFctvLocalizedName(fields) {
  const localizedName = fctvString(fctvValue(fctvChildren(fields, 3), 2));
  if (localizedName) return localizedName;
  return fctvString(fctvValue(fields, 2));
}

function parseFctvTeam(teamField) {
  const team = fctvChildren(teamField, 10);
  if (team.length === 0) return null;

  return {
    id: fctvNumber(fctvValue(team, 1)),
    name: parseFctvLocalizedName(team),
    logo: proxifyFctvImage(fctvString(fctvValue(team, 4))),
  };
}

function slugifyFctv(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatFctvTime(timestamp) {
  if (!timestamp) return "";
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Paris",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString();
  }
}

function buildFctvMatchPageUrl(match) {
  const leagueSlug = match.leagueSlug || "football";
  const matchSlug = match.matchSlug || slugifyFctv(match.name);
  return `${FCTV_PLAYER_BASE_URL}/fr/${match.sportKey || "football"}/${leagueSlug}-${match.matchId}/${matchSlug}.html?icg=RlI&ilang=fr`;
}

// Auto-discover the current FCTV API base. The bio-link page hubu.ru/fctvlink
// points at the live front domain (rotates: .mom / .motorcycles / …), and that
// front's /fr page embeds the API base in its Nuxt SSR payload (unicode-escaped
// `apis-data-defra<N>.<host>`). Cached; on any failure falls back to the last
// good value / hardcoded default.
const FCTV_BIOLINK_URL =
  process.env.FCTV_BIOLINK_URL || "https://hubu.ru/fctvlink";
let fctvApiBaseCache = null;
let fctvApiBaseCacheTime = 0;
const FCTV_API_BASE_TTL = 30 * 60 * 1000; // 30 min
async function getFctvApiBase() {
  if (
    fctvApiBaseCache &&
    Date.now() - fctvApiBaseCacheTime < FCTV_API_BASE_TTL
  ) {
    return fctvApiBaseCache;
  }
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  try {
    // 1) bio-link page -> current front domain (the "FCTV33" button).
    const hub = await axios.get(FCTV_BIOLINK_URL, {
      headers: { "User-Agent": ua },
      timeout: 10000,
      responseType: "text",
      transformResponse: [(d) => d],
    });
    const front = [...String(hub.data).matchAll(/<a[^>]+href="([^"]+)"/gi)]
      .map((mm) => mm[1])
      .find((h) => /fctv33hd/i.test(h));
    if (!front) throw new Error("front domain not found on bio-link page");

    // 2) front /fr -> API base embedded (unicode-escaped) in the SSR payload.
    const idx = await axios.get(front.replace(/\/+$/, "") + "/fr", {
      headers: {
        "User-Agent": ua,
        Referer: new URL(FCTV_BIOLINK_URL).origin + "/",
      },
      timeout: 10000,
      responseType: "text",
      transformResponse: [(d) => d],
    });
    const html = String(idx.data).replace(/\\u002[fF]/g, "/");
    const m = html.match(/https?:\/\/apis-data-defra\d+\.[a-z0-9.-]+/i);
    if (!m) throw new Error("API base not found on front page");
    fctvApiBaseCache = m[0].replace(/\/+$/, "");
    fctvApiBaseCacheTime = Date.now();
    console.log(`[FCTV] Auto API base: ${fctvApiBaseCache} (via ${front})`);
    return fctvApiBaseCache;
  } catch (error) {
    console.warn(`[FCTV] API base auto-fetch failed: ${error.message}`);
    // Cache the fallback so we don't hammer hubu/front for the next TTL window.
    fctvApiBaseCache = fctvApiBaseCache || FCTV_API_BASE_URL;
    fctvApiBaseCacheTime = Date.now();
    return fctvApiBaseCache;
  }
}

// Auto-discover the current player origin (used for the embed iframe AND as the
// Referer for native streams) — same way the site does, from /api/common/params
// `iframePlayerDomains`. Cached; rotates upstream.
let fctvPlayerBaseCache = null;
let fctvPlayerBaseCacheTime = 0;
const FCTV_PLAYER_BASE_TTL = 30 * 60 * 1000; // 30 min
async function getFctvPlayerBaseUrl() {
  if (fctvPlayerBaseCache && Date.now() - fctvPlayerBaseCacheTime < FCTV_PLAYER_BASE_TTL) {
    return fctvPlayerBaseCache;
  }
  try {
    const apiBase = await getFctvApiBase();
    const response = await axios.get(`${apiBase}/api/common/params`, {
      responseType: "arraybuffer",
      headers: FCTV_API_HEADERS,
      timeout: 10000,
    });
    // params is rot47'd, and iframePlayerDomains sits inside a nested (escaped)
    // JSON string — strip backslashes so the list is matchable.
    const decoded = rot47(Buffer.from(response.data).toString("utf8")).replace(/\\/g, "");
    const domains = [];
    const re = /"iframePlayerDomains"\s*:\s*\[([^\]]+)\]/g;
    let m;
    while ((m = re.exec(decoded))) {
      for (const part of m[1].split(",")) {
        const host = part.replace(/[\\"\s]/g, "");
        if (host && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) domains.push(host);
      }
    }
    if (domains.length) {
      fctvPlayerBaseCache = `https://${domains[0]}`;
      fctvPlayerBaseCacheTime = Date.now();
      console.log(`[FCTV] Auto player origin: ${fctvPlayerBaseCache} (${domains.length} candidates)`);
      return fctvPlayerBaseCache;
    }
  } catch (error) {
    console.warn(`[FCTV] Player origin auto-fetch failed: ${error.message}`);
  }
  return fctvPlayerBaseCache || FCTV_PLAYER_BASE_URL;
}

/**
 * Statut d'une rencontre, d'après le champ 4 de /api/match/live.
 *
 * Les constantes viennent du bundle amont. `MS_COMING` vaut 0, les états « en
 * cours » sont des plages par sport toutes inférieures à 10000 (`MS_FTB_LIVE`
 * 0x64, `MS_BSK_LIVE` 0xc8, `MS_TNS_LIVE` 0x12c, … `MS_OTH_LIVE` 0x2328), et
 * tout ce qui est >= 10000 est terminal :
 *
 *   MS_FINISH 0x2710  MS_CANCEL 0x2711  MS_CUT 0x2712
 *   MS_TBD 0x2775     MS_SUSPEND 0x2776 MS_POSTPONE 0x2777
 *   MS_DELETED 0x28a4
 *
 * L'ancien code lisait ce champ à l'envers (`>= 10000` traité comme « en
 * direct ») et complétait avec « a commencé il y a moins de 4 h » : une
 * rencontre finie restait donc annoncée en direct pendant des heures, alors
 * que le site amont la bascule dans son onglet « Terminé ».
 */
function classifyFctvMatchStatus(statusCode) {
  const code = Number(statusCode) || 0;
  if (code === 0) return "upcoming";
  if (code < 10000) return "live";
  if (code >= 10100 && code < 10200) return "postponed";
  return "finished";
}

function parseFctvMatch(matchField, categoryConfig, streamCountByMatchId, streamsByMatchId) {
  const fields = fctvFields(matchField);
  const matchId = fctvNumber(fctvValue(fields, 1));
  if (!matchId) return null;

  const sportType = fctvNumber(fctvValue(fields, 2)) || categoryConfig.sportType;
  const timestamp = fctvNumber(fctvValue(fields, 3)) || 0;
  const statusCode = fctvNumber(fctvValue(fields, 4));
  const league = fctvChildren(fields, 10);
  const country = fctvChildren(league, 80);
  const matchParts = fctvAll(fields, 30);
  const matchName =
    fctvString(fctvValue(fctvFields(matchParts[0]), 2)) ||
    matchParts.map(parseFctvTeam).filter(Boolean).map((team) => team.name).join(" vs ");
  const teams = matchParts.map(parseFctvTeam).filter(Boolean);
  const extra = fctvChildren(fields, 150);
  const matchSlug = fctvString(fctvValue(extra, 20)) || slugifyFctv(matchName);
  const leagueSlug = fctvString(fctvValue(extra, 21)) || slugifyFctv(parseFctvLocalizedName(league));
  const status = classifyFctvMatchStatus(statusCode);
  const isLive = status === "live";
  const serverCount = streamCountByMatchId.get(Number(matchId)) || 0;
  const matchStreams = streamsByMatchId.get(Number(matchId)) || [];
  // Le sport vient du match lui-même : dans « Tous les sports » (sportType 0)
  // la catégorie demandée ne dit rien du sport réel de chaque rencontre.
  const sport =
    FCTV_SPORT_BY_TYPE.get(Number(sportType)) ||
    (categoryConfig.sportKey === "all" ? null : categoryConfig) ||
    FCTV_SPORT_BY_TYPE.get(90);

  const parsedMatch = {
    matchId,
    sportKey: sport.key || sport.sportKey,
    name: matchName || `Match ${matchId}`,
    leagueSlug,
    matchSlug,
  };

  return {
    id: `match_fctv_${matchId}_sport_${sportType}`,
    type: "tv",
    name: parsedMatch.name,
    poster: teams[0]?.logo || teams[1]?.logo || proxifyFctvImage(fctvString(fctvValue(league, 4))) || "",
    genres: [sport.name.toLowerCase()],
    _pageUrl: buildFctvMatchPageUrl(parsedMatch),
    _timestamp: timestamp || undefined,
    _timeText: formatFctvTime(timestamp),
    _competition: parseFctvLocalizedName(league),
    _leagueLogo: proxifyFctvImage(fctvString(fctvValue(league, 4))),
    _country: parseFctvLocalizedName(country),
    _countryLogo: proxifyFctvImage(fctvString(fctvValue(country, 4))),
    _homeTeam: teams[0]?.name || "",
    _awayTeam: teams[1]?.name || "",
    _homeLogo: teams[0]?.logo || "",
    _awayLogo: teams[1]?.logo || "",
    _isLive: isLive,
    _status: status,
    _statusCode: Number(statusCode) || 0,
    _serverCount: serverCount,
    _servers: matchStreams,
    _sport: sport.name,
    _sportKey: parsedMatch.sportKey,
    _sportType: sportType,
    _emoji: sport.emoji,
  };
}

function parseFctvStreamFields(fields) {
  return {
    id: fctvNumber(fctvValue(fields, 1)),
    sportType: fctvNumber(fctvValue(fields, 2)),
    name: fctvString(fctvValue(fields, 3)),
    rawUrl: fctvString(fctvValue(fields, 4)),
    status: fctvNumber(fctvValue(fields, 5)),
    order: fctvNumber(fctvValue(fields, 8)),
    siteType: fctvNumber(fctvValue(fields, 9)) || FCTV_DEFAULT_SITE_TYPE,
    streamStatus: fctvNumber(fctvValue(fields, 11)),
    flag: fctvNumber(fctvValue(fields, 30)),
    matchId: fctvNumber(fctvValue(fields, 50)),
  };
}

function parseFctvStream(streamField) {
  return parseFctvStreamFields(fctvFields(streamField));
}

async function scrapeFctvMatches(categoryKey) {
  try {
    const categoryConfig = FCTV_MATCHES_CATEGORIES[categoryKey];
    if (!categoryConfig) {
      console.log(`[FCTV-MATCHES] Unknown category: ${categoryKey}`);
      return [];
    }

    console.log(`[FCTV-MATCHES] Fetching live matches for ${categoryKey}`);
    const response = await fetchFctvApi("/api/match/live", {
      language: FCTV_LANGUAGE_FR,
      sportType: categoryConfig.sportType,
      stream: true,
    });
    const { body } = parseFctvBody(response.data);
    const streamCountByMatchId = new Map();
    const streamsByMatchId = new Map();

    for (const streamRef of fctvAll(body, 2)) {
      try {
        const streamObj = parseFctvStreamFields(fctvFields(streamRef));
        const matchId = Number(streamObj.matchId);
        if (matchId) {
          streamCountByMatchId.set(
            matchId,
            (streamCountByMatchId.get(matchId) || 0) + 1,
          );

          if (!streamsByMatchId.has(matchId)) {
            streamsByMatchId.set(matchId, []);
          }
          streamsByMatchId.get(matchId).push({
            id: streamObj.id || Math.floor(Math.random() * 100000),
            name: streamObj.name || `Serveur ${streamObj.id || "Auto"}`,
            siteType: streamObj.siteType,
            sportType: streamObj.sportType,
          });
        }
      } catch (err) {
        console.warn("[FCTV-MATCHES] Error parsing stream ref in list:", err.message);
      }
    }

    const parsed = fctvAll(body, 1)
      .map((matchField) =>
        parseFctvMatch(matchField, categoryConfig, streamCountByMatchId, streamsByMatchId),
      )
      .filter(Boolean);

    // Le catalogue sert à regarder, pas à consulter des scores : une rencontre
    // terminée, annulée ou reportée n'a plus rien à diffuser. Le site amont les
    // range dans un onglet « Terminé » séparé ; ici on ne les liste pas.
    const matches = parsed
      .filter((match) => match._status === "live" || match._status === "upcoming")
      .sort((a, b) => {
        if (a._isLive && !b._isLive) return -1;
        if (!a._isLive && b._isLive) return 1;
        return (a._timestamp || 0) - (b._timestamp || 0);
      });

    console.log(
      `[FCTV-MATCHES] Loaded ${matches.length} matches (${parsed.length - matches.length} terminées écartées)`,
    );
    return matches;
  } catch (error) {
    console.error(`[FCTV-MATCHES] Error fetching ${categoryKey}:`, error.message);
    return [];
  }
}

/**
 * Nombre de rencontres par sport, via /api/match/count — l'endpoint que le
 * site amont utilise pour alimenter son `matchCount`.
 *
 * Réponse : une entrée répétée (champ 1) par sport, `{1: sportType, 2: total}`.
 * Protobuf n'émet pas les valeurs nulles, donc l'agrégat « tous sports »
 * (sportType 0) arrive sans champ 1, et un sport sans rencontre arrive sans
 * champ 2.
 *
 * @returns {Promise<Map<number, number>>} sportType -> nombre de rencontres
 */
async function fetchFctvMatchCounts() {
  const response = await fetchFctvApi("/api/match/count", {
    language: FCTV_LANGUAGE_FR,
    stream: true,
  });
  const { body } = parseFctvBody(response.data);

  const counts = new Map();
  for (const entry of fctvAll(body, 1)) {
    const fields = fctvFields(entry);
    const sportType = Number(fctvNumber(fctvValue(fields, 1))) || 0;
    const count = Number(fctvNumber(fctvValue(fields, 2))) || 0;
    counts.set(sportType, count);
  }
  return counts;
}

// Sports effectivement pourvus en ce moment.
//
// Le site amont affiche sa barre de navigation complète et se contente de
// badges de comptage. Ici les catalogues sont des pastilles cliquables : en
// annoncer seize dont douze vides serait pénible, donc on n'annonce que les
// sports dont le compteur est non nul.
//
// La liste ne peut pas être dérivée du catalogue « tous les sports » : ce
// dernier est plafonné en amont (une cinquantaine d'entrées alors que le seul
// football en compte plus), et des sports pourvus en sont absents.
const FCTV_AVAILABLE_SPORTS_TTL = 5 * 60 * 1000;
let fctvAvailableSportsCache = null;
let fctvAvailableSportsCacheTime = 0;

async function getFctvAvailableSportTypes() {
  if (
    fctvAvailableSportsCache &&
    Date.now() - fctvAvailableSportsCacheTime < FCTV_AVAILABLE_SPORTS_TTL
  ) {
    return fctvAvailableSportsCache;
  }

  try {
    const counts = await fetchFctvMatchCounts();
    const types = new Set(
      [...counts.entries()]
        .filter(([sportType, count]) => sportType !== 0 && count > 0)
        .map(([sportType]) => sportType),
    );

    if (types.size === 0) {
      // Réponse vide ou illisible : on préfère annoncer tous les sports
      // plutôt qu'amputer le menu.
      return fctvAvailableSportsCache;
    }

    console.log(`[FCTV-COUNT] ${types.size} sports pourvus`);
    fctvAvailableSportsCache = types;
    fctvAvailableSportsCacheTime = Date.now();
    return types;
  } catch (error) {
    console.warn(`[FCTV-COUNT] échec, menu complet annoncé: ${error.message}`);
    return fctvAvailableSportsCache;
  }
}

async function fetchFctvMatchDetail(matchId, sportType = 1) {
  const response = await fetchFctvApi("/api/match/detail", {
    language: FCTV_LANGUAGE_FR,
    matchId,
    sportType,
    stream: true,
  });
  const { body } = parseFctvBody(response.data);

  return {
    match: fctvAll(body, 1)[0] || null,
    streams: fctvAll(body, 2)
      .map(parseFctvStream)
      .filter((stream) => stream.id && stream.name),
  };
}

function rot47(value) {
  return String(value || "")
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code < 33 || code > 126) return char;
      return String.fromCharCode(33 + ((code - 33 + 47) % 94));
    })
    .join("");
}

// Decode the masked stream URL from /api/stream/detail.
// Format: <8-char per-request nonce> + rot47(originUrl); slice(8) drops the nonce.
// The resulting origin URL is referer-ACL / token gated upstream (the token is
// computed client-side by the player's service-worker), so this is only a
// best-effort "native" source — the embed player is the reliable path.
function decodeFctvStreamUrl(maskedUrl) {
  if (!maskedUrl) return null;
  try {
    const decoded = rot47(maskedUrl).slice(8);
    new URL(decoded); // validate it parsed to a real URL
    return decoded;
  } catch {
    return null;
  }
}

// token = base64( rbSession XOR keystream ) + "a", URL-encoded.
function makeFctvToken(rbSession) {
  const pt = Buffer.from(String(rbSession || ""), "utf8");
  if (!pt.length) return null;
  const n = Math.min(pt.length, FCTV_TOKEN_KEYSTREAM.length);
  const ct = Buffer.alloc(n);
  for (let i = 0; i < n; i++) ct[i] = pt[i] ^ FCTV_TOKEN_KEYSTREAM[i];
  return encodeURIComponent(`${ct.toString("base64")}a`);
}

// Resolve the upstream tokenised playlist for a single server (fresh rb-session
// + token). Cached briefly so HLS live-edge re-fetches don't hammer the API.
const fctvUpstreamCache = new Map(); // `${matchId}_${streamId}_${siteType}` -> { data, time }
const FCTV_UPSTREAM_TTL = 20 * 1000;
async function resolveFctvUpstreamPlaylist(streamId, siteType, matchId, sportType, forceFresh = false) {
  const key = `${matchId}_${streamId}_${siteType}`;
  if (forceFresh) {
    fctvUpstreamCache.delete(key);
  } else {
    const cached = fctvUpstreamCache.get(key);
    if (cached && Date.now() - cached.time < FCTV_UPSTREAM_TTL) return cached.data;
  }

  // Unsigned call with continent/country/digit => returns the `rb-session`
  // header and a masked URL that decodes to the proxy m3u8 path. No
  // `usls`/`language` and no sfver prefix here.
  const response = await fetchFctvApi(
    "/api/stream/detail",
    {
      streamId,
      siteType: siteType || FCTV_DEFAULT_SITE_TYPE,
      continent: FCTV_GEO_CONTINENT,
      country: FCTV_GEO_COUNTRY,
      digit: FCTV_STREAM_DIGIT,
      matchId,
      sportType,
    },
    { skipSfver: true },
  );

  const { body } = parseFctvBody(response.data);
  const streamBody = fctvChildren(body, 2).length ? fctvChildren(body, 2) : body;
  const detail = parseFctvStreamFields(streamBody);
  const proxyUrl = decodeFctvStreamUrl(detail.rawUrl);
  const rbSession = response.headers["rb-session"];
  if (!proxyUrl || !rbSession) return null;

  const token = makeFctvToken(rbSession);
  const u = new URL(proxyUrl);
  const data = {
    origin: u.origin,
    token,
    playlistUrl: `${u.origin}/token-${token}${u.pathname}${u.search}`,
  };
  fctvUpstreamCache.set(key, { data, time: Date.now() });
  return data;
}

function extractFctvMatchAndStreamId(channelId) {
  const match = String(channelId || "").match(/^match_(?:fctv_)?(\d+)(?:_sport_(\d+))?(?:_stream_([a-zA-Z0-9_]+))?$/);
  if (!match) return { matchId: null, sportType: 1, streamId: null };
  return {
    matchId: Number(match[1]),
    sportType: match[2] ? Number(match[2]) : 1,
    streamId: match[3] || null,
  };
}

function extractFctvMatchId(channelId) {
  const { matchId } = extractFctvMatchAndStreamId(channelId);
  return matchId;
}

/**
 * Serveur francophone ? Les noms amont sont du genre « DAZN FR », « beIN FR »,
 * « Canal+ France », « RMC Sport FR ».
 *
 * Le test porte sur un mot entier : sans cette borne, « FRee Sports » ou
 * « SportsnetFRont » passeraient, et surtout « FR » colle à trop de noms si on
 * cherche la sous-chaîne nue. Les accents sont neutralisés pour que
 * « Télé France » compte aussi.
 */
function isFctvFrenchServer(name) {
  const normalized = String(name || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  return /(?:^|[^a-z0-9])(fr|fra|france|french|francais)(?:[^a-z0-9]|$)/.test(
    normalized,
  );
}

async function resolveFctvMatchStream(channelId) {
  const { matchId, sportType } = extractFctvMatchAndStreamId(channelId);
  if (!matchId) {
    console.warn(`[FCTV-MATCHES] Invalid match id: ${channelId}`);
    return [];
  }

  const streams = [];

  // Serveurs HLS natifs (via match/detail). Chacun est lu par le endpoint
  // smart-playlist FCTV, qui résout un jeton frais et proxifie les segments
  // gardés par Referer. Pas de repli « lecteur intégré » : l'iframe amont
  // n'est plus proposée.
  try {
    const detail = await fetchFctvMatchDetail(matchId, sportType);
    const servers = detail.streams
      .filter((stream) => stream.id && stream.siteType)
      .sort((a, b) => {
        // Les serveurs francophones passent devant : c'est la langue attendue
        // par défaut, et l'ordre amont met souvent « DAZN PT » ou « ESPN BR »
        // en tête. À égalité, on garde l'ordre amont.
        const frA = isFctvFrenchServer(a.name) ? 0 : 1;
        const frB = isFctvFrenchServer(b.name) ? 0 : 1;
        if (frA !== frB) return frA - frB;

        const orderA = Number.isFinite(Number(a.order)) ? Number(a.order) : 9999;
        const orderB = Number.isFinite(Number(b.order)) ? Number(b.order) : 9999;
        return orderA - orderB;
      });

    for (const server of servers) {
      streams.push({
        id: server.id,
        title: server.name || `Serveur ${server.id}`,
        _fctvNative: {
          matchId,
          streamId: server.id,
          siteType: server.siteType || FCTV_DEFAULT_SITE_TYPE,
          sportType: server.sportType || sportType,
        },
        behaviorHints: { notWebReady: false },
      });
    }
    console.log(`[FCTV-MATCHES] match ${matchId}: ${streams.length} native servers`);
  } catch (error) {
    console.warn(`[FCTV-MATCHES] match/detail failed for ${channelId}: ${error.message}`);
  }

  return streams;
}

function buildStreamProxyHeaders(
  referer,
  fallbackOrigin,
  userAgent = STREAM_PROXY_USER_AGENT,
) {
  const safeReferer = referer || fallbackOrigin;
  let origin = fallbackOrigin;

  try {
    origin = new URL(safeReferer).origin;
  } catch {
    origin = fallbackOrigin;
  }

  const headers = {
    "User-Agent": userAgent || STREAM_PROXY_USER_AGENT,
  };

  if (safeReferer) {
    headers.Referer = safeReferer;
  }

  if (origin) {
    headers.Origin = origin;
  }

  return headers;
}

// === NORTHLIVE CHANNELS (FREE source, iframe embed) ===
// In-memory mirror of the disk cache to keep manifest/catalog requests cheap.
let northliveMemCache = { channels: [], time: 0 };

/**
 * Fetch every northlive page (France + DOM-TOM only), dedup by slug, classify by
 * content, and cache the result to disk (1h TTL). Called lazily on demand and by
 * the hourly warmer. Never overwrites a good cache with an empty result.
 */
async function fetchAllNorthlive(force = false) {
  const cacheKey = generateCacheKey("northlive_all_v1");

  if (!force) {
    if (northliveMemCache.channels.length && Date.now() - northliveMemCache.time < NORTHLIVE_REFRESH_MS) {
      return northliveMemCache.channels;
    }
    const disk = await getFromCache(cacheKey, 1); // 1h
    if (disk && Array.isArray(disk) && disk.length) {
      northliveMemCache = { channels: disk, time: Date.now() };
      return disk;
    }
  }

  const seen = new Set();
  const channels = [];
  let totalPages = 25; // refined from the first response; hard cap below as a guard

  for (let page = 1; page <= totalPages && page <= 40; page++) {
    try {
      const response = await axios.get(NORTHLIVE_BASE, {
        params: {
          api_key: NORTHLIVE_API_KEY,
          ...(page > 1 ? { page } : {}),
        },
        headers: { "User-Agent": LIVE_PAGE_USER_AGENT },
        timeout: 15000,
      });

      const data = Array.isArray(response.data?.data) ? response.data.data : [];
      const pag = response.data?.pagination;
      if (pag?.total && pag?.per_page) {
        totalPages = Math.ceil(pag.total / pag.per_page);
      }
      if (data.length === 0) break;

      for (const ch of data) {
        if (!ch?.slug || seen.has(ch.slug)) continue;
        if (ch.active === false) continue;
        if (!isNorthliveFrance(ch.country)) continue;
        seen.add(ch.slug);
        channels.push({
          id: `northlive_${ch.slug}`,
          slug: ch.slug,
          name: ch.name || ch.slug,
          cat: classifyNorthlive(ch.name, ch.category),
        });
      }
    } catch (error) {
      console.warn(`[NORTHLIVE] page ${page} error: ${error.message}`);
      break;
    }
  }

  if (channels.length === 0) {
    // Upstream hiccup — keep serving the last good cache rather than blanking out.
    const stale = await getFromCache(cacheKey, 24 * 365);
    if (stale && Array.isArray(stale) && stale.length) return stale;
    return [];
  }

  await saveToCache(cacheKey, channels);
  northliveMemCache = { channels, time: Date.now() };
  console.log(`[NORTHLIVE] Cached ${channels.length} FR channels`);
  return channels;
}

/**
 * Get northlive channels for a UI category (catalog id northlive_<cat>).
 */
async function getNorthliveChannelsByCategory(catalogId) {
  const all = await fetchAllNorthlive();
  // poster intentionally null — the UI renders northlive as name-only landscape
  // cards (logos hidden for now, per product decision; re-add ch.logo to restore).
  return all
    .filter((ch) => ch.cat === catalogId)
    .map((ch) => ({ id: ch.id, type: "tv", name: ch.name, poster: null }));
}

// === ROUTES ===

/**
 * GET /api/livetv/manifest
 * Récupère le manifest combiné (TV Direct + Matches + Northlive + Vavoo)
 */
router.get("/manifest", async (req, res) => {
  try {
    // v18 = un catalogue FCTV par sport.
    const cacheKey = generateCacheKey("manifest_combined_v18");

    // 5 min seulement : la liste des sports FCTV annoncés suit les rencontres
    // en cours, un cache de 24 h la figerait sur un créneau révolu.
    const cached = await getFromCacheMs(cacheKey, 5 * 60 * 1000);
    if (cached) {
      return res.json(cached);
    }

    // Récupérer le manifest TV Direct (catch pour ne pas bloquer si échec)
    const tvDirectRes = await axios
      .get(`${TVDIRECT_BASE_URL}/manifest.json`, {
        headers: STREMIO_HEADERS,
        timeout: 5000,
      })
      .catch((e) => ({ error: e }));

    // Manifeste de base
    const manifest = {
      id: "org.stremio.merged",
      version: "1.0.0",
      name: "Merged Live TV",
      description: "Merged TV sources (TV Direct, Matches, Northlive, Vavoo)",
      catalogs: [],
      resources: ["catalog", "meta", "stream"],
      types: ["tv"],
      idPrefixes: [],
    };

    // Fusionner TV Direct (User request: Don't use default tv-general etc.)
    // We only keep idPrefixes/resources if needed, but not catalogs
    if (tvDirectRes && !tvDirectRes.error && tvDirectRes.data) {
      const data = tvDirectRes.data;
      // if (data.catalogs) manifest.catalogs.push(...data.catalogs);
      if (data.idPrefixes) manifest.idPrefixes.push(...data.idPrefixes);
    }

    // Ajouter les catalogues Matches (FCTV) en premier dans la liste. Un
    // catalogue par sport, comme la barre de navigation du site amont, mais
    // restreint aux sports qui ont réellement des rencontres à l'instant T.
    const availableSportTypes = await getFctvAvailableSportTypes();
    const matchesCatalogs = [];
    for (const [key, config] of Object.entries(FCTV_MATCHES_CATEGORIES)) {
      if (
        config.sportType !== 0 &&
        availableSportTypes &&
        !availableSportTypes.has(config.sportType)
      ) {
        continue;
      }
      matchesCatalogs.push({
        type: "tv",
        id: key,
        name: config.name,
      });
    }
    // Prepend matches catalogs to the beginning
    manifest.catalogs = [...matchesCatalogs, ...manifest.catalogs];
    manifest.idPrefixes.push("match_");

    // NorthLive (FREE — no extension / no VIP, iframe embed). Its catalogs are
    // always advertised; loading the manifest must not depend on the upstream.
    const northliveCatalogs = Object.entries(NORTHLIVE_CATEGORIES).map(
      ([id, cfg]) => ({
        type: "tv",
        id,
        name: `${cfg.emoji} ${cfg.name}`,
        _free: true,
      }),
    );
    manifest.catalogs = [...northliveCatalogs, ...manifest.catalogs];
    manifest.idPrefixes.push("northlive_");

    // Vavoo (FREE — direct HLS, no extension/VIP). Groups are listed
    // unconditionally (no upfront fetch); an empty group simply shows no channels.
    // Prepended so the vavoo pill sits before northlive.
    try {
      const vavooCatalogs = buildVavooCatalogs(VAVOO_GROUPS);
      manifest.catalogs = [...vavooCatalogs, ...manifest.catalogs];
      manifest.idPrefixes.push("vavoo_");
    } catch (e) {
      const failureStatus = e.response?.status || e.code || "unknown";
      console.warn(`[VAVOO] manifest injection failed; status=${failureStatus}`);
    }

    // Sauvegarder en cache
    await saveToCache(cacheKey, manifest);

    res.json(manifest);
  } catch (error) {
    console.error("[LIVETV] Erreur manifest:", error.message);
    res.status(500).json({ error: "Impossible de charger le manifest" });
  }
});

/**
 * GET /api/livetv/catalog/:type/:catalogId
 * Récupère un catalogue de chaînes
 */
router.get("/catalog/:type/:catalogId", async (req, res) => {
  const { type, catalogId } = req.params;

  try {
    // v3 = étiquetage par sport réel des rencontres.
    const catalogCacheVersion = catalogId.startsWith("matches_")
      ? "v3"
      : catalogId.startsWith("vavoo_")
        ? "v7"
        : catalogId.startsWith("northlive_")
          ? "v5"
          : "v1";
    const cacheKey = generateCacheKey(
      `catalog_${type}_${catalogId}_${catalogCacheVersion}`,
    );
    const isMatchesCatalog = catalogId.startsWith("matches_");
    const isDynamicCatalog =
      isMatchesCatalog ||
      catalogId.startsWith("northlive_") ||
      catalogId.startsWith("vavoo_");

    // Vérifier le cache (1 minute pour les catalogues dynamiques, 24h sinon)
    const cached = isDynamicCatalog
      ? await getFromCacheMs(cacheKey, 60000)
      : await getFromCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    let catalog = null;

    // Déterminer la source en fonction de l'ID du catalogue
    if (catalogId.startsWith("tvmio_")) {
      // Source TVMio (Local M3U)
      console.log(`[LIVETV] Fetching TVMio (M3U) catalog: ${catalogId}`);
      const tvmioConfig = TVMIO_CATEGORIES[catalogId];

      if (tvmioConfig) {
        const allChannels = await parseM3u();
        const remoteMetas = await fetchTvmioCatalogMetas(catalogId);
        const tvmioImagesMap = buildTvmioImagesMap(remoteMetas);
        const targetGroup = tvmioConfig.genre; // e.g. "FR | General"

        // Filter by group
        let filtered = allChannels.filter((ch) => ch.group === targetGroup);

        // Deduplicate by ID (pick first one for the catalog entry)
        const unique = [];
        const seen = new Set();
        for (const ch of filtered) {
          if (!seen.has(ch.id)) {
            seen.add(ch.id);
            const remoteImages = getTvmioRemoteImages(ch, tvmioImagesMap);
            unique.push({
              id: `tvmio-${ch.id}`, // Prefix for routing
              type: "tv",
              name: ch.title,
              poster: remoteImages.poster,
              logo: remoteImages.logo,
              background: remoteImages.background,
              description: ch.group,
            });
          }
        }

        catalog = { metas: unique };
      } else {
        catalog = { metas: [] };
      }
      console.log(
        `[TVMIO] Result: ${catalog.metas ? catalog.metas.length : 0} channels`,
      );
    } else if (catalogId.startsWith("northlive_")) {
      // Northlive (FREE, iframe embed) — from the 1h-cached France channel list.
      const channels = await getNorthliveChannelsByCategory(catalogId);
      catalog = { metas: channels };
    } else if (catalogId.startsWith("vavoo_")) {
      // Vavoo (FREE, direct HLS) — country group from the 1h cache.
      const channels = await getVavooChannels(catalogId);
      catalog = { metas: channels };
    } else if (catalogId.startsWith("matches_")) {
      // Source Matches (FCTV33)
      console.log(`[LIVETV] Fetching Matches catalog: ${catalogId}`);
      const matches = await scrapeFctvMatches(catalogId);
      console.log(`[LIVETV] Matches result: ${matches.length} matches`);
      catalog = {
        metas: matches,
      };
    } else {
      // Source TV Direct (Défaut)
      const url = `${TVDIRECT_BASE_URL}/catalog/${type}/${catalogId}.json`;
      const response = await axios.get(url, {
        headers: STREMIO_HEADERS,
        timeout: 10000,
      });
      catalog = response.data;
    }

    // Sauvegarder en cache
    await saveToCache(cacheKey, catalog);

    res.json(catalog);
  } catch (error) {
    console.error(`[LIVETV] Erreur catalog ${catalogId}:`, error.message);
    res.status(500).json({ error: "Impossible de charger le catalogue" });
  }
});

/**
 * GET /api/livetv/stream/:type/:channelId
 * Récupère les flux d'une chaîne
 */
router.get("/stream/:type/:channelId", async (req, res) => {
  const { type, channelId } = req.params;
  const mode =
    String(req.query.mode || "").toLowerCase() === "sources"
      ? "sources"
      : "stream";
  const parsedSourceIndex = Number.parseInt(
    String(req.query.sourceIndex ?? ""),
    10,
  );
  const sourceIndex =
    Number.isInteger(parsedSourceIndex) && parsedSourceIndex >= 0
      ? parsedSourceIndex
      : null;

  try {
    const accessKey = req.headers["x-access-key"];

    let isVip = { vip: false };
    if (accessKey) {
      isVip = await verifyAccessKey(accessKey);
    }

    // Block VIP-only sources immediately if not VIP.
    // Matches (match_/matches_) are free: the IP-locked native stream is resolved
    // client-side by the extension/userscript (RESOLVE_FCTV), and free users without
    // it fall back to the embed player (see the match_ branch below). Only IPTV is
    // strictly VIP.
    if (channelId.startsWith("iptv_") && !isVip.vip) {
      return res.status(403).json({ error: "Réservé aux membres VIP" });
    }

    // IPTV Xtream — return proxified m3u8 URL directly
    if (channelId.startsWith("iptv_")) {
      const streamId = channelId.replace("iptv_", "");
      const directUrl = `${XTREAM_URL}/live/${XTREAM_USER}/${XTREAM_PASS}/${streamId}.m3u8`;
      const proxiedUrl = buildIptvStreamUrl(directUrl);
      return res.json({
        streams: [
          {
            url: proxiedUrl,
            title: "IPTV Stream",
            behaviorHints: { notWebReady: false },
          },
        ],
      });
    }

    // Le cache externe dure 1 h : bien trop long pour un match, dont la liste
    // de serveurs amont grossit au fil de l'événement (et peut être partielle
    // sur une réponse tronquée). Un instantané pauvre restait figé une heure
    // pour la variante concernée — d'où « le VIP ne sort qu'un serveur alors
    // que l'extension en montre six ». Les matchs ont déjà leur propre cache
    // interne de 30 s, on saute donc le cache externe pour eux.
    const skipOuterCache =
      channelId.startsWith("vavoo_") || channelId.startsWith("match_");
    const cacheKey = generateCacheKey(
      `stream_${type}_${channelId}_${mode}_${sourceIndex ?? "all"}_v6_${isVip.vip ? "vip" : "free"}`,
    );
    const streamCacheVariant = isVip.vip ? "vip" : "free";

    // Vérifier le cache (expiration plus courte pour les streams: 1h)
    const cached = skipOuterCache ? null : await getFromCache(cacheKey, 1);
    if (cached) {
      return res.json(cached);
    }

    let streamData = null;

    if (channelId.startsWith("tvmio-")) {
      // === SOURCE TVMIO (Local M3U) ===
      console.log(`[TVMIO] Getting stream for ${channelId}`);

      const targetId = channelId.replace("tvmio-", "");
      const allChannels = await parseM3u();

      // Find all entries for this ID (support multiple qualities/sources)
      const matches = allChannels.filter((ch) => ch.id === targetId);

      if (matches.length > 0) {
        console.log(
          `[TVMIO] Found ${matches.length} stream(s) for ${channelId}`,
        );

        const streams = matches.map((match, index) => {
          // Try to guess quality/label from title
          // Pattern: "FR | TF1 FHD"
          let title = match.title || `Source ${index + 1}`;
          // Simplify title if it contains common quality markers,
          // otherwise keep full title or index
          if (title.includes("FHD")) title = "FHD";
          else if (title.includes("HD") && !title.includes("UHD")) title = "HD";
          else if (title.includes("4K") || title.includes("UHD")) title = "4K";
          else if (title.includes("SD")) title = "SD";
          else if (index > 0 && title === matches[0].title)
            title = `Source ${index + 1}`;

          const originalUrl = match.stream;
          // Use proxy server to help with CORS on some players (only if VIP)
          const proxyUrl = isVip.vip
            ? buildProxyServerUrl(originalUrl)
            : originalUrl;

          return {
            title: title,
            url: proxyUrl,
            originalUrl: originalUrl,
            _isTvmio: true,
            behaviorHints: {
              notWebReady: false,
            },
          };
        });

        streamData = { streams: streams };
      } else {
        console.log(`[TVMIO] No streams found for ${channelId} in M3U`);
        streamData = { streams: [] };
      }
    } else if (channelId.startsWith("northlive_")) {
      // === SOURCE NORTHLIVE (FREE, iframe embed) ===
      // Deterministic player_url from the slug — no VIP, no proxy, no resolution.
      const slug = channelId.slice("northlive_".length);
      const embedUrl = northliveEmbedUrl(slug);
      streamData = {
        streams: [
          {
            title: "northlive",
            url: embedUrl,
            originalUrl: embedUrl,
            _isEmbed: true,
            behaviorHints: { notWebReady: false },
          },
        ],
      };
    } else if (channelId.startsWith("vavoo_")) {
      // === SOURCE VAVOO (FREE, direct HLS) ===
      // Resolve the play URL to a raw .m3u8. Returned as-is and played
      // client-side via _directPlay (no proxy, no VIP, no extension).
      // Keep resolved Vavoo streams for one minute before resolving again.
      const vavooCacheKey = generateCacheKey(`vavoo_stream_${channelId}_v1`);
      const cachedVavoo = await getFromCacheMs(vavooCacheKey, 60_000);
      if (cachedVavoo) return res.json(cachedVavoo);

      const m3u8 = await resolveVavooStream(channelId);
      if (!m3u8) {
        return res.status(404).json({ error: "Flux Vavoo introuvable" });
      }

      streamData = {
        streams: [
          {
            title: "Vavoo",
            url: m3u8,
            _directPlay: true,
            behaviorHints: { notWebReady: false },
          },
        ],
      };
      await saveToCache(vavooCacheKey, streamData);
    } else if (channelId.startsWith("match_")) {
      // === SOURCE MATCHES (FCTV33) ===
      const matchCacheKey = generateCacheKey(
        `fctv_match_stream_${channelId}_ua1_${streamCacheVariant}`,
      );

      // Check for fresh cache (30 seconds)
      const cachedMatch = await getFromCacheMs(matchCacheKey, 30000);

      if (cachedMatch) {
        console.log(`[FCTV-MATCHES] Serving cached stream for ${channelId}`);
        return res.json(cachedMatch);
      }

      // No cache or expired - fetch fresh
      console.log(`[FCTV-MATCHES] Fetching fresh stream for ${channelId}`);
      const matchStreams = await resolveFctvMatchStream(channelId);

      if (!matchStreams || matchStreams.length === 0) {
        return res.status(404).json({ error: "Flux match introuvable" });
      }

      // Public base of THIS API, so the native playlist endpoint URL is absolute.
      const publicApiBase =
        process.env.PUBLIC_API_BASE ||
        `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;

      // VIP -> server proxies the segments. Free -> "raw" mode: the browser
      // extension / userscript injects the player Referer (no proxy needed).
      const fctvNativeMode = isVip.vip ? "proxy" : "raw";
      const fctvPlayerBase = await getFctvPlayerBaseUrl();
      const fctvApiBase = await getFctvApiBase();

      // Build streams array with all FCTV servers.
      const streams = matchStreams.map((stream) => {
        if (stream._fctvNative) {
          const p = stream._fctvNative;
          // VIP: the server proxies the (IP-consistent) segments via the smart
          // playlist endpoint + PROXY_SERVER_URL.
          if (fctvNativeMode === "proxy") {
            const url =
              `${publicApiBase}/api/livetv/fctv/playlist?matchId=${encodeURIComponent(p.matchId)}` +
              `&streamId=${encodeURIComponent(p.streamId)}&siteType=${encodeURIComponent(p.siteType)}` +
              `&sportType=${encodeURIComponent(p.sportType)}&mode=proxy`;
            return {
              title: stream.title,
              url,
              originalUrl: url,
              behaviorHints: { notWebReady: false },
            };
          }
          // Free: the stream is IP-locked, so it must be resolved in the user's
          // browser by the extension/userscript (RESOLVE_FCTV). Empty url here;
          // the frontend fills it. Sans extension le stub est écarté et, le
          // repli « lecteur intégré » ayant été retiré, il ne reste aucun flux.
          return {
            title: stream.title,
            url: "",
            _fctvLocal: {
              matchId: p.matchId,
              streamId: p.streamId,
              siteType: p.siteType,
              sportType: p.sportType,
              apiBase: fctvApiBase,
            },
            _fctvReferer: `${fctvPlayerBase}/`,
            behaviorHints: { notWebReady: false },
          };
        }

        const refererBase = stream.referer || FCTV_PLAYER_BASE_URL;
        const headers = JSON.stringify(
          buildStreamProxyHeaders(
            refererBase,
            refererBase,
            stream.userAgent || STREAM_PROXY_USER_AGENT,
          ),
        );
        // FCTV native m3u8 + TS segments are Referer-gated to the player origin,
        // so they MUST be proxied (the proxy injects that Referer) for every
        // user — not just VIP. Other streams keep the VIP-only proxy behaviour.
        const mustProxy = stream.needsProxy === true;
        const proxyUrl = PROXY_SERVER_URL && (mustProxy || isVip.vip)
          ? buildProxyServerUrl(stream.url, { headers })
          : stream.url;

        return {
          title: stream.title,
          url: proxyUrl,
          originalUrl: stream.url,
          referer: stream.referer,
          userAgent: stream.userAgent || STREAM_PROXY_USER_AGENT,
          behaviorHints: {
            notWebReady: false,
          },
        };
      });

      streamData = {
        streams: streams,
        _cacheTime: Date.now(),
      };

      // Save to cache with timestamp
      await saveToCache(matchCacheKey, streamData);
    } else {
      // === SOURCE TV DIRECT ===
      const url = `${TVDIRECT_BASE_URL}/stream/${type}/${channelId}.json`;
      const response = await axios.get(url, {
        headers: STREMIO_HEADERS,
        timeout: 10000,
      });
      streamData = response.data;

      if (streamData.streams) {
        // Résoudre les URLs (spécifique TV Direct)
        const resolvedStreams = await Promise.all(
          streamData.streams.map(async (stream) => {
            if (stream.url) {
              const resolvedUrl = await resolvePlayUrl(stream.url);
              return {
                ...stream,
                url: resolvedUrl || stream.url,
                originalUrl: stream.url,
              };
            }
            return stream;
          }),
        );
        streamData.streams = resolvedStreams.filter((s) => {
          // Filter out invalid streams
          if (!s.url) return false;

          // Filter out ALL FamilyRestream sources (User Request: "non fonctionnel")
          if (
            s.url.includes("familyrestream.com") ||
            (s.originalUrl && s.originalUrl.includes("familyrestream.com"))
          ) {
            return false;
          }

          return true;
        });
      }
    }

    if (
      mode !== "sources" &&
      (!streamData.streams || streamData.streams.length === 0)
    ) {
      return res.status(404).json({ error: "Aucun flux disponible" });
    }

    // Sauvegarder en cache
    if (!skipOuterCache) {
      await saveToCache(cacheKey, streamData);
    }

    res.json(streamData);
  } catch (error) {
    console.error(`[LIVETV] Erreur stream ${channelId}:`, error.message);
    res.status(500).json({ error: "Impossible de charger les flux" });
  }
});

/**
 * GET /api/livetv/fctv/playlist?matchId=&streamId=&siteType=&sportType=
 * FCTV native HLS smart-playlist. Resolves a fresh token, fetches the upstream
 * tokenised m3u8, and rewrites every segment to the playlist host + path-token
 * form (handles cdnSmartLink absolute/&token segments), routed through
 * PROXY_SERVER_URL so the player-origin Referer is injected. This is what makes
 * the Referer-gated v3b streams playable natively in HLSPlayer.
 */
router.get("/fctv/playlist", async (req, res) => {
  const matchId = req.query.matchId;
  const streamId = req.query.streamId;
  const siteType = req.query.siteType || FCTV_DEFAULT_SITE_TYPE;
  const sportType = req.query.sportType || 1;
  // proxy = segments via PROXY_SERVER_URL (VIP). raw = bare CDN urls; the
  // browser extension / userscript injects the player Referer (free users).
  const mode = req.query.mode === "raw" ? "raw" : "proxy";
  if (!matchId || !streamId) {
    return res.status(400).send("missing matchId/streamId");
  }

  try {
    const playerBase = await getFctvPlayerBaseUrl();
    const upstreamHeaders = {
      "User-Agent": STREAM_PROXY_USER_AGENT,
      Accept: "*/*",
      Origin: playerBase,
      Referer: `${playerBase}/`,
    };
    const fetchPlaylist = (data) =>
      axios.get(data.playlistUrl, {
        responseType: "text",
        headers: upstreamHeaders,
        timeout: 15000,
        validateStatus: () => true,
      });
    const ok = (r) =>
      r && r.status === 200 && typeof r.data === "string" && r.data.includes("#EXTM3U");

    // First try the (briefly cached) token; if the upstream rejects it (token
    // expired), re-resolve a fresh token and retry once.
    let resolved = await resolveFctvUpstreamPlaylist(streamId, siteType, matchId, sportType);
    let pr = resolved ? await fetchPlaylist(resolved) : null;
    if (!ok(pr)) {
      resolved = await resolveFctvUpstreamPlaylist(streamId, siteType, matchId, sportType, true);
      pr = resolved ? await fetchPlaylist(resolved) : null;
    }
    if (!resolved || !ok(pr)) {
      console.warn(`[FCTV-PLAYLIST] upstream ${pr ? pr.status : "no-resolve"} for match ${matchId} stream ${streamId}`);
      return res.status(502).send("upstream playlist failed");
    }

    // NOTE: the segment CDN's Referer ACL requires the TRAILING SLASH
    // (`https://host/` returns 200, `https://host` returns 403).
    const segProxyHeaders = JSON.stringify(
      buildStreamProxyHeaders(`${playerBase}/`, playerBase, STREAM_PROXY_USER_AGENT),
    );

    const rewritten = pr.data
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        let abs;
        try {
          abs = new URL(trimmed, resolved.playlistUrl);
        } catch {
          return line;
        }
        // Normalise to: <playlist origin>/token-<T>/<path-after-host>?<query−token>
        abs.searchParams.delete("token");
        const path = abs.pathname.replace(/^\/token-[^/]+/, "");
        const norm = `${resolved.origin}/token-${resolved.token}${path}${abs.search}`;
        // raw mode (free + extension/userscript): bare CDN url; the extension
        // injects the player Referer on the request -> no proxy needed.
        if (mode === "raw") return norm;
        // Chaque segment porte sa propre signature : la playlist est du texte,
        // elle ne passe pas par `attachSignedProxyUrls`.
        return buildProxyServerUrl(norm, { headers: segProxyHeaders });
      })
      .join("\n");

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-store");
    return res.send(rewritten);
  } catch (error) {
    console.error(`[FCTV-PLAYLIST] error match ${matchId} stream ${streamId}:`, error.message);
    return res.status(502).send("fctv playlist error");
  }
});

/**
 * GET /api/livetv/resolve/:playId
 * Résout une URL de lecture spécifique (TV Direct)
 */
router.get("/resolve/:playId", async (req, res) => {
  const { playId } = req.params;

  try {
    const playUrl = `${TVDIRECT_BASE_URL}/play/${playId}`;
    const resolvedUrl = await resolvePlayUrl(playUrl);

    if (!resolvedUrl) {
      return res.status(404).json({ error: "Impossible de résoudre l'URL" });
    }

    res.json({
      originalUrl: playUrl,
      resolvedUrl: resolvedUrl,
    });
  } catch (error) {
    console.error(`[LIVETV] Erreur resolve ${playId}:`, error.message);
    res.status(500).json({ error: "Erreur lors de la résolution" });
  }
});

/**
 * DELETE /api/livetv/cache
 * Nettoie le cache Live TV (admin only)
 */
router.delete("/cache", async (req, res) => {
  try {
    const files = await fsp.readdir(CACHE_DIR);
    let deletedCount = 0;

    for (const file of files) {
      if (file.endsWith(".json")) {
        await fsp.unlink(path.join(CACHE_DIR, file));
        deletedCount++;
      }
    }

    res.json({
      success: true,
      message: `Cache Live TV nettoyé: ${deletedCount} fichiers supprimés`,
    });
  } catch (error) {
    console.error("[LIVETV] Erreur nettoyage cache:", error.message);
    res.status(500).json({ error: "Erreur lors du nettoyage du cache" });
  }
});

// === IPTV WEB (Xtream API) — VIP ONLY ===
const XTREAM_URL = (process.env.XTREAM_URL || "").replace(/\/+$/, "");
const XTREAM_USER = process.env.XTREAM_USER || "";
const XTREAM_PASS = process.env.XTREAM_PASS || "";
const IPTV_STREAM_PROXY = (
  process.env.IPTV_STREAM_PROXY || "http://localhost:25569/proxy"
).replace(/\/+$/, "");

/**
 * URL IPTV proxifiée et signée.
 *
 * La forme est `.../proxy/<url amont>` : proxiesembed tente d'abord son décodage
 * XOR, échoue, puis retombe sur l'URL brute. On signe donc la route `/proxy`
 * avec l'URL amont comme cible, exactement ce que le handler reconstruit.
 */
function buildIptvStreamUrl(directUrl) {
  const proxiedUrl = `${IPTV_STREAM_PROXY}/${directUrl}`;
  if (!signingConfigured()) {
    console.error("[IPTV] MEDIA_SIGNING_SECRET absent — URL de flux non signée");
    return proxiedUrl;
  }
  return appendSignature(proxiedUrl, "/proxy", directUrl);
}

// Cache catégories IPTV en mémoire (change rarement)
let iptvCategoriesCache = null;
let iptvCategoriesCacheTime = 0;
const IPTV_CATEGORIES_TTL = 30 * 60 * 1000; // 30 min

// Auto-clear IPTV cache after TTL to free memory when not actively used
setInterval(() => {
  if (
    iptvCategoriesCache &&
    Date.now() - iptvCategoriesCacheTime > IPTV_CATEGORIES_TTL
  ) {
    iptvCategoriesCache = null;
  }
}, IPTV_CATEGORIES_TTL).unref();

/**
 * GET /api/livetv/iptv/categories
 * Récupère les catégories live de l'API Xtream (VIP only)
 */
router.get("/iptv/categories", requireVip, async (req, res) => {
  try {
    const now = Date.now();
    if (
      iptvCategoriesCache &&
      now - iptvCategoriesCacheTime < IPTV_CATEGORIES_TTL
    ) {
      return res.json(iptvCategoriesCache);
    }

    const response = await axios.get(`${XTREAM_URL}/player_api.php`, {
      params: {
        username: XTREAM_USER,
        password: XTREAM_PASS,
        action: "get_live_categories",
      },
      timeout: 15000,
    });

    const categories = (response.data || []).map((cat) => ({
      category_id: cat.category_id,
      category_name: cat.category_name,
      parent_id: cat.parent_id || 0,
    }));

    iptvCategoriesCache = { categories };
    iptvCategoriesCacheTime = now;

    res.json({ categories });
  } catch (error) {
    console.error("[IPTV] Erreur get_live_categories:", error.message);
    res
      .status(500)
      .json({ error: "Erreur lors de la récupération des catégories IPTV" });
  }
});

/**
 * GET /api/livetv/iptv/streams/:categoryId
 * Récupère les chaînes d'une catégorie Xtream (VIP only)
 * Pas de logos: le proxy d'images a été retiré (SSRF).
 */
router.get("/iptv/streams/:categoryId", requireVip, async (req, res) => {
  const { categoryId } = req.params;

  try {
    const response = await axios.get(`${XTREAM_URL}/player_api.php`, {
      params: {
        username: XTREAM_USER,
        password: XTREAM_PASS,
        action: "get_live_streams",
        category_id: categoryId,
      },
      timeout: 15000,
    });

    const streams = (response.data || []).map((stream) => ({
      stream_id: stream.stream_id,
      name: stream.name,
      stream_icon: null,
      epg_channel_id: stream.epg_channel_id || null,
      category_id: stream.category_id,
    }));

    res.json({ streams });
  } catch (error) {
    console.error(
      `[IPTV] Erreur get_live_streams cat=${categoryId}:`,
      error.message,
    );
    res
      .status(500)
      .json({ error: "Erreur lors de la récupération des chaînes IPTV" });
  }
});

/**
 * GET /api/livetv/iptv/stream-url/:streamId
 * Construit l'URL m3u8 proxifiée pour un stream Xtream (VIP only)
 */
router.get("/iptv/stream-url/:streamId", requireVip, async (req, res) => {
  const { streamId } = req.params;

  try {
    const directUrl = `${XTREAM_URL}/live/${XTREAM_USER}/${XTREAM_PASS}/${streamId}.m3u8`;
    const proxiedUrl = buildIptvStreamUrl(directUrl);

    res.json({
      streams: [
        {
          url: proxiedUrl,
          title: "IPTV Stream",
          behaviorHints: { notWebReady: false },
        },
      ],
    });
  } catch (error) {
    console.error(`[IPTV] Erreur stream-url ${streamId}:`, error.message);
    res.status(500).json({ error: "Erreur lors de la construction de l'URL" });
  }
});

// Warm the northlive channel cache at boot and refresh it hourly (user request:
// "récupère toutes les pages toutes les heures et mets en cache"). Failures are
// swallowed — the lazy fetch in the manifest/catalog routes is the fallback.
fetchAllNorthlive(true).catch((e) =>
  console.warn(`[NORTHLIVE] initial warm failed: ${e.message}`),
);
setInterval(() => {
  fetchAllNorthlive(true).catch((e) =>
    console.warn(`[NORTHLIVE] hourly refresh failed: ${e.message}`),
  );
}, NORTHLIVE_REFRESH_MS).unref();

module.exports = router;
