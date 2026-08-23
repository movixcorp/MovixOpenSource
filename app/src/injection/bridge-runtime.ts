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
  } = {},
): string {
  const mediaProxyRoutingEnabled = options.mediaProxyRoutingEnabled !== false;
  const mediaProxyCapabilityEnabled =
    mediaProxyRoutingEnabled && options.mediaProxyCapabilityEnabled === true;
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

  function requestLocalMediaProxy(details) {
    var message = {
      type: 'GM_OPEN_MEDIA_PROXY',
      url: details.url,
      method: (details.method || 'GET').toUpperCase(),
      headers: details.headers || {}
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
    var headers = details.headers || {};

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
    if (!_mediaProxyRoutingEnabled || !isLocalMediaProxyCandidate(details)) {
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
