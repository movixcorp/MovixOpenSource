export type VavooAvailabilityFlag =
  | 'backup'
  | 'event-only'
  | 'match-time'
  | 'not-24-7'
  | 'geo-blocked';

export interface VavooChannelVariant {
  id: string;
  originalName: string;
  server: string;
  quality: string;
  qualityRank: number;
  availability: VavooAvailabilityFlag[];
}

export interface VavooChannelInput {
  id: string;
  name: string;
}

export type VavooGroupedChannel<T extends VavooChannelInput> = T & {
  _vavooVariants: VavooChannelVariant[];
};

export interface VavooStreamLabels {
  server: string;
  standard: string;
}

export type VavooResolvedVariantStream<T> = T & {
  _vavooVariantId: string;
  title: string;
};

export interface VavooResolutionOptions<T extends { title?: string; url?: string }> {
  onStreamsResolved?: (streams: Array<VavooResolvedVariantStream<T>>) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ParsedVavooName {
  displayName: string;
  groupKey: string;
  variant: VavooChannelVariant;
}

const SERVER_SUFFIX = /\s+\.([a-z0-9]+)\s*$/iu;
const PARENTHESIZED_QUALITY_SUFFIX = /\s+\((ULTRA\s+4K|4K\s+ULTRA|FULL\s*HD|FHD\+?|UHD|4K|HD\+?|HD|SD|\d{3,4}P)\)\s*$/iu;
const QUALITY_SUFFIX = /\s+(ULTRA\s+4K|4K\s+ULTRA|FULL\s*HD|FHD\+?|UHD|4K|HD\+?|HD|SD|\d{3,4}P)\s*$/iu;

const AVAILABILITY_SUFFIXES: Array<{
  pattern: RegExp;
  flag: VavooAvailabilityFlag;
}> = [
  { pattern: /\s+\(BACKUP\)\s*$/iu, flag: 'backup' },
  { pattern: /\s+\[LIVE DURING EVENTS ONLY\]\s*$/iu, flag: 'event-only' },
  { pattern: /\s+\(MATCH TIME\)\s*$/iu, flag: 'match-time' },
  { pattern: /\s+\[NOT 24\/7\]\s*$/iu, flag: 'not-24-7' },
  { pattern: /\s+\[GEO-BLOCKED\]\s*$/iu, flag: 'geo-blocked' },
];

const normalizeQuality = (rawQuality: string): { quality: string; rank: number } => {
  const normalized = rawQuality.toUpperCase().replace(/\s+/g, ' ').trim();

  if (normalized === 'ULTRA 4K' || normalized === '4K ULTRA' || normalized === '4K') {
    return { quality: '4K', rank: 100 };
  }
  if (normalized === 'UHD') return { quality: 'UHD', rank: 90 };
  if (normalized === 'FULL HD' || normalized === 'FULLHD' || normalized === 'FHD+') {
    return { quality: normalized === 'FHD+' ? 'FHD+' : 'FHD', rank: 82 };
  }
  if (normalized === 'FHD') return { quality: 'FHD', rank: 80 };
  if (normalized === 'HD+') return { quality: 'HD+', rank: 70 };
  if (normalized === 'HD') return { quality: 'HD', rank: 60 };
  if (normalized === 'SD') return { quality: 'SD', rank: 20 };

  const resolution = Number.parseInt(normalized, 10);
  if (Number.isFinite(resolution)) {
    if (resolution >= 2160) return { quality: `${resolution}p`, rank: 100 };
    if (resolution >= 1080) return { quality: `${resolution}p`, rank: 80 };
    if (resolution >= 720) return { quality: `${resolution}p`, rank: 60 };
    return { quality: `${resolution}p`, rank: 20 };
  }

  return { quality: normalized, rank: 40 };
};

const buildGroupKey = (name: string): string => name
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLocaleUpperCase('fr-FR')
  .replace(/&/g, 'ET')
  // A plus is part of a channel brand (CANAL+, PLANETE+, etc.), so preserve it
  // while ignoring harmless spacing, dots and dashes elsewhere in the name.
  .replace(/\+/g, 'PLUS')
  .replace(/[^\p{L}\p{N}]+/gu, '');

export const parseVavooChannelName = (id: string, name: string): ParsedVavooName => {
  const originalName = name.trim();
  let remainingName = originalName;
  let server = '';
  let quality = 'Standard';
  let qualityRank = 40;
  const availability: VavooAvailabilityFlag[] = [];

  const serverMatch = remainingName.match(SERVER_SUFFIX);
  if (serverMatch && serverMatch.index !== undefined) {
    server = serverMatch[1].toLowerCase();
    remainingName = remainingName.slice(0, serverMatch.index).trim();
  }

  // Vavoo combines metadata suffixes in either order, for example
  // "FHD [LIVE DURING EVENTS ONLY]" or "HD (BACKUP)". Repeating the pass
  // makes both forms converge to the same logical channel name.
  let removedSuffix = true;
  while (removedSuffix) {
    removedSuffix = false;

    for (const suffix of AVAILABILITY_SUFFIXES) {
      const match = remainingName.match(suffix.pattern);
      if (!match || match.index === undefined) continue;

      if (!availability.includes(suffix.flag)) availability.push(suffix.flag);
      remainingName = remainingName.slice(0, match.index).trim();
      removedSuffix = true;
      break;
    }
    if (removedSuffix) continue;

    const qualityMatch = remainingName.match(PARENTHESIZED_QUALITY_SUFFIX)
      || remainingName.match(QUALITY_SUFFIX);
    if (qualityMatch && qualityMatch.index !== undefined) {
      const parsedQuality = normalizeQuality(qualityMatch[1]);
      quality = parsedQuality.quality;
      qualityRank = parsedQuality.rank;
      remainingName = remainingName.slice(0, qualityMatch.index).trim();
      removedSuffix = true;
    }
  }

  const displayName = remainingName.replace(/\s+/g, ' ').trim() || originalName;

  return {
    displayName,
    groupKey: buildGroupKey(displayName) || buildGroupKey(originalName) || id,
    variant: {
      id,
      originalName,
      server,
      quality,
      qualityRank,
      availability,
    },
  };
};

const compareVariants = (left: VavooChannelVariant, right: VavooChannelVariant): number => {
  if (left.qualityRank !== right.qualityRank) return right.qualityRank - left.qualityRank;

  const leftIsBackup = left.availability.includes('backup');
  const rightIsBackup = right.availability.includes('backup');
  if (leftIsBackup !== rightIsBackup) return leftIsBackup ? 1 : -1;

  const leftIsLimited = left.availability.some((flag) => flag !== 'backup');
  const rightIsLimited = right.availability.some((flag) => flag !== 'backup');
  if (leftIsLimited !== rightIsLimited) return leftIsLimited ? 1 : -1;

  return left.server.localeCompare(right.server, 'fr', { sensitivity: 'base' });
};

export const formatVavooVariantLabel = (
  variant: VavooChannelVariant,
  labels: VavooStreamLabels,
): string => {
  const parts: string[] = [];
  if (variant.quality && variant.quality !== 'Standard') parts.push(variant.quality);
  if (variant.server) parts.push(`${labels.server} ${variant.server.toUpperCase()}`);
  return parts.join(' · ') || labels.standard;
};

export type VavooFallbackAction = 'next' | 'wait' | 'error';

export const getVavooFallbackAction = (
  currentStreamIndex: number,
  streamCount: number,
  isResolving: boolean,
): VavooFallbackAction => {
  if (currentStreamIndex < streamCount - 1) return 'next';
  return isResolving ? 'wait' : 'error';
};

/**
 * Resolves every server of a grouped Vavoo channel concurrently. A failed
 * variant is isolated so any other playable server can still open the player.
 */
export const resolveVavooVariantStreams = async <T extends { title?: string; url?: string }>(
  variants: VavooChannelVariant[],
  resolveVariant: (variantId: string, signal: AbortSignal) => Promise<{ streams?: T[] }>,
  labels: VavooStreamLabels,
  options: VavooResolutionOptions<T> = {},
): Promise<Array<VavooResolvedVariantStream<T>>> => {
  const results = await Promise.allSettled(variants.map(async (variant) => {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      abortFromParent();
    } else {
      options.signal?.addEventListener('abort', abortFromParent, { once: true });
    }

    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs!) : 0;
    const timeoutId = timeoutMs > 0
      ? setTimeout(() => {
        const timeoutError = new Error(`Vavoo server ${variant.id} timed out`);
        timeoutError.name = 'TimeoutError';
        controller.abort(timeoutError);
      }, timeoutMs)
      : null;

    let rejectOnAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = () => {
        const reason = controller.signal.reason;
        const error = reason instanceof Error ? reason : new Error('Vavoo resolution aborted');
        if (!(reason instanceof Error)) error.name = 'AbortError';
        reject(error);
      };

      if (controller.signal.aborted) rejectOnAbort();
      else controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });

    try {
      const payload = await Promise.race([
        resolveVariant(variant.id, controller.signal),
        aborted,
      ]);
      const streams = Array.isArray(payload?.streams) ? payload.streams : [];
      const title = formatVavooVariantLabel(variant, labels);

      const resolvedStreams = streams
        .filter((stream) => typeof stream?.url === 'string' && stream.url.trim().length > 0)
        .map((stream) => ({
          ...stream,
          _vavooVariantId: variant.id,
          title,
        }));

      if (resolvedStreams.length > 0) options.onStreamsResolved?.(resolvedStreams);
      return resolvedStreams;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', abortFromParent);
      if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort);
    }
  }));

  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
};

/**
 * Collapses Vavoo's server and quality entries into one logical channel.
 * The first variant is the preferred default (best quality, then non-backup),
 * while every original channel id remains available to the player selector.
 */
export const groupVavooChannels = <T extends VavooChannelInput>(
  channels: T[],
): Array<VavooGroupedChannel<T>> => {
  const groups = new Map<string, {
    displayName: string;
    channelById: Map<string, T>;
    variants: VavooChannelVariant[];
  }>();

  channels.forEach((channel) => {
    const parsed = parseVavooChannelName(channel.id, channel.name);
    const existing = groups.get(parsed.groupKey);

    if (existing) {
      if (!existing.channelById.has(channel.id)) {
        existing.channelById.set(channel.id, channel);
        existing.variants.push(parsed.variant);
      }
      return;
    }

    groups.set(parsed.groupKey, {
      displayName: parsed.displayName,
      channelById: new Map([[channel.id, channel]]),
      variants: [parsed.variant],
    });
  });

  return Array.from(groups.values()).map((group) => {
    const variants = [...group.variants].sort(compareVariants);
    const preferredChannel = group.channelById.get(variants[0].id)
      || group.channelById.values().next().value;

    return {
      ...preferredChannel,
      name: group.displayName,
      _vavooVariants: variants,
    } as VavooGroupedChannel<T>;
  });
};
