const GROUP_TO_COUNTRY = Object.freeze({
  "France": "France",
  "France Sport": "France",
  "United Kingdom": "United Kingdom",
  "Germany": "Germany",
  "Italy": "Italy",
  "Spain": "Spain",
  "Portugal": "Portugal",
  "Netherlands": "Netherlands",
  "Poland": "Poland",
  "Romania": "Romania",
  "Bulgaria": "Bulgaria",
  "Albania": "Albania",
  "Balkans": "Balkans",
  "Turkey": "Turkey",
  "Arabia": "Arabia",
  "Russia": "Russia",
});

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isHttpsArtworkUrl(value) {
  try {
    return new URL(text(value)).protocol === "https:";
  } catch {
    return false;
  }
}

function makeEntry({ country, name, logo, category }) {
  const cleanCountry = text(country);
  const cleanName = text(name);
  if (!cleanCountry || !cleanName) return null;
  return {
    country: cleanCountry,
    name: cleanName,
    logo: isHttpsArtworkUrl(logo) ? text(logo) : null,
    category: text(category) || null,
  };
}

function parseTvVooList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(makeEntry).filter(Boolean);
}

function parseItalyM3u(value) {
  if (typeof value !== "string") return [];
  const result = [];
  for (const line of value.split(/\r?\n/)) {
    if (!line.startsWith("#EXTINF")) continue;
    const comma = line.indexOf(",");
    const name = comma >= 0 ? line.slice(comma + 1).trim() : "";
    const logo = line.match(/\btvg-logo="([^"]*)"/i)?.[1] || "";
    const category = line.match(/\bgroup-title="([^"]*)"/i)?.[1] || "";
    const entry = makeEntry({ country: "Italy", name, logo, category });
    if (entry) result.push(entry);
  }
  return result;
}

function normalizeName(value, stripQuality = false) {
  let normalized = text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s*(\.[a-z0-9]{1,3})+$/i, " ")
    .replace(/\s*\((?:\d+|[a-z]{1,3})\)\s*$/i, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(\d+)\s+(eme|ere|er|e)\b/g, "$1$2");
  if (stripQuality) normalized = normalized.replace(/\b(?:sd|hd|fhd|uhd|4k)\b/g, " ");
  return normalized.replace(/\s+/g, " ").trim();
}

function bigramsFromNormalized(normalized) {
  if (normalized.length < 2) return normalized ? [normalized] : [];
  return Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2));
}

function bigrams(value) {
  return bigramsFromNormalized(normalizeName(value, true));
}

function diceSimilarityFromBigrams(a, b) {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 1 : 0;
  const counts = new Map();
  for (const gram of b) counts.set(gram, (counts.get(gram) || 0) + 1);
  let intersection = 0;
  for (const gram of a) {
    const count = counts.get(gram) || 0;
    if (count > 0) {
      intersection += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * intersection) / (a.length + b.length);
}

function diceSimilarity(left, right) {
  return diceSimilarityFromBigrams(bigrams(left), bigrams(right));
}

function buildMetadataIndex(entries) {
  const index = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!index.has(entry.country)) index.set(entry.country, []);
    index.get(entry.country).push(entry);
  }
  return index;
}

const matchCacheByIndex = new WeakMap();
const compiledMetadataByIndex = new WeakMap();

function addLookupEntry(lookup, key, entry) {
  const matches = lookup.get(key);
  if (matches) matches.push(entry);
  else lookup.set(key, [entry]);
}

function inheritUniqueArtwork(entry, candidates) {
  if (entry.logo) return entry;
  const logos = [...new Set(candidates.map((candidate) => candidate.logo).filter(Boolean))];
  return logos.length === 1 ? { ...entry, logo: logos[0] } : entry;
}

function getCompiledCountryMetadata(index, country) {
  let compiledByCountry = compiledMetadataByIndex.get(index);
  if (!compiledByCountry) {
    compiledByCountry = new Map();
    compiledMetadataByIndex.set(index, compiledByCountry);
  }
  if (compiledByCountry.has(country)) return compiledByCountry.get(country);

  const exact = new Map();
  const relaxed = new Map();
  const fuzzy = [];
  for (const entry of index.get(country) || []) {
    const name = entry.name;
    const exactName = normalizeName(name, false);
    const relaxedName = normalizeName(name, true);
    addLookupEntry(exact, exactName, entry);
    addLookupEntry(relaxed, relaxedName, entry);
    fuzzy.push({ entry, grams: bigramsFromNormalized(relaxedName) });
  }
  const compiled = { exact, relaxed, fuzzy };
  compiledByCountry.set(country, compiled);
  return compiled;
}

function findVavooMetadata(index, group, channelName) {
  let matchCache = matchCacheByIndex.get(index);
  if (!matchCache) {
    matchCache = new Map();
    matchCacheByIndex.set(index, matchCache);
  }
  const matchKey = `${group}\u0000${normalizeName(channelName, false)}`;
  if (matchCache.has(matchKey)) return matchCache.get(matchKey);
  const country = GROUP_TO_COUNTRY[group];
  const compiled = country ? getCompiledCountryMetadata(index, country) : null;
  if (!compiled || compiled.fuzzy.length === 0) return null;
  const exact = normalizeName(channelName, false);
  const relaxed = normalizeName(channelName, true);
  const exactMatches = compiled.exact.get(exact) || [];
  const relaxedMatches = compiled.relaxed.get(relaxed) || [];
  if (exactMatches.length === 1) {
    const result = inheritUniqueArtwork(exactMatches[0], relaxedMatches);
    matchCache.set(matchKey, result);
    return result;
  }
  if (relaxedMatches.length === 1) {
    matchCache.set(matchKey, relaxedMatches[0]);
    return relaxedMatches[0];
  }
  const channelBigrams = bigramsFromNormalized(relaxed);
  const ranked = compiled.fuzzy
    .map(({ entry, grams }) => ({ entry, score: diceSimilarityFromBigrams(channelBigrams, grams) }))
    .sort((left, right) => right.score - left.score);
  const result = !ranked[0] || ranked[0].score < 0.85
    || (ranked[1] && ranked[0].score - ranked[1].score < 0.03)
    ? null
    : ranked[0].entry;
  matchCache.set(matchKey, result);
  return result;
}

const LISTS_URL = "https://raw.githubusercontent.com/qwertyuiop8899/tvvoo/main/src/channels/lists.json";
const ITALY_M3U_URL = "https://raw.githubusercontent.com/piholo/logo/main/lista.m3u";
const LISTS_TTL_MS = 24 * 60 * 60 * 1000;
const ITALY_M3U_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const MEMORY_RECHECK_MS = 5 * 60 * 1000;
const MAX_METADATA_BYTES = 20 * 1024 * 1024;

function createVavooMetadataService(options = {}) {
  const request = options.request;
  const readCache = options.readCache || (async () => null);
  const writeCache = options.writeCache || (async () => false);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const logger = options.logger || console;
  const states = new Map();

  function sourceForGroup(group) {
    return group === "Italy"
      ? { key: "vavoo_metadata_italy_m3u_v1", url: ITALY_M3U_URL, ttl: ITALY_M3U_TTL_MS, type: "text" }
      : { key: "vavoo_metadata_tvvoo_list_v1", url: LISTS_URL, ttl: LISTS_TTL_MS, type: "json" };
  }

  async function fetchEntries(source) {
    if (typeof request !== "function") throw new Error("metadata request adapter missing");
    const response = await request({
      url: source.url,
      method: "GET",
      responseType: source.type === "text" ? "text" : "json",
      timeout: 10_000,
      maxContentLength: MAX_METADATA_BYTES,
      maxBodyLength: MAX_METADATA_BYTES,
    });
    const entries = source.type === "text" ? parseItalyM3u(response.data) : parseTvVooList(response.data);
    if (entries.length === 0) throw new Error("metadata payload contained no valid entries");
    try {
      await writeCache(source.key, entries);
    } catch {
      logger.warn(`[VAVOO metadata] ${source.key} cache write failed`);
    }
    return entries;
  }

  async function loadSource(source) {
    const existing = states.get(source.key);
    if (existing?.index && existing.expiresAt > now()) return existing.index;
    if (existing?.inflight) return existing.inflight;
    const state = existing || { index: null, lastKnownGoodIndex: null, expiresAt: 0, inflight: null };
    state.inflight = (async () => {
      const fresh = await readCache(source.key, source.ttl);
      let entries = Array.isArray(fresh) && fresh.length ? fresh : null;
      if (!entries) {
        try {
          entries = await fetchEntries(source);
        } catch (error) {
          const stale = await readCache(source.key, STALE_TTL_MS);
          if (Array.isArray(stale) && stale.length) entries = stale;
          const status = error?.response?.status || error?.code || "unknown";
          logger.warn(`[VAVOO metadata] ${source.key} refresh failed; status=${status}; stale=${Boolean(entries)}`);
        }
      }
      if (entries) {
        state.lastKnownGoodIndex = buildMetadataIndex(entries);
      }
      state.index = state.lastKnownGoodIndex || buildMetadataIndex([]);
      state.expiresAt = now() + MEMORY_RECHECK_MS;
      return state.index;
    })();
    states.set(source.key, state);
    try {
      return await state.inflight;
    } finally {
      state.inflight = null;
    }
  }

  return {
    getIndexForGroup(group) {
      if (!GROUP_TO_COUNTRY[group]) return Promise.resolve(new Map());
      return loadSource(sourceForGroup(group));
    },
  };
}

module.exports = {
  GROUP_TO_COUNTRY,
  ITALY_M3U_TTL_MS,
  ITALY_M3U_URL,
  LISTS_TTL_MS,
  LISTS_URL,
  MAX_METADATA_BYTES,
  MEMORY_RECHECK_MS,
  STALE_TTL_MS,
  buildMetadataIndex,
  createVavooMetadataService,
  diceSimilarity,
  findVavooMetadata,
  isHttpsArtworkUrl,
  normalizeName,
  parseItalyM3u,
  parseTvVooList,
};
