/**
 * Media Session bridge injecté dans le WebView.
 *
 * Le lecteur web Movix (HLSPlayer) ne renseigne pas l'API
 * `navigator.mediaSession`. Résultat : sur l'écran verrouillé / le centre de
 * contrôle iOS et la notification média Android, on n'obtient qu'un titre brut
 * (le `document.title`) sans jaquette ni contrôles fiables.
 *
 * Ce script observe le `<video>` en cours de lecture et :
 *   1. renseigne `navigator.mediaSession.metadata` (titre + jaquette du film) ;
 *   2. installe les handlers play / pause / seek pour piloter la lecture
 *      depuis l'écran verrouillé ou les écouteurs ;
 *   3. publie l'état de lecture (`positionState`) pour la barre de progression ;
 *   4. active l'auto-Picture-in-Picture iOS (`autoPictureInPicture`) afin que la
 *      vidéo bascule en PiP quand on quitte l'app ;
 *   5. relaie l'état lecture/pause au natif (message `MEDIA_PLAYBACK`) pour
 *      déclencher le PiP Android via `onUserLeaveHint`.
 *
 * Greffé sur la phase de capture de l'événement `play`, il survit à la
 * navigation SPA (changement d'épisode, nouveau film) sans réinjection.
 */

export function buildMediaSession(): string {
  return `
(function() {
  'use strict';
  if (window.__MOVIX_MEDIA_SESSION_READY) return;
  window.__MOVIX_MEDIA_SESSION_READY = true;

  if (!('mediaSession' in navigator)) return;

  var activeVideo = null;
  var ms = navigator.mediaSession;

  function postNative(msg) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    } catch (e) {}
  }

  function absUrl(u) {
    if (!u) return '';
    try { return new URL(u, location.href).href; } catch (e) { return ''; }
  }

  // --- Résolution de la jaquette ---
  // 1. poster de la vidéo (jaquette TMDB du film en cours)
  // 2. balise og:image
  // 3. plus grande icône déclarée
  // 4. logo Movix (/movix.png) en dernier recours
  function resolveArtworkUrl(video) {
    if (video && video.poster) {
      var p = absUrl(video.poster);
      if (p) return p;
    }
    var og = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    if (og && og.content) {
      var o = absUrl(og.content);
      if (o) return o;
    }
    var icon = document.querySelector('link[rel="apple-touch-icon"], link[rel~="icon"]');
    if (icon && icon.getAttribute('href')) {
      var i = absUrl(icon.getAttribute('href'));
      if (i) return i;
    }
    return location.origin + '/movix.png';
  }

  function cleanTitle() {
    var t = (document.title || '').trim();
    // Retire un suffixe " - Movix" / " | Movix" éventuel pour un libellé propre.
    t = t.replace(/\\s*[\\-|–—]\\s*Movix\\s*$/i, '').trim();
    return t || 'Movix';
  }

  function buildArtwork(url) {
    if (!url) return [];
    var sizes = ['256x256', '384x384', '512x512'];
    return sizes.map(function(s) {
      return { src: url, sizes: s, type: '' };
    });
  }

  function updateMetadata(video) {
    try {
      var artUrl = resolveArtworkUrl(video);
      ms.metadata = new MediaMetadata({
        title: cleanTitle(),
        artist: 'Movix',
        album: '',
        artwork: buildArtwork(artUrl),
      });
    } catch (e) {}
  }

  function updatePositionState(video) {
    if (!video) return;
    try {
      var dur = video.duration;
      if (!isFinite(dur) || dur <= 0) return;
      var pos = video.currentTime;
      if (!isFinite(pos) || pos < 0) pos = 0;
      if (pos > dur) pos = dur;
      var rate = video.playbackRate;
      if (!isFinite(rate) || rate <= 0) rate = 1;
      ms.setPositionState({ duration: dur, playbackRate: rate, position: pos });
    } catch (e) {}
  }

  function setHandler(action, fn) {
    try { ms.setActionHandler(action, fn); } catch (e) {}
  }

  function installHandlers() {
    setHandler('play', function() {
      if (activeVideo) { activeVideo.play().catch(function() {}); }
    });
    setHandler('pause', function() {
      if (activeVideo) { activeVideo.pause(); }
    });
    setHandler('seekbackward', function(d) {
      if (!activeVideo) return;
      var off = (d && d.seekOffset) || 10;
      activeVideo.currentTime = Math.max(0, activeVideo.currentTime - off);
    });
    setHandler('seekforward', function(d) {
      if (!activeVideo) return;
      var off = (d && d.seekOffset) || 10;
      var dur = isFinite(activeVideo.duration) ? activeVideo.duration : Infinity;
      activeVideo.currentTime = Math.min(dur, activeVideo.currentTime + off);
    });
    setHandler('seekto', function(d) {
      if (!activeVideo || !d || typeof d.seekTime !== 'number') return;
      if (d.fastSeek && typeof activeVideo.fastSeek === 'function') {
        activeVideo.fastSeek(d.seekTime);
      } else {
        activeVideo.currentTime = d.seekTime;
      }
    });
    setHandler('stop', function() {
      if (activeVideo) { activeVideo.pause(); }
    });
  }

  // --- Wake Lock (garde l'écran allumé pendant la lecture) ---
  var _wakeLock = null;
  function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (_wakeLock) return;
    try {
      navigator.wakeLock.request('screen').then(function(lock) {
        _wakeLock = lock;
      }).catch(function() {});
    } catch (e) {}
  }
  function releaseWakeLock() {
    if (!_wakeLock) return;
    try { _wakeLock.release(); } catch (e) {}
    _wakeLock = null;
  }

  var _posTimer = null;
  function startPositionTimer() {
    stopPositionTimer();
    _posTimer = setInterval(function() {
      if (activeVideo && !activeVideo.paused) updatePositionState(activeVideo);
    }, 1000);
  }
  function stopPositionTimer() {
    if (_posTimer) { clearInterval(_posTimer); _posTimer = null; }
  }

  function onVideoPlay(video) {
    activeVideo = video;
    window.__movixActiveVideo = video;

    // Autorise le PiP (utile aussi pour Safari/iPad).
    try { video.disablePictureInPicture = false; } catch (e) {}
    try { video.setAttribute('x-webkit-airplay', 'allow'); } catch (e) {}

    // PiP automatique iOS (best-effort) : l'attribut autoPictureInPicture
    // demande à WebKit de basculer en PiP quand l'app passe en arrière-plan.
    // ATTENTION (limitation WebKit documentée) : pour une vidéo HTML5 inline —
    // a fortiori pilotée par MSE/HLS.js (blob:), comme le lecteur Movix — WebKit
    // n'honore l'auto-PiP QUE depuis le plein écran natif (transition
    // fullscreen → background), jamais depuis la lecture inline. Le seul moyen
    // d'un auto-PiP inline fiable serait un AVPlayerViewController natif
    // (canStartPictureInPictureAutomaticallyFromInline), incompatible avec le
    // flux MSE du site. On pose donc l'attribut (cas plein écran couvert) sans
    // injecter de webkitSetPresentationMode au background : un appel hors
    // user-gesture échoue silencieusement et corrompt l'état tactile au retour.
    try { video.autoPictureInPicture = true; } catch (e) {}
    try { video.setAttribute('autopictureinpicture', ''); } catch (e) {}

    updateMetadata(video);
    updatePositionState(video);
    try { ms.playbackState = 'playing'; } catch (e) {}
    startPositionTimer();
    acquireWakeLock();
    postNative({ type: 'MEDIA_PLAYBACK', playing: true });
  }

  function onVideoPause(video) {
    if (video !== activeVideo) return;
    try { ms.playbackState = 'paused'; } catch (e) {}
    updatePositionState(video);
    stopPositionTimer();
    releaseWakeLock();
    postNative({ type: 'MEDIA_PLAYBACK', playing: false });
  }

  // Capture globale : tout <video> qui démarre devient la session active,
  // ce qui suit naturellement les changements d'épisode/film en SPA.
  document.addEventListener('play', function(e) {
    var t = e.target;
    if (t && t.tagName === 'VIDEO') onVideoPlay(t);
  }, true);

  document.addEventListener('pause', function(e) {
    var t = e.target;
    if (t && t.tagName === 'VIDEO') onVideoPause(t);
  }, true);

  document.addEventListener('loadedmetadata', function(e) {
    var t = e.target;
    if (t && t.tagName === 'VIDEO' && t === activeVideo) {
      updateMetadata(t);
      updatePositionState(t);
    }
  }, true);

  installHandlers();

  // Gestion visibilité : arrêt/reprise du timer de position + wake lock.
  // Le PiP auto est géré depuis le côté natif (AppState inactive sur iOS).
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      stopPositionTimer();
      releaseWakeLock();
    } else {
      if (activeVideo && !activeVideo.paused) {
        startPositionTimer();
        acquireWakeLock();
      }
    }
  });
})();
true;
`;
}
