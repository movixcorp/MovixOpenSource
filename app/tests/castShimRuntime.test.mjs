import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function loadCastShimBuilder() {
  const sourceUrl = new URL('../src/injection/cast-shim.ts', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceUrl.pathname,
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`;
  return import(dataUrl);
}

function createShimHarness(buildCastShim, resolver, responder = () => ({})) {
  const posted = [];
  const registrations = [];
  const listeners = new Map();
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const window = {
    __MOVIX_ANDROID_CAST_INSTALLED__: false,
    __MOVIX_PREPARE_CAST_SOURCE__: resolver,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
    ReactNativeWebView: {
      postMessage(raw) {
        const message = JSON.parse(raw);
        if (message.type === 'CASTSHIM_REGISTER_CAPABILITY') {
          registrations.push(message);
          return;
        }
        posted.push(message);
        queueMicrotask(() => {
          const response = responder(message);
          if (response === undefined) return;
          window.dispatchEvent(new CustomEvent('__MOVIX_CAST_SHIM__', {
            detail: {
              kind: 'RESPONSE',
              id: message.id,
              ok: response.ok !== false,
              payload: response.payload ?? response,
              error: response.error,
            },
          }));
        });
      },
    },
    crypto: {
      getRandomValues(bytes) {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index + 1;
        }
        return bytes;
      },
    },
  };
  vm.runInNewContext(buildCastShim(), {
    Array,
    CustomEvent,
    Date,
    Error,
    JSON,
    Object,
    Promise,
    Uint8Array,
    URL,
    window,
  });
  return { posted, registrations, window };
}

test('emits browser-parseable JavaScript without literal NUL bytes', async () => {
  const { buildCastShim } = await loadCastShimBuilder();

  assert.equal(buildCastShim().includes('\u0000'), false);
});

test('loadMedia rejects without loading and reports a bounded preparation diagnostic', async () => {
  const { buildCastShim } = await loadCastShimBuilder();
  const harness = createShimHarness(buildCastShim);

  await assert.rejects(
    harness.window.MovixAndroidCast.loadMedia('https://cdn.example/master.m3u8', 'Title'),
    /source preparation/i,
  );
  assert.deepEqual(harness.posted, [{
    type: 'CASTSHIM_DIAGNOSTIC',
    capability: harness.registrations[0].capability,
    code: 'PREPARATION_UNAVAILABLE',
    stage: 'media',
    scheme: 'https',
    host: 'cdn.example',
    port: '',
  }]);
});

test('loadMedia posts one structured prepared source payload', async () => {
  const { buildCastShim } = await loadCastShimBuilder();
  const resolver = (request) => ({
    url: request.url,
    headers: { Referer: 'https://player.example/' },
    contentType: request.contentType,
    protocolVersion: 1,
  });
  const harness = createShimHarness(buildCastShim, resolver);

  const pending = harness.window.MovixAndroidCast.loadMedia(
    'https://cdn.example/master.m3u8',
    'Title',
    'https://image.example/poster.jpg',
    12,
    'application/vnd.apple.mpegurl',
  );

  assert.equal(harness.posted.length, 1);
  const { id, capability, ...message } = harness.posted[0];
  assert.equal(typeof id, 'string');
  assert.equal(capability, harness.registrations[0].capability);
  assert.deepEqual(message, {
    type: 'CASTSHIM_LOAD_MEDIA',
    source: {
      url: 'https://cdn.example/master.m3u8',
      headers: { Referer: 'https://player.example/' },
      contentType: 'application/vnd.apple.mpegurl',
      protocolVersion: 1,
    },
    metadata: {
      title: 'Title',
      poster: 'https://image.example/poster.jpg',
      currentTime: 12,
    },
  });
  await pending;
});

test('captures the original native sender and attaches a closure-only capability', async () => {
  const { buildCastShim } = await loadCastShimBuilder();
  const harness = createShimHarness(buildCastShim, () => null);
  const intercepted = [];

  harness.window.ReactNativeWebView.postMessage = raw => intercepted.push(raw);
  await harness.window.MovixAndroidCast.play();

  assert.equal(intercepted.length, 0);
  assert.equal(harness.registrations.length, 2);
  assert.match(harness.registrations[0].capability, /^[a-f0-9]{32}$/);
  assert.equal(
    harness.registrations[1].capability,
    harness.registrations[0].capability,
  );
  assert.equal(
    harness.posted[0].capability,
    harness.registrations[0].capability,
  );
});

test('re-announces the Cast capability immediately before every native command', async () => {
  const { buildCastShim } = await loadCastShimBuilder();
  const harness = createShimHarness(buildCastShim, () => null);

  assert.equal(harness.registrations.length, 1);
  await harness.window.MovixAndroidCast.play();

  assert.equal(harness.registrations.length, 2);
  assert.equal(
    harness.registrations[1].capability,
    harness.registrations[0].capability,
  );
  assert.equal(harness.posted[0].type, 'CASTSHIM_PLAY');
});

test('isSupported requires receiver, preparation, and LAN proxy protocol version 1', async () => {
  const { buildCastShim } = await loadCastShimBuilder();
  const resolver = request => ({
    url: request.url,
    headers: {},
    protocolVersion: 1,
  });
  const supportedPayload = {
    supported: true,
    capabilities: {
      configured: true,
      receiverProtocolVersion: 1,
      castLanProxyVersion: 1,
    },
  };

  const supported = createShimHarness(
    buildCastShim,
    resolver,
    message => message.type === 'CASTSHIM_INIT' ? supportedPayload : {},
  );
  assert.equal(await supported.window.MovixAndroidCast.isSupported(), true);

  for (const capabilities of [
    { configured: false, receiverProtocolVersion: 1, castLanProxyVersion: 1 },
    { configured: true, receiverProtocolVersion: 2, castLanProxyVersion: 1 },
    { configured: true, receiverProtocolVersion: 1, castLanProxyVersion: 0 },
  ]) {
    const harness = createShimHarness(
      buildCastShim,
      resolver,
      message => message.type === 'CASTSHIM_INIT'
        ? { supported: true, capabilities }
        : {},
    );
    assert.equal(await harness.window.MovixAndroidCast.isSupported(), false);
  }

  const wrongPreparationVersion = createShimHarness(
    buildCastShim,
    request => ({ url: request.url, headers: {}, protocolVersion: 2 }),
    message => message.type === 'CASTSHIM_INIT' ? supportedPayload : {},
  );
  assert.equal(
    await wrongPreparationVersion.window.MovixAndroidCast.isSupported(),
    false,
  );
});

test('controller methods post typed commands and reject native failures', async () => {
  const { buildCastShim } = await loadCastShimBuilder();
  const resolver = request => ({
    url: request.url,
    headers: {},
    contentType: request.contentType,
    protocolVersion: 1,
  });
  const harness = createShimHarness(buildCastShim, resolver, message => {
    if (message.type === 'CASTSHIM_INIT') {
      return {
        supported: true,
        capabilities: {
          configured: true,
          receiverProtocolVersion: 1,
          castLanProxyVersion: 1,
        },
      };
    }
    if (message.type === 'CASTSHIM_PAUSE') {
      return {
        ok: false,
        error: { code: 'CAST_COMMAND_REJECTED', message: 'pause rejected' },
      };
    }
    if (message.type === 'CASTSHIM_GET_STATUS') {
      return {
        connected: true,
        deviceName: 'Salon',
        mediaSessionId: 7,
        state: 'playing',
        positionSec: 12,
        durationSec: 100,
        canSeek: true,
      };
    }
    return {};
  });
  const cast = harness.window.MovixAndroidCast;

  await cast.play();
  await assert.rejects(cast.pause(), /pause rejected/);
  await cast.seekTo(25);
  const status = await cast.getStatus();
  await cast.stop();

  assert.equal(status.state, 'playing');
  assert.deepEqual(
    harness.posted.map(({ type, seconds, refresh }) => ({ type, seconds, refresh })),
    [
      { type: 'CASTSHIM_PLAY', seconds: undefined, refresh: undefined },
      { type: 'CASTSHIM_PAUSE', seconds: undefined, refresh: undefined },
      { type: 'CASTSHIM_SEEK_TO', seconds: 25, refresh: undefined },
      { type: 'CASTSHIM_GET_STATUS', seconds: undefined, refresh: true },
      { type: 'CASTSHIM_STOP', seconds: undefined, refresh: undefined },
    ],
  );
});

test('subscribe emits one normalized status event and unsubscribes', async () => {
  const { buildCastShim } = await loadCastShimBuilder();
  const harness = createShimHarness(buildCastShim, () => null);
  const received = [];
  const unsubscribe = harness.window.MovixAndroidCast.subscribe(
    status => received.push(status),
  );
  const status = {
    connected: true,
    deviceName: 'Salon',
    mediaSessionId: 4,
    state: 'buffering',
    positionSec: 8,
    durationSec: 60,
    canSeek: true,
  };

  harness.window.dispatchEvent(new (class {
    type = '__MOVIX_CAST_SHIM__';
    detail = { kind: 'STATUS_EVENT', status };
  })());
  unsubscribe();
  harness.window.dispatchEvent(new (class {
    type = '__MOVIX_CAST_SHIM__';
    detail = { kind: 'STATUS_EVENT', status: { ...status, positionSec: 9 } };
  })());

  assert.deepEqual(JSON.parse(JSON.stringify(received)), [status]);
});

test('loadMedia prepares every external text track before posting', async () => {
  const { buildCastShim } = await loadCastShimBuilder();
  const resolver = request => ({
    url: request.url,
    headers: request.url.includes('captions')
      ? { Referer: 'https://player.example/' }
      : {},
    contentType: request.contentType,
    protocolVersion: 1,
  });
  const harness = createShimHarness(buildCastShim, resolver, message => {
    if (message.type === 'CASTSHIM_INIT') {
      return {
        supported: true,
        capabilities: {
          configured: true,
          receiverProtocolVersion: 1,
          castLanProxyVersion: 1,
        },
      };
    }
    return {};
  });

  await harness.window.MovixAndroidCast.loadMedia(
    'https://cdn.example/master.m3u8',
    'Title',
    '',
    12,
    'application/vnd.apple.mpegurl',
    [{
      url: 'https://captions.example/fr.vtt',
      contentType: 'text/vtt',
      language: 'fr',
      name: 'Français',
      active: true,
    }],
  );

  const load = harness.posted.find(message => message.type === 'CASTSHIM_LOAD_MEDIA');
  assert.equal(load.source.tracks.length, 1);
  assert.deepEqual(load.source.tracks[0], {
    url: 'https://captions.example/fr.vtt',
    headers: { Referer: 'https://player.example/' },
    contentType: 'text/vtt',
    protocolVersion: 1,
    language: 'fr',
    name: 'Français',
    active: true,
  });
});

test('loadMedia sends generated WebVTT inline without resolving it through a backend URL', async () => {
  const { buildCastShim } = await loadCastShimBuilder();
  const harness = createShimHarness(buildCastShim, request => ({
    url: request.url,
    headers: {},
    contentType: request.contentType,
    protocolVersion: 1,
  }), message => message.type === 'CASTSHIM_INIT'
    ? {
        supported: true,
        capabilities: {
          configured: true,
          receiverProtocolVersion: 1,
          castLanProxyVersion: 1,
        },
      }
    : {});
  const inlineVtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n';

  await harness.window.MovixAndroidCast.loadMedia(
    'https://cdn.example/master.m3u8',
    'Title',
    '',
    0,
    'application/vnd.apple.mpegurl',
    [{ inlineVtt, contentType: 'text/vtt', language: 'fr', active: true }],
  );

  const load = harness.posted.find(message => message.type === 'CASTSHIM_LOAD_MEDIA');
  assert.deepEqual(load.source.tracks, [{
    inlineVtt,
    contentType: 'text/vtt',
    protocolVersion: 1,
    language: 'fr',
    active: true,
  }]);
});
