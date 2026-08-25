/**
 * Plein écran du lecteur, et sa survie d'un épisode à l'autre.
 *
 * ## Pourquoi ça ne marchait pas
 *
 * Les changements d'épisode passaient par un rechargement complet de la page
 * (`window.location.href` dans `WatchTv` / `WatchAnime`). Le document était
 * déchargé : le navigateur quittait le plein écran **et** perdait l'activation
 * utilisateur. Or `requestFullscreen()` exige une activation utilisateur
 * récente et *authentique* : Firefox refuse toute demande faite hors d'un
 * gestionnaire d'événement utilisateur réel (`isTrusted === true`).
 *
 * Aucun événement synthétique ne peut s'y substituer : un
 * `dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))` produit un
 * événement non fiable, qui n'accorde aucune activation — le navigateur le
 * rejette exactement comme un appel direct. « Faire comme si quelqu'un
 * appuyait sur F » n'est donc pas implémentable côté page ; la seule façon
 * d'obtenir le même résultat est de **ne jamais perdre le plein écran**.
 *
 * ## Comment on ne le perd plus
 *
 * 1. Le changement d'épisode se fait en navigation SPA (`navigate()`), donc
 *    sans décharger le document. Le routeur remonte quand même la page (voir
 *    `RouteLazyContent`, qui pose `key={pathname}`) : l'état repart propre,
 *    comme après un rechargement, mais le document survit.
 * 2. Le plein écran est demandé sur un **hôte persistant** — le conteneur
 *    racine de l'application (`#movix-fullscreen-host`) — et non sur le
 *    conteneur du lecteur. Le lecteur, lui, est démonté/remonté à chaque
 *    épisode *et* à chaque changement de source ; s'il était l'élément plein
 *    écran, sa destruction ferait sortir du plein écran. L'hôte ne bouge
 *    jamais, donc le plein écran tient.
 * 3. Tant que l'hôte est en plein écran pour le lecteur, celui-ci passe en
 *    `position: fixed; inset: 0` (classe `player-fullscreen-fill`) pour
 *    occuper tout l'écran quelle que soit la mise en page de la page.
 *
 * Résultat : plus aucune demande de plein écran n'est faite au changement
 * d'épisode, donc plus aucune activation utilisateur à retrouver. Ça marche
 * sur Firefox comme ailleurs.
 *
 * Le mécanisme de reprise plus bas (marqueur `sessionStorage` + nouvel essai
 * sur geste) reste en filet de sécurité pour les cas où le document est tout
 * de même déchargé : rechargement manuel, arrivée depuis un lien externe, ou
 * iOS où le plein écran est natif à la balise `<video>` et non récupérable.
 */

/** Clés localStorage des réglages (partagées avec le panneau de paramètres). */
export const KEEP_FULLSCREEN_PREF_KEY = 'playerKeepFullscreenOnEpisodeChangePref';
export const RESUME_PLAYBACK_PREF_KEY = 'playerResumePlaybackOnEpisodeChangePref';

/** Clé sessionStorage du marqueur de passage d'un épisode à l'autre. */
const HANDOFF_KEY = 'movix:player:episodeHandoff';

/** Attribut posé sur le conteneur racine du lecteur HLS. */
export const HLS_PLAYER_ROOT_ATTRIBUTE = 'data-hls-player-root';

/**
 * Id de l'élément qui reçoit le plein écran : le conteneur racine de l'app,
 * monté une seule fois pour toute la session (voir `App.tsx`).
 */
export const PLAYER_FULLSCREEN_HOST_ID = 'movix-fullscreen-host';

/**
 * Attribut posé sur l'hôte tant que son plein écran appartient au lecteur.
 * Il sert de source de vérité *dans le DOM* — et non dans un état React — pour
 * qu'un lecteur fraîchement monté (épisode suivant) sache immédiatement qu'il
 * hérite d'un plein écran déjà en cours.
 */
const HOST_OWNED_ATTRIBUTE = 'data-player-fullscreen';

/** Classe qui fait occuper tout l'écran au lecteur pendant le plein écran hôte. */
export const PLAYER_FULLSCREEN_FILL_CLASS = 'player-fullscreen-fill';

/**
 * Au-delà, le marqueur est périmé. Large, car la résolution des sources du
 * nouvel épisode peut prendre un moment avant que le lecteur ne soit monté.
 */
const HANDOFF_MAX_AGE_MS = 120_000;

/** Durée pendant laquelle on continue d'espérer un geste pour reprendre. */
const GESTURE_FALLBACK_WINDOW_MS = 180_000;

/** Événements accordant une activation utilisateur. `click` couvre le tap. */
const ACTIVATION_EVENTS = ['click', 'keydown'] as const;

/** Étapes du chargement vidéo où retenter la reprise, sans coût. */
const VIDEO_READY_EVENTS = ['loadedmetadata', 'canplay', 'playing'] as const;

export interface EpisodeHandoffState {
  /** Le lecteur HLS occupait le plein écran. */
  fullscreen: boolean;
  /** La lecture était en cours (ou l'épisode venait de se terminer). */
  playing: boolean;
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozCancelFullScreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  mozRequestFullScreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

/** Vidéo iOS : plein écran natif, hors API Fullscreen du document. */
type NativeFullscreenVideo = HTMLVideoElement & {
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
};

/** Élément actuellement en plein écran, toutes préfixations confondues. */
export const getFullscreenElement = (): Element | null => {
  if (typeof document === 'undefined') return null;
  const doc = document as FullscreenDocument;
  return (
    doc.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement ||
    null
  );
};

/** L'hôte persistant du plein écran, s'il est monté. */
export const getPlayerFullscreenHost = (): HTMLElement | null => {
  if (typeof document === 'undefined') return null;
  return document.getElementById(PLAYER_FULLSCREEN_HOST_ID);
};

/** `true` si l'hôte est en plein écran *pour le lecteur*. */
export const isHostFullscreenActive = (): boolean => {
  const host = getPlayerFullscreenHost();
  if (!host) return false;
  return getFullscreenElement() === host && host.hasAttribute(HOST_OWNED_ATTRIBUTE);
};

/** `true` si le lecteur HLS (et non un autre élément) occupe le plein écran. */
export const isHlsPlayerFullscreen = (): boolean => {
  if (isHostFullscreenActive()) {
    return Boolean(document.querySelector(`[${HLS_PLAYER_ROOT_ATTRIBUTE}]`));
  }
  const element = getFullscreenElement();
  if (!element || typeof (element as Element).closest !== 'function') return false;
  return Boolean(element.closest(`[${HLS_PLAYER_ROOT_ATTRIBUTE}]`));
};

const readBooleanPref = (key: string): boolean => {
  try {
    const saved = localStorage.getItem(key);
    return saved !== null ? JSON.parse(saved) === true : true; // activé par défaut
  } catch {
    return true;
  }
};

const writeBooleanPref = (key: string, enabled: boolean): void => {
  try {
    localStorage.setItem(key, JSON.stringify(enabled));
  } catch {
    /* stockage indisponible (navigation privée, quota) : réglage non persisté */
  }
};

export const isKeepFullscreenEnabled = (): boolean => readBooleanPref(KEEP_FULLSCREEN_PREF_KEY);
export const setKeepFullscreenEnabled = (v: boolean): void => writeBooleanPref(KEEP_FULLSCREEN_PREF_KEY, v);
export const isResumePlaybackEnabled = (): boolean => readBooleanPref(RESUME_PLAYBACK_PREF_KEY);
export const setResumePlaybackEnabled = (v: boolean): void => writeBooleanPref(RESUME_PLAYBACK_PREF_KEY, v);

/** Demande le plein écran sur un élément, en gérant les préfixes navigateurs. */
const requestFullscreenOn = async (element: HTMLElement): Promise<boolean> => {
  const target = element as FullscreenElement;
  const request =
    target.requestFullscreen ||
    target.webkitRequestFullscreen ||
    target.mozRequestFullScreen ||
    target.msRequestFullscreen;

  if (typeof request !== 'function') return false;

  try {
    await Promise.resolve(request.call(target));
    return true;
  } catch {
    // Refus le plus fréquent : absence d'activation utilisateur récente.
    return false;
  }
};

interface EnterFullscreenOptions {
  /** Conteneur racine du lecteur, replié sur l'hôte si celui-ci manque. */
  container: HTMLElement | null;
  /** Vidéo, pour le plein écran natif iOS en dernier recours. */
  video?: HTMLVideoElement | null;
  /**
   * Passer l'hôte persistant en plein écran plutôt que le conteneur du
   * lecteur. À n'activer que sur les pages où le lecteur occupe déjà toute la
   * fenêtre (les pages `Watch`) : ailleurs (watch party, aperçus), le plein
   * écran doit rester cantonné au conteneur.
   */
  useHost?: boolean;
}

/**
 * Fait passer le lecteur en plein écran. Sur l'hôte persistant quand c'est
 * possible — c'est ce qui lui permet de survivre au changement d'épisode.
 */
export const enterPlayerFullscreen = async ({
  container,
  video = null,
  useHost = false,
}: EnterFullscreenOptions): Promise<boolean> => {
  const host = useHost ? getPlayerFullscreenHost() : null;

  if (host && await requestFullscreenOn(host)) {
    host.setAttribute(HOST_OWNED_ATTRIBUTE, '');
    return true;
  }

  if (container && await requestFullscreenOn(container)) return true;
  if (video && await requestFullscreenOn(video)) return true;

  // iOS : pas d'API Fullscreen sur les éléments, seulement sur la vidéo.
  const nativeVideo = video as NativeFullscreenVideo | null;
  if (typeof nativeVideo?.webkitEnterFullscreen === 'function') {
    try {
      nativeVideo.webkitEnterFullscreen();
      return true;
    } catch {
      /* refusé : on reste fenêtré */
    }
  }

  console.warn('[Fullscreen] demande refusée ou API indisponible sur cet appareil.');
  return false;
};

/** Sort du plein écran, quel que soit l'élément qui l'occupait. */
export const exitPlayerFullscreen = async (video?: HTMLVideoElement | null): Promise<void> => {
  const host = getPlayerFullscreenHost();
  host?.removeAttribute(HOST_OWNED_ATTRIBUTE);

  const doc = document as FullscreenDocument;
  const exit =
    doc.exitFullscreen ||
    doc.webkitExitFullscreen ||
    doc.mozCancelFullScreen ||
    doc.msExitFullscreen;

  if (getFullscreenElement() && typeof exit === 'function') {
    try {
      await Promise.resolve(exit.call(doc));
    } catch {
      /* déjà sorti, ou refusé */
    }
  }

  const nativeVideo = video as NativeFullscreenVideo | null | undefined;
  if (nativeVideo?.webkitDisplayingFullscreen && typeof nativeVideo.webkitExitFullscreen === 'function') {
    try {
      nativeVideo.webkitExitFullscreen();
    } catch {
      /* déjà sorti */
    }
  }
};

/**
 * À appeler quand on quitte le lecteur pour de bon (navigation hors d'une
 * route `/watch`). Sans ça, le plein écran de l'hôte survivrait au lecteur et
 * le reste du site s'afficherait en plein écran.
 */
export const releaseHostFullscreen = (): void => {
  if (!isHostFullscreenActive()) return;
  void exitPlayerFullscreen();
};

export const clearEpisodeHandoff = (): void => {
  try {
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    /* stockage indisponible */
  }
};

/**
 * À appeler juste avant une navigation vers un autre épisode : mémorise l'état
 * du lecteur HLS pour que le prochain épisode le rejoue. Ne fait rien si aucun
 * lecteur HLS n'est présent (source embed, page hors lecture).
 *
 * En navigation SPA le plein écran n'est plus perdu, donc ce marqueur ne sert
 * en général qu'à relancer la lecture. Il reste le seul recours si le document
 * finit malgré tout par être déchargé.
 */
export const markEpisodeHandoff = (): void => {
  const root = typeof document !== 'undefined'
    ? document.querySelector(`[${HLS_PLAYER_ROOT_ATTRIBUTE}]`)
    : null;
  if (!root) return;

  const video = root.querySelector('video');
  const state: EpisodeHandoffState = {
    fullscreen: isHlsPlayerFullscreen(),
    // `ended` compte comme « en lecture » : après la fin d'un épisode, la vidéo
    // est techniquement en pause alors que l'utilisateur regardait bien.
    playing: Boolean(video && (!video.paused || video.ended)),
  };

  // Le plein écran ne se perd plus tout seul au changement d'épisode : si
  // l'utilisateur a désactivé le réglage, c'est donc à nous d'en sortir, sinon
  // son choix n'aurait plus aucun effet.
  if (state.fullscreen && !isKeepFullscreenEnabled()) {
    void exitPlayerFullscreen(video);
    state.fullscreen = false;
  }

  if (!state.fullscreen && !state.playing) return;

  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...state, ts: Date.now() }));
  } catch {
    /* stockage indisponible : on repartira fenêtré et en pause */
  }
};

/**
 * Lit l'état à restaurer, sans le consommer : le lecteur peut être monté
 * plusieurs fois avant d'aboutir (résolution de source, bascule de secours).
 * Le marqueur est effacé une fois la reprise faite, ou lorsqu'il est périmé.
 */
export const readEpisodeHandoff = (): EpisodeHandoffState | null => {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: { fullscreen?: unknown; playing?: unknown; ts?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearEpisodeHandoff();
    return null;
  }

  const ts = typeof parsed.ts === 'number' ? parsed.ts : null;
  if (ts === null || Date.now() - ts >= HANDOFF_MAX_AGE_MS) {
    clearEpisodeHandoff();
    return null;
  }

  // Un réglage désactivé neutralise sa moitié de la reprise.
  const state: EpisodeHandoffState = {
    fullscreen: parsed.fullscreen === true && isKeepFullscreenEnabled(),
    playing: parsed.playing === true && isResumePlaybackEnabled(),
  };

  if (!state.fullscreen && !state.playing) {
    clearEpisodeHandoff();
    return null;
  }

  return state;
};

/**
 * `true` si l'on arrive sur un nouvel épisode alors que la lecture était en
 * cours mais que l'utilisateur a désactivé « reprendre la lecture ».
 *
 * En navigation SPA le document garde son activation utilisateur : la lecture
 * repartirait toute seule. Le lecteur s'en sert donc pour neutraliser son
 * `autoPlay` sur ce montage-là, et seulement celui-là.
 */
export const isEpisodeAutoplaySuppressed = (): boolean => {
  if (isResumePlaybackEnabled()) return false;

  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(HANDOFF_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;

  try {
    const parsed = JSON.parse(raw) as { playing?: unknown; ts?: unknown };
    if (parsed.playing !== true) return false;
    return typeof parsed.ts === 'number' && Date.now() - parsed.ts < HANDOFF_MAX_AGE_MS;
  } catch {
    return false;
  }
};

/** Un geste dans un champ de saisie ne doit pas être détourné. */
const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
};

interface RestoreOptions {
  state: EpisodeHandoffState;
  getContainer: () => HTMLElement | null;
  getVideo: () => HTMLVideoElement | null;
  /** Le lecteur peut-il demander le plein écran sur l'hôte persistant ? */
  useHost?: boolean;
}

/**
 * Rejoue l'état du lecteur après un changement d'épisode : plein écran et/ou
 * reprise de la lecture, selon ce qui avait été mémorisé et les réglages.
 *
 * En navigation SPA le plein écran est déjà là : `tryFullscreen()` le constate
 * et il ne reste que la lecture à relancer — ce que l'activation utilisateur
 * conservée par le document permet. Le reste (essais sur geste) ne sert plus
 * qu'après un vrai rechargement.
 *
 * @returns une fonction d'annulation à appeler au démontage du lecteur.
 */
export const restoreEpisodeHandoff = ({ state, getContainer, getVideo, useHost = false }: RestoreOptions): (() => void) => {
  let cancelled = false;
  let gestureConsumed = false;
  let fullscreenDone = !state.fullscreen;
  let playbackDone = !state.playing;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let watchedVideo: HTMLVideoElement | null = null;

  const cleanup = () => {
    if (cancelled) return;
    cancelled = true;
    if (timeoutId !== null) clearTimeout(timeoutId);
    for (const eventName of ACTIVATION_EVENTS) {
      window.removeEventListener(eventName, onUserActivation, true);
    }
    for (const eventName of VIDEO_READY_EVENTS) {
      watchedVideo?.removeEventListener(eventName, onVideoReady);
    }
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
  };

  const finishIfDone = (): boolean => {
    if (!fullscreenDone || !playbackDone) return false;
    clearEpisodeHandoff();
    cleanup();
    return true;
  };

  const tryPlayback = (): Promise<boolean> => {
    const video = getVideo();
    if (!video) return Promise.resolve(false);
    if (!video.paused && !video.ended) return Promise.resolve(true);
    return video.play().then(() => true, () => false);
  };

  const tryFullscreen = (): Promise<boolean> => {
    if (getFullscreenElement()) return Promise.resolve(true);
    const container = getContainer();
    if (!container) return Promise.resolve(false);
    return enterPlayerFullscreen({ container, video: getVideo(), useHost });
  };

  const attempt = async (origin: string): Promise<boolean> => {
    if (cancelled) return true;

    // Les deux demandes doivent partir dans le même tour d'événement, et la
    // lecture en premier : `requestFullscreen()` consomme l'activation
    // utilisateur, donc attendre sa réponse avant d'appeler `play()` ferait
    // systématiquement échouer la reprise de lecture.
    const pendingPlayback = playbackDone ? null : tryPlayback();
    const pendingFullscreen = fullscreenDone ? null : tryFullscreen();

    if (pendingPlayback && await pendingPlayback) {
      playbackDone = true;
    }

    if (pendingFullscreen && await pendingFullscreen) {
      fullscreenDone = true;
    }

    void origin;
    return finishIfDone();
  };

  function onUserActivation(event: Event) {
    if (cancelled) return;
    if (event.type === 'keydown' && isTypingTarget(event.target)) return;

    // Le premier geste ne sert qu'à la reprise : on l'empêche d'atteindre le
    // lecteur, sinon un clic mettrait aussi la lecture en pause. Les gestes
    // suivants passent normalement tout en déclenchant un nouvel essai.
    if (!gestureConsumed) {
      gestureConsumed = true;
      event.stopPropagation();
    }

    void attempt(`geste ${event.type}`);
  }

  function onVideoReady(event: Event) {
    void attempt(event.type);
  }

  function onFullscreenChange() {
    if (cancelled || fullscreenDone) return;
    // L'utilisateur a repris la main sur le plein écran : plus rien à faire.
    if (getFullscreenElement()) {
      fullscreenDone = true;
      finishIfDone();
    }
  }

  void attempt('montage').then((done) => {
    if (done || cancelled) return;

    for (const eventName of ACTIVATION_EVENTS) {
      window.addEventListener(eventName, onUserActivation, true);
    }

    watchedVideo = getVideo();
    for (const eventName of VIDEO_READY_EVENTS) {
      watchedVideo?.addEventListener(eventName, onVideoReady);
    }

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    timeoutId = setTimeout(() => {
      clearEpisodeHandoff();
      cleanup();
    }, GESTURE_FALLBACK_WINDOW_MS);
  });

  return cleanup;
};
