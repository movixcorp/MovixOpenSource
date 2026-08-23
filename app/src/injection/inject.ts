import { buildBridgeRuntime } from './bridge-runtime';
import { buildCastShim } from './cast-shim';
import {
  buildPictureInPictureShim,
  type PictureInPictureShimMode,
} from './picture-in-picture-shim';
import { buildPlaybackAwakeShim } from './playback-awake-shim';
import { USERSCRIPT_SOURCE } from './userscript-source';

export function buildInjectedJavaScript(
  options: {
    pictureInPictureMode?: PictureInPictureShimMode;
    mediaProxyRoutingEnabled?: boolean;
    mediaProxyCapabilityEnabled?: boolean;
    mediaProxyXhrRoutingEnabled?: boolean;
  } = {},
): string {
  const castShim = buildCastShim();
  const pipShim = buildPictureInPictureShim(
    options.pictureInPictureMode ?? 'disabled',
  );
  const playbackAwakeShim = buildPlaybackAwakeShim();
  const bridge = buildBridgeRuntime({
    mediaProxyRoutingEnabled: options.mediaProxyRoutingEnabled,
    mediaProxyCapabilityEnabled: options.mediaProxyCapabilityEnabled,
    mediaProxyXhrRoutingEnabled: options.mediaProxyXhrRoutingEnabled,
  });

  // Cast shim FIRST — must be on window before any page JS runs.
  return `
${castShim}

${pipShim}

${playbackAwakeShim}

${bridge}

// --- Userscript Movix ---
${USERSCRIPT_SOURCE}

true;
`;
}
