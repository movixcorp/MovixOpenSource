export type HlsAutoFallbackDecision = 'allow' | 'stale' | 'limit-reached';

export interface HlsAutoFallbackGuard {
  syncActiveSource(source: string, owner?: object): void;
  requestAutomaticSwitch(
    fromSource: string,
    owner?: object,
  ): HlsAutoFallbackDecision;
  getAutomaticSwitchCount(): number;
  activate(): void;
  invalidate(): void;
}

export interface HlsActiveSourceRef {
  current: string;
}

export interface AcceptedWatchSourceOptions {
  requestedSource?: string | null;
  availableSources?: readonly string[];
  allowed?: boolean;
  fallback?: 'none' | 'first' | 'last';
  transform?: (source: string) => string;
}

const DIRECT_WATCH_SOURCE_TYPES = new Set([
  'darkino',
  'mp4',
  'nexus_hls',
  'nexus_file',
  'm3u8',
  'bravo',
]);

export const resolveRenderedWatchSource = (
  selectedSource: string | number | null | undefined,
  directSourceUrl: string | null | undefined,
  embedUrl: string | null | undefined,
): string => (
  typeof selectedSource === 'string' && DIRECT_WATCH_SOURCE_TYPES.has(selectedSource)
    ? directSourceUrl || ''
    : embedUrl || ''
);

export const resolveAcceptedWatchSource = ({
  requestedSource,
  availableSources,
  allowed = true,
  fallback = 'none',
  transform = (source) => source,
}: AcceptedWatchSourceOptions): string | null => {
  if (!allowed) return null;

  const requested = requestedSource || '';
  let accepted = '';
  if (availableSources === undefined) {
    accepted = requested;
  } else if (requested && availableSources.includes(requested)) {
    accepted = requested;
  } else if (fallback === 'first') {
    accepted = availableSources[0] || '';
  } else if (fallback === 'last') {
    accepted = availableSources[availableSources.length - 1] || '';
  }

  return accepted ? transform(accepted) : null;
};

export const syncHlsActiveSource = (
  guard: HlsAutoFallbackGuard,
  activeSourceRef: HlsActiveSourceRef,
  source: string,
): void => {
  activeSourceRef.current = source;
  if (source) {
    guard.syncActiveSource(source);
  }
};

export const createHlsAutoFallbackGuard = (
  maxAutomaticSwitches = 2,
): HlsAutoFallbackGuard => {
  let activeSource = '';
  let pendingSource = '';
  let automaticSwitchCount = 0;
  let invalidated = false;
  let activeOwner: object | null = null;

  return {
    syncActiveSource(source, owner) {
      if (invalidated || !source) return;
      if (source !== activeSource) {
        activeSource = source;
        pendingSource = '';
        activeOwner = owner ?? null;
        return;
      }
      if (owner && owner !== activeOwner) {
        activeOwner = owner;
        pendingSource = '';
      }
    },

    requestAutomaticSwitch(fromSource, owner) {
      if (
        invalidated
        || !fromSource
        || fromSource !== activeSource
        || (owner !== undefined && owner !== activeOwner)
        || pendingSource === fromSource
      ) {
        return 'stale';
      }
      if (automaticSwitchCount >= maxAutomaticSwitches) {
        return 'limit-reached';
      }
      automaticSwitchCount += 1;
      pendingSource = fromSource;
      return 'allow';
    },

    getAutomaticSwitchCount() {
      return automaticSwitchCount;
    },

    activate() {
      invalidated = false;
    },

    invalidate() {
      invalidated = true;
      activeSource = '';
      pendingSource = '';
      activeOwner = null;
    },
  };
};
