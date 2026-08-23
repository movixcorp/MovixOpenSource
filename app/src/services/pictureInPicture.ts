import { NativeEventEmitter, NativeModules } from 'react-native';
import type { PreparedNativePlaybackSource } from './nativePlayback';

declare const require: (
  id: './nativePlayback',
) => typeof import('./nativePlayback');

export type PictureInPictureAction =
  | 'seek-backward'
  | 'toggle-playback'
  | 'seek-forward';

const PICTURE_IN_PICTURE_ACTIONS = new Set<PictureInPictureAction>([
  'seek-backward',
  'toggle-playback',
  'seek-forward',
]);

export type PictureInPictureEvent =
  | { kind: 'prepare' }
  | { kind: 'state'; active: boolean }
  | { kind: 'state'; handoffId: string; active: boolean }
  | { kind: 'error'; code: string }
  | { kind: 'error'; handoffId: string; code: string }
  | { kind: 'ready'; handoffId: string }
  | {
      kind: 'restore';
      handoffId: string;
      positionSec: number;
      paused: boolean;
    }
  | { kind: 'action'; action: PictureInPictureAction };

interface NativePictureInPicture {
  preparedSourceProtocolVersion?: unknown;
  isSupported(): Promise<boolean>;
  setPlaybackActive(active: boolean): void;
  enter(handoffId?: string): Promise<void>;
  exit(): Promise<void>;
  prepare?(
    source: PreparedNativePlaybackSource,
    handoffId: string,
  ): Promise<void>;
  acknowledgeWebViewPaused?(handoffId: string): Promise<void>;
  acknowledgeRestoreApplied?(handoffId: string, ok: boolean): Promise<void>;
  cancel?(handoffId: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const EVENT_NAME = 'MOVIX_PICTURE_IN_PICTURE';
const PREPARED_SOURCE_PROTOCOL_VERSION = 1 as const;
const MAX_NATIVE_PLAYBACK_POSITION_SEC = 366 * 86_400;
const NATIVE_PLAYBACK_HANDOFF_ID = /^[A-Za-z0-9_-]{16,128}$/;
const PICTURE_IN_PICTURE_ERROR_CODE = /^PIP_[A-Z0-9_]{1,60}$/;

function isPictureInPictureHandoffId(value: unknown): value is string {
  return typeof value === 'string' && NATIVE_PLAYBACK_HANDOFF_ID.test(value);
}

export function normalizePreparedNativePlaybackSource(
  value: unknown,
): PreparedNativePlaybackSource | null {
  return require('./nativePlayback').normalizePreparedNativePlaybackSource(value);
}

export function isNativePlaybackHandoffId(value: unknown): value is string {
  return isPictureInPictureHandoffId(value);
}

function module(): NativePictureInPicture | undefined {
  return NativeModules.PictureInPicture as NativePictureInPicture | undefined;
}

export async function isPictureInPictureSupported(): Promise<boolean> {
  const native = module();
  return native ? native.isSupported().catch(() => false) : false;
}

export function getPreparedNativePlaybackSourceProtocolVersion(): 1 | null {
  return module()?.preparedSourceProtocolVersion
    === PREPARED_SOURCE_PROTOCOL_VERSION
    ? PREPARED_SOURCE_PROTOCOL_VERSION
    : null;
}

export function setPictureInPicturePlaybackActive(active: boolean): void {
  module()?.setPlaybackActive(active);
}

export async function enterPictureInPicture(): Promise<void> {
  const native = module();
  if (!native) throw new Error('PIP_UNAVAILABLE');
  await native.enter();
}

export async function enterPreparedPictureInPicture(
  handoffId: string,
): Promise<void> {
  if (!isPictureInPictureHandoffId(handoffId)) {
    throw new Error('PIP_INVALID_HANDOFF');
  }
  const native = module();
  if (!native) throw new Error('PIP_UNAVAILABLE');
  await native.enter(handoffId);
}

export async function exitPictureInPicture(): Promise<void> {
  const native = module();
  if (!native) throw new Error('PIP_UNAVAILABLE');
  await native.exit();
}

export async function preparePictureInPictureSource(
  source: PreparedNativePlaybackSource,
  handoffId: string,
): Promise<void> {
  const normalized = normalizePreparedNativePlaybackSource(source);
  if (!normalized || !isPictureInPictureHandoffId(handoffId)) {
    throw new Error('PIP_INVALID_SOURCE');
  }
  const native = module();
  if (!native?.prepare) throw new Error('PIP_UNAVAILABLE');
  await native.prepare(normalized, handoffId);
}

export async function acknowledgePictureInPictureWebViewPaused(
  handoffId: string,
): Promise<void> {
  if (!isPictureInPictureHandoffId(handoffId)) {
    throw new Error('PIP_INVALID_HANDOFF');
  }
  const native = module();
  if (!native?.acknowledgeWebViewPaused) throw new Error('PIP_UNAVAILABLE');
  await native.acknowledgeWebViewPaused(handoffId);
}

export async function acknowledgePictureInPictureRestoreApplied(
  handoffId: string,
  ok: boolean,
): Promise<void> {
  if (!isPictureInPictureHandoffId(handoffId) || typeof ok !== 'boolean') {
    throw new Error('PIP_INVALID_HANDOFF');
  }
  const native = module();
  if (!native?.acknowledgeRestoreApplied) throw new Error('PIP_UNAVAILABLE');
  await native.acknowledgeRestoreApplied(handoffId, ok);
}

export async function cancelPictureInPictureHandoff(
  handoffId: string,
): Promise<void> {
  if (!isPictureInPictureHandoffId(handoffId)) {
    throw new Error('PIP_INVALID_HANDOFF');
  }
  const native = module();
  if (!native?.cancel) throw new Error('PIP_UNAVAILABLE');
  await native.cancel(handoffId);
}

export function parsePictureInPictureEvent(
  value: unknown,
): PictureInPictureEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'prepare') return { kind: 'prepare' };
  const handoffId = isPictureInPictureHandoffId(raw.handoffId)
    ? raw.handoffId
    : null;
  if (raw.kind === 'ready' && handoffId) {
    return { kind: 'ready', handoffId };
  }
  if (
    raw.kind === 'restore'
    && handoffId
    && typeof raw.positionSec === 'number'
    && Number.isFinite(raw.positionSec)
    && raw.positionSec >= 0
    && raw.positionSec <= MAX_NATIVE_PLAYBACK_POSITION_SEC
    && typeof raw.paused === 'boolean'
  ) {
    return {
      kind: 'restore',
      handoffId,
      positionSec: raw.positionSec,
      paused: raw.paused,
    };
  }
  if (raw.kind === 'state' && typeof raw.active === 'boolean') {
    return handoffId
      ? { kind: 'state', handoffId, active: raw.active }
      : { kind: 'state', active: raw.active };
  }
  if (
    raw.kind === 'error'
    && typeof raw.code === 'string'
    && raw.code.length <= 64
    && PICTURE_IN_PICTURE_ERROR_CODE.test(raw.code)
  ) {
    return handoffId
      ? { kind: 'error', handoffId, code: raw.code }
      : { kind: 'error', code: raw.code };
  }
  if (
    raw.kind === 'action'
    && typeof raw.action === 'string'
    && PICTURE_IN_PICTURE_ACTIONS.has(raw.action as PictureInPictureAction)
  ) {
    return { kind: 'action', action: raw.action as PictureInPictureAction };
  }
  return null;
}

export function subscribePictureInPicture(
  listener: (event: PictureInPictureEvent) => void,
): () => void {
  const native = module();
  if (!native) return () => undefined;
  const subscription = new NativeEventEmitter(native).addListener(EVENT_NAME, value => {
    const event = parsePictureInPictureEvent(value);
    if (event) listener(event);
  });
  return () => subscription.remove();
}
