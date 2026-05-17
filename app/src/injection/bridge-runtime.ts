/**
 * Runtime bridge injecté dans le WebView AVANT le chargement de la page.
 *
 * Fournit les équivalents de GM_xmlhttpRequest, GM_getValue, GM_setValue,
 * GM_deleteValue et unsafeWindow pour que le userscript fonctionne
 * dans le WebView React Native.
 */

export function buildBridgeRuntime(): string {
  return `
(function() {
  'use strict';

  // Empêche la double-injection
  if (window.__MOVIX_BRIDGE_READY) return;
  window.__MOVIX_BRIDGE_READY = true;

  // --- Pending requests ---
  var _pendingRequests = {};
  var _requestCounter = 0;

  function generateId() {
    return 'req_' + (++_requestCounter) + '_' + Date.now();
  }

  function sendToNative(message) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
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

  // --- Base64 helpers ---
  function base64ToArrayBuffer(base64) {
    var binaryString = atob(base64);
    var bytes = new Uint8Array(binaryString.length);
    for (var i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // --- GM_xmlhttpRequest ---
  function GM_xmlhttpRequest(details) {
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
  window.GM_getValue = GM_getValue;
  window.GM_setValue = GM_setValue;
  window.GM_deleteValue = GM_deleteValue;

  // GM.* API (Greasemonkey 4+ compat)
  window.GM = {
    xmlHttpRequest: GM_xmlhttpRequest,
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

  // --- Bridge des téléchargements custom (Android only) ----------------
  // Expose window.MovixBridge avec :
  //   isApp: true            — sentinelle de détection app
  //   platform: 'android'    — info plateforme
  //   download: {            — API des téléchargements in-app
  //     start, pause, resume, cancel, delete, list, get,
  //     subscribe(cb) → unsubscribe
  //   }
  //
  // Toutes les méthodes retournent une Promise. Le bridge utilise un canal
  // séparé (MOVIX_DOWNLOAD_* / __MOVIX_DOWNLOAD_RESPONSE) du canal GM_*.

  var _downloadPending = {};
  var _downloadCounter = 0;
  function _downloadGenerateId() {
    return 'dl_' + (++_downloadCounter) + '_' + Date.now();
  }

  window.addEventListener('__MOVIX_DOWNLOAD_RESPONSE', function(event) {
    var detail = event.detail;
    if (!detail || !detail.id) return;
    var handler = _downloadPending[detail.id];
    if (handler) {
      delete _downloadPending[detail.id];
      if (detail.ok) handler.resolve(detail.payload);
      else handler.reject(new Error(detail.error || 'Download bridge error'));
    }
  });

  function _downloadRequest(type, payload) {
    return new Promise(function(resolve, reject) {
      var id = _downloadGenerateId();
      _downloadPending[id] = { resolve: resolve, reject: reject };
      sendToNative({ type: type, id: id, payload: payload || null });
      setTimeout(function() {
        if (_downloadPending[id]) {
          delete _downloadPending[id];
          reject(new Error('Download bridge timeout'));
        }
      }, 30000);
    });
  }

  var _downloadSubscribers = [];
  window.addEventListener('__MOVIX_DOWNLOAD_EVENT', function(event) {
    var detail = event.detail;
    if (!detail) return;
    for (var i = 0; i < _downloadSubscribers.length; i++) {
      try { _downloadSubscribers[i](detail); } catch (e) {}
    }
  });

  function downloadSubscribe(cb) {
    if (typeof cb !== 'function') return function() {};
    _downloadSubscribers.push(cb);
    return function() {
      var idx = _downloadSubscribers.indexOf(cb);
      if (idx >= 0) _downloadSubscribers.splice(idx, 1);
    };
  }

  window.MovixBridge = {
    isApp: true,
    platform: 'android',
    version: 1,
    download: {
      start: function(opts) { return _downloadRequest('MOVIX_DOWNLOAD_START', opts); },
      pause: function(id) { return _downloadRequest('MOVIX_DOWNLOAD_PAUSE', { downloadId: id }); },
      resume: function(id) { return _downloadRequest('MOVIX_DOWNLOAD_RESUME', { downloadId: id }); },
      cancel: function(id) { return _downloadRequest('MOVIX_DOWNLOAD_CANCEL', { downloadId: id }); },
      delete: function(id) { return _downloadRequest('MOVIX_DOWNLOAD_DELETE', { downloadId: id }); },
      launch: function(id) { return _downloadRequest('MOVIX_DOWNLOAD_LAUNCH', { downloadId: id }); },
      list: function() { return _downloadRequest('MOVIX_DOWNLOAD_LIST', null); },
      get: function(id) { return _downloadRequest('MOVIX_DOWNLOAD_GET', { downloadId: id }); },
      subscribe: downloadSubscribe,
    },
  };

  console.log('[Movix App] Bridge runtime initialisé');
})();
true;
`;
}
