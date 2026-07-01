import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HelmetProvider } from 'react-helmet-async'
import ErrorBoundary from './components/ErrorBoundary'
import './i18n' // Initialize i18n before App
import App from './App.tsx'
import axios from 'axios'
import { api } from './services/api'
import { registerBlockDetection } from './services/blockDetection'
import { registerAuthInterceptor } from './services/authInterceptor'
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
    text: 'Coller quelque chose ici peut donner a un attaquant acces a ton compte Movix.',
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

// Register block detection on both the default axios (used by most services)
// and the api instance (used by contentAPI). Both need their own interceptors
// since instances created via axios.create() don't inherit from the default.
registerBlockDetection(axios)
registerBlockDetection(api)

// Register auth interceptor (JWT refresh on 401) on both instances
registerAuthInterceptor(axios)
registerAuthInterceptor(api)

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
