import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'b'.repeat(43);
const TOKEN_C = '_'.repeat(43);
const LOOPBACK_URL = `http://127.0.0.1:49152/p/${TOKEN_A}/${TOKEN_B}/${TOKEN_C}`;

async function loadPictureInPictureShimBuilder() {
  const sourceUrl = new URL('../src/injection/picture-in-picture-shim.ts', import.meta.url);
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

class EventTarget {
  #listeners = new Map();

  addEventListener(type, listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.#listeners.get(event.type) || []) {
      listener.call(this, event);
    }
    return true;
  }
}

class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

class FakeElement extends EventTarget {
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.classList = {
      add: value => this.attributes.set(`class:${value}`, ''),
      remove: value => this.attributes.delete(`class:${value}`),
      contains: value => this.attributes.has(`class:${value}`),
    };
  }

  appendChild(child) {
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter(candidate => candidate !== child);
    child.parentElement = null;
    child.parentNode = null;
  }

  setAttribute(name, value = '') {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

async function createHarness(mode, environment = {}) {
  const { buildPictureInPictureShim } = await loadPictureInPictureShimBuilder();
  const document = new EventTarget();
  document.title = 'A'.repeat(300);

  let fallbackReceiver = null;
  class HarnessVideoElement extends FakeElement {
    constructor(ownerDocument = document) {
      super('video', ownerDocument);
      this.isConnected = true;
      this.currentSrc = '';
      this.currentTime = 30;
      this.duration = 100;
      this.paused = false;
      this.ended = false;
      this.playbackRate = 1.25;
      this.muted = true;
      this.poster = 'https://images.example/poster.jpg';
      this.pauseCalls = 0;
      this.playCalls = 0;
    }

    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    }

    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    }
  }

  if (environment.standardFallback) {
    HarnessVideoElement.prototype.requestPictureInPicture = function requestPictureInPicture() {
      fallbackReceiver = this;
      return Promise.resolve(this);
    };
  }
  if (environment.webkitFallback) {
    HarnessVideoElement.prototype.webkitSupportsPresentationMode = function supports(modeName) {
      fallbackReceiver = this;
      return modeName === 'picture-in-picture';
    };
    HarnessVideoElement.prototype.webkitSetPresentationMode = function setMode(modeName) {
      fallbackReceiver = this;
      this.presentationMode = modeName;
    };
  }

  const html = new FakeElement('html', document);
  const head = new FakeElement('head', document);
  const body = new FakeElement('body', document);
  const firstContainer = new FakeElement('div', document);
  const secondContainer = new FakeElement('div', document);
  const video = new HarnessVideoElement();
  const otherVideo = new HarnessVideoElement();
  html.appendChild(head);
  html.appendChild(body);
  body.appendChild(firstContainer);
  body.appendChild(secondContainer);
  firstContainer.appendChild(video);
  secondContainer.appendChild(otherVideo);
  document.documentElement = html;
  document.head = head;
  document.body = body;
  document.createElement = tagName => new FakeElement(tagName, document);
  document.querySelectorAll = selector => selector === 'video' ? [video, otherVideo] : [];

  const posted = [];
  const window = new EventTarget();
  window.ReactNativeWebView = {
    postMessage(raw) {
      posted.push(JSON.parse(raw));
    },
  };
  let randomCall = 0;
  window.crypto = {
    getRandomValues(bytes) {
      randomCall += 1;
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (index + randomCall * 17) & 0xff;
      }
      return bytes;
    },
  };

  const context = {
    Array,
    CustomEvent,
    Date,
    DOMException,
    HTMLVideoElement: HarnessVideoElement,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Reflect,
    String,
    Uint8Array,
    URL,
    WeakMap,
    clearTimeout: environment.clearTimeout ?? clearTimeout,
    document,
    setTimeout: environment.setTimeout ?? setTimeout,
    window,
  };
  vm.runInNewContext(buildPictureInPictureShim(mode), context);

  let firstEnterEvents = 0;
  let firstLeaveEvents = 0;
  let secondEnterEvents = 0;
  let secondLeaveEvents = 0;
  video.addEventListener('enterpictureinpicture', () => { firstEnterEvents += 1; });
  video.addEventListener('leavepictureinpicture', () => { firstLeaveEvents += 1; });
  otherVideo.addEventListener('enterpictureinpicture', () => { secondEnterEvents += 1; });
  otherVideo.addEventListener('leavepictureinpicture', () => { secondLeaveEvents += 1; });

  return {
    dispatch(detail) {
      window.dispatchEvent(new CustomEvent('__MOVIX_PIP_SHIM__', { detail }));
    },
    document,
    foreignVideo: new HarnessVideoElement(new EventTarget()),
    get fallbackReceiver() { return fallbackReceiver; },
    get firstEnterEvents() { return firstEnterEvents; },
    get firstLeaveEvents() { return firstLeaveEvents; },
    get secondEnterEvents() { return secondEnterEvents; },
    get secondLeaveEvents() { return secondLeaveEvents; },
    otherVideo,
    posted,
    video,
    window,
  };
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

function registration(harness) {
  return harness.posted.find(message => message.type === 'PIPSHIM_REGISTER_CAPABILITY');
}

function dispatchNative(harness, capability, event) {
  harness.dispatch({ kind: 'NATIVE_EVENT', capability, event });
}

test('iOS v1 installs a non-replaceable exact-video publisher with strict URL and generation checks', async () => {
  const h = await createHarness('ios-native-v1');
  const publisher = h.window.__MOVIX_NATIVE_MEDIA_SOURCE_V1__;
  assert.ok(publisher);
  assert.equal(Object.isFrozen(publisher), true);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(h.window, '__MOVIX_NATIVE_MEDIA_SOURCE_V1__'),
    {
      value: publisher,
      writable: false,
      enumerable: false,
      configurable: false,
    },
  );

  const malformed = [
    LOOPBACK_URL.replace(':49152', ':0'),
    LOOPBACK_URL.replace(':49152', ':01'),
    LOOPBACK_URL.replace(':49152', ':65536'),
    `${LOOPBACK_URL}?token=secret`,
    `${LOOPBACK_URL}#fragment`,
    LOOPBACK_URL.replace('127.0.0.1', 'user@127.0.0.1'),
    LOOPBACK_URL.replace('/p/', '/p//'),
    LOOPBACK_URL.replace(TOKEN_A, 'A'.repeat(42)),
    `${LOOPBACK_URL}\n`,
    `https://cdn.example/${TOKEN_A}.m3u8`,
    'blob:https://movix.example/id',
  ];
  for (const value of malformed) {
    assert.equal(publisher.publish(h.video, value, 'hls'), null, value);
  }
  assert.equal(publisher.publish(h.video, LOOPBACK_URL, 'dash'), null);
  h.otherVideo.isConnected = false;
  assert.equal(publisher.publish(h.otherVideo, LOOPBACK_URL, 'hls'), null);
  assert.equal(publisher.publish(h.foreignVideo, LOOPBACK_URL, 'mp4'), null);

  const firstGeneration = publisher.publish(h.video, LOOPBACK_URL, 'hls');
  const secondGeneration = publisher.publish(h.video, LOOPBACK_URL, 'mp4');
  assert.match(firstGeneration, /^[A-Za-z0-9_-]{16,128}$/);
  assert.match(secondGeneration, /^[A-Za-z0-9_-]{16,128}$/);
  assert.notEqual(firstGeneration, secondGeneration);
  assert.equal(publisher.clear(h.video, firstGeneration), false);
  assert.equal(publisher.clear(h.video, secondGeneration), true);

  const pageGeneration = publisher.publish(h.video, LOOPBACK_URL, 'hls');
  h.window.dispatchEvent(new CustomEvent('pagehide'));
  assert.equal(publisher.clear(h.video, pageGeneration), false);
  assert.equal(publisher.publish(h.video, LOOPBACK_URL, 'hls'), null);
});

test('iOS v1 posts bounded PREPARED before ENTER for the requested video and pauses only after matching ready', async () => {
  const h = await createHarness('ios-native-v1');
  const generation = h.window.__MOVIX_NATIVE_MEDIA_SOURCE_V1__.publish(
    h.otherVideo,
    LOOPBACK_URL,
    'hls',
  );
  assert.ok(generation);
  h.otherVideo.currentTime = Number.POSITIVE_INFINITY;
  h.otherVideo.playbackRate = 99;

  const requestPromise = h.otherVideo.requestPictureInPicture();
  const preparedIndex = h.posted.findIndex(message => message.type === 'PIPSHIM_PREPARED_SOURCE');
  const enterIndex = h.posted.findIndex(message => message.type === 'PIPSHIM_ENTER');
  assert.ok(preparedIndex >= 0);
  assert.ok(enterIndex > preparedIndex);
  const prepared = h.posted[preparedIndex];
  const enter = h.posted[enterIndex];
  assert.equal(prepared.id, enter.id);
  assert.equal(prepared.capability, enter.capability);
  assert.match(enter.id, /^[A-Za-z0-9_-]{16,128}$/);
  assert.deepEqual(prepared.source, {
    protocolVersion: 1,
    url: LOOPBACK_URL,
    positionSec: 0,
    paused: false,
    playbackRate: 1,
    muted: true,
    title: 'A'.repeat(256),
    poster: 'https://images.example/poster.jpg',
  });
  assert.equal(h.video.pauseCalls, 0);
  assert.equal(h.otherVideo.pauseCalls, 0);
  assert.equal(JSON.stringify(h.posted).includes('blob:'), false);

  h.dispatch({
    kind: 'RESPONSE',
    capability: enter.capability,
    id: enter.id,
    ok: true,
    error: null,
  });
  assert.equal(await requestPromise, h.otherVideo);
  dispatchNative(h, enter.capability, { kind: 'ready', handoffId: `${enter.id}x` });
  dispatchNative(h, 'f'.repeat(32), { kind: 'ready', handoffId: enter.id });
  assert.equal(h.otherVideo.pauseCalls, 0);

  dispatchNative(h, enter.capability, { kind: 'ready', handoffId: enter.id });
  assert.equal(h.video.pauseCalls, 0);
  assert.equal(h.otherVideo.pauseCalls, 1);
  const paused = h.posted.at(-1);
  assert.deepEqual(paused, {
    type: 'PIPSHIM_WEBVIEW_PAUSED',
    id: enter.id,
    capability: enter.capability,
  });
});

test('iOS v1 ignores native events after the exact-video association generation changes', async () => {
  const h = await createHarness('ios-native-v1');
  const publisher = h.window.__MOVIX_NATIVE_MEDIA_SOURCE_V1__;
  publisher.publish(h.video, LOOPBACK_URL, 'hls');
  const promise = h.video.requestPictureInPicture();
  const enter = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.dispatch({
    kind: 'RESPONSE',
    capability: enter.capability,
    id: enter.id,
    ok: true,
    error: null,
  });
  await promise;

  publisher.publish(h.video, LOOPBACK_URL, 'mp4');
  dispatchNative(h, enter.capability, { kind: 'ready', handoffId: enter.id });
  dispatchNative(h, enter.capability, { kind: 'state', handoffId: enter.id, active: true });
  assert.equal(h.video.pauseCalls, 0);
  assert.equal(h.firstEnterEvents, 0);
  assert.equal(h.posted.some(message => message.type === 'PIPSHIM_WEBVIEW_PAUSED'), false);
});

test('iOS v1 restores only the entered video, acknowledges after seek/play, and leaves exactly once', async () => {
  const h = await createHarness('ios-native-v1');
  h.window.__MOVIX_NATIVE_MEDIA_SOURCE_V1__.publish(h.video, LOOPBACK_URL, 'hls');
  const promise = h.video.requestPictureInPicture();
  const enter = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.dispatch({
    kind: 'RESPONSE',
    capability: enter.capability,
    id: enter.id,
    ok: true,
    error: null,
  });
  await promise;
  dispatchNative(h, enter.capability, { kind: 'ready', handoffId: enter.id });
  dispatchNative(h, enter.capability, { kind: 'state', handoffId: enter.id, active: true });
  assert.equal(h.document.pictureInPictureElement, h.video);
  assert.equal(h.firstEnterEvents, 1);

  dispatchNative(h, enter.capability, {
    kind: 'restore',
    handoffId: enter.id,
    positionSec: 500,
    paused: false,
  });
  assert.equal(h.video.currentTime, 100, 'restore position is bounded by media duration');
  assert.equal(h.otherVideo.currentTime, 30);
  assert.equal(h.posted.some(message => message.type === 'PIPSHIM_RESTORE_APPLIED'), false);
  h.video.dispatchEvent(new CustomEvent('seeked'));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.video.playCalls, 1);
  assert.equal(h.otherVideo.playCalls, 0);
  assert.equal(h.firstLeaveEvents, 1);
  assert.equal(h.secondLeaveEvents, 0);
  assert.equal(h.document.pictureInPictureElement, null);
  assert.deepEqual(h.posted.at(-1), {
    type: 'PIPSHIM_RESTORE_APPLIED',
    id: enter.id,
    capability: enter.capability,
    ok: true,
  });

  dispatchNative(h, enter.capability, {
    kind: 'restore',
    handoffId: enter.id,
    positionSec: 1,
    paused: true,
  });
  dispatchNative(h, enter.capability, {
    kind: 'state',
    handoffId: enter.id,
    active: false,
  });
  assert.equal(h.firstLeaveEvents, 1);
});

test('iOS v1 retains the exact video for restore after native state becomes inactive', async () => {
  const h = await createHarness('ios-native-v1');
  h.window.__MOVIX_NATIVE_MEDIA_SOURCE_V1__.publish(h.video, LOOPBACK_URL, 'hls');
  const promise = h.video.requestPictureInPicture();
  const enter = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.dispatch({
    kind: 'RESPONSE',
    capability: enter.capability,
    id: enter.id,
    ok: true,
    error: null,
  });
  await promise;
  dispatchNative(h, enter.capability, { kind: 'ready', handoffId: enter.id });
  dispatchNative(h, enter.capability, {
    kind: 'state', handoffId: enter.id, active: true,
  });
  dispatchNative(h, enter.capability, {
    kind: 'state', handoffId: enter.id, active: false,
  });
  assert.equal(h.firstLeaveEvents, 0, 'leave waits until exact-video restore completes');
  assert.equal(h.document.pictureInPictureElement, h.video);

  dispatchNative(h, enter.capability, {
    kind: 'restore',
    handoffId: enter.id,
    positionSec: 44,
    paused: true,
  });
  h.video.dispatchEvent(new CustomEvent('seeked'));
  await Promise.resolve();

  assert.equal(h.video.currentTime, 44);
  assert.equal(h.video.paused, true);
  assert.deepEqual(h.posted.at(-1), {
    type: 'PIPSHIM_RESTORE_APPLIED',
    id: enter.id,
    capability: enter.capability,
    ok: true,
  });
  assert.equal(h.firstLeaveEvents, 1);
});

test('iOS v1 explicit exit keeps the entered video until native restoration completes', async () => {
  const h = await createHarness('ios-native-v1');
  h.window.__MOVIX_NATIVE_MEDIA_SOURCE_V1__.publish(h.video, LOOPBACK_URL, 'hls');
  const promise = h.video.requestPictureInPicture();
  const enter = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.dispatch({
    kind: 'RESPONSE',
    capability: enter.capability,
    id: enter.id,
    ok: true,
    error: null,
  });
  await promise;
  dispatchNative(h, enter.capability, { kind: 'ready', handoffId: enter.id });
  dispatchNative(h, enter.capability, {
    kind: 'state', handoffId: enter.id, active: true,
  });

  await h.document.exitPictureInPicture();
  assert.deepEqual(h.posted.at(-1), {
    type: 'PIPSHIM_EXIT',
    id: enter.id,
    capability: enter.capability,
  });
  assert.equal(h.firstLeaveEvents, 0);

  dispatchNative(h, enter.capability, {
    kind: 'state', handoffId: enter.id, active: false,
  });
  dispatchNative(h, enter.capability, {
    kind: 'restore',
    handoffId: enter.id,
    positionSec: 48,
    paused: false,
  });
  h.video.dispatchEvent(new CustomEvent('seeked'));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.video.currentTime, 48);
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.firstLeaveEvents, 1);
  assert.equal(h.posted.at(-1).type, 'PIPSHIM_RESTORE_APPLIED');
});

test('iOS v1 bounds explicit exit when native never restores or becomes inactive', async () => {
  const timers = createFakeTimers();
  const h = await createHarness('ios-native-v1', {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  h.window.__MOVIX_NATIVE_MEDIA_SOURCE_V1__.publish(h.video, LOOPBACK_URL, 'hls');
  const promise = h.video.requestPictureInPicture();
  const enter = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.dispatch({
    kind: 'RESPONSE', capability: enter.capability, id: enter.id, ok: true, error: null,
  });
  await promise;
  dispatchNative(h, enter.capability, { kind: 'ready', handoffId: enter.id });
  dispatchNative(h, enter.capability, {
    kind: 'state', handoffId: enter.id, active: true,
  });

  await h.document.exitPictureInPicture();
  assert.equal(h.firstLeaveEvents, 0);
  timers.runNext(5_000);

  assert.equal(h.firstLeaveEvents, 1);
  assert.equal(h.document.pictureInPictureElement, null);
});

test('iOS v1 uses captured standard/WebKit fallbacks with the requested receiver and never posts blob or remote URLs', async () => {
  for (const fallback of ['standardFallback', 'webkitFallback']) {
    const h = await createHarness('ios-native-v1', { [fallback]: true });
    h.video.currentSrc = fallback === 'standardFallback'
      ? 'blob:https://movix.example/media-source'
      : 'https://cdn.example/video.m3u8';
    assert.equal(await h.video.requestPictureInPicture(), h.video);
    assert.equal(h.fallbackReceiver, h.video);
    if (fallback === 'webkitFallback') {
      assert.equal(h.video.presentationMode, 'picture-in-picture');
    }
    assert.equal(h.posted.some(message => message.type === 'PIPSHIM_PREPARED_SOURCE'), false);
    assert.doesNotMatch(JSON.stringify(h.posted), /blob:|cdn\.example/);
  }

  const unsupported = await createHarness('ios-native-v1');
  unsupported.video.currentSrc = 'blob:https://movix.example/media-source';
  await assert.rejects(
    unsupported.video.requestPictureInPicture(),
    error => error.name === 'NotSupportedError',
  );
});

test('iOS v1 pagehide cancels the exact handoff, rejects it, and clears document state', async () => {
  const h = await createHarness('ios-native-v1');
  h.video.currentSrc = LOOPBACK_URL;
  const promise = h.video.requestPictureInPicture();
  const enter = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.window.dispatchEvent(new CustomEvent('pagehide'));
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.deepEqual(h.posted.at(-1), {
    type: 'PIPSHIM_EXIT',
    id: enter.id,
    capability: enter.capability,
  });
  assert.equal(h.document.pictureInPictureElement, null);
  assert.equal(h.firstLeaveEvents, 0);
});

test('disabled mode leaves captured browser PiP and WebKit behavior untouched', async () => {
  const h = await createHarness('disabled', { standardFallback: true, webkitFallback: true });
  assert.equal(h.window.__MOVIX_NATIVE_MEDIA_SOURCE_V1__, undefined);
  assert.equal(await h.video.requestPictureInPicture(), h.video);
  assert.equal(h.fallbackReceiver, h.video);
  assert.equal(h.video.presentationMode, undefined);
  assert.deepEqual(h.posted, []);
});
