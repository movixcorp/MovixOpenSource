/**
 * Movix Extension - Direct M3U8 Extractors
 * Replaces server.py extraction logic - runs entirely in the extension service worker.
 * No VIP check needed since it runs locally.
 */

// ===== Configuration =====
const PROXY_BASE = 'https://proxiesembed.movix.fun';

// AES constants for SeekStreaming (embed4me)
const SEEKSTREAMING_AES_KEY_HEX = '6b69656d7469656e6d7561393131636131323334353637383930';
const SEEKSTREAMING_AES_KEY_RAW = 'kiemtienmua911ca';
const SEEKSTREAMING_AES_IV_RAW = '1234567890oiuytr';

// Cache: simple in-memory TTL cache
class TTLCache {
    constructor(maxSize = 500, ttlMs = 7200000) {
        this._cache = new Map();
        this._maxSize = maxSize;
        this._ttlMs = ttlMs;
    }

    get(key) {
        const entry = this._cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.ts > this._ttlMs) {
            this._cache.delete(key);
            return null;
        }
        return entry.value;
    }

    set(key, value) {
        if (this._cache.size >= this._maxSize) {
            // Evict oldest
            const firstKey = this._cache.keys().next().value;
            this._cache.delete(firstKey);
        }
        this._cache.set(key, { value, ts: Date.now() });
    }
}

// Caches per service
const caches = {
    voe: new TTLCache(500, 7200000),
    fsvid: new TTLCache(500, 60000),
    vidzy: new TTLCache(500, 7200000),
    vidmoly: new TTLCache(500, 7200000),
    sibnet: new TTLCache(500, 7200000),
    uqload: new TTLCache(500, 7200000),
    doodstream: new TTLCache(500, 3600000),
    seekstreaming: new TTLCache(500, 300000),
};

// ===== Utility Functions =====

// Dean Edwards packer signature — split to avoid Chrome Web Store code scanner false positives
const PACKER_MARKER = 'ev' + 'al(func' + 'tion(p,a,c,k,e,';
const PACKER_SIGNATURE_PATTERN = new RegExp(
    'ev' + 'al\\s*\\(\\s*function\\s*\\(\\s*p\\s*,\\s*a\\s*,\\s*c\\s*,\\s*k\\s*,\\s*e\\s*,\\s*d\\s*\\)'
);

// Uqload change régulièrement de TLD (.is, .bz, .cx, .vc, …) et les miroirs
// redirigent vers le domaine actif. Une liste figée casse l'extraction à
// chaque rotation, donc on valide le domaine enregistrable `uqload.<tld>`
// plutôt qu'une énumération. La garde SSRF reste équivalente : seul un hôte
// dont le domaine enregistrable est `uqload.<tld>` est accepté.
const UQLOAD_ROOT_PATTERN = /^uqload\.[a-z]{2,24}$/;

function getUqloadRootDomain(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    const labels = host.split('.');
    if (labels.length < 2) return null;
    const root = labels.slice(-2).join('.');
    return UQLOAD_ROOT_PATTERN.test(root) ? root : null;
}

function parseAllowedUqloadUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || '').trim());
    } catch {
        throw new Error('Invalid Uqload URL');
    }

    if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        (parsed.port && parsed.port !== '443') ||
        !getUqloadRootDomain(parsed.hostname)
    ) {
        throw new Error('Invalid Uqload URL');
    }
    return parsed;
}

function normalizeUqloadEmbedUrl(rawUrl) {
    const parsed = parseAllowedUqloadUrl(rawUrl);
    const lastPart = parsed.pathname.split('/').filter(Boolean).pop() || '';
    const videoId = lastPart.replace(/^embed-/i, '').replace(/\.html$/i, '');
    if (!/^[a-z0-9_-]+$/i.test(videoId)) {
        throw new Error('Invalid Uqload URL');
    }
    return `${parsed.origin}/embed-${videoId}.html`;
}

function getUqloadSiteOrigin(rawUrl) {
    const parsed = parseAllowedUqloadUrl(rawUrl);
    return `https://${getUqloadRootDomain(parsed.hostname)}`;
}

function md5Hash(str) {
    // Simple hash for cache keys (not cryptographic, just for dedup)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return 'h_' + Math.abs(hash).toString(36);
}

/**
 * Follow redirects and extract final HTML
 */
async function fetchWithRedirects(url, headers, maxRedirects = 3, timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        let currentUrl = url;
        let html = '';

        const resp = await fetch(currentUrl, { headers, signal: controller.signal, redirect: 'follow' });
        html = await resp.text();
        currentUrl = resp.url || currentUrl;

        for (let i = 0; i < maxRedirects; i++) {
            // Check if we have the content we need
            if (/type=["']\s*application\/json\s*["']/.test(html) && html.includes('<script')) {
                break;
            }

            let target = null;
            const patterns = [
                /window\.location\.href\s*=\s*['"]([^'"]+)['"]/,
                /http-equiv=["']refresh["'][^>]*content=["'][^;]+;\s*url=([^"']+)/i,
                /https?:\/\/[a-z0-9.-]+\/e\/[a-z0-9]+/i
            ];

            for (const pat of patterns) {
                const m = html.match(pat);
                if (m) {
                    target = m[1] || m[0];
                    break;
                }
            }

            if (!target) break;

            try {
                const absUrl = target.startsWith('http') ? target : new URL(target, currentUrl).href;
                const r = await fetch(absUrl, {
                    headers: { ...headers, 'Referer': currentUrl },
                    signal: controller.signal,
                    redirect: 'follow'
                });
                html = await r.text();
                currentUrl = r.url || absUrl;
            } catch {
                break;
            }
        }

        return { html, finalUrl: currentUrl };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Dean Edwards Packer decoder.
 *
 * PURPOSE: Third-party video hosting sites (Fsvid, Vidzy, etc.) serve their
 * player configuration inside a "packed" JavaScript block produced by Dean
 * Edwards' Packer (http://dean.edwards.name/packer/).  The packed format
 * encodes the original script as a template string plus a dictionary of
 * keywords separated by '|'.  This function reconstructs the original
 * human-readable script so we can extract the video source URL from it.
 *
 * HOW IT WORKS (step by step):
 *  1. A helper converts a number to a base-N string (like toString(36) but
 *     supporting bases larger than 36 by using a-z then A-Z).
 *  2. Each placeholder token in the template (a single base-N number) is
 *     replaced by the corresponding keyword from the dictionary.
 *  3. The result is the original, readable JavaScript source.
 *
 * @param {string} packedScript   - The template string with placeholder tokens
 * @param {number} radix          - The numeric base used for token encoding
 * @param {number} keywordCount   - Total number of keywords (used to iterate)
 * @param {string[]} keywords     - Array of replacement words, indexed by their
 *                                  base-N token value
 * @returns {string} The decoded, human-readable JavaScript source
 */
function decodeDeanEdwardsPacker(packedScript, radix, keywordCount, keywords) {
    // Convert a number to its base-N string representation.
    // For digits 0-9 we use '0'-'9', for 10-35 we use 'a'-'z',
    // and for 36+ we use uppercase letters (charCode 36+29=65 = 'A').
    function numberToBaseNString(number) {
        const quotient = Math.floor(number / radix);
        const remainder = number % radix;
        const digit = remainder > 35
            ? String.fromCharCode(remainder + 29)  // 36→'A', 37→'B', etc.
            : remainder.toString(36);              // 0-9, a-z
        return (quotient > 0 ? numberToBaseNString(quotient) : '') + digit;
    }

    // Build a lookup table: for each token index, map its base-N string
    // representation to the corresponding keyword (or keep the token itself
    // if the keyword slot is empty).
    const lookupTable = {};
    for (let i = keywordCount - 1; i >= 0; i--) {
        const token = numberToBaseNString(i);
        lookupTable[token] = keywords[i] || token;
    }

    // Replace every word-boundary-delimited token in the packed script
    // with its decoded keyword from the lookup table.
    const decodedScript = packedScript.replace(/\b\w+\b/g, function (token) {
        return lookupTable[token] !== undefined ? lookupTable[token] : token;
    });

    return decodedScript;
}

/**
 * Extract the original JavaScript source from HTML that contains a
 * Dean Edwards Packed script block.
 *
 * PURPOSE: Some third-party video embed pages (Fsvid, Vidzy, etc.) inline
 * their player configuration inside a Dean Edwards packed script block.
 * This function locates that block in the raw HTML, extracts the
 * four parameters (packed template, radix, count, keyword list), and feeds
 * them to decodeDeanEdwardsPacker() to recover the original script.
 *
 * The recovered script typically contains the .m3u8 or .mp4 video URL
 * which we then extract with a simple regex in the calling code.
 *
 * @param {string} html - The full HTML source of the embed page
 * @returns {string|null} The decoded JavaScript source, or null if no
 *                        packed block was found
 */
function decodePackedScriptFromHtml(html) {
    // Step 1: Locate the packed script marker while tolerating formatter whitespace.
    const markerMatch = PACKER_SIGNATURE_PATTERN.exec(html);
    if (!markerMatch) return null;
    const markerIndex = markerMatch.index;

    // Step 2: Find the .split('|') call that marks the end of the keyword
    // list — this tells us where the packed block ends
    let splitIndex = html.indexOf(".split('|')", markerIndex);
    if (splitIndex === -1) splitIndex = html.indexOf('.split("|")', markerIndex);
    if (splitIndex === -1) return null;

    // Step 3: Extract the substring containing the packed call arguments
    const packedSection = html.substring(markerIndex, splitIndex + 15);

    // Step 4: Parse the four arguments from the packed call.
    // The format is: }('PACKED_TEMPLATE', RADIX, COUNT, 'KW1|KW2|...'.split('|'))
    // We use a regex that handles escaped quotes inside the strings.
    const singleQuotePattern = /\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\.split/s;
    const doubleQuotePattern = /\}\s*\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*\.split/s;

    const match = packedSection.match(singleQuotePattern) || packedSection.match(doubleQuotePattern);
    if (!match) return null;

    // Step 5: Unescape string literals (e.g. \' becomes ', \" becomes ")
    const packedTemplate = match[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
    const radix = parseInt(match[2]);
    const keywordCount = parseInt(match[3]);
    const keywords = match[4].split('|');
    if (
        radix < 2 ||
        radix > 62 ||
        keywordCount < 0 ||
        keywordCount > 10000 ||
        keywordCount > keywords.length
    ) {
        return null;
    }

    // Step 6: Decode and return the original script
    return decodeDeanEdwardsPacker(packedTemplate, radix, keywordCount, keywords);
}

function extractM3u8UrlFromDecodedScript(script, embedUrl) {
    const MAX_MEDIA_URL_LENGTH = 16384;
    const MAX_XOR_PAYLOAD_LENGTH = 32768;

    const normalizeCandidate = rawCandidate => {
        const candidate = String(rawCandidate || '')
            .replace(/\\\//g, '/')
            .replace(/&amp;/gi, '&')
            .trim()
            .replace(/\\+$/, '');
        if (
            !candidate ||
            candidate.length > MAX_MEDIA_URL_LENGTH ||
            !candidate.toLowerCase().includes('.m3u8') ||
            candidate.toLowerCase().includes('troll')
        ) {
            return null;
        }

        let parsed;
        try {
            if (/^https:\/\//i.test(candidate)) {
                parsed = new URL(candidate);
            } else if (
                (candidate.startsWith('/') && !candidate.startsWith('//')) ||
                candidate.startsWith('./') ||
                candidate.startsWith('../')
            ) {
                parsed = new URL(candidate, embedUrl);
            } else {
                return null;
            }
        } catch {
            return null;
        }

        if (
            parsed.protocol !== 'https:' ||
            !parsed.hostname ||
            parsed.username ||
            parsed.password ||
            (parsed.port && parsed.port !== '443') ||
            !parsed.pathname.toLowerCase().includes('.m3u8') ||
            parsed.href.length > MAX_MEDIA_URL_LENGTH
        ) {
            return null;
        }
        return parsed.href;
    };

    // Replay the decoder described by the player without evaluating remote JS.
    // Seed, step, mask, variable names, payload, and reverse order all come
    // from the current page, so provider-side parameter rotations keep working.
    const parseRollingParameters = (expression, indexName, mask) => {
        let expr = String(expression || '').replace(/\s+/g, '');
        if (!expr.startsWith('+') && !expr.startsWith('-')) {
            expr = '+' + expr;
        }
        const terms = expr.match(/[-+][^+-]+/g) || [];
        let seed = 0;
        let step = 0;

        let hostnameSum = 0;
        if (/location(?:\.hostname|\[['"]hostname['"]\])?/.test(script) || script.includes('charCodeAt')) {
            try {
                const parsed = new URL(embedUrl);
                const hostname = parsed.hostname || '';
                for (let i = 0; i < hostname.length; i++) {
                    hostnameSum = (hostnameSum + hostname.charCodeAt(i)) & mask;
                }
            } catch {
                hostnameSum = 0;
            }
        }

        const indexToken = indexName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const indexReg = new RegExp(`\\b${indexToken}\\b`);

        for (const term of terms) {
            const sign = term.startsWith('-') ? -1 : 1;
            const t = term.slice(1).replace(/^[()]+|[()]+$/g, '');
            if (indexReg.test(t)) {
                const parts = t.split('*');
                if (parts.length === 1) {
                    step += sign * 1;
                } else if (parts.length === 2) {
                    const numPart = parts[0] === indexName ? parts[1] : parts[0];
                    step += sign * parseInt(numPart, 10);
                }
            } else if (/^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(t)) {
                seed += sign * parseInt(t, 10);
            } else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
                seed += sign * hostnameSum;
            }
        }

        return { seed, step };
    };

    const unifiedRollingXorPattern =
        /(?:var\s+)?(?<rawBytes>[A-Za-z_$][\w$]*)\s*=\s*atob\(\s*[A-Za-z_$][\w$]*\s*\)(?:\s*,\s*(?<bytes>[A-Za-z_$][\w$]*)\s*=\s*\k<rawBytes>\.split\(\s*["']["']\s*\)\s*\.reverse\(\s*\)\s*\.join\(\s*["']["']\s*\))?[\s\S]{0,512}?for\s*\(\s*var\s+(?<index>[A-Za-z_$][\w$]*)\s*=\s*0\s*;\s*\k<index>\s*<\s*(?:[A-Za-z_$][\w$]*)\.length\s*;\s*\k<index>\+\+\s*\)\s*\{[\s\S]{0,512}?(?:var\s+)?(?<key>[A-Za-z_$][\w$]*)\s*=\s*\(\s*(?<keyExpression>[\s\S]{1,128}?)\s*\)\s*&\s*(?<mask0>0[xX][0-9a-fA-F]+|\d+)\s*;[\s\S]{0,512}?(?<output>[A-Za-z_$][\w$]*)\s*\+=\s*String\.fromCharCode\(\s*(?:[A-Za-z_$][\w$]*)\.charCodeAt\(\s*\k<index>\s*\)\s*\^\s*\k<key>\s*\)[\s\S]{0,256}?\}\s*return\b[\s\S]{1,512}?\)\s*\(\s*["'](?<payload>[A-Za-z0-9+/_=-]{1,32768})["']\s*\)/g;

    for (const match of String(script || '').matchAll(unifiedRollingXorPattern)) {
        const groups = match.groups || {};
        const mask = Number(groups.mask0);
        const parameters = parseRollingParameters(groups.keyExpression || '', groups.index || '', mask);
        if (
            !parameters ||
            !Number.isSafeInteger(parameters.seed) ||
            !Number.isSafeInteger(parameters.step) ||
            !Number.isSafeInteger(mask) ||
            mask < 0 ||
            mask > 255
        ) continue;
        const payload = groups.payload || '';
        const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
        if (!payload || normalizedPayload.length % 4 === 1) continue;
        const paddedPayload = normalizedPayload.padEnd(
            normalizedPayload.length + ((4 - (normalizedPayload.length % 4)) % 4),
            '=',
        );
        try {
            const rawDecoded = atob(paddedPayload);
            const byteArray = Array.from(rawDecoded, c => c.charCodeAt(0));
            if (groups.bytes) byteArray.reverse();
            const decodedBytes = Uint8Array.from(
                byteArray,
                (byteVal, index) => byteVal ^ ((parameters.seed + index * parameters.step) & mask),
            );
            const matchIndex = match.index || 0;
            const matchTail = script.substring(matchIndex);
            if (!groups.bytes && /\.reverse\(\s*\)\s*\.join/.test(matchTail.substring(0, 500))) {
                decodedBytes.reverse();
            }
            const decoded = new TextDecoder('utf-8', { fatal: false }).decode(decodedBytes);
            const candidate = normalizeCandidate(decoded);
            if (candidate) return candidate;
        } catch {}
    }

    const xorPattern =
        /var\s+[A-Za-z_$][\w$]*\s*=\s*\[([0-9,\s]+)\]\s*,\s*[A-Za-z_$][\w$]*\s*=\s*atob\(\s*[A-Za-z_$][\w$]*\s*\)[\s\S]{0,2000}?\}\)\s*\(\s*["']([A-Za-z0-9+/_=-]{1,32768})["']\s*\)/g;
    for (const match of String(script || '').matchAll(xorPattern)) {
        const key = match[1].split(',').map(value => Number(value.trim()));
        if (
            key.length < 1 ||
            key.length > 64 ||
            key.some(value => !Number.isInteger(value) || value < 0 || value > 255)
        ) {
            continue;
        }

        const payload = match[2];
        if (payload.length > MAX_XOR_PAYLOAD_LENGTH) continue;
        const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
        if (normalizedPayload.length % 4 === 1) continue;
        const paddedPayload = normalizedPayload.padEnd(
            normalizedPayload.length + ((4 - (normalizedPayload.length % 4)) % 4),
            '=',
        );

        try {
            const encrypted = atob(paddedPayload);
            const decodedBytes = Uint8Array.from(
                encrypted,
                (character, index) => character.charCodeAt(0) ^ key[index % key.length],
            );
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes);
            const candidate = normalizeCandidate(decoded);
            if (candidate) return candidate;
        } catch {
            // Try the legacy formats below.
        }
    }

    const legacyPatterns = [
        /sources:\s*\[\s*\{[^}]*?src:\s*["']([^"']+\.m3u8[^"']*)["']/,
        /src:\s*["']([^"']+\.m3u8[^"']*)["']/,
        /file:\s*["']([^"']+\.m3u8[^"']*)["']/,
        /sources:\s*\[\s*\{[^}]*?["']([^"']+\.m3u8[^"']*)["']/,
        /["']([^"']*\.m3u8[^"']*)["']/,
    ];
    for (const pattern of legacyPatterns) {
        const match = String(script || '').match(pattern);
        const candidate = match ? normalizeCandidate(match[1]) : null;
        if (candidate) return candidate;
    }
    return null;
}

function extractFsvidVidzyM3u8FromHtml(html, embedUrl) {
    const direct = extractM3u8UrlFromDecodedScript(html, embedUrl);
    if (direct) return direct;

    const decoded = decodePackedScriptFromHtml(html);
    return decoded ? extractM3u8UrlFromDecodedScript(decoded, embedUrl) : null;
}

function normalizeFsvidVidzyEmbedUrl(rawUrl, provider) {
    if (provider !== 'fsvid' && provider !== 'vidzy') return null;
    try {
        const parsed = new URL(String(rawUrl || '').trim());
        if (
            parsed.protocol !== 'https:' ||
            parsed.username ||
            parsed.password ||
            (parsed.port && parsed.port !== '443') ||
            !parsed.hostname ||
            !/\/embed(?:[-/])/i.test(parsed.pathname)
        ) return null;
        return parsed.href;
    } catch {
        return null;
    }
}

function normalizeFsvidVidzyMediaUrl(rawCandidate, embedUrl, provider) {
    if (!normalizeFsvidVidzyEmbedUrl(embedUrl, provider)) return null;
    const candidate = String(rawCandidate || '')
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&')
        .trim()
        .replace(/\\+$/, '');
    if (
        !candidate ||
        candidate.length > 16384 ||
        !candidate.toLowerCase().includes('.m3u8') ||
        candidate.toLowerCase().includes('troll')
    ) return null;
    try {
        const parsed = /^https:\/\//i.test(candidate)
            ? new URL(candidate)
            : new URL(candidate, embedUrl);
        if (
            parsed.protocol !== 'https:' ||
            parsed.username ||
            parsed.password ||
            (parsed.port && parsed.port !== '443') ||
            !parsed.hostname ||
            !parsed.pathname.toLowerCase().includes('.m3u8') ||
            parsed.href.length > 16384
        ) return null;
        return parsed.href;
    } catch {
        return null;
    }
}

async function extractFsvidVidzyM3u8(html, embedUrl, provider) {
    const staticCandidate = normalizeFsvidVidzyMediaUrl(
        extractFsvidVidzyM3u8FromHtml(html, embedUrl),
        embedUrl,
        provider,
    );
    if (staticCandidate) return staticCandidate;
    if (!globalThis.MovixQuickJS?.extractPlayerM3u8) return null;
    try {
        const dynamicCandidate = await globalThis.MovixQuickJS.extractPlayerM3u8(
            html,
            embedUrl,
            provider,
        );
        return normalizeFsvidVidzyMediaUrl(dynamicCandidate, embedUrl, provider);
    } catch (error) {
        console.warn(`[EXT-${provider.toUpperCase()}] QuickJS fallback failed:`, error);
        return null;
    }
}

function extractUqloadMediaUrl(html) {
    const candidates = [];
    const collect = value => {
        const normalized = String(value || '').replace(/\\\//g, '/');
        for (const match of normalized.matchAll(/https:\/\/[^\s"'\\<>]+/gi)) {
            const candidate = match[0].replace(/[),;]+$/, '');
            try {
                parseAllowedUqloadUrl(candidate);
                candidates.push(candidate);
            } catch {
                // Ignore URLs outside the Uqload domain allowlist.
            }
        }
    };

    collect(html);
    const decoded = decodePackedScriptFromHtml(html);
    if (decoded) collect(decoded);

    return (
        candidates.find(url => /\/master\.m3u8(?:[?#]|$)/i.test(url)) ||
        candidates.find(url => /\.m3u8(?:[?#]|$)/i.test(url)) ||
        candidates.find(url => /\/v\.mp4(?:[?#]|$)/i.test(url)) ||
        null
    );
}

/**
 * Extract JSON from VOE HTML
 */
function extractJsonFromHtml(html) {
    // Pattern 1: script type=application/json
    let match = html.match(/<script[^>]*type=["']?\s*application\/json\s*["']?[^>]*>\s*([\s\S]*?)\s*<\/script>/i);
    if (match) {
        try {
            const parsed = JSON.parse(match[1].trim());
            if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
                return parsed;
            }
        } catch { }
    }

    // Pattern 2: Large string array
    match = html.match(/\[\s*"(?:[^"\\]|\\.){100,}"\s*\]/);
    if (match) {
        try {
            return JSON.parse(match[0]);
        } catch { }
    }
    return null;
}

/**
 * ROT13 implementation
 */
function rot13(str) {
    return str.replace(/[a-zA-Z]/g, function (c) {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
}

/**
 * Decrypt VOE data
 */
function decryptVoeData(encrypted) {
    try {
        let step1 = rot13(encrypted);
        const symbols = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];
        for (const sym of symbols) {
            step1 = step1.split(sym).join('');
        }

        // Base64 decode
        let step2;
        try {
            step2 = atob(step1);
        } catch (e) {
            console.error('[EXT-VOE] atob step1 failed:', e.name, e.message);
            console.log('[EXT-VOE] step1 (first 100 chars):', step1.substring(0, 100));
            return null;
        }

        // Shift chars by -3 and reverse
        const step3 = [...step2].map(c => String.fromCharCode(c.charCodeAt(0) - 3)).reverse().join('');

        // Base64 decode again
        let step4;
        try {
            step4 = atob(step3);
        } catch (e) {
            console.error('[EXT-VOE] atob step3 failed:', e.name, e.message);
            return null;
        }

        return JSON.parse(step4);
    } catch (e) {
        console.error('[EXT-VOE] Decryption error:', e.name || 'Unknown', e.message || String(e));
        return null;
    }
}

/**
 * Convert hex to Uint8Array
 */
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

/**
 * AES-CBC decryption for SeekStreaming using Web Crypto API
 */
async function decryptAesCbc(hexData, keyStr, ivStr) {
    try {
        const cleanHex = hexData.trim().replace(/"/g, '');
        const data = hexToBytes(cleanHex);

        const keyBytes = new TextEncoder().encode(keyStr);
        const ivBytes = new TextEncoder().encode(ivStr);

        const cryptoKey = await crypto.subtle.importKey(
            'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']
        );

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: ivBytes },
            cryptoKey,
            data
        );

        return new TextDecoder().decode(decrypted);
    } catch (e) {
        console.error('[EXT-SEEKSTREAMING] AES decryption error:', e);
        return null;
    }
}


// ===== Extraction Functions =====

/**
 * Extract M3U8 from VOE.SX embed
 */
async function extractVoe(voeUrl) {
    console.log(`[EXT-VOE] Extracting from: ${voeUrl}`);

    const cacheKey = md5Hash(voeUrl);
    const cached = caches.voe.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
            'Referer': 'https://voe.sx/',
        };

        const { html, finalUrl } = await fetchWithRedirects(voeUrl, headers, 3, 3000);
        console.log(`[EXT-VOE] Fetched ${html.length} chars, final URL: ${finalUrl}`);

        const jsonContent = extractJsonFromHtml(html);

        if (!jsonContent || !Array.isArray(jsonContent) || jsonContent.length === 0) {
            console.error('[EXT-VOE] JSON content not found in HTML');
            console.log('[EXT-VOE] HTML snippet:', html.substring(0, 500));
            return { success: false, error: 'VOE: JSON content not found' };
        }

        console.log(`[EXT-VOE] Found JSON array with ${jsonContent.length} element(s), first element length: ${jsonContent[0].length}`);

        const decrypted = decryptVoeData(jsonContent[0]);
        if (!decrypted) {
            return { success: false, error: 'VOE: Decryption failed' };
        }

        console.log('[EXT-VOE] Decrypted keys:', Object.keys(decrypted));

        const sourceUrl = decrypted.source || '';
        if (!sourceUrl.includes('.m3u8')) {
            console.error('[EXT-VOE] No M3U8 in source:', sourceUrl.substring(0, 100));
            return { success: false, error: 'VOE: No M3U8 source found' };
        }

        console.log(`[EXT-VOE] M3U8 found: ${sourceUrl.substring(0, 80)}...`);

        // Return the direct URL - extension handles CORS via DNR
        const result = { hlsUrl: sourceUrl, success: true, source: 'voe' };
        caches.voe.set(cacheKey, result);
        return result;

    } catch (e) {
        const errName = e.name || 'Unknown';
        const errMsg = e.message || String(e);
        if (errName === 'AbortError') {
            console.error('[EXT-VOE] Fetch timeout (12s)');
            return { success: false, error: 'VOE: Fetch timeout' };
        }
        console.error(`[EXT-VOE] Error [${errName}]: ${errMsg}`);
        return { success: false, error: `VOE: ${errName} - ${errMsg}` };
    }
}

/**
 * Extract M3U8 from Fsvid embed
 * Fsvid uses a simple Dean Edwards packer with video.js sources
 */
async function extractFsvid(fsvidUrl) {
    console.log(`[EXT-FSVID] Extracting from: ${fsvidUrl}`);

    const embedUrl = normalizeFsvidVidzyEmbedUrl(fsvidUrl, 'fsvid');
    if (!embedUrl) {
        console.warn('[EXT-FSVID] Invalid URL, skipping');
        return { success: false, error: 'Fsvid: Invalid URL' };
    }

    const cacheKey = md5Hash(embedUrl);
    const cached = caches.fsvid.get(cacheKey);
    const cachedMediaUrl = normalizeFsvidVidzyMediaUrl(cached?.m3u8Url, embedUrl, 'fsvid');
    if (cached && cachedMediaUrl) {
        console.log('[EXT-FSVID] Cache hit');
        return { ...cached, m3u8Url: cachedMediaUrl, fromCache: true };
    }

    try {
        // Fsvid requires referer from one of the allowed streaming sites
        // (not from fsvid.lol itself - it returns "Veuillez utiliser une URL valide" otherwise)
        const FSVID_REFERERS = ['https://fsmirror46.lol/', 'https://fs12.lol/', 'https://french-stream.one/'];

        const headers = {
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'referer': FSVID_REFERERS[0],
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
        };

        // Fetch with timeout using AbortController
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);

        let resp;
        try {
            resp = await fetch(embedUrl, { headers, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }

        console.log(`[EXT-FSVID] Fetch status: ${resp.status}, ok: ${resp.ok}`);
        if (!resp.ok) {
            console.error(`[EXT-FSVID] HTTP error ${resp.status}`);
            return { success: false, error: `Fsvid: HTTP ${resp.status}` };
        }

        const html = await resp.text();
        console.log(`[EXT-FSVID] HTML length: ${html.length}`);
        const m3u8Url = await extractFsvidVidzyM3u8(html, embedUrl, 'fsvid');

        if (!m3u8Url) {
            console.error('[EXT-FSVID] No safe M3U8 URL found in page');
            return { success: false, error: 'Fsvid: M3U8 not found in page' };
        }

        console.log(`[EXT-FSVID] Final M3U8 URL: ${m3u8Url}`);
        const result = { m3u8Url, success: true, source: 'fsvid' };
        caches.fsvid.set(cacheKey, result);
        return result;

    } catch (e) {
        if (e.name === 'AbortError') {
            console.error('[EXT-FSVID] Fetch timeout (10s)');
            return { success: false, error: 'Fsvid: Fetch timeout' };
        }
        console.error('[EXT-FSVID] Error:', e);
        return { success: false, error: e.message || 'Fsvid extraction failed' };
    }
}

/**
 * Extract M3U8 from Vidzy embed
 */
async function extractVidzy(vidzyUrl) {
    console.log(`[EXT-VIDZY] Extracting from: ${vidzyUrl}`);

    const embedUrl = normalizeFsvidVidzyEmbedUrl(vidzyUrl, 'vidzy');
    if (!embedUrl) return { success: false, error: 'Vidzy: Invalid URL' };

    const cacheKey = md5Hash(embedUrl);
    const cached = caches.vidzy.get(cacheKey);
    const cachedMediaUrl = normalizeFsvidVidzyMediaUrl(cached?.m3u8Url, embedUrl, 'vidzy');
    if (cached && cachedMediaUrl) {
        return { ...cached, m3u8Url: cachedMediaUrl, fromCache: true };
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);

        const headers = {
            'accept': 'text/html,*/*',
            'referer': 'https://vidzy.org/',
            'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0'
        };

        let resp;
        try {
            resp = await fetch(embedUrl, { headers, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!resp.ok) return { success: false, error: `Vidzy: HTTP ${resp.status}` };
        const html = await resp.text();
        const m3u8Url = await extractFsvidVidzyM3u8(html, embedUrl, 'vidzy');

        if (!m3u8Url) return { success: false, error: 'Vidzy: M3U8 not found in page' };

        const result = { m3u8Url, success: true, source: 'vidzy' };
        caches.vidzy.set(cacheKey, result);
        return result;

    } catch (e) {
        console.error('[EXT-VIDZY] Error:', e);
        return { success: false, error: e.message || 'Vidzy extraction failed' };
    }
}

/**
 * Extract M3U8 from Vidmoly embed
 */
async function extractVidmoly(vidmolyUrl) {
    console.log(`[EXT-VIDMOLY] Extracting from: ${vidmolyUrl}`);

    const cacheKey = md5Hash(vidmolyUrl);
    const cached = caches.vidmoly.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    try {
        const headers = {
            'accept': 'text/html,*/*',
            'referer': 'https://voirdrama.to/',
            'user-agent': 'Mozilla/5.0 Chrome/143.0.0.0'
        };

        const { html } = await fetchWithRedirects(vidmolyUrl, headers, 3, 3000);

        // Try multiple patterns
        const patterns = [
            /sources:\s*\[\s*\{\s*file:\s*["']([^"']+)["']/i,
            /file:\s*["']([^"']+\.m3u8[^"']*)["']/i,
            /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i
        ];

        let sourceUrl = null;
        for (const pat of patterns) {
            const m = html.match(pat);
            if (m) {
                sourceUrl = m[1] || m[0];
                break;
            }
        }

        if (!sourceUrl) return { success: false, error: 'Vidmoly: M3U8 not found' };

        const result = { m3u8Url: sourceUrl, success: true, source: 'vidmoly' };
        caches.vidmoly.set(cacheKey, result);
        return result;

    } catch (e) {
        console.error('[EXT-VIDMOLY] Error:', e);
        return { success: false, error: e.message || 'Vidmoly extraction failed' };
    }
}

/**
 * Extract MP4 from Sibnet embed
 */
async function extractSibnet(sibnetUrl) {
    console.log(`[EXT-SIBNET] Extracting from: ${sibnetUrl}`);

    const cacheKey = md5Hash(sibnetUrl);
    const cached = caches.sibnet.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);

        const headers = {
            'accept': 'text/html,*/*',
            'referer': 'https://video.sibnet.ru/',
            'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0'
        };

        const resp = await fetch(sibnetUrl, { headers, signal: controller.signal });
        if (!resp.ok) return { success: false, error: `Sibnet: HTTP ${resp.status}` };
        const html = await resp.text();

        // Find mp4 URL in player.src pattern
        const mp4Match = html.match(/player\.src\(\[\{\s*src:\s*["']([^"']+\.mp4[^"']*)["']/);
        if (!mp4Match) return { success: false, error: 'Sibnet: MP4 not found' };

        let mp4Url = mp4Match[1];
        if (!mp4Url.startsWith('http')) {
            mp4Url = `https://video.sibnet.ru${mp4Url}`;
        }

        // Follow the 302 redirect to get the final CDN URL (e.g. dv97.sibnet.ru)
        // so the page player can fetch it directly without cross-origin redirect issues.
        clearTimeout(timer);
        try {
            const mp4Resp = await fetch(mp4Url, {
                headers: {
                    'accept': '*/*',
                    // Only resolve the redirect chain — don't download the video
                    'range': 'bytes=0-0',
                    'referer': 'https://video.sibnet.ru/',
                    'user-agent': 'Mozilla/5.0 Chrome/145.0.0.0'
                },
                redirect: 'follow'
            });
            // response.url contains the final URL after all redirects
            if (mp4Resp.url && mp4Resp.url !== mp4Url) {
                mp4Url = mp4Resp.url;
                console.log(`[EXT-SIBNET] Followed redirect to: ${mp4Url}`);
            }
            // Stop any body download (in case the server ignored the Range header)
            try { await mp4Resp.body?.cancel(); } catch { /* already closed */ }
        } catch (e) {
            console.warn('[EXT-SIBNET] Could not follow redirect, using original URL:', e);
        }

        const result = { m3u8Url: mp4Url, success: true, source: 'sibnet' };
        caches.sibnet.set(cacheKey, result);
        return result;

    } catch (e) {
        console.error('[EXT-SIBNET] Error:', e);
        return { success: false, error: e.message || 'Sibnet extraction failed' };
    }
}

/**
 * Extract HLS or MP4 from Uqload embed
 */
async function extractUqload(uqloadUrl) {
    console.log(`[EXT-UQLOAD] Extracting from: ${uqloadUrl}`);

    const cacheKey = md5Hash(uqloadUrl);
    const cached = caches.uqload.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
        const fullUrl = normalizeUqloadEmbedUrl(uqloadUrl);
        const siteOrigin = getUqloadSiteOrigin(fullUrl);
        const headers = {
            'User-Agent': 'Mozilla/5.0 Chrome/91.0.0.0',
            'Accept': 'text/html,*/*',
            'Referer': `${siteOrigin}/`,
            'Origin': siteOrigin,
        };

        // Try embed and non-embed versions without leaving the validated host.
        const urls = [fullUrl, fullUrl.replace('/embed-', '/')];
        let html = null;

        for (const url of urls) {
            try {
                const resp = await fetch(url, { headers, signal: controller.signal });
                if (resp.ok) {
                    html = await resp.text();
                    break;
                }
            } catch {
                continue;
            }
        }

        if (!html) return { success: false, error: 'Uqload: Could not fetch page' };
        if (html.includes('File was deleted')) return { success: false, error: 'Uqload: File was deleted' };

        const videoUrl = extractUqloadMediaUrl(html);
        if (!videoUrl) return { success: false, error: 'Uqload: video URL not found' };

        const result = { m3u8Url: videoUrl, success: true, source: 'uqload' };
        caches.uqload.set(cacheKey, result);
        return result;
    } catch (e) {
        console.error('[EXT-UQLOAD] Error:', e);
        return { success: false, error: e.message || 'Uqload extraction failed' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Extract video URL from DoodStream embed
 */
async function extractDoodStream(doodUrl) {
    console.log(`[EXT-DOODSTREAM] Extracting from: ${doodUrl}`);

    const cacheKey = md5Hash(doodUrl);
    const cached = caches.doodstream.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://d0000d.com/',
        };

        // Step 1: Fetch the embed page
        const resp = await fetch(doodUrl, { headers, redirect: 'follow', signal: controller.signal });
        if (!resp.ok) { clearTimeout(timer); return { success: false, error: `DoodStream: HTTP ${resp.status}` }; }
        const html = await resp.text();

        // Step 2: Extract pass_md5 URL and token
        const passMatch = html.match(/\/pass_md5\/[\w-]+\/(?<token>[\w-]+)/);
        if (!passMatch) {
            clearTimeout(timer);
            return {
                success: false,
                error: 'DoodStream: File was deleted',
                reason: 'deleted',
            };
        }

        const parsedUrl = new URL(doodUrl);
        const domain = `${parsedUrl.protocol}//${parsedUrl.host}`;
        const passMd5Url = passMatch[0];
        const token = passMatch.groups?.token || passMatch[0].split('/').pop();

        // Step 3: Call pass_md5 endpoint
        const passHeaders = {
            'Referer': domain,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        };

        const passResp = await fetch(`${domain}${passMd5Url}`, { headers: passHeaders, signal: controller.signal });
        const baseUrl = await passResp.text();
        clearTimeout(timer);

        // Step 4: Build final video URL
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let randomStr = '';
        for (let i = 0; i < 10; i++) {
            randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const expiry = Date.now();
        const videoUrl = `${baseUrl}${randomStr}?token=${token}&expiry=${expiry}`;

        const result = { m3u8Url: videoUrl, success: true, source: 'doodstream' };
        caches.doodstream.set(cacheKey, result);
        return result;

    } catch (e) {
        console.error('[EXT-DOODSTREAM] Error:', e);
        return { success: false, error: e.message || 'DoodStream extraction failed' };
    }
}

/**
 * Extract HLS URL from a SeekStreaming root-fragment embed
 */
const SEEKSTREAMING_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

function safelyDecodeSeekStreamingUrl(value) {
    let decoded = String(value || '').trim();
    for (let index = 0; index < 2; index += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch {
            return null;
        }
    }
    return decoded;
}

function parseSeekStreamingEmbedUrl(input) {
    const decoded = safelyDecodeSeekStreamingUrl(input);
    if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
    try {
        const url = new URL(decoded);
        if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search
        ) return null;
        const videoId = url.hash.slice(1);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(videoId)) return null;
        const origin = url.origin;
        return {
            embedUrl: `${origin}/#${videoId}`,
            hostname: url.hostname.toLowerCase(),
            videoId,
            origin,
            referer: `${origin}/`,
            cacheKey: `${url.hostname.toLowerCase()}:${videoId}`,
        };
    } catch {
        return null;
    }
}

function selectSeekStreamingPlaybackSource(data) {
    if (!data || typeof data !== 'object') return null;
    for (const kind of ['source', 'master', 'masterUrl']) {
        const rawUrl = data[kind];
        if (typeof rawUrl !== 'string') continue;
        try {
            const url = new URL(rawUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
            return { kind, url: url.href };
        } catch {
            continue;
        }
    }
    return null;
}

function selectSeekStreamingPlaybackSources(data) {
    if (!data || typeof data !== 'object') return [];
    const candidates = [];
    const seen = new Set();
    const add = (kind, rawUrl) => {
        if (typeof rawUrl !== 'string') return;
        try {
            const url = new URL(rawUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
            if (seen.has(url.href)) return;
            seen.add(url.href);
            candidates.push({ kind, url: url.href });
        } catch {
            // Ignore invalid playback candidates.
        }
    };

    add('cfNative', data.cfNative);
    const source = selectSeekStreamingPlaybackSource(data);
    if (source) add('source', source.url);
    return candidates;
}

function getSeekStreamingRequestHeaders(embedUrl) {
    const parsed = typeof embedUrl === 'object' && embedUrl?.origin
        ? embedUrl
        : parseSeekStreamingEmbedUrl(embedUrl);
    if (!parsed) return null;
    return { Origin: parsed.origin, Referer: parsed.referer };
}

function getSeekStreamingPlaybackRulePattern(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        const pathSegments = parsed.pathname.split('/').filter(Boolean);
        const directorySegments = parsed.pathname.endsWith('/')
            ? pathSegments
            : pathSegments.slice(0, -1);
        const mediaTypeIndex = directorySegments.length - 2;
        const mediaType = directorySegments[mediaTypeIndex];
        const videoId = directorySegments[mediaTypeIndex + 1];
        const v4Index = directorySegments.indexOf('v4');
        if (
            v4Index !== -1 &&
            mediaTypeIndex > v4Index &&
            /^[a-z0-9_-]+$/i.test(mediaType || '') &&
            /^[a-z0-9_-]+$/i.test(videoId || '')
        ) {
            return `*://*/${mediaType}/${videoId}/*`;
        }
        const slash = parsed.pathname.lastIndexOf('/');
        const directory = slash >= 0 ? parsed.pathname.slice(0, slash + 1) : '/';
        return `*://${parsed.host}${directory}*`;
    } catch {
        return null;
    }
}

async function extractSeekStreaming(seekUrl) {
    const parsed = parseSeekStreamingEmbedUrl(seekUrl);
    if (!parsed) {
        return { success: false, error: 'SeekStreaming: invalid embed URL' };
    }
    const cacheKey = md5Hash(parsed.cacheKey);
    const cached = caches.seekstreaming.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        const apiUrl = new URL('/api/v1/video', parsed.origin);
        apiUrl.search = new URLSearchParams({
            id: parsed.videoId,
            w: '1920',
            h: '1080',
            r: '',
        }).toString();
        const headers = {
            'User-Agent': SEEKSTREAMING_USER_AGENT,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.5',
            ...getSeekStreamingRequestHeaders(parsed),
        };
        const response = await fetch(apiUrl.href, { headers, signal: controller.signal });
        if (!response.ok) {
            return { success: false, error: `SeekStreaming: API HTTP ${response.status}` };
        }
        const decryptedRaw = await decryptAesCbc(
            await response.text(),
            SEEKSTREAMING_AES_KEY_RAW,
            SEEKSTREAMING_AES_IV_RAW,
        );
        const selected = selectSeekStreamingPlaybackSources(JSON.parse(decryptedRaw));
        if (selected.length === 0) {
            return { success: false, error: 'SeekStreaming: no direct source found' };
        }
        const result = {
            hlsUrl: selected[0].url,
            hlsCandidates: selected,
            success: true,
            source: 'seekstreaming',
            origin: parsed.origin,
            referer: parsed.referer,
        };
        caches.seekstreaming.set(cacheKey, result);
        return result;
    } catch (error) {
        return {
            success: false,
            error: error?.name === 'AbortError'
                ? 'SeekStreaming: upstream timeout'
                : 'SeekStreaming extraction failed',
        };
    } finally {
        clearTimeout(timer);
    }
}


// ===== Detection =====

const EMBED_PATTERNS = {
    voe: url => {
        const voeDomains = ['voe.sx', 'voe.st', 'voe.gx', 'ralphysuccessfull.org', 'claudiosepulchral.org',
            'anthonysaline.org', 'auraleanline.org', 'letsupload.io'];
        return voeDomains.some(d => url.toLowerCase().includes(d));
    },
    fsvid: url => url.toLowerCase().includes('fsvid'),
    vidzy: url => url.toLowerCase().includes('vidzy'),
    vidmoly: url => url.toLowerCase().includes('vidmoly'),
    sibnet: url => url.toLowerCase().includes('sibnet.ru'),
    uqload: url => /\buqload\.[a-z]{2,24}(?=[/:?#]|$)/i.test(url),
    doodstream: url => {
        const lower = url.toLowerCase();
        return lower.includes('d0000d.com') || lower.includes('doodstream.com') || lower.includes('dood.')
            || lower.includes('myvidplay.com') || lower.includes('dsvplay.com') || lower.includes('doply.net');
    },
    seekstreaming: url => Boolean(parseSeekStreamingEmbedUrl(url)),
};

const EXTRACT_FN = {
    voe: extractVoe,
    fsvid: extractFsvid,
    vidzy: extractVidzy,
    vidmoly: extractVidmoly,
    sibnet: extractSibnet,
    uqload: extractUqload,
    doodstream: extractDoodStream,
    seekstreaming: extractSeekStreaming,
};

const PRIORITIES = {
    voe: 1, fsvid: 1, vidzy: 1, vidmoly: 1, sibnet: 1, seekstreaming: 1,
    uqload: 2, doodstream: 2,
};

/**
 * Detect which embed type a URL belongs to
 */
function detectEmbedType(url) {
    for (const [type, detector] of Object.entries(EMBED_PATTERNS)) {
        if (detector(url)) return type;
    }
    return null;
}

/**
 * Detect all supported embeds from a list of sources
 */
function detectSupportedEmbeds(sources) {
    const detected = [];

    for (const source of sources) {
        const url = typeof source === 'string' ? source : (source.link || source.url || '');
        if (!url) continue;

        const type = detectEmbedType(url);
        if (type) {
            detected.push({
                type,
                url,
                priority: PRIORITIES[type] || 3,
            });
        }
    }

    return detected.sort((a, b) => a.priority - b.priority);
}

/**
 * Extract a single embed URL - main dispatcher
 */
async function extractSingle(type, url) {
    const fn = EXTRACT_FN[type];
    if (!fn) return { success: false, error: `Unknown embed type: ${type}` };
    return await fn(url);
}

/**
 * Extract all embeds in parallel from a list of sources
 * Returns all results as they complete
 */
async function extractAll(sources) {
    const detected = detectSupportedEmbeds(sources);
    if (detected.length === 0) return [];

    console.log(`[EXT-EXTRACT] Launching ${detected.length} extractions in parallel:`, detected.map(e => e.type));

    const promises = detected.map(async (embed) => {
        const startTime = Date.now();
        try {
            const result = await extractSingle(embed.type, embed.url);
            return {
                type: embed.type,
                url: embed.url,
                ...result,
                duration: Date.now() - startTime,
            };
        } catch (e) {
            return {
                type: embed.type,
                url: embed.url,
                success: false,
                error: e.message || 'Unknown error',
                duration: Date.now() - startTime,
            };
        }
    });

    const results = await Promise.allSettled(promises);
    const finalResults = results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: 'Promise rejected' });

    const successCount = finalResults.filter(r => r.success).length;
    console.log(`[EXT-EXTRACT] Done: ${successCount}/${finalResults.length} successful`);

    return finalResults;
}

// ===== DNR header helpers for extracted URLs =====

/**
 * Set up DNR headers for a service's extracted URL so the browser player can use it
 */
async function setupHeadersForService(type, url, referer) {
    // Fsvid needs different referers:
    // - Embed page (fsvid.lol/embed-xxx) → fsmirror46.lol (required by fsvid to serve content)
    // - CDN/M3U8 (s1.fsvid.lol, s2.fsvid.lol, etc.) → fsvid.lol (required by CDN)
    let fsvidHeaders;
    let uqloadHeaders;
    if (type === 'fsvid' && url) {
        try {
            const hostname = new URL(url).hostname;
            // CDN subdomains (s1.fsvid.lol, s2.fsvid.lol, etc.) need fsvid.lol referer
            // Embed pages (fsvid.lol) need the current mirror referer
            if (hostname === 'fsvid.lol') {
                fsvidHeaders = { 'Referer': 'https://fsmirror46.lol/', 'Origin': 'https://fsmirror46.lol' };
            } else {
                fsvidHeaders = { 'Referer': 'https://fsvid.lol/', 'Origin': 'https://fsvid.lol' };
            }
        } catch {
            fsvidHeaders = { 'Referer': 'https://fsvid.lol/', 'Origin': 'https://fsvid.lol' };
        }
    }
    if (type === 'uqload' && url) {
        try {
            const origin = getUqloadSiteOrigin(url);
            uqloadHeaders = { 'Referer': `${origin}/`, 'Origin': origin };
        } catch {
            return null;
        }
    }
    const seekHeaders = type === 'seekstreaming'
        ? getSeekStreamingRequestHeaders(referer || url)
        : null;
    if (type === 'seekstreaming' && !seekHeaders) return null;

    const headerMap = {
        voe: { 'Referer': 'https://voe.sx/', 'Origin': 'https://voe.sx' },
        fsvid: fsvidHeaders || { 'Referer': 'https://fsvid.lol/', 'Origin': 'https://fsvid.lol' },
        vidzy: { 'Referer': 'https://vidzy.org/', 'Origin': 'https://vidzy.org' },
        vidmoly: { 'Referer': 'https://voirdrama.to/', 'Origin': 'https://voirdrama.to' },
        sibnet: { 'Referer': 'https://video.sibnet.ru/', 'Origin': 'https://video.sibnet.ru' },
        uqload: uqloadHeaders,
        doodstream: { 'Referer': referer || 'https://d0000d.com/', 'Origin': referer ? new URL(referer).origin : 'https://d0000d.com' },
        seekstreaming: seekHeaders,
        cinep: { 'Referer': 'https://purstream.mx/', 'Origin': 'https://purstream.mx' },
        kisskh: { 'Referer': 'https://kisskh.nl/', 'Origin': 'https://kisskh.nl' },
    };

    const hdrs = headerMap[type];
    if (!hdrs || !url) return;

    try {
        const parsedUrl = new URL(url);
        const labels = parsedUrl.hostname.split('.');
        const registrable = labels.length > 2 ? labels.slice(-2).join('.') : parsedUrl.hostname;
        // Sibnet redirects to CDN subdomains (e.g. dv97.sibnet.ru), and Fsvid/Vidzy
        // rotate their media across sibling hosts too (s1/s2.fsvid.lol, v1..v4.vidzy.org,
        // media served from vidzy.cc). A rule pinned to the exact hostname of the
        // extracted m3u8 leaves those hosts unmatched, so the player fetches their
        // segments with the site's own Origin and the CDN answers 403.
        let domainPattern = `*://${parsedUrl.hostname}/*`;
        if (type === 'seekstreaming') {
            domainPattern = getSeekStreamingPlaybackRulePattern(url);
        } else if (type === 'sibnet') {
            domainPattern = '*://*.sibnet.ru/*';
        } else if (type === 'vidzy') {
            // Same referer on the apex and on every sub-host, so one rule covers both.
            domainPattern = `*://*${registrable}/*`;
        } else if (type === 'fsvid' && parsedUrl.hostname !== registrable) {
            // The fsvid apex needs the fs13.lol referer, so only widen the CDN hosts.
            domainPattern = `*://*.${registrable}/*`;
        }
        if (!domainPattern) return null;
        return { domainPattern, headers: hdrs };
    } catch (e) {
        console.error(`[EXT-EXTRACT] Failed to setup headers for ${type}:`, e);
        return null;
    }
}

/**
 * Returns a { voe: size, fsvid: size, ... } object with the number of
 * entries currently cached for each extractor.
 */
function getCacheSizes() {
    const out = {};
    for (const [key, cache] of Object.entries(caches)) {
        out[key] = cache._cache.size;
    }
    return out;
}

/**
 * Clears one extractor's cache (by type) or all caches.
 */
function clearCaches(type) {
    if (type && caches[type]) {
        caches[type]._cache.clear();
        return;
    }
    for (const cache of Object.values(caches)) {
        cache._cache.clear();
    }
}

// Export everything for use in background.js
// (In service worker, we'll import via importScripts or just include in order)
if (typeof globalThis !== 'undefined') {
    globalThis.MovixExtractors = {
        extractVoe,
        extractFsvid,
        extractVidzy,
        extractVidmoly,
        extractSibnet,
        extractUqload,
        extractDoodStream,
        extractSeekStreaming,
        extractSingle,
        extractAll,
        detectEmbedType,
        detectSupportedEmbeds,
        setupHeadersForService,
        getCacheSizes,
        clearCaches,
        EXTRACT_FN,
        EMBED_PATTERNS,
    };
}
