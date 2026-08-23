import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const bridgeSource = await readFile(
  new URL('../src/services/bridge.ts', import.meta.url),
  'utf8',
);
const nativePlaybackSource = await readFile(
  new URL('../src/services/nativePlayback.ts', import.meta.url),
  'utf8',
);
const pictureInPictureSource = await readFile(
  new URL('../src/services/pictureInPicture.ts', import.meta.url),
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
const nativePlaybackOutput = ts.transpileModule(nativePlaybackSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const pictureInPictureOutput = ts.transpileModule(pictureInPictureSource, {
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

function loadNativePlayback() {
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(module,exports){${nativePlaybackOutput}\n})`,
    { URL },
  )(module, module.exports);
  return module.exports;
}

function loadPictureInPictureService(nativeModule) {
  const nativePlayback = loadNativePlayback();
  const module = { exports: {} };
  const require = id => {
    if (id === './nativePlayback') return nativePlayback;
    if (id === 'react-native') {
      return {
        NativeEventEmitter: class {},
        NativeModules: { PictureInPicture: nativeModule },
      };
    }
    throw new Error(`Unexpected pictureInPicture dependency: ${id}`);
  };
  vm.runInNewContext(
    `(function(require,module,exports){${pictureInPictureOutput}\n})`,
    {},
  )(require, module, module.exports);
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runNext(delay) {
      const match = [...pending.entries()]
        .find(([, timer]) => delay === undefined || timer.delay === delay);
      assert.ok(match, `expected a pending ${delay ?? 'any'}ms timer`);
      const [id, timer] = match;
      pending.delete(id);
      timer.callback();
    },
  };
}

function loadBridge(pipOverrides = {}, runtimeOverrides = {}) {
  let pipListener = null;
  const nativePlayback = loadNativePlayback();
  const calls = {
    awake: [],
    awakeOwner: [],
    pipPlayback: [],
    enter: 0,
    enterPrepared: [],
    exit: 0,
    prepare: [],
    acknowledgePaused: [],
    acknowledgeRestore: [],
    cancel: [],
    sequence: [],
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
      return {
        NativeModules: {
          PlaybackAwake: {
            setLocalPlaybackAwake: active => calls.awake.push(active),
          },
        },
        Platform: { OS: runtimeOverrides.platform ?? 'android' },
      };
    }
    if (id === './cast') {
      return {
        getCastCapabilities: async () => ({}),
        getCastStatus: async () => ({}),
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
        subscribeCastStatus: () => () => {},
      };
    }
    if (id === './castLoadSingleFlight') return loadCastLoadSingleFlight();
    if (id === './mediaProxyHeaders') {
      return { applyMediaProxyHeaderRules: (_url, headers) => ({ ...headers }) };
    }
    if (id === './nativePlayback') return nativePlayback;
    if (id === './playbackAwake') {
      return {
        setPlaybackAwakeOwner: (owner, active) => {
          calls.awakeOwner.push([owner, active]);
        },
      };
    }
    if (id === './pictureInPicture') {
      return {
        acknowledgePictureInPictureRestoreApplied: async (...args) => {
          calls.acknowledgeRestore.push(args);
          calls.sequence.push(`ackRestore:${args[0]}:${args[1]}`);
          await pipOverrides.acknowledgePictureInPictureRestoreApplied?.(...args);
        },
        acknowledgePictureInPictureWebViewPaused: async (...args) => {
          calls.acknowledgePaused.push(args);
          calls.sequence.push(`ackPaused:${args[0]}`);
          await pipOverrides.acknowledgePictureInPictureWebViewPaused?.(...args);
        },
        cancelPictureInPictureHandoff: async (...args) => {
          calls.cancel.push(args);
          calls.sequence.push(`cancel:${args[0]}`);
          await pipOverrides.cancelPictureInPictureHandoff?.(...args);
        },
        enterPictureInPicture: async () => {
          calls.enter += 1;
          await pipOverrides.enterPictureInPicture?.();
        },
        enterPreparedPictureInPicture: async (...args) => {
          calls.enterPrepared.push(args);
          calls.sequence.push(`enter:${args[0]}`);
          await pipOverrides.enterPreparedPictureInPicture?.(...args);
        },
        exitPictureInPicture: async () => {
          calls.exit += 1;
          await pipOverrides.exitPictureInPicture?.();
        },
        getPreparedNativePlaybackSourceProtocolVersion: () => (
          pipOverrides.getPreparedNativePlaybackSourceProtocolVersion?.()
          ?? (runtimeOverrides.platform === 'ios' ? 1 : null)
        ),
        isNativePlaybackHandoffId: nativePlayback.isNativePlaybackHandoffId,
        isPictureInPictureSupported: async () => true,
        normalizePreparedNativePlaybackSource:
          nativePlayback.normalizePreparedNativePlaybackSource,
        preparePictureInPictureSource: async (...args) => {
          calls.prepare.push(args);
          calls.sequence.push(`prepare:${args[1]}`);
          await pipOverrides.preparePictureInPictureSource?.(...args);
        },
        setPictureInPicturePlaybackActive: active => calls.pipPlayback.push(active),
        subscribePictureInPicture: listener => {
          pipListener = listener;
          return () => { pipListener = null; };
        },
      };
    }
    throw new Error(`Unexpected bridge dependency: ${id}`);
  };
  vm.runInNewContext(
    `(function(require,module,exports){${output}\n})`,
    {
      URL,
      AbortController,
      Headers,
      Response,
      fetch,
      setTimeout,
      clearTimeout,
      ...runtimeOverrides,
    },
  )(require, module, module.exports);
  return {
    bridge: module.exports,
    calls,
    emitPip(event) {
      assert.ok(pipListener, 'PiP listener must be active');
      pipListener(event);
    },
  };
}

test('trusted bridge provenance does not depend on React Native URL properties', async () => {
  class IncompleteReactNativeURL {
    constructor() {}
    get protocol() { throw new Error('URL.protocol is not implemented'); }
    get origin() { throw new Error('URL.origin is not implemented'); }
  }
  const { bridge, calls } = loadBridge({}, { URL: IncompleteReactNativeURL });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };

  await registerPip(bridge, ref, 'f'.repeat(32));
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'rn-url-enter', capability: 'f'.repeat(32),
  }), ref, trustedContext);

  assert.equal(calls.enter, 1);
  assert.equal(injected.length, 1);
});

const trustedContext = {
  sourceUrl: 'https://movix.example/watch/1',
  trustedOrigins: ['https://movix.example'],
  isTopFrame: true,
  navigationGeneration: 0,
};
const untrustedContext = {
  sourceUrl: 'https://attacker.example/',
  trustedOrigins: ['https://movix.example'],
  isTopFrame: true,
};
const sameOriginSubframeContext = {
  sourceUrl: 'https://movix.example/embed/1',
  trustedOrigins: ['https://movix.example'],
  isTopFrame: false,
};
const iosMainDocumentWithoutFrameIdentity = {
  sourceUrl: 'https://movix.example/watch/1',
  topLevelUrl: 'https://movix.example/watch/1',
  trustedOrigins: ['https://movix.example'],
  navigationGeneration: 4,
};
const PIP_TOKEN_A = 'A'.repeat(43);
const PIP_TOKEN_B = 'b'.repeat(43);
const PIP_TOKEN_C = '_'.repeat(43);
const PIP_SOURCE_URL = `http://127.0.0.1:49152/p/${PIP_TOKEN_A}/${PIP_TOKEN_B}/${PIP_TOKEN_C}`;
const HANDOFF_ONE = 'handoff_00000001';
const HANDOFF_TWO = 'handoff_00000002';

function preparedSource(overrides = {}) {
  return {
    protocolVersion: 1,
    url: PIP_SOURCE_URL,
    positionSec: 7.5,
    paused: false,
    playbackRate: 1,
    muted: false,
    title: 'Episode 1',
    ...overrides,
  };
}

async function registerPip(bridge, ref, capability, context = trustedContext) {
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_REGISTER_CAPABILITY',
    capability,
  }), ref, context);
}

async function postPrepared(
  bridge,
  ref,
  capability,
  id = HANDOFF_ONE,
  source = preparedSource(),
  context = trustedContext,
) {
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_PREPARED_SOURCE',
    id,
    capability,
    source,
  }), ref, context);
}

test('iOS accepts the coherent Apple main document without isTopFrame while explicit subframes stay rejected', async () => {
  const capability = 'd'.repeat(32);
  const accepted = loadBridge({}, { platform: 'ios' });
  const acceptedRef = { current: { injectJavaScript() {} } };
  await registerPip(
    accepted.bridge,
    acceptedRef,
    capability,
    iosMainDocumentWithoutFrameIdentity,
  );
  await postPrepared(
    accepted.bridge,
    acceptedRef,
    capability,
    HANDOFF_ONE,
    preparedSource(),
    iosMainDocumentWithoutFrameIdentity,
  );
  await accepted.bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), acceptedRef, iosMainDocumentWithoutFrameIdentity);
  assert.equal(accepted.calls.prepare.length, 1);

  for (const rejectedContext of [
    { ...iosMainDocumentWithoutFrameIdentity, isTopFrame: false },
    {
      ...iosMainDocumentWithoutFrameIdentity,
      sourceUrl: 'https://movix.example/embed/1',
    },
  ]) {
    const rejected = loadBridge({}, { platform: 'ios' });
    const rejectedRef = { current: { injectJavaScript() {} } };
    await registerPip(rejected.bridge, rejectedRef, capability, rejectedContext);
    await postPrepared(
      rejected.bridge,
      rejectedRef,
      capability,
      HANDOFF_ONE,
      preparedSource(),
      rejectedContext,
    );
    await rejected.bridge.handleBridgeMessage(JSON.stringify({
      type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
    }), rejectedRef, rejectedContext);
    assert.equal(rejected.calls.prepare.length, 0);
  }

  const android = loadBridge({}, { platform: 'android' });
  const androidRef = { current: { injectJavaScript() {} } };
  await registerPip(
    android.bridge,
    androidRef,
    capability,
    iosMainDocumentWithoutFrameIdentity,
  );
  await android.bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'legacy-enter', capability,
  }), androidRef, iosMainDocumentWithoutFrameIdentity);
  assert.equal(android.calls.enter, 0);
});

test('trusted current PiP capability can enter and gets its matching response', async () => {
  const { bridge, calls } = loadBridge();
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  await registerPip(bridge, ref, 'a'.repeat(32));
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'pip-1', capability: 'a'.repeat(32),
  }), ref, trustedContext);
  assert.equal(calls.enter, 1);
  assert.equal(injected.length, 1);
  assert.match(injected[0], /__MOVIX_PIP_SHIM__/);
  assert.match(injected[0], /pip-1/);
});

test('untrusted and wrong-capability commands are ignored', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  await registerPip(bridge, ref, 'b'.repeat(32), untrustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'pip-2', capability: 'b'.repeat(32),
  }), ref, trustedContext);
  assert.equal(calls.enter, 0);
});

test('same-origin subframes and missing frame identity cannot register PiP or set playback state', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  const capability = 'd'.repeat(32);
  await registerPip(bridge, ref, capability, sameOriginSubframeContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'subframe-enter', capability,
  }), ref, trustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PLAYBACK_AWAKE_SET',
    capability: 'MOVIX_PLAYBACK_AWAKE_V1',
    active: true,
  }), ref, sameOriginSubframeContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PLAYBACK_AWAKE_SET',
    capability: 'MOVIX_PLAYBACK_AWAKE_V1',
    active: true,
  }), ref, {
    sourceUrl: 'https://movix.example/watch/1',
    trustedOrigins: ['https://movix.example'],
  });
  assert.equal(calls.enter, 0);
  assert.deepEqual(calls.awake, []);
  assert.deepEqual(calls.pipPlayback, []);
});

test('a registered PiP capability rejects a different capability', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  await registerPip(bridge, ref, 'e'.repeat(32));
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'wrong-capability', capability: 'f'.repeat(32),
  }), ref, trustedContext);
  assert.equal(calls.enter, 0);
});

test('rejected native enter and exit return only the generic PiP rejection code', async () => {
  const secret = 'native failure https://token.example/?token=secret';
  const { bridge } = loadBridge({
    enterPictureInPicture: async () => { throw new Error(secret); },
    exitPictureInPicture: async () => { throw new Error(secret); },
  });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  const capability = '1'.repeat(32);
  await registerPip(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'enter-rejected', capability,
  }), ref, trustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_EXIT', id: 'exit-rejected', capability,
  }), ref, trustedContext);
  assert.equal(injected.length, 2);
  for (const script of injected) {
    assert.match(script, /PIP_REQUEST_REJECTED/);
    assert.doesNotMatch(script, /native failure|token\.example|secret/);
  }
});

test('malformed PiP capabilities and request IDs are ignored', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  await registerPip(bridge, ref, 'A'.repeat(32));
  await registerPip(bridge, ref, 'short');
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: '', capability: 'a'.repeat(32),
  }), ref, trustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'x'.repeat(129), capability: 'a'.repeat(32),
  }), ref, trustedContext);
  assert.equal(calls.enter, 0);
});

test('playback transition updates awake and PiP eligibility together', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PLAYBACK_AWAKE_SET',
    capability: 'MOVIX_PLAYBACK_AWAKE_V1',
    active: true,
  }), ref, trustedContext);
  assert.deepEqual(calls.awake, [true]);
  assert.deepEqual(calls.pipPlayback, [true]);
});

test('inactive playback transition clears awake and PiP eligibility together', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PLAYBACK_AWAKE_SET',
    capability: 'MOVIX_PLAYBACK_AWAKE_V1',
    active: false,
  }), ref, trustedContext);
  assert.deepEqual(calls.awake, [false]);
  assert.deepEqual(calls.pipPlayback, [false]);
});

test('current PiP capability receives native events and the React listener', async () => {
  const { bridge, emitPip } = loadBridge();
  const injected = [];
  const received = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  await registerPip(bridge, ref, '2'.repeat(32));
  const stop = bridge.startPictureInPictureEventForwarding(ref, event => received.push(event));
  emitPip({ kind: 'state', active: true });
  stop();
  assert.equal(injected.length, 1);
  assert.match(injected[0], /NATIVE_EVENT/);
  assert.match(injected[0], /"active":true/);
  assert.deepEqual(received, [{ kind: 'state', active: true }]);
});

test('native events cannot cross navigation into a new capability', async () => {
  const { bridge, emitPip } = loadBridge();
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  await registerPip(bridge, ref, 'c'.repeat(32));
  assert.equal(typeof bridge.startPictureInPictureEventForwarding, 'function');
  const stop = bridge.startPictureInPictureEventForwarding(ref, () => {});
  bridge.clearBridgeCapabilities(ref);
  emitPip({ kind: 'state', active: true });
  stop();
  assert.deepEqual(injected, []);
});

test('an async PiP command response cannot cross navigation into a new capability', async () => {
  const enter = deferred();
  const { bridge } = loadBridge({ enterPictureInPicture: () => enter.promise });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  await registerPip(bridge, ref, '3'.repeat(32));
  const pending = bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'old-pip-request', capability: '3'.repeat(32),
  }), ref, trustedContext);
  bridge.clearBridgeCapabilities(ref);
  await registerPip(bridge, ref, '4'.repeat(32));
  enter.resolve();
  await pending;
  assert.deepEqual(injected, []);
});

test('PiP action events are parsed and forwarded to the trusted shim', async () => {
  const { bridge, emitPip } = loadBridge();
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  await registerPip(bridge, ref, 'e'.repeat(32));
  const received = [];
  const stop = bridge.startPictureInPictureEventForwarding(ref, event => received.push(event));
  emitPip({ kind: 'action', action: 'seek-forward' });
  stop();
  assert.deepEqual(received, [{ kind: 'action', action: 'seek-forward' }]);
  assert.match(injected.at(-1), /seek-forward/);
});

test('service exposes iOS v1 handoff APIs while legacy enter and exit remain argument-free', async () => {
  const calls = [];
  const service = loadPictureInPictureService({
    preparedSourceProtocolVersion: 1,
    prepare: async (...args) => calls.push(['prepare', ...args]),
    acknowledgeWebViewPaused: async (...args) => calls.push(['ackPaused', ...args]),
    acknowledgeRestoreApplied: async (...args) => calls.push(['ackRestore', ...args]),
    cancel: async (...args) => calls.push(['cancel', ...args]),
    enter: async (...args) => calls.push(['enter', ...args]),
    exit: async (...args) => calls.push(['exit', ...args]),
  });

  assert.equal(service.getPreparedNativePlaybackSourceProtocolVersion(), 1);
  await service.preparePictureInPictureSource(preparedSource(), HANDOFF_ONE);
  await service.acknowledgePictureInPictureWebViewPaused(HANDOFF_ONE);
  await service.acknowledgePictureInPictureRestoreApplied(HANDOFF_ONE, true);
  await service.cancelPictureInPictureHandoff(HANDOFF_ONE);
  await service.enterPictureInPicture();
  await service.exitPictureInPicture();

  assert.equal(calls[0][0], 'prepare');
  assert.equal(calls[0][2], HANDOFF_ONE);
  assert.deepEqual(calls.slice(1).map(call => call[0]), [
    'ackPaused', 'ackRestore', 'cancel', 'enter', 'exit',
  ]);
  assert.deepEqual(calls.at(-2), ['enter']);
  assert.deepEqual(calls.at(-1), ['exit']);
});

test('service parses only bounded handoff-bound native events', () => {
  const { parsePictureInPictureEvent } = loadPictureInPictureService({});
  const events = [
    { kind: 'ready', handoffId: HANDOFF_ONE },
    { kind: 'restore', handoffId: HANDOFF_ONE, positionSec: 61.25, paused: true },
    { kind: 'state', handoffId: HANDOFF_ONE, active: true },
    { kind: 'error', handoffId: HANDOFF_ONE, code: 'PIP_PREPARE_FAILED' },
  ];
  for (const event of events) {
    assert.equal(
      JSON.stringify(parsePictureInPictureEvent({ ...event, secret: PIP_SOURCE_URL })),
      JSON.stringify(event),
    );
  }
  assert.equal(parsePictureInPictureEvent({ kind: 'ready', handoffId: 'short' }), null);
  assert.equal(parsePictureInPictureEvent({
    kind: 'restore',
    handoffId: HANDOFF_ONE,
    positionSec: Number.POSITIVE_INFINITY,
    paused: false,
  }), null);
  assert.equal(parsePictureInPictureEvent({
    kind: 'error',
    handoffId: HANDOFF_ONE,
    code: PIP_SOURCE_URL,
  }), null);
});

test('iOS v1 stores a prepared source synchronously and consumes it only on matching enter', async () => {
  const prepare = deferred();
  const { bridge, calls } = loadBridge({
    preparePictureInPictureSource: () => prepare.promise,
  }, { platform: 'ios' });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  const capability = '6'.repeat(32);
  await registerPip(bridge, ref, capability);
  await postPrepared(
    bridge,
    ref,
    capability,
    HANDOFF_ONE,
    preparedSource({ unknownSecret: PIP_SOURCE_URL }),
  );

  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.enter, 0);
  const entering = bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER',
    id: HANDOFF_ONE,
    capability,
  }), ref, trustedContext);
  await Promise.resolve();

  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.prepare[0][1], HANDOFF_ONE);
  assert.equal(Object.hasOwn(calls.prepare[0][0], 'unknownSecret'), false);
  assert.equal(calls.enter, 0, 'iOS enter waits for the future WebView-paused ACK');
  assert.deepEqual(injected, []);

  prepare.resolve();
  await entering;
  assert.equal(injected.length, 1);
  assert.match(injected[0], /"kind":"RESPONSE"/);
  assert.match(injected[0], new RegExp(HANDOFF_ONE));
  assert.match(injected[0], new RegExp(capability));
  assert.doesNotMatch(injected[0], /unknownSecret|127\.0\.0\.1|\/p\//);
});

test('iOS v1 enter without a validated prepared source fails closed', async () => {
  const { bridge, calls } = loadBridge({}, { platform: 'ios' });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  const capability = '7'.repeat(32);
  await registerPip(bridge, ref, capability);

  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER',
    id: HANDOFF_ONE,
    capability,
  }), ref, trustedContext);

  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.enter, 0);
  assert.equal(injected.length, 1);
  assert.match(injected[0], /PIP_REQUEST_REJECTED/);
});

test('invalid iOS sources and unsafe handoff identifiers never become pending', async () => {
  const { bridge, calls } = loadBridge({}, { platform: 'ios' });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  const capability = '8'.repeat(32);
  await registerPip(bridge, ref, capability);

  await postPrepared(
    bridge,
    ref,
    capability,
    HANDOFF_ONE,
    preparedSource({ url: 'https://cdn.example/video.m3u8' }),
  );
  await postPrepared(
    bridge,
    ref,
    capability,
    'unsafe.id.00001',
    preparedSource(),
  );
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER',
    id: HANDOFF_ONE,
    capability,
  }), ref, trustedContext);

  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.enter, 0);
  assert.equal(injected.length, 1);
  assert.doesNotMatch(injected[0], /cdn\.example|video\.m3u8/);
});

test('iOS v1 rejects capabilities without a navigation generation and stale generations', async () => {
  const { bridge, calls } = loadBridge({}, { platform: 'ios' });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  const capability = '0'.repeat(32);
  const missingGeneration = {
    sourceUrl: trustedContext.sourceUrl,
    trustedOrigins: trustedContext.trustedOrigins,
    isTopFrame: true,
  };
  await registerPip(bridge, ref, capability, missingGeneration);
  await postPrepared(
    bridge,
    ref,
    capability,
    HANDOFF_ONE,
    preparedSource(),
    missingGeneration,
  );
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, missingGeneration);

  await registerPip(bridge, ref, capability, trustedContext);
  await postPrepared(bridge, ref, capability, HANDOFF_TWO, preparedSource(), {
    ...trustedContext,
    navigationGeneration: 1,
  });
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_TWO, capability,
  }), ref, trustedContext);

  assert.equal(calls.prepare.length, 0);
  assert.equal(injected.length, 1);
  assert.match(injected[0], /PIP_REQUEST_REJECTED/);
  assert.doesNotMatch(injected[0], /127\.0\.0\.1|\/p\//);
});

test('duplicate and stale prepared messages cannot select an ambiguous source', async () => {
  const { bridge, calls } = loadBridge({}, { platform: 'ios' });
  const ref = { current: { injectJavaScript() {} } };
  const capability = '9'.repeat(32);
  await registerPip(bridge, ref, capability);

  await postPrepared(bridge, ref, capability, HANDOFF_ONE);
  await postPrepared(bridge, ref, capability, HANDOFF_ONE);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER',
    id: HANDOFF_ONE,
    capability,
  }), ref, trustedContext);
  assert.equal(calls.prepare.length, 0, 'duplicate prepared id invalidates the pending source');

  await postPrepared(bridge, ref, capability, HANDOFF_ONE);
  await postPrepared(bridge, ref, capability, HANDOFF_TWO, preparedSource({ positionSec: 9 }));
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER',
    id: HANDOFF_ONE,
    capability,
  }), ref, trustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER',
    id: HANDOFF_TWO,
    capability,
  }), ref, trustedContext);
  assert.equal(calls.prepare.length, 0, 'stale enter invalidates the replacement pending source');
});

test('parallel duplicate enter cancels the native preparation and suppresses stale success', async () => {
  const prepare = deferred();
  const { bridge, calls } = loadBridge({
    preparePictureInPictureSource: () => prepare.promise,
  }, { platform: 'ios' });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  const capability = 'a'.repeat(32);
  await registerPip(bridge, ref, capability);
  await postPrepared(bridge, ref, capability);

  const first = bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  await Promise.resolve();
  const duplicate = bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  await duplicate;

  assert.equal(calls.prepare.length, 1);
  assert.deepEqual(calls.cancel, [[HANDOFF_ONE]]);
  prepare.resolve();
  await first;
  assert.equal(injected.filter(script => /"ok":true/.test(script)).length, 0);
  assert.equal(injected.filter(script => /PIP_REQUEST_REJECTED/.test(script)).length, 1);
});

test('navigation clears pending and active handoffs and cancels only native work that started', async () => {
  const prepare = deferred();
  const { bridge, calls } = loadBridge({
    preparePictureInPictureSource: () => prepare.promise,
  }, { platform: 'ios' });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  const oldCapability = 'b'.repeat(32);
  const newCapability = 'c'.repeat(32);
  await registerPip(bridge, ref, oldCapability);
  await postPrepared(bridge, ref, oldCapability);
  bridge.clearBridgeCapabilities(ref);
  assert.deepEqual(calls.cancel, [], 'pending-only sources have no native resource to cancel');

  await registerPip(bridge, ref, newCapability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability: newCapability,
  }), ref, trustedContext);
  assert.equal(calls.prepare.length, 0);

  await postPrepared(bridge, ref, newCapability, HANDOFF_TWO);
  const entering = bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_TWO, capability: newCapability,
  }), ref, trustedContext);
  await Promise.resolve();
  bridge.clearBridgeCapabilities(ref);
  assert.deepEqual(calls.cancel, [[HANDOFF_TWO]]);

  prepare.resolve();
  await entering;
  assert.equal(injected.filter(script => /"ok":true/.test(script)).length, 0);
});

test('iOS native events are capability and handoff bound across navigation', async () => {
  const { bridge, emitPip } = loadBridge({}, { platform: 'ios' });
  const injected = [];
  const received = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  const capability = 'd'.repeat(32);
  await registerPip(bridge, ref, capability);
  const stop = bridge.startPictureInPictureEventForwarding(
    ref,
    event => received.push(event),
  );
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  injected.length = 0;

  emitPip({ kind: 'ready', handoffId: HANDOFF_TWO });
  emitPip({ kind: 'state', active: true });
  assert.deepEqual(injected, []);
  emitPip({ kind: 'ready', handoffId: HANDOFF_ONE });
  assert.equal(injected.length, 1);
  assert.match(injected[0], new RegExp(HANDOFF_ONE));
  assert.match(injected[0], new RegExp(capability));

  injected.length = 0;
  bridge.clearBridgeCapabilities(ref);
  await registerPip(bridge, ref, 'e'.repeat(32));
  emitPip({ kind: 'ready', handoffId: HANDOFF_ONE });
  stop();
  assert.deepEqual(injected, []);
  assert.deepEqual(received, [{ kind: 'ready', handoffId: HANDOFF_ONE }]);
});

test('iOS exit cancels the matching prepared handoff while Android exit stays unchanged', async () => {
  const ios = loadBridge({}, { platform: 'ios' });
  const iosRef = { current: { injectJavaScript() {} } };
  const capability = 'f'.repeat(32);
  await registerPip(ios.bridge, iosRef, capability);
  await postPrepared(ios.bridge, iosRef, capability);
  await ios.bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), iosRef, trustedContext);
  await ios.bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_EXIT', id: HANDOFF_ONE, capability,
  }), iosRef, trustedContext);
  assert.deepEqual(ios.calls.cancel, [[HANDOFF_ONE]]);
  assert.equal(ios.calls.exit, 0);

  const android = loadBridge();
  const androidRef = { current: { injectJavaScript() {} } };
  await registerPip(android.bridge, androidRef, capability);
  await android.bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_EXIT', id: 'legacy-exit', capability,
  }), androidRef, trustedContext);
  assert.equal(android.calls.exit, 1);
  assert.deepEqual(android.calls.cancel, []);
});

test('native prepare failures cancel by id and expose no source or native error details', async () => {
  const secret = `prepare failed for ${PIP_SOURCE_URL}`;
  const { bridge, calls } = loadBridge({
    preparePictureInPictureSource: async () => { throw new Error(secret); },
  }, { platform: 'ios' });
  const injected = [];
  const ref = { current: { injectJavaScript: script => injected.push(script) } };
  const capability = '1'.repeat(32);
  await registerPip(bridge, ref, capability);
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);

  assert.deepEqual(calls.cancel, [[HANDOFF_ONE]]);
  assert.equal(injected.length, 1);
  assert.match(injected[0], /PIP_REQUEST_REJECTED/);
  assert.doesNotMatch(injected[0], /127\.0\.0\.1|\/p\/|prepare failed/);
});

test('an active iOS handoff releases awake state but shields only native PiP eligibility from DOM pause', async () => {
  const prepare = deferred();
  const { bridge, calls } = loadBridge({
    preparePictureInPictureSource: () => prepare.promise,
  }, { platform: 'ios' });
  const ref = { current: { injectJavaScript() {} } };
  const capability = '2'.repeat(32);
  await registerPip(bridge, ref, capability);
  await postPrepared(bridge, ref, capability);
  const entering = bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  await Promise.resolve();

  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PLAYBACK_AWAKE_SET',
    capability: 'MOVIX_PLAYBACK_AWAKE_V1',
    active: false,
  }), ref, trustedContext);
  assert.deepEqual(calls.awake, [false]);
  assert.deepEqual(calls.pipPlayback, []);

  bridge.clearBridgeCapabilities(ref);
  prepare.resolve();
  await entering;
});

test('Android ignores prepared-source messages and preserves legacy enter and playback transitions', async () => {
  const { bridge, calls } = loadBridge();
  const ref = { current: { injectJavaScript() {} } };
  const capability = '3'.repeat(32);
  await registerPip(bridge, ref, capability);
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: 'legacy-enter', capability,
  }), ref, trustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PLAYBACK_AWAKE_SET',
    capability: 'MOVIX_PLAYBACK_AWAKE_V1',
    active: false,
  }), ref, trustedContext);

  assert.equal(calls.enter, 1);
  assert.equal(calls.prepare.length, 0);
  assert.deepEqual(calls.cancel, []);
  assert.deepEqual(calls.awake, [false]);
  assert.deepEqual(calls.pipPlayback, [false]);
});

test('matching iOS WebView-paused acknowledgement enters the same handoff exactly once in order', async () => {
  const { bridge, calls, emitPip } = loadBridge({}, { platform: 'ios' });
  const ref = { current: { injectJavaScript() {} } };
  const capability = '4'.repeat(32);
  await registerPip(bridge, ref, capability);
  const stop = bridge.startPictureInPictureEventForwarding(ref, () => {});
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  emitPip({ kind: 'ready', handoffId: HANDOFF_ONE });

  const paused = JSON.stringify({
    type: 'PIPSHIM_WEBVIEW_PAUSED', id: HANDOFF_ONE, capability,
  });
  await bridge.handleBridgeMessage(paused, ref, trustedContext);
  await bridge.handleBridgeMessage(paused, ref, trustedContext);
  stop();

  assert.deepEqual(calls.acknowledgePaused, [[HANDOFF_ONE]]);
  assert.deepEqual(calls.enterPrepared, [[HANDOFF_ONE]]);
  assert.deepEqual(calls.sequence.slice(-2), [
    `ackPaused:${HANDOFF_ONE}`,
    `enter:${HANDOFF_ONE}`,
  ]);
  assert.equal(calls.enter, 0, 'legacy Android enter stays untouched');
});

test('stale capability, handoff, and navigation cannot pause-ack or enter native iOS PiP', async () => {
  const pauseAck = deferred();
  const { bridge, calls, emitPip } = loadBridge({
    acknowledgePictureInPictureWebViewPaused: () => pauseAck.promise,
  }, { platform: 'ios' });
  const ref = { current: { injectJavaScript() {} } };
  const capability = '5'.repeat(32);
  await registerPip(bridge, ref, capability);
  const stop = bridge.startPictureInPictureEventForwarding(ref, () => {});
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  emitPip({ kind: 'ready', handoffId: HANDOFF_ONE });

  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_WEBVIEW_PAUSED', id: HANDOFF_TWO, capability,
  }), ref, trustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_WEBVIEW_PAUSED', id: HANDOFF_ONE, capability: '6'.repeat(32),
  }), ref, trustedContext);
  const acknowledging = bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_WEBVIEW_PAUSED', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  await Promise.resolve();
  bridge.clearBridgeCapabilities(ref);
  pauseAck.resolve();
  await acknowledging;
  stop();

  assert.deepEqual(calls.acknowledgePaused, [[HANDOFF_ONE]]);
  assert.deepEqual(calls.enterPrepared, []);
});

test('matching iOS restore acknowledgement is capability-bound and applied once', async () => {
  const { bridge, calls, emitPip } = loadBridge({}, { platform: 'ios' });
  const ref = { current: { injectJavaScript() {} } };
  const capability = '7'.repeat(32);
  await registerPip(bridge, ref, capability);
  const stop = bridge.startPictureInPictureEventForwarding(ref, () => {});
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  emitPip({
    kind: 'restore',
    handoffId: HANDOFF_ONE,
    positionSec: 4,
    paused: true,
  });

  const applied = JSON.stringify({
    type: 'PIPSHIM_RESTORE_APPLIED',
    id: HANDOFF_ONE,
    capability,
    ok: true,
  });
  await bridge.handleBridgeMessage(applied, ref, trustedContext);
  await bridge.handleBridgeMessage(applied, ref, trustedContext);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_RESTORE_APPLIED',
    id: HANDOFF_ONE,
    capability: '8'.repeat(32),
    ok: false,
  }), ref, trustedContext);
  stop();

  assert.deepEqual(calls.acknowledgeRestore, [[HANDOFF_ONE, true]]);
});

test('iOS keeps the exact handoff restorable when inactive state arrives before restore', async () => {
  const forwarded = [];
  const { bridge, calls, emitPip } = loadBridge({}, { platform: 'ios' });
  const ref = { current: { injectJavaScript() {} } };
  const capability = '8'.repeat(32);
  await registerPip(bridge, ref, capability);
  const stop = bridge.startPictureInPictureEventForwarding(
    ref,
    event => forwarded.push(event),
  );
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  emitPip({ kind: 'ready', handoffId: HANDOFF_ONE });
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_WEBVIEW_PAUSED', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  emitPip({ kind: 'state', handoffId: HANDOFF_ONE, active: true });
  emitPip({ kind: 'state', handoffId: HANDOFF_ONE, active: false });
  assert.deepEqual(calls.cancel, []);

  emitPip({
    kind: 'restore',
    handoffId: HANDOFF_ONE,
    positionSec: 18,
    paused: false,
  });
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_RESTORE_APPLIED',
    id: HANDOFF_ONE,
    capability,
    ok: true,
  }), ref, trustedContext);
  stop();

  assert.deepEqual(calls.acknowledgeRestore, [[HANDOFF_ONE, true]]);
  assert.deepEqual(calls.cancel, []);
  assert.deepEqual(forwarded.map(event => event.kind), [
    'ready',
    'state',
    'state',
    'restore',
  ]);
});

test('iOS active exit requests native stop but preserves the handoff through restore', async () => {
  const { bridge, calls, emitPip } = loadBridge({}, { platform: 'ios' });
  const ref = { current: { injectJavaScript() {} } };
  const capability = 'e'.repeat(32);
  await registerPip(bridge, ref, capability);
  const stop = bridge.startPictureInPictureEventForwarding(ref, () => {});
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  emitPip({ kind: 'ready', handoffId: HANDOFF_ONE });
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_WEBVIEW_PAUSED', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  emitPip({ kind: 'state', handoffId: HANDOFF_ONE, active: true });

  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_EXIT', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  assert.equal(calls.exit, 1);
  assert.deepEqual(calls.cancel, []);

  emitPip({ kind: 'state', handoffId: HANDOFF_ONE, active: false });
  emitPip({
    kind: 'restore',
    handoffId: HANDOFF_ONE,
    positionSec: 21,
    paused: true,
  });
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_RESTORE_APPLIED',
    id: HANDOFF_ONE,
    capability,
    ok: true,
  }), ref, trustedContext);
  stop();

  assert.deepEqual(calls.acknowledgeRestore, [[HANDOFF_ONE, true]]);
  assert.deepEqual(calls.cancel, []);
});

test('iOS bounds active exit when native never sends restore or inactive state', async () => {
  const timers = createFakeTimers();
  const { bridge, calls, emitPip } = loadBridge({}, {
    platform: 'ios',
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const ref = { current: { injectJavaScript() {} } };
  const capability = 'a'.repeat(32);
  await registerPip(bridge, ref, capability);
  const stop = bridge.startPictureInPictureEventForwarding(ref, () => {});
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  emitPip({ kind: 'ready', handoffId: HANDOFF_ONE });
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_WEBVIEW_PAUSED', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  emitPip({ kind: 'state', handoffId: HANDOFF_ONE, active: true });

  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_EXIT', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  assert.deepEqual(calls.cancel, []);
  timers.runNext(5_000);
  await Promise.resolve();
  stop();

  assert.deepEqual(calls.cancel, [[HANDOFF_ONE]]);
});

test('iOS bounds an acknowledged restore when native omits inactive state', async () => {
  const timers = createFakeTimers();
  const { bridge, calls, emitPip } = loadBridge({}, {
    platform: 'ios',
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const ref = { current: { injectJavaScript() {} } };
  const capability = 'b'.repeat(32);
  await registerPip(bridge, ref, capability);
  const stop = bridge.startPictureInPictureEventForwarding(ref, () => {});
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);
  emitPip({ kind: 'restore', handoffId: HANDOFF_ONE, positionSec: 9, paused: true });
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_RESTORE_APPLIED', id: HANDOFF_ONE, capability, ok: true,
  }), ref, trustedContext);
  assert.deepEqual(calls.cancel, []);
  timers.runNext(5_000);
  await Promise.resolve();
  stop();

  assert.deepEqual(calls.acknowledgeRestore, [[HANDOFF_ONE, true]]);
  assert.deepEqual(calls.cancel, [[HANDOFF_ONE]]);
});

test('iOS acknowledgements are ignored until their matching native ready and restore phases', async () => {
  const { bridge, calls, emitPip } = loadBridge({}, { platform: 'ios' });
  const ref = { current: { injectJavaScript() {} } };
  const capability = '9'.repeat(32);
  await registerPip(bridge, ref, capability);
  const stop = bridge.startPictureInPictureEventForwarding(ref, () => {});
  await postPrepared(bridge, ref, capability);
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'PIPSHIM_ENTER', id: HANDOFF_ONE, capability,
  }), ref, trustedContext);

  const paused = JSON.stringify({
    type: 'PIPSHIM_WEBVIEW_PAUSED', id: HANDOFF_ONE, capability,
  });
  const restored = JSON.stringify({
    type: 'PIPSHIM_RESTORE_APPLIED',
    id: HANDOFF_ONE,
    capability,
    ok: true,
  });
  await bridge.handleBridgeMessage(paused, ref, trustedContext);
  await bridge.handleBridgeMessage(restored, ref, trustedContext);
  assert.deepEqual(calls.acknowledgePaused, []);
  assert.deepEqual(calls.acknowledgeRestore, []);

  emitPip({ kind: 'ready', handoffId: HANDOFF_ONE });
  await bridge.handleBridgeMessage(paused, ref, trustedContext);
  assert.deepEqual(calls.acknowledgePaused, [[HANDOFF_ONE]]);
  assert.deepEqual(calls.enterPrepared, [[HANDOFF_ONE]]);
  await bridge.handleBridgeMessage(restored, ref, trustedContext);
  assert.deepEqual(calls.acknowledgeRestore, []);

  emitPip({
    kind: 'restore',
    handoffId: HANDOFF_ONE,
    positionSec: 8,
    paused: false,
  });
  await bridge.handleBridgeMessage(restored, ref, trustedContext);
  stop();
  assert.deepEqual(calls.acknowledgeRestore, [[HANDOFF_ONE, true]]);
});
