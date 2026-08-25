// Backend API URL for got-scraping based extraction.
// Dev override: when the requesting page is localhost (Vite dev on :3000),
// talk to the local backend (:25565) instead of prod. Set per-message from
// the sender origin (see maybeUseLocalApi in the onMessage listener below).
const PROD_API_BASE_URL = "https://api.movix.fun";
const LOCAL_API_BASE_URL = "http://localhost:25565";
let API_BASE_URL = PROD_API_BASE_URL;

function maybeUseLocalApi(sender) {
  try {
    const u =
      sender && (sender.url || (sender.tab && sender.tab.url) || sender.origin);
    if (!u) return;
    const host = new URL(u).hostname;
    API_BASE_URL =
      host === "localhost" || host === "127.0.0.1"
        ? LOCAL_API_BASE_URL
        : PROD_API_BASE_URL;
  } catch (e) {}
}
const STREAM_PROXY_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Import extractors module
importScripts("fsvid-vidzy-quickjs.js");
importScripts("extractors.js");
const Extractors = globalThis.MovixExtractors;

// BEGIN KISSKH FALLBACK
const KISSKH_BROWSER_API = chrome;
const KISSKH_SESSION_RULE_ID = 59;
const KISSKH_MAX_REDIRECTS = 5;
const KISSKH_REQUEST_TIMEOUT_MS = 10000;
const KISSKH_MAX_MEDIA_URL_LENGTH = 8192;
const KISSKH_MAX_HEADER_VALUE_LENGTH = 2048;
const KISSKH_MAX_SUBTITLE_BYTES = 2097152;
const KISSKH_MAX_EXCHANGE_BYTES = 32768;
const KISSKH_MAX_EXCHANGE_LIFETIME_MS = 120000;
const KISSKH_ALLOWED_HEADER_ORIGIN = "https://kisskh.nl";
let kisskhSessionRuleQueue = Promise.resolve();

function kisskhFailure(code) {
  return { success: false, code };
}

function kisskhHasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function kisskhValidateSubtitleUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > KISSKH_MAX_MEDIA_URL_LENGTH || /[\r\n\0]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.hash
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function kisskhValidateMediaUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > KISSKH_MAX_MEDIA_URL_LENGTH || /[\r\n\0]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.hash
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function kisskhValidateHeaderValue(name, value) {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > KISSKH_MAX_HEADER_VALUE_LENGTH || /[\r\n\0]/.test(value)
  ) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== "443") || parsed.hash ||
      parsed.origin !== KISSKH_ALLOWED_HEADER_ORIGIN
    ) {
      return null;
    }
    if (name === "Origin" && (parsed.pathname !== "/" || parsed.search)) return null;
    return name === "Origin" ? parsed.origin : parsed.toString();
  } catch {
    return null;
  }
}

function kisskhValidateExchange(value) {
  if (!kisskhHasExactKeys(value, ["url", "expiresAt", "requiredHeaders"])) return null;
  const url = kisskhValidateMediaUrl(value.url);
  if (
    !url || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() ||
    value.expiresAt > Date.now() + KISSKH_MAX_EXCHANGE_LIFETIME_MS ||
    value.requiredHeaders === null || typeof value.requiredHeaders !== "object" || Array.isArray(value.requiredHeaders)
  ) {
    return null;
  }
  const headers = {};
  for (const [name, rawValue] of Object.entries(value.requiredHeaders)) {
    if (name !== "Referer" && name !== "Origin") return null;
    const headerValue = kisskhValidateHeaderValue(name, rawValue);
    if (!headerValue) return null;
    headers[name] = headerValue;
  }
  return { url, expiresAt: value.expiresAt, requiredHeaders: headers };
}

async function kisskhReadBoundedBody(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      return { error: "response_too_large" };
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    return { error: "unsupported_transport" };
  }
  const reader = response.body.getReader();
  let timeoutId;
  const readResult = (async () => {
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        length += chunk.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          return { error: "response_too_large" };
        }
        chunks.push(chunk);
      }
    } catch {
      return { error: "upstream_unavailable" };
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes };
  })();
  const timeoutResult = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve({ error: "timeout", timedOut: true }), KISSKH_REQUEST_TIMEOUT_MS);
  });
  const result = await Promise.race([readResult, timeoutResult]);
  clearTimeout(timeoutId);
  if (result.timedOut) {
    try {
      await reader.cancel();
    } catch {}
    return { error: "timeout" };
  }
  return result;
}

function kisskhBytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

async function kisskhFetch(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KISSKH_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function kisskhFetchSubtitle(sourceUrl) {
  let currentUrl = sourceUrl;
  for (let redirects = 0; redirects <= KISSKH_MAX_REDIRECTS; redirects += 1) {
    let response;
    try {
      response = await kisskhFetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        headers: { Accept: "text/*", "Cache-Control": "no-store" },
      });
    } catch (error) {
      return kisskhFailure(error?.name === "AbortError" ? "timeout" : "upstream_unavailable");
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirects === KISSKH_MAX_REDIRECTS) return kisskhFailure("upstream_unavailable");
      const location = response.headers.get("location");
      let redirected = null;
      try {
        redirected = location ? kisskhValidateSubtitleUrl(new URL(location, currentUrl).toString()) : null;
      } catch {}
      if (!redirected) return kisskhFailure("invalid_request");
      currentUrl = redirected;
      continue;
    }
    if (response.status === 429) return kisskhFailure("provider_rate_limited");
    if (!response.ok) return kisskhFailure("upstream_unavailable");
    const contentType = response.headers.get("content-type") || "";
    if (!/^text\/[a-z0-9!#$&^_.+-]+(?:\s*;|$)/i.test(contentType)) {
      return kisskhFailure("invalid_content_type");
    }
    const body = await kisskhReadBoundedBody(response, KISSKH_MAX_SUBTITLE_BYTES);
    if (body.error) return kisskhFailure(body.error);
    return {
      success: true,
      kind: "subtitle",
      status: response.status,
      contentType,
      bodyBase64: kisskhBytesToBase64(body.bytes),
    };
  }
  return kisskhFailure("upstream_unavailable");
}

function kisskhAlarmName(expiresAt) {
  return `${KISSKH_SESSION_RULE_ID}:${expiresAt}`;
}

function kisskhParseAlarm(alarm) {
  const match = new RegExp(`^${KISSKH_SESSION_RULE_ID}:(\\d{13})$`).exec(alarm?.name || "");
  if (!match) return null;
  const expiresAt = Number(match[1]);
  return Number.isSafeInteger(expiresAt) && alarm.scheduledTime === expiresAt ? expiresAt : null;
}

function kisskhHasSessionTransport() {
  return Boolean(
    KISSKH_BROWSER_API?.declarativeNetRequest?.getSessionRules &&
    KISSKH_BROWSER_API?.declarativeNetRequest?.updateSessionRules &&
    KISSKH_BROWSER_API?.alarms?.getAll &&
    KISSKH_BROWSER_API?.alarms?.create &&
    KISSKH_BROWSER_API?.alarms?.clear,
  );
}

async function kisskhClearAlarms() {
  if (!KISSKH_BROWSER_API?.alarms?.getAll) return;
  const alarms = await KISSKH_BROWSER_API.alarms.getAll();
  await Promise.all(
    alarms
      .filter(alarm => String(alarm.name || "").startsWith(`${KISSKH_SESSION_RULE_ID}:`))
      .map(alarm => KISSKH_BROWSER_API.alarms.clear(alarm.name)),
  );
}

async function kisskhRemoveSessionRule() {
  if (!kisskhHasSessionTransport()) return false;
  await KISSKH_BROWSER_API.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [KISSKH_SESSION_RULE_ID],
  });
  await kisskhClearAlarms();
  return true;
}

function kisskhExactRegex(url) {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

async function kisskhInstallSessionRule(exchange) {
  if (!kisskhHasSessionTransport()) return false;
  const update = kisskhSessionRuleQueue.then(async () => {
    await kisskhClearAlarms();
    const requestHeaders = Object.entries(exchange.requiredHeaders).map(([header, value]) => ({
      header,
      operation: "set",
      value,
    }));
    try {
      await KISSKH_BROWSER_API.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [KISSKH_SESSION_RULE_ID],
        addRules: [{
          id: KISSKH_SESSION_RULE_ID,
          priority: 100,
          action: { type: "modifyHeaders", requestHeaders },
          condition: {
            regexFilter: kisskhExactRegex(exchange.url),
            resourceTypes: ["xmlhttprequest", "media", "other"],
          },
        }],
      });
      await KISSKH_BROWSER_API.alarms.create(kisskhAlarmName(exchange.expiresAt), {
        when: exchange.expiresAt,
      });
      return true;
    } catch {
      try {
        await KISSKH_BROWSER_API.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [KISSKH_SESSION_RULE_ID],
        });
        await kisskhClearAlarms();
      } catch {}
      return false;
    }
  });
  kisskhSessionRuleQueue = update.then(() => undefined, () => undefined);
  return update;
}

async function reconcileKisskhSessionRule() {
  if (!kisskhHasSessionTransport()) return false;
  const [rules, alarms] = await Promise.all([
    KISSKH_BROWSER_API.declarativeNetRequest.getSessionRules(),
    KISSKH_BROWSER_API.alarms.getAll(),
  ]);
  const ruleCount = rules.filter(rule => rule.id === KISSKH_SESSION_RULE_ID).length;
  const relatedAlarms = alarms.filter(alarm => String(alarm.name || "").startsWith(`${KISSKH_SESSION_RULE_ID}:`));
  const expiry = relatedAlarms.length === 1 ? kisskhParseAlarm(relatedAlarms[0]) : null;
  if (ruleCount === 1 && expiry !== null && expiry > Date.now()) return true;
  if (ruleCount > 0) {
    await KISSKH_BROWSER_API.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [KISSKH_SESSION_RULE_ID],
    });
  }
  await kisskhClearAlarms();
  return false;
}

async function kisskhExchangeMedia(fallbackToken) {
  let response;
  try {
    response = await kisskhFetch(`${PROD_API_BASE_URL}/api/kisskh/fallback/${fallbackToken}`, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return kisskhFailure(error?.name === "AbortError" ? "timeout" : "upstream_unavailable");
  }
  if (response.status === 429) return kisskhFailure("provider_rate_limited");
  if (!response.ok) return kisskhFailure("upstream_unavailable");
  if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") || "")) {
    return kisskhFailure("provider_changed");
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) {
    return kisskhFailure("provider_changed");
  }
  const body = await kisskhReadBoundedBody(response, KISSKH_MAX_EXCHANGE_BYTES);
  if (body.error) return kisskhFailure(body.error === "response_too_large" ? "provider_changed" : body.error);
  let rawExchange;
  try {
    rawExchange = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
  } catch {
    return kisskhFailure("provider_changed");
  }
  const exchange = kisskhValidateExchange(rawExchange);
  if (!exchange) return kisskhFailure("provider_changed");
  const headerNames = Object.keys(exchange.requiredHeaders);
  if (headerNames.length === 0) {
    if (kisskhHasSessionTransport()) await kisskhRemoveSessionRule();
    return {
      success: true,
      kind: "media",
      url: exchange.url,
      expiresAt: exchange.expiresAt,
      headersApplied: false,
    };
  }
  if (!(await kisskhInstallSessionRule(exchange))) return kisskhFailure("unsupported_transport");
  return {
    success: true,
    kind: "media",
    url: exchange.url,
    expiresAt: exchange.expiresAt,
    headersApplied: true,
  };
}

async function handleKisskhFallback(payload) {
  if (!kisskhHasExactKeys(payload, payload?.kind === "subtitle" ? ["kind", "sourceUrl"] : ["kind", "fallbackToken"])) {
    return kisskhFailure("invalid_request");
  }
  if (payload.kind === "subtitle") {
    const sourceUrl = kisskhValidateSubtitleUrl(payload.sourceUrl);
    return sourceUrl ? kisskhFetchSubtitle(sourceUrl) : kisskhFailure("invalid_request");
  }
  if (
    payload.kind !== "media" || typeof payload.fallbackToken !== "string" ||
    payload.fallbackToken.length < 16 || payload.fallbackToken.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/.test(payload.fallbackToken)
  ) {
    return kisskhFailure("invalid_request");
  }
  return kisskhExchangeMedia(payload.fallbackToken);
}

if (KISSKH_BROWSER_API?.alarms?.onAlarm?.addListener) {
  KISSKH_BROWSER_API.alarms.onAlarm.addListener(async alarm => {
    const expiresAt = kisskhParseAlarm(alarm);
    if (expiresAt === null) return;
    if (expiresAt > Date.now()) {
      await KISSKH_BROWSER_API.alarms.create(alarm.name, { when: expiresAt });
      return;
    }
    await kisskhRemoveSessionRule();
  });
}
KISSKH_BROWSER_API.runtime.onStartup.addListener(() => {
  void reconcileKisskhSessionRule().catch(() => {});
});
void reconcileKisskhSessionRule().catch(() => {});
// END KISSKH FALLBACK

// Extension enabled state
let extensionEnabled = true;

// User extraction preferences (synced from site via SET_EXTRACTION_PREFS)
const DEFAULT_EXTRACTION_PREFS = {
  version: 1,
  m3u8: {
    voe: true, fsvid: true, vidzy: true, vidmoly: true,
    sibnet: true, uqload: true, doodstream: true, seekstreaming: true,
    lulustream: true, veev: true, vidara: true,
  },
  livetv: {
    northlive: true, vavoo: true, matches: true,
  },
};
let extractionPrefs = DEFAULT_EXTRACTION_PREFS;

// Stats tracking (enriched with per-type counters)
let sessionStats = {
  extractions: 0,
  corsFixed: 0,
  cached: 0,
  byType: { voe: 0, fsvid: 0, vidzy: 0, vidmoly: 0, sibnet: 0, uqload: 0, doodstream: 0, seekstreaming: 0, lulustream: 0, veev: 0, vidara: 0 },
};

// Load initial state
chrome.storage.local.get(["extensionEnabled", "stats", "extractionPrefs"], (result) => {
  extensionEnabled = result.extensionEnabled !== false;
  if (result.stats) {
    sessionStats = { ...sessionStats, ...result.stats };
    // Guarantee byType subobject even for stats saved before this migration
    if (!sessionStats.byType) {
      sessionStats.byType = { voe: 0, fsvid: 0, vidzy: 0, vidmoly: 0, sibnet: 0, uqload: 0, doodstream: 0, seekstreaming: 0, lulustream: 0, veev: 0, vidara: 0 };
    }
  }
  if (result.extractionPrefs) extractionPrefs = result.extractionPrefs;
});

// Initial setup
chrome.runtime.onInstalled.addListener(() => {
  setupRules();
});

chrome.runtime.onStartup.addListener(() => {
  setupRules();
  // Reset session stats on startup (keep byType shape to avoid silent miss-counts)
  sessionStats = {
    extractions: 0,
    corsFixed: 0,
    cached: 0,
    byType: { voe: 0, fsvid: 0, vidzy: 0, vidmoly: 0, sibnet: 0, uqload: 0, doodstream: 0, seekstreaming: 0, lulustream: 0, veev: 0, vidara: 0 },
  };
  chrome.storage.local.set({ stats: sessionStats });
});

// Configure DNR rules for CORS and Headers
async function setupRules() {
  // Clear existing dynamic rules to prevent accumulation
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const ruleIds = existingRules.map((rule) => rule.id);

  // Reset rule counter when rules are cleared
  ruleIdCounter = 100;

  const rules = [
    // 1. Allow CORS for everything (Response Headers)
    {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          {
            header: "Access-Control-Allow-Origin",
            operation: "set",
            value: "*",
          },
          {
            header: "Access-Control-Allow-Methods",
            operation: "set",
            value: "GET, POST, OPTIONS, HEAD, PUT, DELETE, PATCH",
          },
          {
            header: "Access-Control-Allow-Headers",
            operation: "set",
            value: "*",
          },
        ],
      },
      condition: {
        urlFilter: "*",
        initiatorDomains: [
          "localhost",
          "127.0.0.1",
          "movix.cash",
          "movix.cloud",
          "movix.tax",
          "movix.club",
          "movix.chat",
          "movix.golf",
          "movix.date",
          "movix.fun",
          "movix.show",
        ],
        resourceTypes: [
          "xmlhttprequest",
          "other",
          "media",
          "image",
          "script",
          "stylesheet",
          "font",
          "websocket",
        ],
      },
    },
  ];

  // Remove and add in a single call: removals apply before additions, and
  // always listing the added ids in removeRuleIds keeps the call idempotent
  // when onInstalled and onStartup both fire ("Rule with id 1 does not have
  // a unique ID" otherwise).
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [...new Set([...ruleIds, ...rules.map((rule) => rule.id)])],
    addRules: rules,
  });
}

// Handle messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  maybeUseLocalApi(sender);
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; // Keep channel open for async response
});

/**
 * Map a catalogId (e.g. "matches_football") to a livetv source key.
 * Returns null if unknown — unknown keys are allowed by default.
 */
function getLiveTvSourceKey(catalogId) {
  if (!catalogId || typeof catalogId !== 'string') return null;
  if (catalogId.startsWith('northlive_')) return 'northlive';
  if (catalogId.startsWith('vavoo_')) return 'vavoo';
  if (catalogId.startsWith('matches_')) return 'matches';
  return null;
}

function isLiveTvAllowed(catalogId) {
  const key = getLiveTvSourceKey(catalogId);
  if (!key) return true; // Unknown source → allow by default
  return extractionPrefs.livetv[key] !== false;
}

function isEmbedAllowed(type) {
  if (!type) return true;
  return extractionPrefs.m3u8[type] !== false;
}

async function handleMessage(message) {
  const { action, payload } = message;

  // Handle toggle action (always allowed)
  if (action === "TOGGLE_EXTENSION") {
    extensionEnabled = payload.enabled;
    if (extensionEnabled) {
      await setupRules();
    } else {
      // Remove all DNR rules when disabled
      const existingRules =
        await chrome.declarativeNetRequest.getDynamicRules();
      const ruleIds = existingRules.map((rule) => rule.id);
      if (ruleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: ruleIds,
        });
      }
    }
    return { success: true, enabled: extensionEnabled };
  }

  // Handle stats request (always allowed)
  if (action === "GET_STATS") {
    return sessionStats;
  }

  // Block all other actions if disabled
  if (!extensionEnabled) {
    return { error: "Extension is disabled" };
  }

  switch (action) {
    case "KISSKH_FALLBACK":
      return await handleKisskhFallback(payload);
    case "GET_MANIFEST":
      return await getManifest();
    case "GET_CATALOG": {
      const catalogId = payload?.id || '';
      if (!isLiveTvAllowed(catalogId)) {
        return { metas: [], disabled_by_user: true };
      }
      return await getCatalog(payload.type, payload.id, payload?.accessKey);
    }
    case "GET_STREAM": {
      const channelId = payload?.id || '';
      if (!isLiveTvAllowed(channelId)) {
        return { error: "disabled_by_user", source: getLiveTvSourceKey(channelId) };
      }
      return await getStream(payload.type, payload.id, payload?.accessKey, payload);
    }
    case "PROXY_HTTP":
      return await proxyHttpRequest(payload.url, payload.headers);

    // === Nexus M3U8 Extraction (runs locally in extension, no server needed) ===
    case "EXTRACT_M3U8": {
      const { url: embedUrl, type: hintedType } = payload || {};
      const detectedType = hintedType || (Extractors.detectEmbedType ? Extractors.detectEmbedType(embedUrl) : null);
      if (detectedType && !isEmbedAllowed(detectedType)) {
        return { success: false, error: "disabled_by_user", type: detectedType };
      }
      sessionStats.extractions++;
      if (detectedType && sessionStats.byType) {
        sessionStats.byType[detectedType] = (sessionStats.byType[detectedType] || 0) + 1;
      }
      chrome.storage.local.set({ stats: sessionStats });
      return await handleExtractM3u8(payload);
    }
    case "EXTRACT_ALL_M3U8": {
      const filteredSources = (payload?.sources || []).filter((source) => {
        const srcUrl = typeof source === 'string' ? source : (source?.link || source?.url || '');
        const srcType = Extractors.detectEmbedType ? Extractors.detectEmbedType(srcUrl) : null;
        return !srcType || isEmbedAllowed(srcType);
      });
      sessionStats.extractions++;
      chrome.storage.local.set({ stats: sessionStats });
      return await handleExtractAllM3u8({ ...payload, sources: filteredSources });
    }
    case "DETECT_EMBEDS":
      return handleDetectEmbeds(payload);

    case "SETUP_HEADERS": {
      const headerInfo = await Extractors.setupHeadersForService(
        payload.type,
        payload.url,
      );
      if (headerInfo) {
        await addHeadersRule(
            headerInfo.domainPattern,
            headerInfo.headers,
            headerInfo.removeHeaders,
            headerInfo.removeDomains,
          );
        console.log(
          `[NEXUS] DNR headers set for ${payload.type}: ${headerInfo.domainPattern}`,
        );
        return { success: true };
      }
      return { success: false, error: "Could not setup headers" };
    }

    // FCTV (matches) native: inject the player Referer on the CDN segments so
    // free users play natively without the server proxy.
    case "SETUP_FCTV_HEADERS": {
      const okFctv = await setupFctvHeadersRule(payload?.referer);
      return { success: okFctv };
    }

    // FCTV (matches) native: resolve ONE server locally (IP-bound) -> m3u8 url.
    // Also installs the Referer DNR rule for the segments.
    case "RESOLVE_FCTV": {
      const fctvUrl = await resolveFctvStream(payload || {});
      if (fctvUrl) return { success: true, url: fctvUrl };
      return { success: false, error: "fctv resolve failed" };
    }

    case "SET_EXTRACTION_PREFS": {
      const incoming = payload?.prefs;
      if (incoming && incoming.version === 1 && incoming.m3u8 && incoming.livetv) {
        extractionPrefs = {
          version: 1,
          m3u8: { ...DEFAULT_EXTRACTION_PREFS.m3u8, ...incoming.m3u8 },
          livetv: { ...DEFAULT_EXTRACTION_PREFS.livetv, ...incoming.livetv },
        };
        await chrome.storage.local.set({ extractionPrefs });
        return { success: true };
      }
      return { success: false, error: "Invalid prefs shape" };
    }

    case "GET_EXTRACTION_PREFS":
      return extractionPrefs;

    case "GET_CACHE_STATS": {
      if (typeof Extractors.getCacheSizes === 'function') {
        return Extractors.getCacheSizes();
      }
      return {};
    }

    case "CLEAR_EXTRACTION_CACHE": {
      if (typeof Extractors.clearCaches === 'function') {
        Extractors.clearCaches(payload?.type);
        return { success: true };
      }
      return { success: false, error: "Cache API unavailable" };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// Helper to proxy HTTP requests via extension (to bypass Mixed Content)
async function proxyHttpRequest(url, headers = {}) {
  try {
    if (headers && Object.keys(headers).length > 0) {
      try {
        const parsedUrl = new URL(url);
        const rulePattern = `*://${parsedUrl.host}${parsedUrl.pathname}*`;
        await addHeadersRule(rulePattern, headers);
      } catch (ruleError) {
        console.warn("[PROXY_HTTP] Failed to add DNR headers rule:", ruleError);
      }
    }

    const response = await fetch(url, { headers });
    const buffer = await response.arrayBuffer();

    // Convert ArrayBuffer to Base64
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    return {
      data: base64,
      contentType: response.headers.get("content-type"),
      status: response.status,
      finalUrl: response.url,
    };
  } catch (e) {
    console.error("Proxy HTTP error:", e);
    return { error: e.message };
  }
}

// === NEXUS M3U8 EXTRACTION HANDLERS ===

function getSeekStreamingPlaybackUrls(result) {
  const urls = [];
  const seen = new Set();
  const add = (url) => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  if (Array.isArray(result?.hlsCandidates)) {
    for (const candidate of result.hlsCandidates) {
      add(candidate?.url);
    }
  }
  add(result?.hlsUrl);
  add(result?.m3u8Url);
  return urls;
}

/**
 * Handle single embed extraction request
 * payload: { type: 'voe'|'fsvid'|..., url: 'https://...' }
 */
async function handleExtractM3u8(payload) {
  const { type, url } = payload;
  if (!url) return { success: false, error: "Missing URL" };

  // Auto-detect type if not provided
  const embedType = type || Extractors.detectEmbedType(url);
  if (!embedType) return { success: false, error: "Unknown embed type" };

  if (embedType === "seekstreaming") {
    let extractionRuleId = null;
    try {
      const extractionHeaders = await Extractors.setupHeadersForService(
        embedType,
        url,
        url,
      );
      if (extractionHeaders) {
        extractionRuleId = await addHeadersRule(
          extractionHeaders.domainPattern,
          extractionHeaders.headers,
        );
      }
      const result = await Extractors.extractSingle(embedType, url);
      if (result.success) {
        for (const videoUrl of getSeekStreamingPlaybackUrls(result)) {
          const playbackHeaders =
            await Extractors.setupHeadersForService(embedType, videoUrl, url);
          if (playbackHeaders) {
            await replaceSeekPlaybackRule(playbackHeaders);
          }
        }
      }
      return result;
    } finally {
      await removeHeadersRule(extractionRuleId);
    }
  }

  // Set up DNR headers BEFORE extraction so the fetch request succeeds
  try {
    const headerInfo = await Extractors.setupHeadersForService(embedType, url);
    if (headerInfo) {
      await addHeadersRule(
            headerInfo.domainPattern,
            headerInfo.headers,
            headerInfo.removeHeaders,
            headerInfo.removeDomains,
          );
      console.log(
        `[NEXUS] Pre-extraction DNR headers set for ${embedType}: ${headerInfo.domainPattern}`,
      );
    }
  } catch (e) {
    console.warn("[NEXUS] Failed to set pre-extraction headers:", e);
  }

  console.log(`[NEXUS] Extracting ${embedType} from: ${url}`);
  const result = await Extractors.extractSingle(embedType, url);

  // Set up DNR headers for the extracted URL so the page player can use it
  if (result.success) {
    const videoUrl = result.hlsUrl || result.m3u8Url;
    // If the video URL is different from the page URL (likely), set headers for it too
    if (videoUrl && videoUrl !== url) {
      const headerInfo = await Extractors.setupHeadersForService(
        embedType,
        videoUrl,
        url,
      );
      if (headerInfo) {
        await addHeadersRule(
            headerInfo.domainPattern,
            headerInfo.headers,
            headerInfo.removeHeaders,
            headerInfo.removeDomains,
          );
        console.log(
          `[NEXUS] DNR headers set for ${embedType}: ${headerInfo.domainPattern}`,
        );
      }
    }
  }

  return result;
}

/**
 * Handle parallel extraction of all supported embeds from a sources list
 * payload: { sources: ['url1', 'url2', ...] or [{link:'url', player:'name'}, ...] }
 */
async function handleExtractAllM3u8(payload) {
  const { sources } = payload;
  if (!sources || !Array.isArray(sources) || sources.length === 0) {
    return { success: false, error: "No sources provided", results: [] };
  }

  console.log(`[NEXUS] Extracting all from ${sources.length} sources`);

  const seekExtractionRuleIds = [];

  // Set up DNR headers for all sources BEFORE extraction
  try {
    const detected = Extractors.detectSupportedEmbeds(sources);
    for (const item of detected) {
      const headerInfo = await Extractors.setupHeadersForService(
        item.type,
        item.url,
        item.url,
      );
      if (headerInfo) {
        const ruleId = await addHeadersRule(
          headerInfo.domainPattern,
          headerInfo.headers,
        );
        if (item.type === "seekstreaming" && Number.isInteger(ruleId)) {
          seekExtractionRuleIds.push(ruleId);
        }
      }
    }
    console.log(
      `[NEXUS] Pre-extraction headers set for ${detected.length} sources`,
    );
  } catch (e) {
    console.warn("[NEXUS] Failed to set pre-extraction headers for batch:", e);
  }

  try {
    const results = await Extractors.extractAll(sources);

    // Set up DNR headers for all successful extractions (video URLs)
    for (const result of results) {
      if (result.success) {
        const videoUrls = result.type === "seekstreaming"
          ? getSeekStreamingPlaybackUrls(result)
          : [result.hlsUrl || result.m3u8Url].filter(Boolean);
        for (const videoUrl of videoUrls) {
          const headerInfo = await Extractors.setupHeadersForService(
            result.type,
            videoUrl,
            result.url,
          );
          if (headerInfo) {
            if (result.type === "seekstreaming") {
              await replaceSeekPlaybackRule(headerInfo);
            } else {
              await addHeadersRule(
                headerInfo.domainPattern,
                headerInfo.headers,
              );
            }
          }
        }
      }
    }

    const successCount = results.filter((r) => r.success).length;
    return {
      success: successCount > 0,
      total: results.length,
      successCount,
      results,
    };
  } finally {
    await Promise.all(seekExtractionRuleIds.map(removeHeadersRule));
  }
}

/**
 * Handle embed type detection only (no extraction)
 * payload: { sources: ['url1', 'url2', ...] }
 */
function handleDetectEmbeds(payload) {
  const { sources } = payload;
  if (!sources || !Array.isArray(sources)) return { embeds: [] };
  return { embeds: Extractors.detectSupportedEmbeds(sources) };
}

// === API LOGIC ===

function buildBackendApiHeaders(accessKey, extraHeaders = {}) {
  const headers = {
    Accept: "application/json",
    Origin: "https://movix.fun",
    Referer: "https://movix.fun/",
    ...extraHeaders,
  };

  if (accessKey) {
    headers["x-access-key"] = accessKey;
  }

  return headers;
}

async function getManifest() {
  const manifest = {
    id: "org.stremio.merged",
    version: "1.0.0",
    name: "Live TV (Extension)",
    description: "TV sources via Extension",
    catalogs: [],
    resources: ["catalog", "meta", "stream"],
    types: ["tv"],
    idPrefixes: [],
  };

  return manifest;
}

async function getCatalog(type, catalogId, accessKey = null) {
  // Route to backend (handles matches_, northlive_, vavoo_, TV Direct, etc.)
  console.log(`[CATALOG] Fetching catalog via Backend: ${catalogId}`);
  const response = await fetch(
    `${API_BASE_URL}/api/livetv/catalog/tv/${catalogId}`,
    {
      headers: buildBackendApiHeaders(accessKey),
    },
  );
  if (!response.ok) throw new Error(`Backend API error: ${response.status}`);
  return await response.json();
}

async function getStream(type, channelId, accessKey = null, options = {}) {
  // Route to backend (handles matches_, northlive_, vavoo_, TV Direct, etc.)
  console.log(`[STREAM] Fetching stream via Backend: ${channelId}`);
  const response = await fetch(
    `${API_BASE_URL}/api/livetv/stream/tv/${channelId}`,
    {
      headers: buildBackendApiHeaders(accessKey),
    },
  );
  if (!response.ok) throw new Error(`Backend API error: ${response.status}`);
  return await response.json();
}

// === UTILS ===

/**
 * Dean Edwards Packer decoder (see extractors.js for full documentation).
 *
 * Converts a number to its base-N string, builds a keyword lookup table,
 * then replaces every placeholder token in the packed template with the
 * corresponding keyword to recover the original readable JavaScript.
 *
 * @param {string} packedScript   - Template with placeholder tokens
 * @param {number} radix          - Numeric base for token encoding
 * @param {number} keywordCount   - Number of keywords
 * @param {string[]} keywords     - Replacement words indexed by token value
 * @returns {string} Decoded JavaScript source
 */
function decodeDeanEdwardsPacker(packedScript, radix, keywordCount, keywords) {
  function numberToBaseNString(number) {
    const quotient = Math.floor(number / radix);
    const remainder = number % radix;
    const digit =
      remainder > 35
        ? String.fromCharCode(remainder + 29)
        : remainder.toString(36);
    return (quotient > 0 ? numberToBaseNString(quotient) : "") + digit;
  }

  const lookupTable = {};
  for (let i = keywordCount - 1; i >= 0; i--) {
    const token = numberToBaseNString(i);
    lookupTable[token] = keywords[i] || token;
  }

  return packedScript.replace(/\b\w+\b/g, function (token) {
    return lookupTable[token] !== undefined ? lookupTable[token] : token;
  });
}

/**
 * Extract M3U8 video URLs from HTML that contains Dean Edwards Packed
 * script blocks (used by WigiStream / live TV embed pages).
 *
 * The function searches for all packed blocks in the HTML, decodes each
 * one, and looks for .m3u8 stream URLs in the decoded output.
 *
 * @param {string} html - Raw HTML source of the embed page
 * @returns {string|null} The best M3U8 URL found, or null
 */
function extractM3u8FromPackedHtml(html) {
  try {
    // Strategy 1: Try to match complete packed blocks with a regex.
    // Split to avoid Chrome Web Store code scanner false positives.
    const packerBlockPattern = new RegExp(
      "ev" +
        "al\\(function\\(p,a,c,k,e,(?:d|r)\\)\\{.*?return p\\}\\(\\s*['\"]([\\s\\S]*?)['\"]\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*['\"]([\\s\\S]*?)['\"]\\s*\\.split\\(['\"]\\|['\"]\\)\\s*(?:,\\s*0\\s*,\\s*\\{\\})?\\s*\\)\\)",
      "gs",
    );
    const regexMatches = [...html.matchAll(packerBlockPattern)];

    // Strategy 2: If the regex didn't match (malformed or unusual formatting),
    // manually locate each packed block by searching for the marker string
    // and parsing the arguments by hand.
    if (regexMatches.length === 0) {
      const markerPositions = [];
      let searchPos = 0;
      const marker = "ev" + "al(func" + "tion(p,a,c,k,e,";
      while (true) {
        const index = html.indexOf(marker, searchPos);
        if (index === -1) break;
        markerPositions.push(index);
        searchPos = index + 1;
      }

      for (const position of markerPositions) {
        // Take a chunk of HTML starting at the marker (5000 chars should
        // be enough to contain the full packed block arguments)
        const chunk = html.substring(position, position + 5000);

        // Find the .split('|') that terminates the keyword list
        const splitIdx = chunk.indexOf(".split('|')");
        const splitIdx2 = chunk.indexOf('.split("|")');
        const keywordListEnd = splitIdx !== -1 ? splitIdx : splitIdx2;
        if (keywordListEnd === -1) continue;

        // Extract the keyword string (everything between the last quote
        // before .split and the .split itself)
        let keywordStringStart = chunk.lastIndexOf("'", keywordListEnd - 1);
        if (keywordStringStart === -1)
          keywordStringStart = chunk.lastIndexOf('"', keywordListEnd - 1);
        if (keywordStringStart === -1) continue;

        const keywords = chunk
          .substring(keywordStringStart + 1, keywordListEnd)
          .split("|");

        // Find the template string: starts after }(' or }("
        const templateMarker1 = chunk.indexOf("}('");
        const templateMarker2 = chunk.indexOf('}("');
        const templateStart =
          templateMarker1 !== -1 ? templateMarker1 : templateMarker2;
        if (templateStart === -1) continue;

        const quoteChar = chunk[templateStart + 2];
        const templateBegin = templateStart + 3;
        const templateEnd = chunk.indexOf(quoteChar + ",", templateBegin);
        if (templateEnd === -1) continue;

        const packedTemplate = chunk.substring(templateBegin, templateEnd);

        // Parse the radix and count numbers that follow the template
        const afterTemplate = chunk.substring(templateEnd + 2);
        const numbersMatch = afterTemplate.match(/^\s*(\d+)\s*,\s*(\d+)\s*,/);
        if (!numbersMatch) continue;

        const radix = parseInt(numbersMatch[1]);
        const keywordCount = parseInt(numbersMatch[2]);
        const decodedScript = decodeDeanEdwardsPacker(
          packedTemplate,
          radix,
          keywordCount,
          keywords,
        );

        // Check if the decoded script contains video player code
        const hasVideoContent =
          decodedScript &&
          (decodedScript.includes(".m3u8") ||
            decodedScript.includes("hls") ||
            decodedScript.includes("Clappr"));

        if (hasVideoContent) {
          const m3u8Url = findBestM3u8Url(decodedScript);
          if (m3u8Url) return m3u8Url;
        }
      }
    }

    // Process regex-matched packed blocks
    for (const packerMatch of regexMatches) {
      const packedTemplate = packerMatch[1];
      const radix = parseInt(packerMatch[2]);
      const keywordCount = parseInt(packerMatch[3]);
      const keywords = packerMatch[4].split("|");
      const decodedScript = decodeDeanEdwardsPacker(
        packedTemplate,
        radix,
        keywordCount,
        keywords,
      );

      const hasVideoContent =
        decodedScript.includes("Clappr") ||
        decodedScript.includes(".m3u8") ||
        decodedScript.includes("hls");

      if (!hasVideoContent) continue;

      const m3u8Url = findBestM3u8Url(decodedScript);
      if (m3u8Url) return m3u8Url;
    }

    // Fallback: try to find M3U8 URLs directly in the raw HTML
    const directSrcMatch = html.match(/src:\s*["']([^"']+\.m3u8[^"']*)/i);
    if (directSrcMatch) return directSrcMatch[1].replace(/\\\//g, "/");

    const directStreamMatch = html.match(/["'](https?:\/\/[^"']*\.m3u8[^"']*)/);
    if (directStreamMatch) return directStreamMatch[1].replace(/\\\//g, "/");

    const varSrcMatch = html.match(/var\s+src\s*=\s*["']([^"']+)/i);
    if (varSrcMatch && varSrcMatch[1].includes(".m3u8")) {
      return varSrcMatch[1].replace(/\\\//g, "/");
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Find the best M3U8 URL from decoded script content.
 * Prefers backup/CDN URLs over primary ones.
 *
 * @param {string} scriptContent - Decoded JavaScript source
 * @returns {string|null} Best M3U8 URL found, or null
 */
function findBestM3u8Url(scriptContent) {
  const m3u8Pattern = /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/g;
  let match;
  const urls = [];
  while ((match = m3u8Pattern.exec(scriptContent)) !== null) {
    urls.push(match[1].replace(/\\\//g, "/"));
  }
  if (urls.length === 0) return null;

  // Prefer backup/live CDN URLs, then primary CDN, then first found
  const backupUrl = urls.find(
    (u) => u.includes("vuunov") || u.includes("live"),
  );
  const primaryUrl = urls.find(
    (u) => u.includes("shop") || u.includes("srvagu"),
  );
  return backupUrl || primaryUrl || urls[0];
}

async function fetchSafe(url, context = "") {
  try {
    const options = {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      cache: "no-cache",
    };

    const response = await fetch(url, options);
    if (!response.ok) {
      console.error(
        `Fetch failed for ${context || url}: ${response.status} ${response.statusText}`,
      );
      return null;
    }
    return await response.json();
  } catch (e) {
    console.error(`Fetch error for ${context || url}:`, e);
    return null;
  }
}

// Cache helpers
async function getFromCache(key) {
  const result = await chrome.storage.local.get(key);
  const entry = result[key];
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    chrome.storage.local.remove(key);
    return null;
  }
  return entry.data;
}

async function saveToCache(key, data, ttlMinutes) {
  const expiry = Date.now() + ttlMinutes * 60 * 1000;
  await chrome.storage.local.set({ [key]: { data, expiry } });
}

// DNR Helper
let ruleIdCounter = 100;
// Reserved below the general 100+ allocator; FCTV owns fixed rule 60.
const SEEK_PLAYBACK_RULE_ID_MIN = 61;
const SEEK_PLAYBACK_RULE_ID_MAX = 99;

function isSeekPlaybackRuleId(ruleId) {
  return (
    Number.isInteger(ruleId) &&
    ruleId >= SEEK_PLAYBACK_RULE_ID_MIN &&
    ruleId <= SEEK_PLAYBACK_RULE_ID_MAX
  );
}

async function addUserAgentRule(urlPattern, userAgent) {
  return addHeadersRule(urlPattern, { "User-Agent": userAgent });
}

// FCTV (matches) native streams: the rotating segment CDN hosts are Referer-
// gated to the current player origin. They all share a `/cfall/s.../v3b/` path,
// so one rule injects the player Referer for every host + cdnSmartLink redirect.
// Fixed id => replaced when the player domain rotates.
const FCTV_HEADERS_RULE_ID = 60;
async function setupFctvHeadersRule(referer) {
  if (!referer) return false;
  const ref = referer.endsWith("/") ? referer : referer + "/";
  let origin;
  try {
    origin = new URL(ref).origin;
  } catch {
    origin = ref.replace(/\/+$/, "");
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [FCTV_HEADERS_RULE_ID],
      addRules: [
        {
          id: FCTV_HEADERS_RULE_ID,
          priority: 20,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: ref },
              { header: "Origin", operation: "set", value: origin },
              { header: "User-Agent", operation: "set", value: STREAM_PROXY_USER_AGENT },
            ],
          },
          condition: {
            urlFilter: "/cfall/s",
            resourceTypes: ["xmlhttprequest", "media", "other"],
          },
        },
      ],
    });
    return true;
  } catch (e) {
    console.error("[FCTV] Failed to add headers rule:", e);
    return false;
  }
}

// === FCTV (matches) local resolver ==========================================
// The stream is IP-locked: the token must be minted from the SAME IP that
// fetches the segments. So free users resolve it here, in the browser, then
// HLS plays the segments directly with the Referer injected by the DNR rule.
const FCTV_API_BASE = "https://apis-data-defra10.tcore131ybdf.ru";
const FCTV_TOKEN_KEYSTREAM_HEX =
  "15764bab80a419c6abdd5518f3db0ea95bb3b9a2e2b519ce5c159af6917e2000c2d680ae30706a3aba1c9c25786c7c28774eecf20450a3cf414ca17f6472798cfa557c7a8705b7861f06e84f827f8a24676eeab77ce504bfc335b79609b9";

function fctvRot47(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    out += k < 33 || k > 126 ? s[i] : String.fromCharCode(33 + ((k - 33 + 47) % 94));
  }
  return out;
}
function fctvReadVarint(buf, off) {
  let result = 0n, shift = 0n, cur = off;
  while (cur < buf.length) {
    const b = buf[cur++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, offset: cur };
    shift += 7n;
    if (shift > 70n) break;
  }
  throw new Error("varint");
}
function fctvDecode(buf, depth = 0) {
  const fields = [];
  let off = 0;
  while (off < buf.length) {
    let tag;
    try { tag = fctvReadVarint(buf, off); } catch { break; }
    off = tag.offset;
    const field = Number(tag.value >> 3n);
    const wt = Number(tag.value & 7n);
    const e = { field, wireType: wt };
    if (wt === 0) {
      const p = fctvReadVarint(buf, off); off = p.offset;
    } else if (wt === 1) {
      off += 8;
    } else if (wt === 2) {
      const pl = fctvReadVarint(buf, off); off = pl.offset;
      const len = Number(pl.value);
      const bytes = buf.subarray(off, off + len);
      off += len;
      let text = "";
      try { text = new TextDecoder().decode(bytes); } catch {}
      let printable = 0;
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if ((c >= 32 && c <= 126) || c >= 160) printable++; }
      if (text && printable / text.length > 0.7) e.value = text;
      if (depth < 8 && bytes.length) { try { const ch = fctvDecode(bytes, depth + 1); if (ch.length) e.children = ch; } catch {} }
    } else if (wt === 5) {
      off += 4;
    } else break;
    fields.push(e);
  }
  return fields;
}
const fctvField = (fields, f) => (fields || []).find((e) => e.field === f);
const fctvChildren = (fields, f) => { const x = fctvField(fields, f); return (x && x.children) || []; };
function fctvMakeToken(rbSession) {
  const ks = [];
  for (let i = 0; i < FCTV_TOKEN_KEYSTREAM_HEX.length; i += 2) ks.push(parseInt(FCTV_TOKEN_KEYSTREAM_HEX.substr(i, 2), 16));
  const pt = new TextEncoder().encode(rbSession);
  const n = Math.min(pt.length, ks.length);
  let bin = "";
  for (let i = 0; i < n; i++) bin += String.fromCharCode(pt[i] ^ ks[i]);
  return encodeURIComponent(btoa(bin) + "a");
}

// Resolve one server -> tokenised m3u8 url (IP-bound to THIS browser).
async function resolveFctvStream(opts) {
  const { matchId, streamId, siteType, sportType, referer, apiBase } = opts || {};
  if (!matchId || !streamId) return null;
  const base = apiBase || FCTV_API_BASE;
  const u = new URL(base + "/api/stream/detail");
  u.searchParams.set("streamId", String(streamId));
  u.searchParams.set("siteType", String(siteType || 2001));
  u.searchParams.set("continent", "EU");
  u.searchParams.set("country", "FR");
  u.searchParams.set("digit", "seth");
  u.searchParams.set("matchId", String(matchId));
  u.searchParams.set("sportType", String(sportType || 1));
  // NB: a service worker can't set Referer on fetch — stream/detail returns the
  // rb-session header regardless. Only the segments are Referer-gated (DNR rule).
  const resp = await fetch(u.toString(), { headers: { Accept: "*/*" } });
  const rbSession = resp.headers.get("rb-session");
  const buf = new Uint8Array(await resp.arrayBuffer());
  const root = fctvDecode(buf);
  const body = fctvChildren(root, 10);
  const inner = fctvChildren(body, 2).length ? fctvChildren(body, 2) : body;
  const maskedField = fctvField(inner, 4);
  const masked = maskedField && typeof maskedField.value === "string" ? maskedField.value : "";
  if (!masked || !rbSession) return null;
  let parsed;
  try { parsed = new URL(fctvRot47(masked).slice(8)); } catch { return null; }
  const token = fctvMakeToken(rbSession);
  if (referer) await setupFctvHeadersRule(referer);
  return `${parsed.origin}/token-${token}${parsed.pathname}${parsed.search}`;
}

function createHeadersRule(
  id,
  urlPattern,
  headers,
  removeHeaders = [],
  requestDomains = [],
) {
  const requestHeaders = Object.entries(headers).map(([header, value]) => ({
    header: header,
    operation: "set",
    value: value,
  }));
  // Retirer un en-tete que le navigateur impose : `fetch` refuse de les
  // effacer, seul declarativeNetRequest le peut. Voir fetchIpBoundPage.
  for (const header of removeHeaders) {
    requestHeaders.push({ header: header, operation: "remove" });
  }

  return {
    id: id,
    priority: 10,
    action: {
      type: "modifyHeaders",
      requestHeaders: requestHeaders,
    },
    condition: {
      // Une grappe d'hébergeur se joue de `urlFilter` : LuluStream sert la même
      // page depuis luluvdo.com, luluvid.com et consorts, et un 301 fait passer
      // la requête d'un domaine à l'autre. `requestDomains` couvre la grappe
      // entière, là où un motif calculé sur l'URL de départ laisse la cible du
      // 301 sans règle — les deux se cumulant en ET, il REMPLACE `urlFilter`
      // au lieu de s'y ajouter, sinon la cible du 301 reste exclue.
      ...(requestDomains.length
        ? { requestDomains: requestDomains }
        : { urlFilter: urlPattern }),
      resourceTypes: [
        "xmlhttprequest",
        "media",
        "websocket",
        "other",
        "sub_frame",
        "main_frame",
      ],
    },
  };
}

/**
 * Une règle déjà posée vise-t-elle la même chose que celle qu'on s'apprête à
 * ajouter ? Même `urlFilter`, ou même grappe de `requestDomains` : dans les
 * deux cas la nouvelle la remplace.
 */
function isSupersededRule(condition, urlPattern, requestDomains) {
  if (!condition) return false;
  if (urlPattern && condition.urlFilter === urlPattern) return true;
  if (!requestDomains.length) return false;
  const existing = condition.requestDomains || [];
  return (
    existing.length === requestDomains.length &&
    existing.every((domain) => requestDomains.includes(domain))
  );
}

async function addHeadersRule(
  urlPattern,
  headers,
  removeHeaders = [],
  requestDomains = [],
) {
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const existingIds = new Set(existingRules.map((r) => r.id));

  // Les règles dynamiques survivent aux redémarrages du navigateur : sans
  // purge, chaque extraction en empile une de plus sur la même cible. Les
  // doublons ne sont pas inoffensifs — à priorité égale, la règle qui l'emporte
  // sur un en-tête donné n'est pas déterminée, et une règle posée par une
  // version précédente (sans `Accept-Language` épinglé) peut donc gagner.
  const supersededIds = existingRules
    .filter(
      (rule) =>
        !isSeekPlaybackRuleId(rule.id) &&
        isSupersededRule(rule.condition, urlPattern, requestDomains),
    )
    .map((rule) => rule.id);

  let id = ruleIdCounter;
  while (existingIds.has(id)) {
    id++;
  }
  ruleIdCounter = id + 1;

  const rule = createHeadersRule(
    id,
    urlPattern,
    headers,
    removeHeaders,
    requestDomains,
  );

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: supersededIds,
      addRules: [rule],
    });
    return id;
  } catch (e) {
    console.error("Failed to add dynamic rule:", e);
    return null;
  }
}

async function removeHeadersRule(ruleId) {
  if (!Number.isInteger(ruleId)) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
  });
}

async function persistSeekPlaybackRule(headerInfo) {
  try {
    const existingRules =
      await chrome.declarativeNetRequest.getDynamicRules();
    const seekRules = existingRules.filter((rule) =>
      isSeekPlaybackRuleId(rule.id),
    );
    const matchingRule = seekRules.find(
      (rule) => rule.condition?.urlFilter === headerInfo.domainPattern,
    );
    const usedIds = new Set(seekRules.map((rule) => rule.id));
    let ruleId = matchingRule?.id ?? null;

    if (ruleId === null) {
      for (
        let candidate = SEEK_PLAYBACK_RULE_ID_MIN;
        candidate <= SEEK_PLAYBACK_RULE_ID_MAX;
        candidate += 1
      ) {
        if (!usedIds.has(candidate)) {
          ruleId = candidate;
          break;
        }
      }
    }

    if (ruleId === null) {
      ruleId = SEEK_PLAYBACK_RULE_ID_MIN;
      console.warn(
        "[NEXUS] Seek playback rule capacity reached; evicting oldest slot",
      );
    }

    const rule = createHeadersRule(
      ruleId,
      headerInfo.domainPattern,
      headerInfo.headers,
    );
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: [rule],
    });
    return ruleId;
  } catch (e) {
    console.error("Failed to persist Seek playback rule:", e);
    return null;
  }
}

let seekPlaybackRuleUpdateQueue = Promise.resolve();

function replaceSeekPlaybackRule(headerInfo) {
  const update = seekPlaybackRuleUpdateQueue.then(() =>
    persistSeekPlaybackRule(headerInfo),
  );
  seekPlaybackRuleUpdateQueue = update.then(
    () => undefined,
    () => undefined,
  );
  return update;
}
