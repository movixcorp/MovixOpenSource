import { MEDIA_ENTRY_PATH_SOURCE } from './mediaProxyRouting';

/**
 * Runtime bridge injecté dans le WebView AVANT le chargement de la page.
 *
 * Fournit les équivalents de GM_xmlhttpRequest, GM_getValue, GM_setValue,
 * GM_deleteValue et unsafeWindow pour que le userscript fonctionne
 * dans le WebView React Native.
 */

export function buildBridgeRuntime(
  options: {
    mediaProxyRoutingEnabled?: boolean;
    mediaProxyCapabilityEnabled?: boolean;
    mediaProxyXhrRoutingEnabled?: boolean;
    journalConsoleEnabled?: boolean;
    mediaProxyScheme?: string | null;
  } = {},
): string {
  const mediaProxyRoutingEnabled = options.mediaProxyRoutingEnabled !== false;
  const mediaProxyCapabilityEnabled =
    mediaProxyRoutingEnabled && options.mediaProxyCapabilityEnabled === true;
  // WebKit refuse toute sous-requête `http://127.0.0.1` depuis une page https :
  // contrairement à Chromium, il n'applique pas l'exemption « loopback est une
  // origine digne de confiance » du Mixed Content (bugs WebKit 171934 / 218627,
  // toujours ouverts, et aucune dérogation ATS ne s'y substitue). Sur iOS, faire
  // passer les segments par la boucle locale échoue donc systématiquement et
  // coûte deux allers-retours de pont par requête avant de retomber sur
  // GM_FETCH. Le handoff natif (`GM_openMediaProxy` -> AVPlayer, Cast) reste lui
  // valable : il ne transite jamais par le moteur web.
  const mediaProxyXhrRoutingEnabled =
    mediaProxyRoutingEnabled && options.mediaProxyXhrRoutingEnabled !== false;
  // Le renvoi de la console vers le journal est armé à la construction, jamais
  // négocié au démarrage : le runtime injecté ne doit émettre aucun message de
  // pont qui ne soit pas une requête de la page. Éteint, le crochet ne coûte
  // qu'un test booléen et n'émet rien.
  const journalConsoleEnabled = options.journalConsoleEnabled === true;
  // Nom du schéma personnalisé qui remplace la boucle locale là où le moteur
  // web la refuse (WebKit). Vide ailleurs : sur Android la boucle locale marche
  // et n'a besoin d'aucun détour.
  const mediaProxySchemeName = JSON.stringify(
    typeof options.mediaProxyScheme === 'string' && options.mediaProxyScheme
      ? options.mediaProxyScheme
      : null,
  );
  return `
(function() {
  'use strict';

  // Empêche la double-injection
  if (window.__MOVIX_BRIDGE_READY) return;
  window.__MOVIX_BRIDGE_READY = true;

  // --- Pending requests ---
  var _pendingRequests = {};
  var _requestCounter = 0;
  var _nativeWindowFetch =
    typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  var _mediaEntryPath = new RegExp(${JSON.stringify(MEDIA_ENTRY_PATH_SOURCE)}, 'i');
  var _mediaProxyRoutingEnabled = ${mediaProxyRoutingEnabled};
  var _mediaProxyCapabilityEnabled = ${mediaProxyCapabilityEnabled};
  var _mediaProxyXhrRoutingEnabled = ${mediaProxyXhrRoutingEnabled};
  var _mediaProxyCapability = null;
  var _mediaProxyGeneration = null;

  if (_mediaProxyCapabilityEnabled) {
    try {
      if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
        throw new Error('Secure randomness unavailable');
      }
      var capabilityBytes = new Uint8Array(16);
      var generationBytes = new Uint8Array(16);
      window.crypto.getRandomValues(capabilityBytes);
      window.crypto.getRandomValues(generationBytes);
      _mediaProxyCapability = Array.prototype.map.call(
        capabilityBytes,
        function(value) { return value.toString(16).padStart(2, '0'); }
      ).join('');
      _mediaProxyGeneration = Array.prototype.map.call(
        generationBytes,
        function(value) { return value.toString(16).padStart(2, '0'); }
      ).join('');
      if (
        !/^[a-f0-9]{32}$/.test(_mediaProxyCapability)
        || !/^[a-f0-9]{32}$/.test(_mediaProxyGeneration)
      ) {
        throw new Error('Invalid media proxy capability');
      }
    } catch (error) {
      _mediaProxyCapability = null;
      _mediaProxyGeneration = null;
    }
  }

  function generateId() {
    return 'req_' + (++_requestCounter) + '_' + Date.now();
  }

  function sendToNative(message) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
        return true;
      } catch (error) {}
    }
    return false;
  }

  // Réception des réponses du bridge React Native
  window.addEventListener('__MOVIX_BRIDGE_RESPONSE', function(event) {
    var response = event.detail;
    if (!response || !response.id) return;
    var handler = _pendingRequests[response.id];
    if (handler) {
      delete _pendingRequests[response.id];
      handler(response);
    }
  });

  function bridgeRequest(message) {
    return new Promise(function(resolve) {
      var id = generateId();
      message.id = id;
      _pendingRequests[id] = resolve;
      sendToNative(message);

      // Timeout de sécurité (60s)
      setTimeout(function() {
        if (_pendingRequests[id]) {
          delete _pendingRequests[id];
          resolve({ id: id, success: false, error: 'Timeout bridge' });
        }
      }, 60000);
    });
  }

  // LuluStream et Veev lient le jeton de leur manifeste a l'identite du client
  // qui l'a obtenu : leur CDN repond 403 des que celle-ci change entre les deux
  // requetes. Or l'extraction tourne dans la WebView (Chrome Android) alors que
  // la lecture part du natif, deguise en Chrome Windows pour les besoins de
  // Fsvid/Vidzy — deux clients differents, donc jeton refuse. On releve ici
  // l'identite reelle de la WebView et on la joint a la demande ; le natif ne
  // l'applique qu'a cette grappe (voir services/mediaProxyHeaders.ts).
  function webViewIdentityHeaders() {
    var identity = {};
    try {
      if (navigator.userAgent) {
        identity['User-Agent'] = navigator.userAgent;
      }
      // Chrome derive son Accept-Language de navigator.languages : premiere
      // langue sans q, puis q decroissant de 0,1 en 0,1 (plancher 0,1).
      var languages = navigator.languages && navigator.languages.length
        ? [].slice.call(navigator.languages, 0, 10)
        : (navigator.language ? [navigator.language] : []);
      if (languages.length) {
        identity['Accept-Language'] = languages.map(function(language, index) {
          if (index === 0) return language;
          return language + ';q=' + Math.max(0.1, 1 - index * 0.1).toFixed(1);
        }).join(',');
      }
      var client = navigator.userAgentData;
      if (client && client.brands && client.brands.length) {
        identity['Sec-Ch-Ua'] = client.brands.map(function(brand) {
          return '"' + brand.brand + '";v="' + brand.version + '"';
        }).join(', ');
        identity['Sec-Ch-Ua-Mobile'] = client.mobile ? '?1' : '?0';
        identity['Sec-Ch-Ua-Platform'] = '"' + client.platform + '"';
      }
    } catch (e) {}
    return identity;
  }

  // Fusion insensible a la casse : un en-tete pose par l'appelant remplace
  // celui releve sur la WebView au lieu de coexister avec lui.
  function withWebViewIdentity(callerHeaders) {
    var headers = webViewIdentityHeaders();
    var provided = callerHeaders || {};
    for (var name in provided) {
      if (!Object.prototype.hasOwnProperty.call(provided, name)) continue;
      var lowered = name.toLowerCase();
      for (var existing in headers) {
        if (
          Object.prototype.hasOwnProperty.call(headers, existing)
          && existing.toLowerCase() === lowered
        ) {
          delete headers[existing];
        }
      }
      headers[name] = provided[name];
    }
    return headers;
  }

  function requestLocalMediaProxy(details) {
    var message = {
      type: 'GM_OPEN_MEDIA_PROXY',
      url: details.url,
      method: (details.method || 'GET').toUpperCase(),
      headers: withWebViewIdentity(details.headers)
    };
    if (_mediaProxyCapabilityEnabled) {
      if (!_mediaProxyCapability || !_mediaProxyGeneration) {
        return Promise.resolve({
          success: false,
          error: 'Local media proxy unavailable'
        });
      }
      if (!sendToNative({
        type: 'GM_MEDIA_PROXY_REGISTER_CAPABILITY',
        capability: _mediaProxyCapability,
        generation: _mediaProxyGeneration
      })) {
        return Promise.resolve({
          success: false,
          error: 'Local media proxy unavailable'
        });
      }
      message.capability = _mediaProxyCapability;
      message.generation = _mediaProxyGeneration;
    }
    return bridgeRequest(message);
  }

  // --- Base64 helpers ---
  function base64ToArrayBuffer(base64) {
    var binaryString = atob(base64);
    var bytes = new Uint8Array(binaryString.length);
    for (var i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // --- Console de la page vers le journal réseau ---
  // Rien ne remonte autrement : react-native-webview ne publie pas la console
  // dans logcat, et un build release n'expose pas le débogage distant. Armé à
  // la construction : capture éteinte, le crochet n'est même pas posé.
  var _journalOn = ${journalConsoleEnabled};

  function forwardConsole(level, text) {
    if (!_journalOn) return;
    sendToNative({
      type: 'GM_JOURNAL_CONSOLE',
      id: generateId(),
      key: level,
      value: text
    });
  }

  function stringifyConsoleArg(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) {
      return value.message + (value.stack ? '\\n' + value.stack : '');
    }
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  (function hookConsole() {
    if (!_journalOn) return;
    var levels = ['log', 'info', 'warn', 'error', 'debug'];
    for (var i = 0; i < levels.length; i++) {
      (function(level) {
        var original = console[level];
        console[level] = function() {
          try {
            var parts = [];
            for (var a = 0; a < arguments.length; a++) {
              parts.push(stringifyConsoleArg(arguments[a]));
            }
            forwardConsole(level, parts.join(' ').slice(0, 4000));
          } catch (e) {}
          if (typeof original === 'function') {
            return original.apply(console, arguments);
          }
        };
      })(levels[i]);
    }
    // Une promesse rejetée sans catch ne passe par aucun console.*, et c'est
    // souvent la seule trace qu'un lecteur laisse en mourant.
    window.addEventListener('unhandledrejection', function(event) {
      forwardConsole('rejet', stringifyConsoleArg(event && event.reason));
    });
    window.addEventListener('error', function(event) {
      if (!event) return;
      forwardConsole(
        'erreur',
        (event.message || '') + ' @ ' + (event.filename || '') + ':' + (event.lineno || 0)
      );
    });

  })();

  function isLocalMediaProxyCandidate(details) {
    var method = String(details.method || 'GET').toUpperCase();
    var url = String(details.url || '').trim();
    if (method !== 'GET' && method !== 'HEAD') return false;
    if (!/^https:\\/\\//i.test(url)) return false;
    if (/^https:\\/\\/(?:127\\.0\\.0\\.1|localhost)(?::|\\/)/i.test(url)) {
      return false;
    }
    if (!_mediaEntryPath.test(url)) return false;

    var headers = details.headers || {};
    return Object.keys(headers).some(function(key) {
      return /^(?:origin|referer|range)$/i.test(key);
    });
  }

  function responseHeadersToString(headers) {
    var headersStr = '';
    if (headers && typeof headers.forEach === 'function') {
      headers.forEach(function(value, key) {
        headersStr += key + ': ' + value + '\\r\\n';
      });
    }
    return headersStr;
  }

  async function tryLocalMediaProxy(details) {
    if (!_nativeWindowFetch) {
      throw new Error('Native WebView fetch unavailable');
    }

    var upstreamHeaders = {};
    var originalHeaders = details.headers || {};
    for (var upstreamKey in originalHeaders) {
      if (!/^(?:accept|range)$/i.test(upstreamKey)) {
        upstreamHeaders[upstreamKey] = originalHeaders[upstreamKey];
      }
    }

    var openResponse = await requestLocalMediaProxy({
      url: details.url,
      method: details.method,
      headers: upstreamHeaders
    });
    if (!openResponse.success || typeof openResponse.value !== 'string') {
      throw new Error(openResponse.error || 'Local media proxy unavailable');
    }

    var localHeaders = {};
    for (var key in originalHeaders) {
      if (/^(?:accept|range)$/i.test(key)) {
        localHeaders[key] = originalHeaders[key];
      }
    }

    var response = await _nativeWindowFetch(openResponse.value, {
      method: (details.method || 'GET').toUpperCase(),
      headers: localHeaders
    });
    var responseBody;
    if (details.responseType === 'arraybuffer') {
      responseBody = await response.arrayBuffer();
    } else {
      responseBody = await response.text();
    }

    return {
      status: response.status || 0,
      statusText: response.statusText || '',
      responseHeaders: responseHeadersToString(response.headers),
      response: responseBody,
      responseText: typeof responseBody === 'string' ? responseBody : '',
      finalUrl: details.url
    };
  }

  // --- GM_xmlhttpRequest ---
  function sendBridgeRequest(details) {
    // Meme identite que sur le handoff natif : sur iOS le lecteur ne peut pas
    // passer par la boucle locale et ses segments repartent par ici, donc le
    // jeton LuluStream doit y retrouver le client qui l'a obtenu. Les en-tetes
    // poses par l'appelant restent prioritaires, et Fsvid/Vidzy gardent leur
    // deguisement Chrome-desktop, impose cote natif.
    var headers = withWebViewIdentity(details.headers);

    var bodyStr = null;
    if (details.data != null) {
      if (typeof details.data === 'string') {
        bodyStr = details.data;
      } else if (details.data instanceof URLSearchParams) {
        bodyStr = details.data.toString();
      } else {
        bodyStr = String(details.data);
      }
    }

    var message = {
      type: 'GM_FETCH',
      url: details.url,
      method: (details.method || 'GET').toUpperCase(),
      headers: headers,
      body: bodyStr,
      responseType: details.responseType || '',
      timeout: details.timeout || 30000
    };

    bridgeRequest(message).then(function(response) {
      if (!response.success) {
        if (details.onerror) {
          details.onerror({
            error: response.error || 'Requête échouée',
            status: 0,
            statusText: response.error || 'Erreur'
          });
        }
        return;
      }

      var responseBody;
      if (details.responseType === 'arraybuffer' && response.body) {
        responseBody = base64ToArrayBuffer(response.body);
      } else {
        responseBody = response.body || '';
      }

      var headersStr = '';
      if (response.headers) {
        for (var key in response.headers) {
          headersStr += key + ': ' + response.headers[key] + '\\r\\n';
        }
      }

      var gmResponse = {
        status: response.status || 0,
        statusText: response.statusText || '',
        responseHeaders: headersStr,
        response: responseBody,
        responseText: typeof responseBody === 'string' ? responseBody : '',
        finalUrl: response.finalUrl || details.url
      };

      if (details.onload) {
        details.onload(gmResponse);
      }
    });

    return { abort: function() {} };
  }

  function GM_xmlhttpRequest(details) {
    if (!_mediaProxyXhrRoutingEnabled || !isLocalMediaProxyCandidate(details)) {
      return sendBridgeRequest(details);
    }

    var cancelled = false;
    Promise.resolve()
      .then(function() {
        return tryLocalMediaProxy(details);
      })
      .then(function(response) {
        if (!cancelled && details.onload) {
          details.onload(response);
        }
      })
      .catch(function() {
        if (!cancelled) {
          sendBridgeRequest(details);
        }
      });

    return {
      abort: function() {
        cancelled = true;
      }
    };
  }

  async function GM_openMediaProxy(details) {
    if (!_mediaProxyRoutingEnabled) {
      throw new Error('Local media proxy unavailable');
    }
    var openResponse = await requestLocalMediaProxy(details);
    if (!openResponse.success || typeof openResponse.value !== 'string') {
      throw new Error(openResponse.error || 'Local media proxy unavailable');
    }
    return openResponse.value;
  }

  // --- GM_getValue / GM_setValue / GM_deleteValue ---
  // Version synchrone avec cache local + sync async vers le natif
  var _storageCache = {};

  function GM_getValue(key, defaultValue) {
    if (key in _storageCache) {
      return _storageCache[key];
    }
    // Fallback sur localStorage
    try {
      var stored = localStorage.getItem('movix_userscript:' + key);
      if (stored !== null) {
        return JSON.parse(stored);
      }
    } catch(e) {}
    return defaultValue;
  }

  function GM_setValue(key, value) {
    _storageCache[key] = value;
    try {
      localStorage.setItem('movix_userscript:' + key, JSON.stringify(value));
    } catch(e) {}
    // Sync vers natif en arrière-plan
    sendToNative({ type: 'GM_SET_VALUE', id: generateId(), key: key, value: value });
  }

  function GM_deleteValue(key) {
    delete _storageCache[key];
    try {
      localStorage.removeItem('movix_userscript:' + key);
    } catch(e) {}
    sendToNative({ type: 'GM_DELETE_VALUE', id: generateId(), key: key });
  }

  // --- Exposition globale ---
  window.GM_xmlhttpRequest = GM_xmlhttpRequest;
  window.GM_openMediaProxy = GM_openMediaProxy;
  // Une URL de boucle locale n'est jouable par le moteur web que là où il
  // accepte de la joindre. WebKit refuse http://127.0.0.1 depuis une page
  // https (contenu mixte, cf. plus haut), donc sur iOS une URL de proxy local
  // posée sur un élément video est bloquée avant même de partir : le userscript
  // a besoin de le savoir pour ne pas convertir une source jouable en source
  // morte. Le handoff natif, lui, reste valable partout.
  window.__MOVIX_MEDIA_PROXY_WEB_ROUTING__ = _mediaProxyXhrRoutingEnabled;
  // Là où la boucle locale est refusée, un schéma personnalisé la remplace :
  // WebKit route « movix-media:// » vers le natif (MediaProxySchemeHandler),
  // qui relaie vers le proxy local. Le contenu mixte ne s'y applique pas.
  window.__MOVIX_MEDIA_PROXY_SCHEME__ = ${mediaProxySchemeName};
  window.GM_getValue = GM_getValue;
  window.GM_setValue = GM_setValue;
  window.GM_deleteValue = GM_deleteValue;

  // GM.* API (Greasemonkey 4+ compat)
  window.GM = {
    xmlHttpRequest: GM_xmlhttpRequest,
    openMediaProxy: GM_openMediaProxy,
    getValue: function(key, defaultValue) {
      return Promise.resolve(GM_getValue(key, defaultValue));
    },
    setValue: function(key, value) {
      GM_setValue(key, value);
      return Promise.resolve();
    },
    deleteValue: function(key) {
      GM_deleteValue(key);
      return Promise.resolve();
    }
  };

  // unsafeWindow = window (pas de sandboxing dans le WebView)
  window.unsafeWindow = window;

  console.log('[Movix App] Bridge runtime initialisé');
})();
true;
`;
}
