const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const zlib = require('node:zlib');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { createBundleRegistry } = require('./bundleRegistry');
const { KisskhError } = require('./errors');
const { computeKkey } = require('./kkey');

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;
const KISSKH_METADATA_MAX_ATTEMPTS = 3;
const MAX_SEARCH_LENGTH = 200;

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function isPublicIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function expandIpv6(address) {
  let input = address.toLowerCase().split('%')[0];
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const ipv4 = input.slice(lastColon + 1);
    if (!net.isIPv4(ipv4)) return null;
    const octets = ipv4.split('.').map(Number);
    input = `${input.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const zeros = 8 - left.length - right.length;
  if (zeros < 0 || (halves.length === 2 && zeros < 1)) return null;
  const words = [...left, ...Array(zeros).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

function isPublicIpv6(address) {
  const words = expandIpv6(address);
  if (!words) return false;
  if (words.every((word) => word === 0)) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return false;
  if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) return false;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPublicIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  return (words[0] & 0xe000) === 0x2000;
}

function isPublicIp(address) {
  if (net.isIPv4(address)) return isPublicIpv4(address);
  if (net.isIPv6(address)) return isPublicIpv6(address);
  return false;
}

function normalizeDnsAnswers(answers) {
  return (Array.isArray(answers) ? answers : [answers])
    .map((answer) => typeof answer === 'string' ? answer : answer?.address)
    .filter(Boolean);
}

async function defaultResolveDns(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

function validateMetadataUrl(value, allowedHosts) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new KisskhError('provider_security', 'URL KissKH non autorisee');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new KisskhError('provider_security', 'URL KissKH non autorisee');
  }
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)
      || (url.port && url.port !== '443') || url.username || url.password || url.hash) {
    throw new KisskhError('provider_security', 'URL KissKH non autorisee');
  }
  return url;
}

function createPinnedLookup(addresses) {
  const pins = addresses.map((address) => ({ address, family: net.isIP(address) }));
  return (_hostname, options, callback) => {
    const settings = typeof options === 'object' && options ? options : { family: Number(options) || 0 };
    const candidates = settings.family ? pins.filter((pin) => pin.family === settings.family) : pins;
    if (!candidates.length) {
      const error = new Error('Adresse KissKH indisponible');
      error.code = 'ENOTFOUND';
      callback(error);
      return;
    }
    if (settings.all) callback(null, candidates.map((pin) => ({ ...pin })));
    else callback(null, candidates[0].address, candidates[0].family);
  };
}

function createMetadataSocksAgent(proxy, timeout, Agent = SocksProxyAgent) {
  if (!proxy || typeof proxy !== 'object') throw new TypeError('proxy KissKH invalide');
  const proxyType = String(proxy.type || 'socks5').trim().toLowerCase().replace(/:$/, '');
  const host = String(proxy.host || '').trim();
  const port = Number(proxy.port);
  if (!['socks', 'socks5', 'socks5h'].includes(proxyType)
      || !host || /[\s/?#@]/.test(host)
      || !Number.isSafeInteger(port) || port <= 0 || port > 65_535
      || typeof Agent !== 'function') {
    throw new TypeError('proxy KissKH invalide');
  }
  const proxyHost = net.isIPv6(host) ? `[${host}]` : host;
  const proxyUrl = new URL(`socks5h://${proxyHost}:${port}`);
  if (proxy.auth) {
    const auth = String(proxy.auth);
    const separator = auth.indexOf(':');
    proxyUrl.username = separator === -1 ? auth : auth.slice(0, separator);
    proxyUrl.password = separator === -1 ? '' : auth.slice(separator + 1);
  }
  return new Agent(proxyUrl, { timeout });
}

function decoderFor(contentEncoding) {
  const encoding = String(contentEncoding || 'identity').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return new PassThrough();
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip();
  if (encoding === 'deflate') return zlib.createInflate();
  if (encoding === 'br') return zlib.createBrotliDecompress();
  throw new KisskhError('provider_security', 'Encodage KissKH non autorise');
}

function createDefaultRequest(deps = {}) {
  const requestHttps = deps.request || https.request;
  const Agent = deps.SocksProxyAgent || SocksProxyAgent;
  if (typeof requestHttps !== 'function' || typeof Agent !== 'function') {
    throw new TypeError('transport KissKH invalide');
  }
  return (options) => new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const maxCompressedBytes = options.maxCompressedBytes;
    const maxDecompressedBytes = options.maxDecompressedBytes;
    const contentChunks = [];
    let compressedBytes = 0;
    let decompressedBytes = 0;
    let response;
    let settled = false;
    let timer;
    if (!Array.isArray(options.addresses) || !options.addresses.length
        || options.addresses.some((address) => !isPublicIp(address))) {
      throw new KisskhError('provider_security', 'Adresse KissKH non publique');
    }
    const destinationAddress = options.addresses[0];
    const agent = options.proxy ? createMetadataSocksAgent(options.proxy, options.timeout, Agent) : null;
    const headers = { ...options.headers };
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'host') delete headers[name];
    }
    headers.Host = url.hostname;
    const requestOptions = {
      protocol: 'https:',
      hostname: agent ? url.hostname : destinationAddress,
      port: 443,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      agent: agent || false,
      headers,
    };
    if (!agent) requestOptions.lookup = createPinnedLookup([destinationAddress]);
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (response && !response.destroyed) response.destroy();
      if (request && !request.destroyed) request.destroy();
      reject(error);
    };
    const request = requestHttps(requestOptions, (incoming) => {
      response = incoming;
      const declared = getHeader(response.headers, 'content-length');
      if (declared !== null && (!/^\d+$/.test(String(declared)) || Number(declared) > maxCompressedBytes)) {
        finishReject(new KisskhError('provider_security', 'Reponse KissKH trop volumineuse'));
        return;
      }
      let decoder;
      try {
        decoder = decoderFor(getHeader(response.headers, 'content-encoding'));
      } catch (error) {
        finishReject(error);
        return;
      }
      response.on('data', (chunk) => {
        compressedBytes += Buffer.byteLength(chunk);
        if (compressedBytes > maxCompressedBytes) {
          finishReject(new KisskhError('provider_security', 'Reponse KissKH trop volumineuse'));
        }
      });
      response.on('error', finishReject);
      decoder.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        decompressedBytes += buffer.length;
        if (decompressedBytes > maxDecompressedBytes) {
          finishReject(new KisskhError('provider_security', 'Reponse KissKH trop volumineuse'));
          return;
        }
        contentChunks.push(buffer);
      });
      decoder.on('error', finishReject);
      decoder.on('end', () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          status: Number(response.statusCode),
          headers: response.headers,
          data: Buffer.concat(contentChunks, decompressedBytes).toString('utf8'),
          compressedBytes,
          decompressedBytes,
        });
      });
      response.pipe(decoder);
    });
    request.on('error', finishReject);
    request.setTimeout(options.timeout, () => finishReject(new Error('metadata timeout')));
    timer = setTimeout(() => finishReject(new Error('metadata timeout')), options.timeout);
    request.end();
  });
}

function readBoundedJson(response, { allowImagePng = false } = {}) {
  for (const value of [response?.compressedBytes, response?.decompressedBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > MAX_JSON_BYTES)) {
      throw new KisskhError('provider_security', 'Reponse KissKH trop volumineuse');
    }
  }
  const declared = getHeader(response?.headers, 'content-length');
  if (declared !== null && declared !== undefined
      && (!/^\d+$/.test(String(declared)) || Number(declared) > MAX_JSON_BYTES)) {
    throw new KisskhError('provider_security', 'Reponse KissKH trop volumineuse');
  }
  const contentType = getHeader(response?.headers, 'content-type');
  const normalizedContentType = String(contentType || '');
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(normalizedContentType)
      && !(allowImagePng && /^image\/png(?:\s*;|$)/i.test(normalizedContentType))) {
    throw new KisskhError('provider_security', 'Reponse KissKH invalide');
  }
  if (typeof response?.data === 'string' || Buffer.isBuffer(response?.data)) {
    const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data, 'utf8');
    if (buffer.length > MAX_JSON_BYTES) throw new KisskhError('provider_security', 'Reponse KissKH trop volumineuse');
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new KisskhError('provider_unavailable', 'Reponse KissKH invalide');
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(response?.data);
  } catch {
    throw new KisskhError('provider_unavailable', 'Reponse KissKH invalide');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) {
    throw new KisskhError('provider_security', 'Reponse KissKH trop volumineuse');
  }
  return response.data;
}

function invalidInput() {
  return new KisskhError('invalid_input', 'Parametre KissKH invalide');
}

function assertPositiveId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidInput();
}

function createKisskhClient(deps = {}) {
  const allowedHostValues = deps.allowedHosts || ['kisskh.nl'];
  if (!Array.isArray(allowedHostValues) || !allowedHostValues.length || allowedHostValues.length > 16) {
    throw new TypeError('allowlist KissKH invalide');
  }
  const allowedHosts = new Set(allowedHostValues.map((host) => String(host).toLowerCase()));
  if (allowedHosts.size !== allowedHostValues.length
      || [...allowedHosts].some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))) {
    throw new TypeError('allowlist KissKH invalide');
  }
  const baseUrl = validateMetadataUrl(deps.baseUrl || 'https://kisskh.nl', allowedHosts);
  if (baseUrl.pathname !== '/' || baseUrl.search) throw new TypeError('baseUrl KissKH invalide');
  const proxyPolicy = deps.proxyPolicy;
  if (!proxyPolicy || ['reserve', 'reserveGlobal', 'recordSuccess', 'recordFailure', 'record429', 'assertCircuitClosed']
    .some((name) => typeof proxyPolicy[name] !== 'function')) {
    throw new TypeError('policy proxy KissKH invalide');
  }
  const request = deps.request || createDefaultRequest();
  const resolveDns = deps.resolveDns || defaultResolveDns;
  const bundleRegistry = deps.bundleRegistry || createBundleRegistry();
  const calculateKkey = deps.computeKkey || computeKkey;
  const timeout = deps.timeout === undefined ? DEFAULT_TIMEOUT_MS : deps.timeout;
  const maxAttempts = deps.maxAttempts === undefined ? KISSKH_METADATA_MAX_ATTEMPTS : deps.maxAttempts;
  if (typeof request !== 'function' || typeof resolveDns !== 'function'
      || !Number.isSafeInteger(timeout) || timeout <= 0
      || !Number.isSafeInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > KISSKH_METADATA_MAX_ATTEMPTS
      || typeof bundleRegistry?.resolveApprovedAlgorithm !== 'function' || typeof calculateKkey !== 'function') {
    throw new TypeError('client KissKH invalide');
  }
  const referer = `${baseUrl.origin}/`;
  async function validateDns(url) {
    let answers;
    try {
      answers = normalizeDnsAnswers(await resolveDns(url.hostname));
    } catch {
      throw new KisskhError('provider_unavailable', 'KissKH indisponible');
    }
    if (!answers.length || answers.some((address) => !isPublicIp(address))) {
      throw new KisskhError('provider_security', 'Adresse KissKH non publique');
    }
    return answers;
  }

  async function requestWithRedirects(initialUrl, proxy) {
    let current = validateMetadataUrl(initialUrl, allowedHosts);
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const addresses = await validateDns(current);
      await proxyPolicy.reserveGlobal();
      await proxyPolicy.assertCircuitClosed();
      const response = await request({
        url: current.href,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
          Referer: referer,
          'User-Agent': 'Movix-KissKH-Metadata/1.0',
        },
        timeout,
        redirect: 'manual',
        maxCompressedBytes: MAX_JSON_BYTES,
        maxDecompressedBytes: MAX_JSON_BYTES,
        addresses,
        proxy,
      });
      const status = Number(response?.status);
      if (status >= 300 && status < 400) {
        if (redirectCount === MAX_REDIRECTS) throw new KisskhError('provider_security', 'Trop de redirections KissKH');
        const location = getHeader(response.headers, 'location');
        if (typeof location !== 'string' || !location || /[\r\n]/.test(location)) {
          throw new KisskhError('provider_security', 'Redirection KissKH invalide');
        }
        current = validateMetadataUrl(new URL(location, current).href, allowedHosts);
        continue;
      }
      return response;
    }
    throw new KisskhError('provider_security', 'Trop de redirections KissKH');
  }

  async function execute(pathname) {
    const allowImagePng = /^\/api\/DramaList\/Episode\/\d+\.png(?:\?|$)/.test(pathname);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const proxy = await proxyPolicy.reserve();
      if (!proxy) throw new KisskhError('provider_unavailable', 'Proxy KissKH indisponible');
      let response;
      try {
        response = await requestWithRedirects(new URL(pathname, baseUrl).href, proxy);
      } catch (error) {
        if (error instanceof KisskhError
            && ['provider_rate_limited', 'provider_security'].includes(error.code)) throw error;
        const kind = error?.code === 'ETIMEDOUT' || /timeout/i.test(String(error?.message || '')) ? 'timeout' : 'transport';
        await proxyPolicy.recordFailure(proxy, kind);
        if (attempt + 1 === maxAttempts) throw new KisskhError('provider_unavailable', 'KissKH indisponible');
        continue;
      }
      const status = Number(response?.status);
      if (status === 429) {
        await proxyPolicy.record429(proxy, response.headers || {});
        if (attempt + 1 === maxAttempts) {
          throw new KisskhError('provider_rate_limited', 'KissKH temporairement limite');
        }
        continue;
      }
      if (status === 408 || (status >= 500 && status < 600)) {
        await proxyPolicy.recordFailure(proxy, 'transport');
        if (attempt + 1 === maxAttempts) throw new KisskhError('provider_unavailable', 'KissKH indisponible');
        continue;
      }
      if (status < 200 || status >= 300) {
        throw new KisskhError('provider_unavailable', 'KissKH indisponible');
      }
      const data = readBoundedJson(response, { allowImagePng });
      await proxyPolicy.recordSuccess(proxy);
      return data;
    }
    throw new KisskhError('provider_unavailable', 'KissKH indisponible');
  }

  async function episodePath(context, episodeId) {
    assertPositiveId(episodeId);
    let algorithm;
    try {
      algorithm = await bundleRegistry.resolveApprovedAlgorithm();
    } catch (error) {
      if (error instanceof KisskhError) throw error;
      throw new KisskhError('provider_unavailable', 'KissKH indisponible');
    }
    let kkey;
    try {
      kkey = calculateKkey({ context, episodeId, algorithm });
    } catch {
      throw new KisskhError('provider_changed', 'Version KissKH non approuvee');
    }
    if (context === 'episode') {
      return `/api/DramaList/Episode/${episodeId}.png?err=false&ts=null&time=null&kkey=${encodeURIComponent(kkey)}`;
    }
    return `/api/Sub/${episodeId}?kkey=${encodeURIComponent(kkey)}`;
  }

  return Object.freeze({
    async list(page = 1, pageSize = 100, type = 0) {
      if (!Number.isSafeInteger(page) || page <= 0
          || !Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > 100
          || !Number.isSafeInteger(type) || type < 0 || type > 4) throw invalidInput();
      const search = new URLSearchParams({
        type: String(type),
        page: String(page),
        pageSize: String(pageSize),
      });
      return execute(`/api/DramaList/List?${search}`);
    },
    async search(query, type = 0) {
      if (typeof query !== 'string' || !query.trim() || query.length > MAX_SEARCH_LENGTH || /[\r\n]/.test(query)) {
        throw invalidInput();
      }
      if (!Number.isSafeInteger(type) || type < 0 || type > 4) throw invalidInput();
      const search = new URLSearchParams({ q: query.trim(), type: String(type) });
      return execute(`/api/DramaList/Search?${search}`);
    },
    async getDrama(dramaId) {
      assertPositiveId(dramaId);
      return execute(`/api/DramaList/Drama/${dramaId}?isq=false`);
    },
    async getEpisode(episodeId) {
      return execute(await episodePath('episode', episodeId));
    },
    async getSubtitles(episodeId) {
      return execute(await episodePath('sub', episodeId));
    },
  });
}

module.exports = { createDefaultRequest, createKisskhClient };
