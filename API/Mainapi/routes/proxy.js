/**
 * Proxy route.
 * Extracted from server.js -- raw HTML proxy with domain-specific headers.
 * Mount point: app.use('/proxy', router)
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fsp = require('fs').promises;

const { safeWriteJsonFile } = require('../utils/safeFile');
const { CACHE_DIR } = require('../utils/cacheManager');

// === Routes ===

// GET /* - Proxy route for raw HTML (replaces old /proxy route)
router.get(/^\/(.*)/, async (req, res) => {
  try {
    // Extract the target URL after /
    let targetUrl = req.url.slice(1); // Remove leading '/'

    // Decode the URL recursively if it's encoded (handles double/triple encoding)
    try {
      let decoded = targetUrl;
      let previousDecoded = '';
      // Keep decoding until the URL doesn't change anymore (handles multiple encodings)
      while (decoded !== previousDecoded) {
        previousDecoded = decoded;
        try {
          decoded = decodeURIComponent(decoded);
        } catch (e) {
          // If decoding fails, break the loop
          break;
        }
      }
      targetUrl = decoded;
    } catch (decodeError) {
      // If decoding fails, use the original URL
      console.warn('Failed to decode URL:', targetUrl, decodeError.message);
    }

    // Fix recursive proxying issue - remove any localhost/proxy/ patterns
    const localhostProxyPattern = /localhost(:\d+)?\/proxy\//i;
    if (localhostProxyPattern.test(targetUrl)) {
      console.log(`Detected recursive proxy request in: ${targetUrl}`);
      targetUrl = targetUrl.replace(localhostProxyPattern, '');
      console.log(`Corrected to: ${targetUrl}`);
    }

    // Check if the URL starts with http(s)://, if not, prepend https://
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    // === TVDIRECT SPECIAL HANDLING ===
    if (targetUrl.includes('tvdirect.ddns')) {
      try {
        const cacheKey = crypto.createHash('md5').update(targetUrl).digest('hex');
        // Ensure directory exists
        await fsp.mkdir(CACHE_DIR.TVDIRECT, { recursive: true });
        const cacheFile = path.join(CACHE_DIR.TVDIRECT, `${cacheKey}.json`);

        // Helper to fetch external resource
        const fetchTvDirect = async () => {
          console.log(`[TVDIRECT] Fetching ${targetUrl}`);
          const resp = await axios.get(targetUrl, {
            headers: {
              'User-Agent': 'stremio',
              'Accept': '*/*'
            },
            responseType: 'text',
            timeout: 15000
          });
          return {
            data: resp.data,
            headers: resp.headers,
            timestamp: Date.now()
          };
        };

        // Try to read from cache
        let cachedEntry = null;
        try {
          const fileContent = await fsp.readFile(cacheFile, 'utf8');
          cachedEntry = JSON.parse(fileContent);
        } catch (e) { /* No cache or invalid */ }

        const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
        const now = Date.now();

        if (cachedEntry && cachedEntry.data) {
          // Serve cached response
          if (cachedEntry.headers && cachedEntry.headers['content-type']) {
            res.setHeader('Content-Type', cachedEntry.headers['content-type']);
          }
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.send(cachedEntry.data);

          // Check if stale for background update
          if (now - cachedEntry.timestamp > CACHE_TTL) {
            console.log(`[TVDIRECT] Cache stale for ${targetUrl}, updating in background...`);
            // Background update (no await)
            fetchTvDirect().then(async (newData) => {
              await safeWriteJsonFile(cacheFile, newData);
              console.log(`[TVDIRECT] Background update success for ${targetUrl}`);
            }).catch(err => console.error(`[TVDIRECT] Background update failed: ${err.message}`));
          }
          return; // Exit route
        }

        // No cache, fetch synchronously
        const newData = await fetchTvDirect();
        await safeWriteJsonFile(cacheFile, newData);

        if (newData.headers && newData.headers['content-type']) {
          res.setHeader('Content-Type', newData.headers['content-type']);
        }
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(newData.data);
        return; // Exit route
      } catch (error) {
        console.error(`[TVDIRECT] Error handling request:`, error);
        return res.status(502).json({ error: 'TVDirect proxy failed', details: error.message });
      }
    }

    // Préparer les headers à forwarder
    let refererOrigin;
    let targetHost;
    try {
      const urlObj = new URL(targetUrl);
      refererOrigin = urlObj.origin;
      targetHost = urlObj.host;
    } catch (urlError) {
      // Si l'URL est invalide, utiliser une valeur par défaut
      console.warn('Invalid URL for referer:', targetUrl, urlError.message);
      refererOrigin = 'https://vmwesa.online';
      targetHost = 'vmwesa.online';
    }

    // Headers spécifiques pour vmwesa/vidmoly et certains CDN (ex: getromes.space)
    const isVmwesa = /vmwesa\.online|vidmoly|getromes\.space/i.test(targetUrl);

    // Headers spécifiques pour dropcdn
    const isDropcdn = /dropcdn/i.test(targetUrl);

    // Headers spécifiques pour serversicuro
    const isServersicuro = /serversicuro/i.test(targetUrl);

    // Headers spécifiques pour coflix
    const isCoflix = /coflix\.(bet|si|boo|io)/i.test(targetUrl);

    const headers = isCoflix ? {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.7',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Priority': 'u=0, i',
      'Referer': 'https://coflix.click/',
      'Sec-CH-UA': '"Brave";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Storage-Access': 'none',
      'Sec-GPC': '1',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
    } : isVmwesa ? {
      'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'fr-FR,fr;q=0.8',
      'Connection': 'keep-alive',
      'Host': targetHost,
      'Origin': 'https://vidmoly.net',
      'Referer': 'https://vidmoly.net/',
      'Sec-CH-UA': '"Not;A=Brand";v="99", "Brave";v="139", "Chromium";v="139"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-GPC': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
    } : isDropcdn ? {
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Connection': 'keep-alive',
      'Host': targetHost,
      'Origin': 'https://dropload.tv',
      'Referer': 'https://dropload.tv/',
      'Sec-CH-UA': '"Not;A=Brand";v="99", "Brave";v="139", "Chromium";v="139"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-GPC': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
    } : isServersicuro ? {
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'fr-FR,fr;q=0.8',
      'Connection': 'keep-alive',
      'Host': targetHost,
      'Origin': 'https://supervideo.cc',
      'Referer': 'https://supervideo.cc/',
      'Sec-CH-UA': '"Not;A=Brand";v="99", "Brave";v="139", "Chromium";v="139"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-GPC': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
    } : {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Referer': refererOrigin,
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Encoding': req.headers['accept-encoding'] || 'gzip, deflate, br',
      'Connection': 'keep-alive',
    };
    // Forward Range header if present (important for video streaming)
    if (req.headers['range']) {
      headers['Range'] = req.headers['range'];
    }

    // Détecter si c'est un .m3u8 (playlist HLS)
    const isM3U8 = targetUrl.toLowerCase().includes('.m3u8') || (req.headers.accept && req.headers.accept.includes('application/vnd.apple.mpegurl'));

    // Faire la requête distante avec l'agent de streaming pour le proxy
    const response = await axios({
      method: 'get',
      url: targetUrl,
      responseType: isM3U8 ? 'text' : 'stream',
      headers,
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: status => true, // On gère nous-même les codes d'erreur
      decompress: true // Disable automatic decompression for better performance
    });

    // Copier les headers utiles
    Object.entries(response.headers).forEach(([key, value]) => {
      // Éviter certains headers problématiques
      if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS', 'DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');

    // Si c'est un .m3u8, retourner le contenu original sans modification
    if (isM3U8 && typeof response.data === 'string') {
      const contentType = response.headers['content-type'] || '';
      const bodyText = response.data;

      // Retourner le contenu M3U8 original sans modification
      if (contentType) res.setHeader('content-type', contentType);
      res.status(response.status).send(bodyText);
      return;
    }

    // Gestion du code de retour (206 pour Range, sinon code d'origine)
    res.status(response.status);

    // Détruire le stream upstream si le client se déconnecte pour éviter les fuites mémoire
    const upstream = response.data;
    res.on('close', () => {
      if (!upstream.destroyed) {
        upstream.destroy();
      }
    });

    upstream.on('error', (err) => {
      console.error('Proxy upstream error:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Upstream stream error', message: err.message });
      }
      if (!upstream.destroyed) upstream.destroy();
    });

    upstream.pipe(res);
  } catch (error) {
    console.error('Proxy error:', error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: `Target server responded with ${error.response.status}`,
        message: error.message
      });
    } else if (error.request) {
      res.status(504).json({
        error: 'Gateway Timeout',
        message: 'No response received from target server'
      });
    } else {
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
});

module.exports = router;
