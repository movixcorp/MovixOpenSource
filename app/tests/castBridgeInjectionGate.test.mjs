import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const bridgeSource = await readFile(
  new URL('../src/services/bridge.ts', import.meta.url),
  'utf8',
);
const castLoadSingleFlightSource = await readFile(
  new URL('../src/services/castLoadSingleFlight.ts', import.meta.url),
  'utf8',
);
const castLoadSingleFlightOutput = ts.transpileModule(castLoadSingleFlightSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

function loadCastLoadSingleFlight() {
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(module,exports){${castLoadSingleFlightOutput}\n})`,
    {},
  )(module, module.exports);
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function loadBridge(overrides = {}, nativeModules = {}) {
  let statusListener = null;
  const cast = {
    getCastCapabilities: async () => ({
      configured: true,
      receiverProtocolVersion: 1,
      castLanProxyVersion: 1,
    }),
    getCastStatus: async () => ({
      connected: true,
      deviceName: 'Salon',
      mediaSessionId: 1,
      state: 'playing',
      positionSec: 1,
      durationSec: 2,
      canSeek: true,
    }),
    getRelayDisclosurePreference: async () => false,
    isCastSupported: async () => true,
    loadCastMedia: async () => {},
    openCastBatterySettings: async () => {},
    pauseCast: async () => {},
    playCast: async () => {},
    requestCastRelayNotificationPermission: () => {},
    seekCastTo: async () => {},
    setRelayDisclosureSuppressed: async () => {},
    stopCast: async () => {},
    subscribeCastStatus: listener => {
      statusListener = listener;
      return () => {
        statusListener = null;
      };
    },
    ...overrides,
  };
  const output = ts.transpileModule(bridgeSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const require = id => {
    if (id === 'react-native') {
      return { NativeModules: nativeModules, Platform: { OS: 'android' } };
    }
    if (id === './cast') return cast;
    if (id === './castLoadSingleFlight') return loadCastLoadSingleFlight();
    if (id === './mediaProxyHeaders') {
      return {
        applyMediaProxyHeaderRules: (_url, headers) => ({ ...headers }),
      };
    }
    if (id === './playbackAwake') return { setPlaybackAwakeOwner: () => {} };
    if (id === './pictureInPicture') {
      return {
        enterPictureInPicture: async () => {},
        exitPictureInPicture: async () => {},
        isPictureInPictureSupported: async () => true,
        setPictureInPicturePlaybackActive: () => {},
        subscribePictureInPicture: () => () => {},
      };
    }
    throw new Error(`Unexpected bridge dependency: ${id}`);
  };
  vm.runInNewContext(
    `(function(require,module,exports){${output}\n})`,
    { URL, AbortController, Headers, Response, fetch, setTimeout, clearTimeout },
  )(require, module, module.exports);
  return {
    bridge: module.exports,
    emitStatus(status) {
      assert.ok(statusListener, 'status listener must be active');
      statusListener(status);
    },
  };
}

const trustedContext = {
  sourceUrl: 'https://movix.example/watch/1',
  trustedOrigins: ['https://movix.example'],
};
const untrustedContext = {
  sourceUrl: 'https://attacker.example/',
  trustedOrigins: ['https://movix.example'],
};
const capabilityA = 'a'.repeat(32);
const capabilityB = 'b'.repeat(32);

async function register(bridge, webViewRef, capability, context = trustedContext) {
  await bridge.handleBridgeMessage(
    JSON.stringify({
      type: 'CASTSHIM_REGISTER_CAPABILITY',
      capability,
    }),
    webViewRef,
    context,
  );
}

test('status injection requires the active trusted document capability', async () => {
  const { bridge, emitStatus } = loadBridge();
  const injected = [];
  const webViewRef = {
    current: {
      injectJavaScript(script) {
        injected.push(script);
      },
    },
  };
  const status = {
    connected: true,
    state: 'playing',
    positionSec: 1,
    durationSec: 2,
    canSeek: true,
  };

  bridge.startCastShimEventForwarding(webViewRef);
  emitStatus(status);
  assert.equal(injected.length, 0, 'no active capability must block status');

  await register(bridge, webViewRef, capabilityA);
  emitStatus(status);
  assert.equal(injected.length, 1, 'current trusted document receives status');

  bridge.clearBridgeCapabilities(webViewRef);
  emitStatus(status);
  assert.equal(injected.length, 1, 'navigation/unmount invalidation blocks status');

  await register(bridge, webViewRef, capabilityB, untrustedContext);
  emitStatus(status);
  assert.equal(injected.length, 1, 'untrusted document cannot establish a gate');
});

test('an async response cannot cross navigation into a new capability', async () => {
  const support = deferred();
  const { bridge } = loadBridge({
    isCastSupported: () => support.promise,
  });
  const injected = [];
  const webViewRef = {
    current: {
      injectJavaScript(script) {
        injected.push(script);
      },
    },
  };

  await register(bridge, webViewRef, capabilityA);
  const oldResponse = bridge.handleBridgeMessage(
    JSON.stringify({
      type: 'CASTSHIM_INIT',
      id: 'old-document-request',
      capability: capabilityA,
    }),
    webViewRef,
    trustedContext,
  );

  bridge.clearBridgeCapabilities(webViewRef);
  await register(bridge, webViewRef, capabilityB);
  support.resolve(true);
  await oldResponse;

  assert.equal(
    injected.length,
    0,
    'response for the old capability must not enter the new document',
  );
});

test('an async status refresh cannot cross reload into a new capability', async () => {
  const refreshedStatus = deferred();
  const { bridge } = loadBridge({
    getCastStatus: () => refreshedStatus.promise,
  });
  const injected = [];
  const webViewRef = {
    current: {
      injectJavaScript(script) {
        injected.push(script);
      },
    },
  };

  await register(bridge, webViewRef, capabilityA);
  const refresh = bridge.refreshCastShimStatus(webViewRef);
  bridge.clearBridgeCapabilities(webViewRef);
  await register(bridge, webViewRef, capabilityB);
  refreshedStatus.resolve({
    connected: true,
    state: 'playing',
    positionSec: 1,
    durationSec: 2,
    canSeek: true,
  });
  await refresh;

  assert.equal(
    injected.length,
    0,
    'refresh started by the old document must not enter the new document',
  );
});

test('resolves an authenticated loopback media URL before native Cast loading', async () => {
  const loaded = [];
  const resolved = [];
  const localUrl =
    'http://127.0.0.1:36375/p/process-token/session-token/resource-token';
  const { bridge } = loadBridge(
    {
      loadCastMedia: async source => loaded.push(source),
    },
    {
      MediaProxy: {
        resolveForCast: async url => {
          resolved.push(url);
          return {
            url: 'https://cdn.example/master.m3u8',
            headers: { Referer: 'https://player.example/' },
            protocolVersion: 1,
          };
        },
      },
    },
  );
  const webViewRef = {
    current: { injectJavaScript() {} },
  };
  await register(bridge, webViewRef, capabilityA);

  await bridge.handleBridgeMessage(
    JSON.stringify({
      type: 'CASTSHIM_LOAD_MEDIA',
      id: 'loopback-load',
      capability: capabilityA,
      source: {
        url: localUrl,
        headers: {},
        contentType: 'application/vnd.apple.mpegurl',
        protocolVersion: 1,
      },
      metadata: { title: 'Film', currentTime: 12 },
    }),
    webViewRef,
    trustedContext,
  );

  assert.deepEqual(resolved, [localUrl]);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), [{
    url: 'https://cdn.example/master.m3u8',
    headers: { Referer: 'https://player.example/' },
    contentType: 'application/vnd.apple.mpegurl',
    protocolVersion: 1,
  }]);
});

test('preserves bounded inline WebVTT tracks for the native LAN relay', async () => {
  const loaded = [];
  const { bridge } = loadBridge({
    loadCastMedia: async source => loaded.push(source),
  });
  const webViewRef = { current: { injectJavaScript() {} } };
  await register(bridge, webViewRef, capabilityA);
  const inlineVtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n';

  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'CASTSHIM_LOAD_MEDIA',
    id: 'inline-subtitle-load',
    capability: capabilityA,
    source: {
      url: 'https://cdn.example/master.m3u8',
      headers: {},
      protocolVersion: 1,
      tracks: [{
        inlineVtt,
        contentType: 'text/vtt',
        protocolVersion: 1,
        language: 'fr',
        active: true,
      }],
    },
    metadata: { title: 'Film', currentTime: 0 },
  }), webViewRef, trustedContext);

  assert.equal(loaded[0].tracks[0].inlineVtt, inlineVtt);
  assert.equal('url' in loaded[0].tracks[0], false);
});
