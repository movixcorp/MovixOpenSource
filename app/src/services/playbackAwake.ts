import { NativeModules } from 'react-native';

interface PlaybackAwakeNativeModule {
  setLocalPlaybackAwake: (active: boolean) => void;
  setPlaybackAwakeOwner?: (owner: PlaybackAwakeOwner, active: boolean) => void;
}

export type PlaybackAwakeOwner = 'local-playback' | 'pip' | 'cast';

export function setLocalPlaybackAwake(active: boolean): void {
  const module = NativeModules.PlaybackAwake as PlaybackAwakeNativeModule | undefined;
  module?.setLocalPlaybackAwake(active);
}

export function setPlaybackAwakeOwner(
  owner: PlaybackAwakeOwner,
  active: boolean,
): void {
  const module = NativeModules.PlaybackAwake as PlaybackAwakeNativeModule | undefined;
  if (module?.setPlaybackAwakeOwner) {
    module.setPlaybackAwakeOwner(owner, active);
  } else if (owner === 'local-playback') {
    module?.setLocalPlaybackAwake(active);
  }
}
