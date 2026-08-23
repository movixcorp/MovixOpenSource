export type PictureInPictureShimMode =
  | 'disabled'
  | 'android'
  | 'ios-native-v1';

/** Injects the browser PiP surface backed by the selected native implementation. */
export function buildPictureInPictureShim(
  mode: PictureInPictureShimMode,
): string {
  return `
(function() {
  'use strict';
  var mode = ${JSON.stringify(mode)};
  if (mode === 'disabled') return;
  if (mode !== 'android' && mode !== 'ios-native-v1') return;

  var nativeWebView = window.ReactNativeWebView;
  if (!nativeWebView || typeof nativeWebView.postMessage !== 'function') return;
  if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') return;
  if (typeof HTMLVideoElement !== 'function') return;
  if (mode === 'android' && window.__MOVIX_ANDROID_PIP_INSTALLED__) return;
  if (mode === 'ios-native-v1' && window.__MOVIX_IOS_NATIVE_PIP_V1_INSTALLED__) return;

  var capabilityBytes = new Uint8Array(16);
  try {
    window.crypto.getRandomValues(capabilityBytes);
  } catch (error) {
    return;
  }
  var capability = Array.prototype.map.call(capabilityBytes, function(value) {
    return value.toString(16).padStart(2, '0');
  }).join('');
  if (!/^[a-f0-9]{32}$/.test(capability)) return;

  var videoPrototype = HTMLVideoElement.prototype;
  var originalRequestPictureInPicture =
    typeof videoPrototype.requestPictureInPicture === 'function'
      ? videoPrototype.requestPictureInPicture
      : null;
  var originalWebkitSupportsPresentationMode =
    typeof videoPrototype.webkitSupportsPresentationMode === 'function'
      ? videoPrototype.webkitSupportsPresentationMode
      : null;
  var originalWebkitSetPresentationMode =
    typeof videoPrototype.webkitSetPresentationMode === 'function'
      ? videoPrototype.webkitSetPresentationMode
      : null;
  var originalExitPictureInPicture =
    typeof document.exitPictureInPicture === 'function'
      ? document.exitPictureInPicture
      : null;

  if (mode === 'android') window.__MOVIX_ANDROID_PIP_INSTALLED__ = true;
  else window.__MOVIX_IOS_NATIVE_PIP_V1_INSTALLED__ = true;

  var nativePostMessage = nativeWebView.postMessage.bind(nativeWebView);
  var pending = Object.create(null);
  var sequence = 0;
  var selectedVideo = null;
  var enteredVideo = null;
  var styleElement = null;
  var markedTargets = [];
  var markedAncestors = [];
  var mediaAssociations = new WeakMap();
  var publisherActive = true;
  var iosHandoff = null;
  var MAX_POSITION_SEC = 366 * 86400;
  var CSS = [
    'html.movix-native-pip,html.movix-native-pip body{background:#000!important;overflow:hidden!important}',
    'html.movix-native-pip body *{visibility:hidden!important}',
    'html.movix-native-pip [data-movix-native-pip-ancestor]{visibility:visible!important;overflow:visible!important;transform:none!important;clip:auto!important;opacity:1!important}',
    'html.movix-native-pip video[data-movix-native-pip-target]{visibility:visible!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:contain!important;background:#000!important;z-index:2147483647!important}',
  ].join('');

  function postNative(message) {
    try {
      nativePostMessage(JSON.stringify(message));
      return true;
    } catch (error) {
      return false;
    }
  }

  function registerCapability() {
    return postNative({
      type: 'PIPSHIM_REGISTER_CAPABILITY',
      capability: capability,
    });
  }

  function makeError(name) {
    return new DOMException('', name);
  }

  function randomOpaqueId() {
    var bytes = new Uint8Array(16);
    try {
      window.crypto.getRandomValues(bytes);
    } catch (error) {
      return null;
    }
    var value = Array.prototype.map.call(bytes, function(byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
    return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
  }

  function nextRequestId() {
    sequence = (sequence + 1) % 0x7fffffff;
    return 'pip-' + sequence + '-' + Date.now();
  }

  function connectedVideo(video) {
    return video instanceof HTMLVideoElement && video.isConnected === true;
  }

  function ownedConnectedVideo(video) {
    return connectedVideo(video) && video.ownerDocument === document;
  }

  function canonicalLoopbackUrl(value) {
    if (
      typeof value !== 'string'
      || /[\\u0000-\\u0020\\u007f\\\\]/.test(value)
    ) {
      return false;
    }
    var match = /^http:\\/\\/127\\.0\\.0\\.1:([1-9]\\d{0,4})\\/p\\/[A-Za-z0-9_-]{43}\\/[A-Za-z0-9_-]{43}\\/[A-Za-z0-9_-]{43}$/.exec(value);
    if (!match) return false;
    var port = Number(match[1]);
    return port >= 1 && port <= 65535 && String(port) === match[1];
  }

  function validKind(kind) {
    return kind === 'hls' || kind === 'mp4';
  }

  function publishMediaSource(video, url, kind) {
    if (
      !publisherActive
      || !ownedConnectedVideo(video)
      || !canonicalLoopbackUrl(url)
      || !validKind(kind)
    ) {
      return null;
    }
    var generation = randomOpaqueId();
    if (!generation) return null;
    mediaAssociations.set(video, {
      generation: generation,
      kind: kind,
      url: url,
    });
    return generation;
  }

  function clearMediaSource(video, generation) {
    if (
      !publisherActive
      || !(video instanceof HTMLVideoElement)
      || typeof generation !== 'string'
    ) {
      return false;
    }
    var association = mediaAssociations.get(video);
    if (!association || association.generation !== generation) return false;
    mediaAssociations.delete(video);
    return true;
  }

  if (mode === 'ios-native-v1') {
    var publisher = Object.freeze({
      publish: publishMediaSource,
      clear: clearMediaSource,
    });
    try {
      Object.defineProperty(window, '__MOVIX_NATIVE_MEDIA_SOURCE_V1__', {
        value: publisher,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } catch (error) {
      return;
    }
    if (window.__MOVIX_NATIVE_MEDIA_SOURCE_V1__ !== publisher) return;
  }

  function applyNativeAction(action) {
    var video = enteredVideo;
    if (!connectedVideo(video)) return;
    if (action === 'seek-backward') {
      video.currentTime = Math.max(0, Number(video.currentTime || 0) - 10);
      return;
    }
    if (action === 'seek-forward') {
      var forward = Number(video.currentTime || 0) + 10;
      video.currentTime = Number.isFinite(video.duration)
        ? Math.min(video.duration, forward)
        : forward;
      return;
    }
    if (action !== 'toggle-playback') return;
    if (video.paused || video.ended) {
      try {
        var result = video.play();
        if (result && typeof result.catch === 'function') result.catch(function() {});
      } catch (error) {}
    } else {
      video.pause();
    }
  }

  function selectVideo(preferred) {
    if (connectedVideo(preferred)) return preferred;
    var videos = document.querySelectorAll('video');
    for (var index = 0; index < videos.length; index += 1) {
      var video = videos[index];
      if (connectedVideo(video) && video.paused === false && video.ended === false) {
        return video;
      }
    }
    return null;
  }

  function dispatchVideoEvent(video, type) {
    if (video) video.dispatchEvent(new CustomEvent(type));
  }

  function clearMarkers() {
    for (var targetIndex = 0; targetIndex < markedTargets.length; targetIndex += 1) {
      markedTargets[targetIndex].removeAttribute('data-movix-native-pip-target');
    }
    markedTargets = [];
    for (var ancestorIndex = 0; ancestorIndex < markedAncestors.length; ancestorIndex += 1) {
      markedAncestors[ancestorIndex].removeAttribute('data-movix-native-pip-ancestor');
    }
    markedAncestors = [];
  }

  function removeAndroidPresentation() {
    var root = document.documentElement;
    if (root) root.classList.remove('movix-native-pip');
    clearMarkers();
    if (styleElement && styleElement.parentNode) {
      styleElement.parentNode.removeChild(styleElement);
    }
    styleElement = null;
    if (enteredVideo) dispatchVideoEvent(enteredVideo, 'leavepictureinpicture');
    enteredVideo = null;
    selectedVideo = null;
  }

  function applyAndroidPresentation() {
    var video = selectVideo(selectedVideo);
    if (!video) {
      removeAndroidPresentation();
      return null;
    }
    clearMarkers();
    selectedVideo = video;
    var root = document.documentElement;
    if (root) root.classList.add('movix-native-pip');
    video.setAttribute('data-movix-native-pip-target', '');
    markedTargets.push(video);
    for (var ancestor = video.parentElement; ancestor; ancestor = ancestor.parentElement) {
      ancestor.setAttribute('data-movix-native-pip-ancestor', '');
      markedAncestors.push(ancestor);
    }
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.textContent = CSS;
      (document.head || root).appendChild(styleElement);
    }
    return video;
  }

  function rejectPending(id, name) {
    var request = pending[id];
    if (!request) return;
    delete pending[id];
    clearTimeout(request.timeout);
    request.reject(makeError(name));
  }

  function rejectAll(name) {
    Object.keys(pending).forEach(function(id) {
      rejectPending(id, name);
    });
  }

  function requestAndroid(type, video) {
    return new Promise(function(resolve, reject) {
      var id = nextRequestId();
      var timeout = setTimeout(function() {
        var request = pending[id];
        if (!request) return;
        delete pending[id];
        reject(makeError('AbortError'));
      }, 5000);
      pending[id] = { resolve: resolve, reject: reject, timeout: timeout };
      if (
        !registerCapability()
        || !postNative({ type: type, id: id, capability: capability })
      ) {
        delete pending[id];
        clearTimeout(timeout);
        reject(makeError('NotAllowedError'));
        return;
      }
      if (type === 'PIPSHIM_ENTER') selectedVideo = selectVideo(video);
    });
  }

  function canonicalHttpsPoster(value) {
    if (
      typeof value !== 'string'
      || value.length === 0
      || value.length > 16384
      || /[\\u0000-\\u0020\\u007f\\\\]/.test(value)
    ) {
      return null;
    }
    try {
      var parsed = new URL(value);
      if (
        parsed.protocol !== 'https:'
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.hostname === ''
        || parsed.href !== value
      ) {
        return null;
      }
      return value;
    } catch (error) {
      return null;
    }
  }

  function finitePosition(value) {
    var position = Number(value);
    if (!Number.isFinite(position)) return 0;
    return Math.min(MAX_POSITION_SEC, Math.max(0, position));
  }

  function boundedPlaybackRate(value) {
    var rate = Number(value);
    return Number.isFinite(rate) && rate >= 0.25 && rate <= 4 ? rate : 1;
  }

  function sourceSnapshotFor(video) {
    if (!ownedConnectedVideo(video)) return null;
    var direct = typeof video.currentSrc === 'string' ? video.currentSrc : '';
    var association = mediaAssociations.get(video);
    var fromDirect = canonicalLoopbackUrl(direct);
    if (fromDirect) {
      if (!association || association.url !== direct) {
        var directGeneration = randomOpaqueId();
        if (!directGeneration) return null;
        association = {
          generation: directGeneration,
          kind: 'hls',
          url: direct,
        };
        mediaAssociations.set(video, association);
      }
    } else if (!association || !canonicalLoopbackUrl(association.url)) {
      return null;
    }
    return {
      associationGeneration: association.generation,
      fromDirect: fromDirect,
      source: {
        protocolVersion: 1,
        url: association.url,
        positionSec: finitePosition(video.currentTime),
        paused: video.paused === true,
        playbackRate: boundedPlaybackRate(video.playbackRate),
        muted: video.muted === true,
      },
    };
  }

  function addPreparedMetadata(source, video) {
    var title = String(document.title || '').slice(0, 256);
    if (title) source.title = title;
    var poster = canonicalHttpsPoster(video.poster || '');
    if (poster) source.poster = poster;
    return source;
  }

  function associationMatches(handoff, requireConnected) {
    if (!handoff || handoff.capability !== capability) return false;
    var video = handoff.video;
    if (!(video instanceof HTMLVideoElement) || video.ownerDocument !== document) return false;
    if (requireConnected && video.isConnected !== true) return false;
    var association = mediaAssociations.get(video);
    if (
      !association
      || association.generation !== handoff.associationGeneration
      || association.url !== handoff.url
    ) {
      return false;
    }
    return !handoff.fromDirect || video.currentSrc === handoff.url;
  }

  function fallbackRequest(video) {
    if (originalRequestPictureInPicture) {
      try {
        return Promise.resolve(Reflect.apply(originalRequestPictureInPicture, video, []));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (originalWebkitSupportsPresentationMode && originalWebkitSetPresentationMode) {
      try {
        var supported = Reflect.apply(
          originalWebkitSupportsPresentationMode,
          video,
          ['picture-in-picture'],
        );
        if (supported === true) {
          Reflect.apply(
            originalWebkitSetPresentationMode,
            video,
            ['picture-in-picture'],
          );
          return Promise.resolve(video);
        }
      } catch (error) {}
    }
    return Promise.reject(makeError('NotSupportedError'));
  }

  function requestIos(video) {
    if (!ownedConnectedVideo(video)) return Promise.reject(makeError('InvalidStateError'));
    var snapshot = sourceSnapshotFor(video);
    if (!snapshot) return fallbackRequest(video);
    if (iosHandoff) return Promise.reject(makeError('InvalidStateError'));
    var id = randomOpaqueId();
    if (!id) return Promise.reject(makeError('NotAllowedError'));
    addPreparedMetadata(snapshot.source, video);

    return new Promise(function(resolve, reject) {
      var timeout = setTimeout(function() {
        if (!pending[id]) return;
        delete pending[id];
        if (iosHandoff && iosHandoff.id === id) iosHandoff = null;
        reject(makeError('AbortError'));
      }, 15000);
      pending[id] = { resolve: resolve, reject: reject, timeout: timeout };
      iosHandoff = {
        id: id,
        capability: capability,
        video: video,
        url: snapshot.source.url,
        associationGeneration: snapshot.associationGeneration,
        fromDirect: snapshot.fromDirect,
        ready: false,
        active: false,
        nativeInactive: false,
        exiting: false,
        restoring: false,
        restoreTimeout: null,
        leaveDispatched: false,
      };
      var registered = registerCapability();
      var prepared = registered && postNative({
        type: 'PIPSHIM_PREPARED_SOURCE',
        id: id,
        capability: capability,
        source: snapshot.source,
      });
      var entered = prepared && postNative({
        type: 'PIPSHIM_ENTER',
        id: id,
        capability: capability,
      });
      if (!entered) {
        delete pending[id];
        clearTimeout(timeout);
        iosHandoff = null;
        reject(makeError('NotAllowedError'));
      }
    });
  }

  function dispatchLeaveOnce(handoff) {
    if (!handoff || handoff.leaveDispatched) return;
    handoff.leaveDispatched = true;
    if (handoff.active || enteredVideo === handoff.video) {
      dispatchVideoEvent(handoff.video, 'leavepictureinpicture');
    }
    if (enteredVideo === handoff.video) enteredVideo = null;
  }

  function finishIosHandoff(handoff) {
    if (!handoff || iosHandoff !== handoff) return;
    if (handoff.restoreTimeout !== null) {
      clearTimeout(handoff.restoreTimeout);
      handoff.restoreTimeout = null;
    }
    dispatchLeaveOnce(handoff);
    iosHandoff = null;
  }

  function scheduleIosHandoffTimeout(handoff) {
    if (!handoff || iosHandoff !== handoff || handoff.restoreTimeout !== null) return;
    handoff.restoreTimeout = setTimeout(function() {
      if (iosHandoff === handoff) finishIosHandoff(handoff);
    }, 5000);
  }

  function restoreIosHandoff(handoff, event) {
    if (!associationMatches(handoff, false) || handoff.restoring) return;
    handoff.restoring = true;
    var video = handoff.video;
    var position = Number(event.positionSec);
    var valid = Number.isFinite(position)
      && position >= 0
      && position <= MAX_POSITION_SEC
      && typeof event.paused === 'boolean';

    function acknowledge(ok) {
      if (iosHandoff !== handoff) return;
      postNative({
        type: 'PIPSHIM_RESTORE_APPLIED',
        id: handoff.id,
        capability: capability,
        ok: ok,
      });
      finishIosHandoff(handoff);
    }

    if (!valid || !associationMatches(handoff, true)) {
      acknowledge(false);
      return;
    }
    if (Number.isFinite(video.duration) && video.duration >= 0) {
      position = Math.min(position, video.duration);
    }

    var settled = false;
    var timeout = null;
    function afterSeek() {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      video.removeEventListener('seeked', afterSeek);
      if (!associationMatches(handoff, true)) {
        acknowledge(false);
        return;
      }
      if (event.paused === true) {
        try {
          video.pause();
          acknowledge(true);
        } catch (error) {
          acknowledge(false);
        }
        return;
      }
      try {
        var playResult = video.play();
        Promise.resolve(playResult).then(
          function() { acknowledge(true); },
          function() { acknowledge(false); },
        );
      } catch (error) {
        acknowledge(false);
      }
    }

    if (Math.abs(Number(video.currentTime) - position) <= 0.05) {
      afterSeek();
      return;
    }
    video.addEventListener('seeked', afterSeek);
    timeout = setTimeout(afterSeek, 1000);
    try {
      video.currentTime = position;
    } catch (error) {
      afterSeek();
    }
  }

  function exitIos() {
    var handoff = iosHandoff;
    if (!handoff) {
      if (originalExitPictureInPicture) {
        try {
          return Promise.resolve(Reflect.apply(originalExitPictureInPicture, document, []));
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return Promise.resolve();
    }
    if (handoff.exiting) return Promise.resolve();
    handoff.exiting = true;
    if (!handoff.ready) rejectPending(handoff.id, 'AbortError');
    var posted = postNative({
      type: 'PIPSHIM_EXIT',
      id: handoff.id,
      capability: capability,
    });
    if (!posted || !handoff.ready) finishIosHandoff(handoff);
    else scheduleIosHandoffTimeout(handoff);
    return posted ? Promise.resolve() : Promise.reject(makeError('NotAllowedError'));
  }

  Object.defineProperty(document, 'pictureInPictureEnabled', {
    configurable: true,
    get: function() { return true; },
  });
  Object.defineProperty(document, 'pictureInPictureElement', {
    configurable: true,
    get: function() { return enteredVideo; },
  });
  Object.defineProperty(videoPrototype, 'requestPictureInPicture', {
    configurable: true,
    writable: true,
    value: function() {
      var video = this;
      if (mode === 'ios-native-v1') return requestIos(video);
      return requestAndroid('PIPSHIM_ENTER', video).then(function() {
        return video;
      });
    },
  });
  Object.defineProperty(document, 'exitPictureInPicture', {
    configurable: true,
    writable: true,
    value: function() {
      return mode === 'ios-native-v1'
        ? exitIos()
        : requestAndroid('PIPSHIM_EXIT', null);
    },
  });

  window.addEventListener('__MOVIX_PIP_SHIM__', function(event) {
    var detail = event && event.detail;
    if (!detail || typeof detail !== 'object') return;

    if (mode === 'ios-native-v1') {
      if (detail.capability !== capability) return;
      var handoff = iosHandoff;
      if (detail.kind === 'RESPONSE' && typeof detail.id === 'string') {
        var iosRequest = pending[detail.id];
        if (!iosRequest || !handoff || detail.id !== handoff.id) return;
        delete pending[detail.id];
        clearTimeout(iosRequest.timeout);
        if (detail.ok === true && associationMatches(handoff, true)) {
          iosRequest.resolve(handoff.video);
        } else {
          iosRequest.reject(makeError('NotAllowedError'));
          finishIosHandoff(handoff);
        }
        return;
      }
      if (
        detail.kind !== 'NATIVE_EVENT'
        || !detail.event
        || typeof detail.event !== 'object'
        || !handoff
        || detail.event.handoffId !== handoff.id
        || !associationMatches(handoff, false)
      ) {
        return;
      }
      if (detail.event.kind === 'ready') {
        if (handoff.ready || !associationMatches(handoff, true)) return;
        handoff.ready = true;
        try {
          handoff.video.pause();
        } catch (error) {
          return;
        }
        postNative({
          type: 'PIPSHIM_WEBVIEW_PAUSED',
          id: handoff.id,
          capability: capability,
        });
        return;
      }
      if (detail.event.kind === 'state') {
        if (detail.event.active === true) {
          if (!handoff.ready || handoff.active || !associationMatches(handoff, true)) return;
          handoff.active = true;
          enteredVideo = handoff.video;
          dispatchVideoEvent(handoff.video, 'enterpictureinpicture');
        } else if (detail.event.active === false) {
          handoff.nativeInactive = true;
          scheduleIosHandoffTimeout(handoff);
        }
        return;
      }
      if (detail.event.kind === 'restore') {
        restoreIosHandoff(handoff, detail.event);
        return;
      }
      if (detail.event.kind === 'error') {
        rejectPending(handoff.id, 'AbortError');
        finishIosHandoff(handoff);
      }
      return;
    }

    if (detail.kind === 'RESPONSE' && typeof detail.id === 'string') {
      var request = pending[detail.id];
      if (!request) return;
      delete pending[detail.id];
      clearTimeout(request.timeout);
      if (detail.ok === true) request.resolve();
      else request.reject(makeError('NotAllowedError'));
      return;
    }
    if (detail.kind !== 'NATIVE_EVENT' || !detail.event || typeof detail.event !== 'object') return;
    if (detail.event.kind === 'action') {
      applyNativeAction(detail.event.action);
      return;
    }
    if (detail.event.kind === 'prepare') {
      applyAndroidPresentation();
      return;
    }
    if (detail.event.kind === 'state') {
      if (detail.event.active === true) {
        var androidVideo = applyAndroidPresentation();
        if (androidVideo && enteredVideo !== androidVideo) {
          if (enteredVideo) dispatchVideoEvent(enteredVideo, 'leavepictureinpicture');
          enteredVideo = androidVideo;
          dispatchVideoEvent(androidVideo, 'enterpictureinpicture');
        }
      } else if (detail.event.active === false) {
        removeAndroidPresentation();
      }
      return;
    }
    if (detail.event.kind === 'error') {
      rejectAll('AbortError');
      removeAndroidPresentation();
    }
  });

  window.addEventListener('pagehide', function() {
    rejectAll('AbortError');
    publisherActive = false;
    mediaAssociations = new WeakMap();
    if (mode === 'ios-native-v1') {
      var handoff = iosHandoff;
      if (handoff) {
        postNative({
          type: 'PIPSHIM_EXIT',
          id: handoff.id,
          capability: capability,
        });
        finishIosHandoff(handoff);
      }
      return;
    }
    removeAndroidPresentation();
  });

  registerCapability();
})();
true;
`;
}
