import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

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

async function loadInjectedJavaScriptBuilder() {
  const sourceUrl = new URL('../src/injection/inject.ts', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourceUrl.pathname,
  }).outputText;
  const module = { exports: {} };
  const require = id => {
    if (id === './cast-shim') return { buildCastShim: () => 'CAST_SHIM' };
    if (id === './picture-in-picture-shim') return { buildPictureInPictureShim: enabled => enabled ? 'PIP_SHIM' : 'PIP_DISABLED' };
    if (id === './playback-awake-shim') return { buildPlaybackAwakeShim: () => 'PLAYBACK_AWAKE_SHIM' };
    if (id === './bridge-runtime') return { buildBridgeRuntime: () => 'BRIDGE_RUNTIME' };
    if (id === './userscript-source') return { USERSCRIPT_SOURCE: 'USERSCRIPT_SOURCE' };
    // Fork Movix : `inject.ts` conditionne le cast shim à la plateforme et
    // injecte en plus le pont Media Session (jaquette écran verrouillé).
    if (id === 'react-native') return { Platform: { OS: 'android' } };
    if (id === './media-session') return { buildMediaSession: () => 'MEDIA_SESSION' };
    throw new Error(`Unexpected injection dependency: ${id}`);
  };
  vm.runInNewContext(`(function(require,module,exports){${output}\n})`, {})(require, module, module.exports);
  return module.exports;
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
    for (const listener of this.#listeners.get(event.type) || []) listener.call(this, event);
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
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
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

  hasAttribute(name) {
    return this.attributes.has(name);
  }
}

class HTMLVideoElement extends FakeElement {
  constructor() {
    super('video');
    this.isConnected = true;
    this.paused = false;
    this.ended = false;
  }
}

async function createHarness(enabled, environment = {}) {
  const { buildPictureInPictureShim } = await loadPictureInPictureShimBuilder();
  class HarnessVideoElement extends FakeElement {
    constructor() {
      super('video');
      this.isConnected = true;
      this.paused = false;
      this.ended = false;
      this.currentTime = 30;
      this.duration = 100;
      this.playCalls = 0;
      this.pauseCalls = 0;
    }

    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    }

    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    }
  }
  const posted = [];
  const window = new EventTarget();
  const html = new FakeElement('html');
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const container = new FakeElement('div');
  const video = new HarnessVideoElement();
  const otherVideo = new HarnessVideoElement();
  html.appendChild(head);
  html.appendChild(body);
  body.appendChild(container);
  container.appendChild(video);
  body.appendChild(otherVideo);
  const document = new EventTarget();
  document.documentElement = html;
  document.head = head;
  document.body = body;
  document.createElement = tagName => new FakeElement(tagName);
  document.querySelectorAll = selector => selector === 'video' ? [video, otherVideo] : [];
  window.ReactNativeWebView = enabled && !environment.missingNativeWebView ? {
    postMessage(raw) {
      posted.push(JSON.parse(raw));
    },
  } : undefined;
  window.crypto = environment.missingCrypto ? undefined : {
    getRandomValues(bytes) {
      if (environment.throwingCrypto) throw new Error('unavailable');
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1;
      return bytes;
    },
  };
  const context = {
    Array,
    CustomEvent,
    Date,
    DOMException,
    HTMLVideoElement: environment.missingHtmlVideoElement ? undefined : HarnessVideoElement,
    JSON,
    Map,
    Object,
    Promise,
    Uint8Array,
    clearTimeout,
    document,
    setTimeout,
    window,
  };
  vm.runInNewContext(buildPictureInPictureShim(enabled), context);
  let enterEvents = 0;
  let leaveEvents = 0;
  video.addEventListener('enterpictureinpicture', () => { enterEvents += 1; });
  video.addEventListener('leavepictureinpicture', () => { leaveEvents += 1; });
  otherVideo.addEventListener('enterpictureinpicture', () => { enterEvents += 1; });
  otherVideo.addEventListener('leavepictureinpicture', () => { leaveEvents += 1; });
  return {
    container,
    body,
    dispatch(detail) {
      window.dispatchEvent(new CustomEvent('__MOVIX_PIP_SHIM__', { detail }));
    },
    document,
    get enterEvents() { return enterEvents; },
    get leaveEvents() { return leaveEvents; },
    html,
    otherVideo,
    posted,
    video,
    window,
  };
}

test('unsupported runtime leaves PiP globals untouched', async () => {
  const h = await createHarness(false);
  assert.equal(h.document.pictureInPictureEnabled, undefined);
  assert.equal(h.video.requestPictureInPicture, undefined);
  assert.deepEqual(h.posted, []);
});

test('missing native capabilities leave PiP globals untouched', async () => {
  for (const environment of [
    { missingNativeWebView: true },
    { missingCrypto: true },
    { throwingCrypto: true },
    { missingHtmlVideoElement: true },
  ]) {
    const h = await createHarness(true, environment);
    assert.equal(h.document.pictureInPictureEnabled, undefined);
    assert.equal(h.video.requestPictureInPicture, undefined);
    assert.deepEqual(h.posted, []);
  }
});

test('injected runtime preserves Cast-first PiP and playback ordering', async () => {
  const { buildInjectedJavaScript } = await loadInjectedJavaScriptBuilder();
  const script = buildInjectedJavaScript({ pictureInPictureEnabled: true });
  const order = ['CAST_SHIM', 'PIP_SHIM', 'PLAYBACK_AWAKE_SHIM', 'BRIDGE_RUNTIME', 'USERSCRIPT_SOURCE']
    .map(marker => script.indexOf(marker));
  assert.equal(order.every((position, index) => index === 0 || position > order[index - 1]), true);
});

test('supported runtime registers and resolves a matching request', async () => {
  const h = await createHarness(true);
  assert.equal(h.document.pictureInPictureEnabled, true);
  const registration = h.posted.find(message => message.type === 'PIPSHIM_REGISTER_CAPABILITY');
  assert.match(registration.capability, /^[a-f0-9]{32}$/);
  const promise = h.video.requestPictureInPicture();
  assert.equal(
    h.posted.filter(message => message.type === 'PIPSHIM_REGISTER_CAPABILITY').length,
    2,
  );
  const request = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  assert.ok(request);
  assert.match(request.id, /^pip-\d+-\d+$/);
  h.dispatch({ kind: 'RESPONSE', id: request.id, ok: true, error: null });
  assert.equal(await promise, h.video);
});

test('native prepare and state isolate then restore the selected video', async () => {
  const h = await createHarness(true);
  const promise = h.video.requestPictureInPicture();
  const request = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.dispatch({ kind: 'RESPONSE', id: request.id, ok: true, error: null });
  await promise;
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'prepare' } });
  assert.equal(h.html.classList.contains('movix-native-pip'), true);
  assert.equal(h.video.hasAttribute('data-movix-native-pip-target'), true);
  assert.equal(h.container.hasAttribute('data-movix-native-pip-ancestor'), true);
  assert.equal(h.document.head.children.length, 1);
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'state', active: true } });
  assert.equal(h.document.pictureInPictureElement, h.video);
  assert.equal(h.enterEvents, 1);
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'state', active: false } });
  assert.equal(h.document.pictureInPictureElement, null);
  assert.equal(h.leaveEvents, 1);
  assert.equal(h.html.classList.contains('movix-native-pip'), false);
  assert.equal(h.video.hasAttribute('data-movix-native-pip-target'), false);
  assert.equal(h.container.hasAttribute('data-movix-native-pip-ancestor'), false);
  assert.equal(h.document.head.children.length, 0);
});

test('wrong response IDs stay pending and matching errors reject with NotAllowedError', async () => {
  const h = await createHarness(true);
  const promise = h.video.requestPictureInPicture();
  const request = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.dispatch({ kind: 'RESPONSE', id: 'pip-wrong-id', ok: true, error: null });
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  h.dispatch({ kind: 'RESPONSE', id: request.id, ok: false, error: { code: 'PIP_REQUEST_REJECTED' } });
  await assert.rejects(promise, error => error.name === 'NotAllowedError');
});

test('pagehide removes markers and rejects pending requests with AbortError', async () => {
  const h = await createHarness(true);
  const committed = h.video.requestPictureInPicture();
  const request = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.dispatch({ kind: 'RESPONSE', id: request.id, ok: true, error: null });
  await committed;
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'prepare' } });
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'state', active: true } });
  const pending = h.document.exitPictureInPicture();
  h.window.dispatchEvent(new CustomEvent('pagehide'));
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(h.html.classList.contains('movix-native-pip'), false);
  assert.equal(h.video.hasAttribute('data-movix-native-pip-target'), false);
  assert.equal(h.container.hasAttribute('data-movix-native-pip-ancestor'), false);
  assert.equal(h.document.head.children.length, 0);
  assert.equal(h.leaveEvents, 1);
});

test('fallback and repeated lifecycle events retain markers only for the current video', async () => {
  for (const terminalEvent of ['inactive', 'error', 'pagehide']) {
    const h = await createHarness(true);
    const promise = h.video.requestPictureInPicture();
    const request = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
    h.dispatch({ kind: 'RESPONSE', id: request.id, ok: true, error: null });
    await promise;
    h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'prepare' } });
    h.video.isConnected = false;
    h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'state', active: true } });
    h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'prepare' } });
    h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'state', active: true } });

    assert.equal(h.video.hasAttribute('data-movix-native-pip-target'), false);
    assert.equal(h.otherVideo.hasAttribute('data-movix-native-pip-target'), true);
    assert.equal(h.container.hasAttribute('data-movix-native-pip-ancestor'), false);
    assert.equal(h.body.hasAttribute('data-movix-native-pip-ancestor'), true);
    assert.equal(h.enterEvents, 1);
    assert.equal(h.leaveEvents, 0);
    assert.equal(h.document.head.children.length, 1);

    if (terminalEvent === 'inactive') {
      h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'state', active: false } });
    } else if (terminalEvent === 'error') {
      h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'error', code: 'PIP_ENTER_REJECTED' } });
    } else {
      h.window.dispatchEvent(new CustomEvent('pagehide'));
    }
    assert.equal(h.video.hasAttribute('data-movix-native-pip-target'), false);
    assert.equal(h.otherVideo.hasAttribute('data-movix-native-pip-target'), false);
    assert.equal(h.container.hasAttribute('data-movix-native-pip-ancestor'), false);
    assert.equal(h.body.hasAttribute('data-movix-native-pip-ancestor'), false);
    assert.equal(h.html.hasAttribute('data-movix-native-pip-ancestor'), false);
    assert.equal(h.document.head.children.length, 0);
    assert.equal(h.html.classList.contains('movix-native-pip'), false);
    assert.equal(h.enterEvents, 1);
    assert.equal(h.leaveEvents, 1);
  }
});

test('native PiP actions control only the entered video and clamp seeks', async () => {
  const h = await createHarness(true);
  const promise = h.video.requestPictureInPicture();
  const request = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.dispatch({ kind: 'RESPONSE', id: request.id, ok: true, error: null });
  await promise;

  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'action', action: 'seek-forward' } });
  assert.equal(h.video.currentTime, 30, 'actions are stale until native PiP is active');

  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'state', active: true } });
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'action', action: 'seek-backward' } });
  assert.equal(h.video.currentTime, 20);
  h.video.currentTime = 5;
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'action', action: 'seek-backward' } });
  assert.equal(h.video.currentTime, 0);
  h.video.currentTime = 95;
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'action', action: 'seek-forward' } });
  assert.equal(h.video.currentTime, 100);
  assert.equal(h.otherVideo.currentTime, 30);
});

test('native PiP toggle pauses and resumes the entered video', async () => {
  const h = await createHarness(true);
  const promise = h.video.requestPictureInPicture();
  const request = h.posted.find(message => message.type === 'PIPSHIM_ENTER');
  h.dispatch({ kind: 'RESPONSE', id: request.id, ok: true, error: null });
  await promise;
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'state', active: true } });
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'action', action: 'toggle-playback' } });
  assert.equal(h.video.pauseCalls, 1);
  h.dispatch({ kind: 'NATIVE_EVENT', event: { kind: 'action', action: 'toggle-playback' } });
  assert.equal(h.video.playCalls, 1);
});
