import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function loadBridgeRuntimeBuilder() {
  const sourceUrl = new URL('../src/injection/bridge-runtime.ts', import.meta.url);
  let source = await readFile(sourceUrl, 'utf8');
  source = source.replace(
    /import\s+\{\s*MEDIA_ENTRY_PATH_SOURCE\s*\}\s+from\s+['"]\.\/mediaProxyRouting['"];\s*/,
    `const MEDIA_ENTRY_PATH_SOURCE = ${JSON.stringify(String.raw`\.(?:m3u8|mp4|m4v|m4s|mpd|ts|aac|m4a|vtt|srt)(?:$|[?#])`)};\n`,
  );
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

function createRuntimeHarness(buildBridgeRuntime, { rejectOpen = false } = {}) {
  const posted = [];
  const nativeFetches = [];
  const listeners = new Map();

  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const window = {
    __MOVIX_BRIDGE_READY: false,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
    fetch: async (url, init = {}) => {
      nativeFetches.push({
        url: String(url),
        method: init.method,
        headers: { ...init.headers },
      });
      return {
        status: 206,
        statusText: 'Partial Content',
        url: String(url),
        headers: new Map([
          ['content-type', 'application/vnd.apple.mpegurl'],
          ['content-range', 'bytes 0-2/3'],
        ]),
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
        text: async () => 'LOCAL',
      };
    },
  };

  window.ReactNativeWebView = {
    postMessage(raw) {
      const message = JSON.parse(raw);
      // Fork Movix : le runtime relaie aussi les `console.*` du WebView vers la
      // console de debug native. Ce bruit n'a rien à voir avec le proxy média.
      if (message.type === 'CONSOLE_LOG') return;
      posted.push(message);
      queueMicrotask(() => {
        if (message.type === 'GM_OPEN_MEDIA_PROXY') {
          window.dispatchEvent(new CustomEvent('__MOVIX_BRIDGE_RESPONSE', {
            detail: rejectOpen
              ? { id: message.id, success: false, error: 'unavailable' }
              : {
                  id: message.id,
                  success: true,
                  value: 'http://127.0.0.1:28123/p/opaque-session',
                },
          }));
          return;
        }

        window.dispatchEvent(new CustomEvent('__MOVIX_BRIDGE_RESPONSE', {
          detail: {
            id: message.id,
            success: true,
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/octet-stream' },
            body: 'BAUG',
            finalUrl: message.url,
          },
        }));
      });
    },
  };

  const context = vm.createContext({
    window,
    CustomEvent,
    Uint8Array,
    ArrayBuffer,
    URLSearchParams,
    Promise,
    console,
    atob,
    btoa,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  vm.runInContext(buildBridgeRuntime(), context);
  return { window, posted, nativeFetches };
}

function gmRequest(window, details) {
  return new Promise((resolve, reject) => {
    window.GM_xmlhttpRequest({
      responseType: 'arraybuffer',
      ...details,
      onload: resolve,
      onerror: reject,
    });
  });
}

test('Seek media opens a header-bound proxy and sends Range only to loopback', async () => {
  const { buildBridgeRuntime } = await loadBridgeRuntimeBuilder();
  const harness = createRuntimeHarness(buildBridgeRuntime);

  const response = await gmRequest(harness.window, {
    method: 'GET',
    url: 'https://185.237.106.181/v4/synthetic/master.m3u8?v=1',
    headers: {
      Origin: 'https://movix1.embedseek.com',
      Referer: 'https://movix1.embedseek.com/',
      Range: 'bytes=0-99',
    },
  });

  assert.deepEqual(harness.posted.map(entry => entry.type), [
    'GM_OPEN_MEDIA_PROXY',
  ]);
  const { id, ...openPayload } = harness.posted[0];
  assert.equal(typeof id, 'string');
  assert.deepEqual(openPayload, {
    type: 'GM_OPEN_MEDIA_PROXY',
    url: 'https://185.237.106.181/v4/synthetic/master.m3u8?v=1',
    method: 'GET',
    headers: {
      Origin: 'https://movix1.embedseek.com',
      Referer: 'https://movix1.embedseek.com/',
    },
  });
  assert.deepEqual(harness.nativeFetches, [
    {
      url: 'http://127.0.0.1:28123/p/opaque-session',
      method: 'GET',
      headers: {
        Range: 'bytes=0-99',
      },
    },
  ]);
  assert.deepEqual([...new Uint8Array(response.response)], [1, 2, 3]);
});

test('falls back to GM_FETCH when the native proxy is unavailable', async () => {
  const { buildBridgeRuntime } = await loadBridgeRuntimeBuilder();
  const harness = createRuntimeHarness(buildBridgeRuntime, { rejectOpen: true });

  const response = await gmRequest(harness.window, {
    method: 'GET',
    url: 'https://r1.fsvid.lol/movie/master.m3u8',
    headers: {
      Origin: 'https://fsvid.lol',
      Referer: 'https://fsvid.lol/',
    },
  });

  assert.deepEqual(harness.posted.map(entry => entry.type), [
    'GM_OPEN_MEDIA_PROXY',
    'GM_FETCH',
  ]);
  assert.deepEqual([...new Uint8Array(response.response)], [4, 5, 6]);
});
