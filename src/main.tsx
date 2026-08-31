import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HelmetProvider } from 'react-helmet-async'
import ErrorBoundary from './components/ErrorBoundary'
import './i18n' // Initialize i18n before App
import App from './App.tsx'
import axios from 'axios'
import { api } from './services/api'
import { registerBlockDetection } from './services/blockDetection'
import { initAnalytics } from './utils/analytics'
import { installHttpCache } from './utils/httpCache'
import { installSegmentedSeasons } from './utils/segmentedSeasons'
import './index.css'
import './styles/light-mode.css'

type MovixConsoleWarningWindow = Window & {
  __movixConsoleSafetyWarningStarted?: boolean;
  __movixConsoleSafetyWarningTimerId?: number;
};

type MovixConsoleWarningLine = {
  text: string;
  style: string;
};

const MOVIX_CONSOLE_SAFETY_WARNING_LINES: MovixConsoleWarningLine[] = [
  {
    text: 'ATTENDS !',
    style: [
      'font-size: 34px',
      'font-weight: 900',
      'letter-spacing: 0.18em',
      'text-transform: uppercase',
      'color: #111827',
      'background: #ffea00',
      'padding: 10px 16px',
      'border-radius: 12px',
      'text-shadow: 0 1px 0 rgba(255,255,255,0.65)',
      'box-shadow: 0 0 0 3px #ff006e inset'
    ].join('; '),
  },
  {
    text: "Si quelqu'un t'a dit de copier/coller quelque chose ici, il y a de fortes chances que ce soit une arnaque.",
    style: [
      'font-size: 22px',
      'font-weight: 900',
      'line-height: 1.5',
      'color: #ffffff',
      'background: #ff006e',
      'padding: 10px 16px',
      'border-radius: 12px',
      'text-shadow: 0 2px 12px rgba(0,0,0,0.35)',
      'box-shadow: 0 0 0 3px #ffd166 inset'
    ].join('; '),
  },
  {
    text: 'Coller quelque chose ici peut donner à un attaquant accès à ton compte Movix.',
    style: [
      'font-size: 22px',
      'font-weight: 900',
      'line-height: 1.5',
      'color: #0f172a',
      'background: #00e5ff',
      'padding: 10px 16px',
      'border-radius: 12px',
      'text-shadow: 0 1px 0 rgba(255,255,255,0.6)',
      'box-shadow: 0 0 0 3px #ffffff inset'
    ].join('; '),
  },
  {
    text: 'Ne colle rien que tu ne comprends pas.',
    style: [
      'font-size: 22px',
      'font-weight: 900',
      'line-height: 1.5',
      'color: #ffffff',
      'background: #7c3aed',
      'padding: 10px 16px',
      'border-radius: 12px',
      'text-shadow: 0 2px 12px rgba(0,0,0,0.35)',
      'box-shadow: 0 0 0 3px #22c55e inset'
    ].join('; '),
  },
  {
    text: "Fuck les sites qui bloquent le devtool et qui mettent des screamers quand on l'ouvre — et merci à LibreWolf pour bypass les détections.",
    style: [
      'font-size: 10px',
      'font-weight: 600',
      'line-height: 1.4',
      'color: #94a3b8',
      'background: transparent',
      'padding: 2px 4px',
      'text-shadow: none'
    ].join('; '),
  },
];

const emitMovixConsoleSafetyWarning = () => {
  console.log(
    '%c MOVIX SECURITY WARNING ',
    [
      'font-size: 16px',
      'font-weight: 900',
      'letter-spacing: 0.28em',
      'text-transform: uppercase',
      'color: #ffffff',
      'background: #111827',
      'padding: 6px 12px',
      'border-radius: 999px',
      'box-shadow: 0 0 0 3px #ffea00 inset'
    ].join('; ')
  );

  MOVIX_CONSOLE_SAFETY_WARNING_LINES.forEach((line) => {
    console.log(`%c${line.text}`, line.style);
  });
};

const startMovixConsoleSafetyWarning = () => {
  if (typeof window === 'undefined') return;

  const globalWindow = window as MovixConsoleWarningWindow;
  if (globalWindow.__movixConsoleSafetyWarningStarted) return;

  globalWindow.__movixConsoleSafetyWarningStarted = true;

  emitMovixConsoleSafetyWarning();
  window.setTimeout(emitMovixConsoleSafetyWarning, 700);
  window.setTimeout(emitMovixConsoleSafetyWarning, 1400);
  // The previous 30s setInterval kept printing forever, blocking idle and
  // flooding the DevTools console for power users. The three staggered
  // emissions above cover the case where devtools opens slightly after page
  // load; that's enough deterrent without permanent main-thread work. — perf
};

startMovixConsoleSafetyWarning();

// Coins carrés (Paramètres > Apparence) : posé avant le premier render pour
// éviter un flash de coins arrondis. Togglé live depuis SettingsPage.
if (localStorage.getItem('square_corners_enabled') === '1') {
  document.documentElement.classList.add('square-corners');
}

// Register block detection on both the default axios (used by most services)
// and the api instance (used by contentAPI). Both need their own interceptors
// since instances created via axios.create() don't inherit from the default.
registerBlockDetection(axios)
registerBlockDetection(api)

// Cache des lectures de catalogue (TMDB, /api/content) : une réponse déjà vue
// est resservie sans réseau, et rafraîchie en arrière-plan si elle a vieilli.
// Même remarque que ci-dessus : les deux instances ont besoin de leur propre
// installation. Voir `utils/httpCache.ts` pour ce qui est mis en cache — et
// surtout pour ce qui ne l'est jamais.
installHttpCache(axios)
installHttpCache(api)

// Séries que TMDB découpe en segments de 11 minutes (« Bienvenue chez les
// Loud ») : les épisodes sont recollés à la volée pour coller aux fichiers.
// Posé APRÈS le cache — celui-ci stocke la réponse TMDB brute, la fusion
// s'applique à chaque lecture. Voir `utils/segmentedSeasons.ts`.
installSegmentedSeasons(axios)
installSegmentedSeasons(api)

// ---------------------------------------------------------------------------
// Resilience patches — run before the app mounts.
// ---------------------------------------------------------------------------

// 1. Stale dynamic-import chunks after a deploy. Vite dispatches
//    `vite:preloadError` when a chunk preload (the helper behind every lazy
//    route and hover-prefetch) fails — e.g. the previous build's hashed chunk
//    now 404s on the production domain.
//
//    We must NOT call `event.preventDefault()` here. Vite's preload helper only
//    rethrows the failure when the event is left un-prevented:
//        return baseModule().catch(handlePreloadError)
//        function handlePreloadError(err){ …dispatch…; if (!e.defaultPrevented) throw err }
//    Calling preventDefault() makes the failed `import()` RESOLVE TO `undefined`
//    instead of rejecting. React.lazy then reads `.default` off that `undefined`
//    and crashes the whole app with "Cannot read properties of undefined
//    (reading 'default')" — the exact opposite of recovery, and it bypasses every
//    handler below (a resolved promise has no error to catch).
//
//    So we let the rejection propagate to where the import was triggered:
//    lazyWithRetry retries + does a budgeted reload for interactive route loads,
//    PrefetchLink's `.catch` swallows background prefetches, and ErrorBoundary
//    shows a soft "new version available" screen once the reload budget is spent.
//    (lazyWithRetry also defensively treats a nullish resolved module as a chunk
//    failure, so re-introducing preventDefault here can never silently crash again.)

// 2. Guard against the React + browser-translation (Google Translate, Edge,
//    Samsung Internet, …) crash: the translation engine swaps text nodes
//    underneath React, so React's reconciler later calls removeChild /
//    insertBefore on a node whose parent has since changed →
//    "Failed to execute 'removeChild' on 'Node': The node to be removed is not
//    a child of this node." Making these DOM ops no-ops when the parent no
//    longer matches lets React recover instead of tearing down the whole tree.
//    https://github.com/facebook/react/issues/11538#issuecomment-417504600
if (typeof Node === 'function' && Node.prototype) {
  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(
    this: Node,
    newNode: T,
    referenceNode: Node | null
  ): T {
    if (referenceNode && referenceNode.parentNode !== this) {
      return newNode;
    }
    return originalInsertBefore.call(this, newNode, referenceNode) as T;
  };
}

// Analytics (Google Analytics ou Plausible, au choix via VITE_ANALYTICS_PROVIDER).
// Ne charge rien si le fournisseur est "none", si sa config est incomplète, ou
// si l'utilisateur a coupé la mesure (Do Not Track / opt-out local).
initAnalytics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <HelmetProvider>
        <App />
      </HelmetProvider>
    </ErrorBoundary>
  </StrictMode>
);

// Enregistrer le service worker et re-souscrire au push si la permission est déjà accordée
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      registration.update().catch(() => {});

      // Re-souscrire au push si permission déjà accordée mais subscription perdue
      if ('PushManager' in window && Notification.permission === 'granted' && localStorage.getItem('auth_token')) {
        const subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          const { subscribeToPush } = await import('./services/pushNotificationService');
          subscribeToPush();
        }
      }
    } catch {}
  });
}
