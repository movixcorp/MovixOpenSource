/**
 * Buffer de logs en mémoire + capture des `console.*`.
 *
 * Alimenté par deux sources :
 *   - le côté React Native (via `installConsoleCapture`, appelé au démarrage)
 *   - le WebView (via le message `CONSOLE_LOG` relayé par le bridge)
 *
 * Consommé par le composant `DebugConsole` (modal dans les réglages).
 */

export type LogLevel = 'log' | 'info' | 'warn' | 'error';
export type LogSource = 'app' | 'web';

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  source: LogSource;
  message: string;
}

const MAX_ENTRIES = 500;

let entries: LogEntry[] = [];
let counter = 0;
const listeners = new Set<(entries: LogEntry[]) => void>();

function emit(): void {
  for (const listener of listeners) {
    listener(entries);
  }
}

function formatPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part instanceof Error) return part.stack || `${part.name}: ${part.message}`;
  if (part === undefined) return 'undefined';
  if (part === null) return 'null';
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

/** Ajoute une entrée au buffer (rotation au-delà de MAX_ENTRIES). */
export function pushLog(level: LogLevel, source: LogSource, parts: unknown[]): void {
  const message = parts.map(formatPart).join(' ');
  const entry: LogEntry = { id: ++counter, ts: Date.now(), level, source, message };
  entries = entries.length >= MAX_ENTRIES
    ? [...entries.slice(entries.length - MAX_ENTRIES + 1), entry]
    : [...entries, entry];
  emit();
}

export function getLogs(): LogEntry[] {
  return entries;
}

export function clearLogs(): void {
  entries = [];
  emit();
}

/** S'abonne aux changements. Appelle immédiatement avec l'état courant. Retourne l'unsubscribe. */
export function subscribeLogs(fn: (entries: LogEntry[]) => void): () => void {
  listeners.add(fn);
  fn(entries);
  return () => {
    listeners.delete(fn);
  };
}

let captureInstalled = false;

/**
 * Patche `console.log/info/warn/error` pour dupliquer les appels vers le buffer.
 * Idempotent. À appeler une seule fois au démarrage de l'app.
 */
export function installConsoleCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;

  (['log', 'info', 'warn', 'error'] as LogLevel[]).forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        pushLog(level, 'app', args);
      } catch {
        // ne jamais casser le console réel
      }
      original(...args);
    };
  });
}
