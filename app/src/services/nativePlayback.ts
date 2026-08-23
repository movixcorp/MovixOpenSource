export const PREPARED_NATIVE_PLAYBACK_SOURCE_PROTOCOL_VERSION = 1 as const;

export type PreparedNativePlaybackSource = {
  protocolVersion: typeof PREPARED_NATIVE_PLAYBACK_SOURCE_PROTOCOL_VERSION;
  url: string;
  positionSec: number;
  paused: boolean;
  playbackRate: number;
  muted: boolean;
  title?: string;
  poster?: string;
};

export const NATIVE_PLAYBACK_MAX_POSITION_SEC = 366 * 86_400;

const MAX_POSTER_URL_LENGTH = 16_384;
const MAX_TITLE_LENGTH = 256;
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const LOOPBACK_MEDIA_PATTERN = (
  /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/p\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}$/
);
const FORBIDDEN_URL_CHARACTERS = /[\u0000-\u0020\u007f\\]/;

type OwnData = Record<string, PropertyDescriptor | undefined>;

function ownDataDescriptors(value: object): OwnData | null {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function dataValue(
  descriptors: OwnData,
  key: string,
): { present: boolean; value?: unknown } | null {
  const descriptor = descriptors[key];
  if (!descriptor) return { present: false };
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  return { present: true, value: descriptor.value };
}

export function isNativePlaybackHandoffId(value: unknown): value is string {
  return typeof value === 'string' && HANDOFF_ID_PATTERN.test(value);
}

export function isCanonicalMovixLoopbackURL(value: unknown): value is string {
  if (typeof value !== 'string' || FORBIDDEN_URL_CHARACTERS.test(value)) {
    return false;
  }
  const match = LOOPBACK_MEDIA_PATTERN.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 && String(port) === match[1];
}

function isCanonicalHttpsPosterURL(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_POSTER_URL_LENGTH
    || FORBIDDEN_URL_CHARACTERS.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.hostname !== ''
      && parsed.href === value;
  } catch {
    return false;
  }
}

export function normalizePreparedNativePlaybackSource(
  raw: unknown,
): PreparedNativePlaybackSource | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const descriptors = ownDataDescriptors(raw);
  if (!descriptors) return null;
  const protocolVersion = dataValue(descriptors, 'protocolVersion');
  const url = dataValue(descriptors, 'url');
  const positionSec = dataValue(descriptors, 'positionSec');
  const paused = dataValue(descriptors, 'paused');
  const playbackRate = dataValue(descriptors, 'playbackRate');
  const muted = dataValue(descriptors, 'muted');
  const title = dataValue(descriptors, 'title');
  const poster = dataValue(descriptors, 'poster');
  if (
    !protocolVersion
    || !url
    || !positionSec
    || !paused
    || !playbackRate
    || !muted
    || !title
    || !poster
    || !protocolVersion.present
    || protocolVersion.value !== PREPARED_NATIVE_PLAYBACK_SOURCE_PROTOCOL_VERSION
    || !url.present
    || !isCanonicalMovixLoopbackURL(url.value)
    || !positionSec.present
    || typeof positionSec.value !== 'number'
    || !Number.isFinite(positionSec.value)
    || positionSec.value < 0
    || positionSec.value > NATIVE_PLAYBACK_MAX_POSITION_SEC
    || !paused.present
    || typeof paused.value !== 'boolean'
    || !playbackRate.present
    || typeof playbackRate.value !== 'number'
    || !Number.isFinite(playbackRate.value)
    || playbackRate.value < 0.25
    || playbackRate.value > 4
    || !muted.present
    || typeof muted.value !== 'boolean'
    || (title.present && (
      typeof title.value !== 'string' || title.value.length > MAX_TITLE_LENGTH
    ))
    || (poster.present && !isCanonicalHttpsPosterURL(poster.value))
  ) {
    return null;
  }

  const normalized: PreparedNativePlaybackSource = {
    protocolVersion: PREPARED_NATIVE_PLAYBACK_SOURCE_PROTOCOL_VERSION,
    url: url.value,
    positionSec: positionSec.value,
    paused: paused.value,
    playbackRate: playbackRate.value,
    muted: muted.value,
  };
  if (title.present) normalized.title = title.value as string;
  if (poster.present) normalized.poster = poster.value as string;
  return normalized;
}
