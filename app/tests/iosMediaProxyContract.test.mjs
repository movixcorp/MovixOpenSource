import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = new URL('../', import.meta.url);
const read = relativePath => readFile(new URL(relativePath, ROOT), 'utf8');
const capability = 'a'.repeat(32);
const documentGeneration = 'b'.repeat(32);
const token43 = character => character.repeat(43);
const validIOSLocalURL = port =>
  `http://127.0.0.1:${port}/p/${token43('A')}/${token43('b')}/${token43('_')}`;

async function loadBridge({ platform = 'ios', openResult = validIOSLocalURL(28123) } = {}) {
  const source = await read('src/services/bridge.ts');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: 'bridge.ts',
  });

  const openCalls = [];
  const nativeModules = {
    MediaProxy: {
      async open(...args) {
        openCalls.push(args);
        if (openResult instanceof Error) throw openResult;
        return typeof openResult === 'function' ? openResult(...args) : openResult;
      },
      async resolveForCast() {
        throw new Error('unused');
      },
    },
  };
  const noop = () => {};
  const asyncNoop = async () => undefined;
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === 'react-native') {
        return { NativeModules: nativeModules, Platform: { OS: platform } };
      }
      if (specifier === './mediaProxyHeaders') {
        return { applyMediaProxyHeaderRules: (_url, headers) => headers };
      }
      if (specifier === './castLoadSingleFlight') {
        return {
          createCastLoadIdentity: () => 'unused',
          createCastLoadSingleFlight: () => ({ run: asyncNoop }),
        };
      }
      if (specifier === './cast') {
        return new Proxy({}, {
          get: (_target, property) =>
            String(property).startsWith('subscribe') ? () => noop : asyncNoop,
        });
      }
      if (specifier === './playbackAwake') return { setPlaybackAwakeOwner: noop };
      if (specifier === './pictureInPicture') {
        return {
          enterPictureInPicture: asyncNoop,
          exitPictureInPicture: asyncNoop,
          setPictureInPicturePlaybackActive: noop,
          subscribePictureInPicture: () => noop,
        };
      }
      throw new Error(`Unexpected bridge dependency: ${specifier}`);
    },
    AbortController,
    Headers,
    Map,
    Number,
    Object,
    Promise,
    Response,
    Set,
    String,
    URL,
    WeakMap,
    console,
    fetch: async () => {
      throw new Error('unused');
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(outputText, sandbox, { filename: 'bridge.cjs' });
  return { bridge: module.exports, openCalls };
}

async function loadBridgeRuntimeBuilder() {
  let source = await read('src/injection/bridge-runtime.ts');
  source = source.replace(
    /import\s+\{\s*MEDIA_ENTRY_PATH_SOURCE\s*\}\s+from\s+['"]\.\/mediaProxyRouting['"];\s*/,
    `const MEDIA_ENTRY_PATH_SOURCE = ${JSON.stringify(String.raw`\.(?:m3u8|mp4)(?:$|[?#])`)};\n`,
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: 'bridge-runtime.ts',
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, { module, exports: module.exports });
  return module.exports.buildBridgeRuntime;
}

function makeWebViewHarness() {
  const responses = [];
  class CustomEvent {
    constructor(_type, init = {}) {
      this.detail = init.detail;
    }
  }
  const ref = {
    current: {
      injectJavaScript(script) {
        vm.runInNewContext(script, {
          CustomEvent,
          window: {
            dispatchEvent(event) {
              responses.push(event.detail);
            },
          },
        });
      },
    },
  };
  return { ref, responses };
}

const trustedContext = (overrides = {}) => ({
  sourceUrl: 'https://movix.tax/watch/movie/1',
  topLevelUrl: 'https://movix.tax/watch/movie/1',
  trustedOrigins: ['https://movix.tax/'],
  isTopFrame: false,
  navigationGeneration: 7,
  ...overrides,
});

async function registerIOSCapability(
  bridge,
  ref,
  context = trustedContext(),
  authorization = { capability, generation: documentGeneration },
) {
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'GM_MEDIA_PROXY_REGISTER_CAPABILITY',
    ...authorization,
  }), ref, context);
}

async function openMedia(bridge, ref, context = trustedContext(), overrides = {}) {
  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'GM_OPEN_MEDIA_PROXY',
    id: `open-${Math.random()}`,
    capability,
    generation: documentGeneration,
    url: 'https://cdn.example/movie/master.m3u8',
    method: 'GET',
    headers: { Referer: 'https://movix.tax/' },
    ...overrides,
  }), ref, context);
}

test('iOS exports the exact MediaProxy Swift and Objective-C promise bridge', async () => {
  const [swift, objc] = await Promise.all([
    read('ios/Movix/Proxy/MediaProxyModule.swift'),
    read('ios/Movix/Proxy/MediaProxyModule.m'),
  ]);

  assert.match(swift, /@objc\(MediaProxy\)\s*\nfinal class MediaProxyModule: NSObject/);
  assert.match(swift, /private let server = MediaProxyServer\.shared/);
  assert.match(swift, /@objc static func requiresMainQueueSetup\(\) -> Bool \{ false \}/);
  assert.match(swift, /func open\(\s*_ url: String,\s*method: String,\s*headers: \[String: String\],\s*resolve: @escaping RCTPromiseResolveBlock,\s*reject: @escaping RCTPromiseRejectBlock\s*\)/s);
  assert.match(swift, /func resolveForCast\(\s*_ localURL: String,\s*resolve: @escaping RCTPromiseResolveBlock,\s*reject: @escaping RCTPromiseRejectBlock\s*\)/s);
  assert.match(swift, /Task \{[\s\S]*?validatePublicHTTPSURLSyntax\(url\)[\s\S]*?sanitizeRequestHeaders\(headers\)[\s\S]*?await server\.open\(target: target\)/);
  assert.match(swift, /normalizedMethod == "GET" \|\| normalizedMethod == "HEAD"/);
  assert.match(swift, /headers\.count <= 32/);
  assert.match(swift, /name\.utf8\.count <= 128/);
  assert.match(swift, /value\.utf8\.count <= 8_192/);
  assert.match(swift, /!name\.contains\("\\r"\)[\s\S]*?!name\.contains\("\\n"\)[\s\S]*?!value\.contains\("\\r"\)[\s\S]*?!value\.contains\("\\n"\)/);
  assert.match(swift, /let payload: \[String: Any\][\s\S]*?"protocolVersion": 1/);
  assert.match(swift, /await server\.resolveForCast\(url\)/);
  assert.match(swift, /reject\("MEDIA_PROXY_OPEN_FAILED", "Local media proxy unavailable", nil\)/);
  assert.match(swift, /reject\(\s*"MEDIA_PROXY_CAST_RESOLVE_FAILED",\s*"Local media source unavailable",\s*nil\s*\)/s);
  assert.doesNotMatch(swift, /validatePublicHTTPSURL\(url\)|server\.close|invalidateAll|localizedDescription|\bprint\(|NSLog|@MainActor/);

  assert.match(objc, /@interface RCT_EXTERN_MODULE\(MediaProxy, NSObject\)/);
  assert.match(objc, /RCT_EXTERN_METHOD\(open:\(NSString \*\)url\s*method:\(NSString \*\)method\s*headers:\(NSDictionary<NSString \*, NSString \*> \*\)headers\s*resolve:\(RCTPromiseResolveBlock\)resolve\s*reject:\(RCTPromiseRejectBlock\)reject\)/s);
  assert.match(objc, /RCT_EXTERN_METHOD\(resolveForCast:\(NSString \*\)localURL\s*resolve:\(RCTPromiseResolveBlock\)resolve\s*reject:\(RCTPromiseRejectBlock\)reject\)/s);
});

test('Xcode compiles both MediaProxy bridge files only in the Movix app target', async () => {
  const project = await read('ios/Movix.xcodeproj/project.pbxproj');
  const testSources = project.match(/00E356EA1AD99517003FC87E \/\* Sources \*\/ = \{[\s\S]*?\n\s*\};/)?.[0] ?? '';
  const appSources = project.match(/13B07F871A680F5B00A75B9A \/\* Sources \*\/ = \{[\s\S]*?\n\s*\};/)?.[0] ?? '';
  const proxyGroup = project.match(/B30000000000000000000001 \/\* Proxy \*\/ = \{[\s\S]*?\n\s*\};/)?.[0] ?? '';

  for (const file of ['MediaProxyModule.swift', 'MediaProxyModule.m']) {
    const escaped = file.replaceAll('.', '\\.');
    assert.equal(
      project.match(new RegExp(`PBXBuildFile; fileRef = [^;]+ \/\\* ${escaped} \\*\/`, 'g'))?.length,
      1,
      `${file} build file`,
    );
    assert.equal(
      project.match(new RegExp(`PBXFileReference; lastKnownFileType = sourcecode\\.[^;]+; path = ${escaped};`, 'g'))?.length,
      1,
      `${file} file reference`,
    );
    assert.match(proxyGroup, new RegExp(escaped));
    assert.match(appSources, new RegExp(`${escaped} in Sources`));
    assert.doesNotMatch(testSources, new RegExp(escaped));
  }
});

test('injection keeps proxy routing separate from explicit Android/iOS-v1 PiP modes', async () => {
  const [webView, inject, runtime] = await Promise.all([
    read('src/components/WebViewBrowser.tsx'),
    read('src/injection/inject.ts'),
    read('src/injection/bridge-runtime.ts'),
  ]);

  assert.match(webView, /Platform\.OS === 'android' && Number\(Platform\.Version\) >= 26[\s\S]*?return 'android'/);
  assert.match(webView, /Platform\.OS === 'ios'[\s\S]*?getPreparedNativePlaybackSourceProtocolVersion\(\) === 1[\s\S]*?return 'ios-native-v1'/);
  assert.match(webView, /pictureInPictureMode:\s*getPictureInPictureShimMode\(\)/);
  assert.match(webView, /mediaProxyRoutingEnabled:\s*Platform\.OS === 'android' \|\| Platform\.OS === 'ios'/);
  assert.match(webView, /mediaProxyCapabilityEnabled:\s*Platform\.OS === 'ios'/);
  assert.match(webView, /injectedJavaScriptBeforeContentLoadedForMainFrameOnly=\{true\}/);
  assert.match(webView, /const navigationGenerationRef = useRef\(0\)/);
  assert.match(webView, /topLevelUrl:\s*topLevelUrlRef\.current/);
  assert.match(webView, /navigationGeneration:\s*navigationGenerationRef\.current/);
  assert.match(webView, /navigationGenerationRef\.current \+= 1;[\s\S]*?clearBridgeCapabilities\(webViewRef\)/);
  assert.match(inject, /mediaProxyRoutingEnabled\?: boolean/);
  assert.match(inject, /mediaProxyCapabilityEnabled\?: boolean/);
  assert.match(inject, /buildBridgeRuntime\(\{[\s\S]*?mediaProxyRoutingEnabled:[\s\S]*?mediaProxyCapabilityEnabled:/);
  assert.match(runtime, /GM_MEDIA_PROXY_REGISTER_CAPABILITY/);
  assert.match(runtime, /crypto\.getRandomValues/);
  assert.match(runtime, /capability:[^,\n]+,[\s\S]*?generation:/);
  assert.doesNotMatch(runtime, /window\.__MOVIX_MEDIA_PROXY_(?:CAPABILITY|GENERATION)/);
  assert.match(runtime, /\.catch\(function\(\) \{\s*if \(!cancelled\) \{\s*sendBridgeRequest\(details\);/);
});

test('iOS runtime keeps capability material lexical and sends it only with proxy messages', async () => {
  const buildBridgeRuntime = await loadBridgeRuntimeBuilder();
  const listeners = new Map();
  const posted = [];
  let randomFill = 0x10;
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const window = {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
    crypto: {
      getRandomValues(bytes) {
        randomFill += 1;
        bytes.fill(randomFill);
        return bytes;
      },
    },
    fetch: async () => {
      throw new Error('unused');
    },
  };
  window.ReactNativeWebView = {
    postMessage(raw) {
      const message = JSON.parse(raw);
      posted.push(message);
      if (message.type === 'GM_OPEN_MEDIA_PROXY') {
        window.dispatchEvent(new CustomEvent('__MOVIX_BRIDGE_RESPONSE', {
          detail: {
            id: message.id,
            success: true,
            value: validIOSLocalURL(28123),
          },
        }));
      }
    },
  };
  const context = vm.createContext({
    ArrayBuffer,
    CustomEvent,
    Promise,
    URLSearchParams,
    Uint8Array,
    atob,
    clearTimeout: () => {},
    console,
    setTimeout: () => 1,
    window,
  });
  vm.runInContext(buildBridgeRuntime({
    mediaProxyRoutingEnabled: true,
    mediaProxyCapabilityEnabled: true,
  }), context);

  const localURL = await window.GM_openMediaProxy({
    url: 'https://cdn.example/movie/master.m3u8',
    headers: {},
  });
  assert.equal(localURL, validIOSLocalURL(28123));
  assert.deepEqual(posted.map(message => message.type), [
    'GM_MEDIA_PROXY_REGISTER_CAPABILITY',
    'GM_OPEN_MEDIA_PROXY',
  ]);
  assert.match(posted[0].capability, /^[a-f0-9]{32}$/);
  assert.match(posted[0].generation, /^[a-f0-9]{32}$/);
  assert.equal(posted[1].capability, posted[0].capability);
  assert.equal(posted[1].generation, posted[0].generation);
  assert.notEqual(posted[0].capability, posted[0].generation);
  assert.equal(window.__MOVIX_MEDIA_PROXY_CAPABILITY, undefined);
  assert.equal(window.__MOVIX_MEDIA_PROXY_GENERATION, undefined);
});

test('trusted iOS main-document capability opens the native proxy without isTopFrame', async () => {
  const { bridge, openCalls } = await loadBridge();
  const { ref, responses } = makeWebViewHarness();

  await registerIOSCapability(bridge, ref);
  await openMedia(bridge, ref);

  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0][0], 'https://cdn.example/movie/master.m3u8');
  assert.equal(openCalls[0][1], 'GET');
  assert.equal(JSON.stringify(openCalls[0][2]), JSON.stringify({
    Referer: 'https://movix.tax/',
  }));
  assert.equal(responses.at(-1)?.success, true);
  assert.equal(responses.at(-1)?.value, validIOSLocalURL(28123));
});

test('iOS rejects subframe, untrusted, mismatched, and stale capabilities immediately', async () => {
  const { bridge, openCalls } = await loadBridge();
  const { ref, responses } = makeWebViewHarness();

  const rejectedContexts = [
    trustedContext({
      sourceUrl: 'https://frame.attacker.invalid/embed',
    }),
    trustedContext({
      sourceUrl: 'https://untrusted.invalid/watch',
      topLevelUrl: 'https://untrusted.invalid/watch',
    }),
    trustedContext({
      sourceUrl: 'https://movix.tax/iframe',
    }),
  ];
  for (const context of rejectedContexts) {
    await registerIOSCapability(bridge, ref, context);
    await openMedia(bridge, ref, context);
    assert.equal(JSON.stringify(responses.at(-1)), JSON.stringify({
      id: responses.at(-1).id,
      success: false,
      error: 'Local media proxy unavailable',
    }));
  }
  assert.equal(openCalls.length, 0);

  await registerIOSCapability(bridge, ref);
  await openMedia(bridge, ref, trustedContext(), { capability: 'c'.repeat(32) });
  assert.equal(openCalls.length, 0);
  assert.equal(responses.at(-1)?.error, 'Local media proxy unavailable');

  bridge.clearBridgeCapabilities(ref);
  await registerIOSCapability(bridge, ref);
  await openMedia(bridge, ref, trustedContext({ navigationGeneration: 8 }));
  assert.equal(openCalls.length, 0);
  assert.equal(responses.at(-1)?.error, 'Local media proxy unavailable');

  const freshAuthorization = {
    capability: 'c'.repeat(32),
    generation: 'd'.repeat(32),
  };
  const nextNavigation = trustedContext({ navigationGeneration: 8 });
  await registerIOSCapability(bridge, ref, nextNavigation, freshAuthorization);
  await openMedia(bridge, ref, nextNavigation, freshAuthorization);
  assert.equal(openCalls.length, 1);
  assert.equal(responses.at(-1)?.success, true);
});

test('iOS accepts only canonical 43-token loopback URLs and bounded ports', async () => {
  let localURL = validIOSLocalURL(1);
  const { bridge } = await loadBridge({ openResult: () => localURL });
  const { ref, responses } = makeWebViewHarness();
  await registerIOSCapability(bridge, ref);

  for (const accepted of [validIOSLocalURL(1), validIOSLocalURL(65535)]) {
    localURL = accepted;
    await openMedia(bridge, ref);
    assert.equal(responses.at(-1)?.success, true, accepted);
  }

  const path = `/p/${token43('A')}/${token43('b')}/${token43('_')}`;
  const invalid = [
    `http://127.0.0.1:0${path}`,
    `http://127.0.0.1:65536${path}`,
    `http://127.0.0.1:01${path}`,
    `HTTP://127.0.0.1:1${path}`,
    `http://localhost:1${path}`,
    `http://user@127.0.0.1:1${path}`,
    `http://127.0.0.1:1/p/${token43('A').slice(1)}/${token43('b')}/${token43('_')}`,
    `http://127.0.0.1:1/p/${token43('A')}A/${token43('b')}/${token43('_')}`,
    `http://127.0.0.1:1/p/${token43('A')}/${token43('b')}/${'+'.repeat(43)}`,
    `http://127.0.0.1:1${path}/`,
    `http://127.0.0.1:1${path}?query=1`,
    `http://127.0.0.1:1${path}#fragment`,
    `http://127.0.0.1:1\\p\\${token43('A')}\\${token43('b')}\\${token43('_')}`,
    `http://127.0.0.1:1${path}\n`,
  ];
  for (const rejected of invalid) {
    localURL = rejected;
    await openMedia(bridge, ref);
    assert.equal(responses.at(-1)?.success, false, rejected);
    assert.equal(responses.at(-1)?.error, 'Local media proxy unavailable');
  }
});

test('iOS native failures expose only the generic proxy error', async () => {
  const { bridge } = await loadBridge({
    openResult: new Error('https://secret.invalid/path?token=sensitive'),
  });
  const { ref, responses } = makeWebViewHarness();
  await registerIOSCapability(bridge, ref);
  await openMedia(bridge, ref);

  assert.equal(JSON.stringify(responses.at(-1)), JSON.stringify({
    id: responses.at(-1).id,
    success: false,
    error: 'Local media proxy unavailable',
  }));
  assert.doesNotMatch(JSON.stringify(responses), /secret|token|sensitive/i);
});

test('navigation revocation suppresses an in-flight iOS proxy result', async () => {
  let finishOpen;
  const pendingNativeOpen = new Promise(resolve => {
    finishOpen = resolve;
  });
  const { bridge, openCalls } = await loadBridge({
    openResult: () => pendingNativeOpen,
  });
  const { ref, responses } = makeWebViewHarness();
  await registerIOSCapability(bridge, ref);

  const pendingMessage = openMedia(bridge, ref);
  await Promise.resolve();
  assert.equal(openCalls.length, 1);
  bridge.clearBridgeCapabilities(ref);
  finishOpen(validIOSLocalURL(28123));
  await pendingMessage;

  assert.equal(responses.at(-1)?.success, false);
  assert.equal(responses.at(-1)?.error, 'Local media proxy unavailable');
});

test('Android retains top-frame provenance and its historical 24-token local URL', async () => {
  const token24 = 'a'.repeat(24);
  const androidURL = `http://127.0.0.1:28123/p/${token24}/${token24}/${token24}`;
  const { bridge, openCalls } = await loadBridge({
    platform: 'android',
    openResult: androidURL,
  });
  const { ref, responses } = makeWebViewHarness();
  const androidContext = trustedContext({ isTopFrame: true });

  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'GM_OPEN_MEDIA_PROXY',
    id: 'android-open',
    url: 'https://cdn.example/movie/master.m3u8',
    method: 'GET',
    headers: {},
  }), ref, androidContext);
  assert.equal(openCalls.length, 1);
  assert.equal(responses.at(-1)?.value, androidURL);

  await bridge.handleBridgeMessage(JSON.stringify({
    type: 'GM_OPEN_MEDIA_PROXY',
    id: 'android-subframe',
    url: 'https://cdn.example/movie/master.m3u8',
    method: 'GET',
    headers: {},
  }), ref, trustedContext({ isTopFrame: false }));
  assert.equal(openCalls.length, 1);
  assert.equal(responses.at(-1)?.error, 'Local media proxy unavailable');
});

test('proxy request header limits reject excess, oversized, and CRLF input before native open', async () => {
  const { bridge, openCalls } = await loadBridge();
  const { ref, responses } = makeWebViewHarness();
  await registerIOSCapability(bridge, ref);

  const accepted = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`X-${index}`, 'v']),
  );
  accepted['K'.repeat(128)] = 'V'.repeat(8192);
  delete accepted['X-0'];
  await openMedia(bridge, ref, trustedContext(), { headers: accepted });
  assert.equal(openCalls.length, 1);

  const rejectedHeaders = [
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`X-${index}`, 'v'])),
    { ['K'.repeat(129)]: 'v' },
    { K: 'V'.repeat(8193) },
    { 'X-Bad\r\nInjected': 'v' },
    { K: 'value\r\nInjected: true' },
  ];
  for (const headers of rejectedHeaders) {
    await openMedia(bridge, ref, trustedContext(), { headers });
    assert.equal(responses.at(-1)?.success, false);
  }
  assert.equal(openCalls.length, 1);
});

test('proxy bridge permits HTTPS GET and HEAD only', async () => {
  const { bridge, openCalls } = await loadBridge();
  const { ref, responses } = makeWebViewHarness();
  await registerIOSCapability(bridge, ref);

  await openMedia(bridge, ref, trustedContext(), { method: 'HEAD' });
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0][1], 'HEAD');

  await openMedia(bridge, ref, trustedContext(), { method: 'POST' });
  assert.equal(responses.at(-1)?.success, false);
  await openMedia(bridge, ref, trustedContext(), {
    url: 'http://cdn.example/movie/master.m3u8',
  });
  assert.equal(responses.at(-1)?.success, false);
  assert.equal(openCalls.length, 1);
});
