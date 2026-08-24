import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const providerSignedUserAgent = 'Mozilla/5.0 Chrome/140.0.0.0';
// Fsvid/Vidzy renvoient leur flux leurre (302 vers .../troll/master.m3u8) ou
// une 403 tant que la requête n'a pas un Referer sur un de leurs domaines ET
// un en-tête Sec-Ch-Ua.
const providerSecChUa = '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"';

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

async function importTypeScript(relativePath) {
  const source = await read(relativePath);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

test('TypeScript bridge exposes the GM_OPEN_MEDIA_PROXY native contract', async () => {
  const bridge = await read('src/services/bridge.ts');

  assert.match(bridge, /GM_OPEN_MEDIA_PROXY/);
  assert.match(bridge, /NativeModules\.MediaProxy/);
  assert.match(bridge, /\.open\s*\(\s*req\.url/);
  assert.match(bridge, /case\s+['"]GM_FETCH['"]/);
});

test('Android local proxy injects the required Fsvid headers', async () => {
  const bridge = await read('src/services/bridge.ts');
  const openHandler = bridge.match(
    /async function handleGMOpenMediaProxy[\s\S]*?\r?\n}\r?\n\r?\nasync function fetchWithRedirectHeaders/,
  )?.[0];

  assert.ok(openHandler, 'GM_OPEN_MEDIA_PROXY handler must exist');
  assert.match(bridge, /import\s*\{\s*applyMediaProxyHeaderRules\s*}\s*from\s*['"]\.\/mediaProxyHeaders['"]/);
  assert.match(
    openHandler,
    /mediaProxy\.open\s*\(\s*req\.url,\s*method,\s*applyMediaProxyHeaderRules\s*\(\s*req\.url,\s*headers\s*,?\s*\)\s*,?\s*\)/,
  );
});

test('Fsvid media headers preserve the user agent used to sign playback URLs', async () => {
  const { applyMediaProxyHeaderRules } = await importTypeScript(
    'src/services/mediaProxyHeaders.ts',
  );
  const sampleFsvidUrl =
    'https://s1.fsvid.lol/hls2/01/00028/example/master.m3u8?t=redacted';

  assert.deepEqual(
    applyMediaProxyHeaderRules(sampleFsvidUrl, {
      origin: 'https://wrong.invalid',
      REFERER: 'https://wrong.invalid/',
    }),
    {
      Origin: 'https://fsvid.lol',
      Referer: 'https://fsvid.lol/',
      'Sec-Ch-Ua': providerSecChUa,
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'User-Agent': providerSignedUserAgent,
    },
  );
  assert.deepEqual(
    applyMediaProxyHeaderRules('https://fsvid.lol/embed-example', {}),
    {
      Origin: 'https://fs13.lol',
      Referer: 'https://fs13.lol/',
      'Sec-Ch-Ua': providerSecChUa,
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'User-Agent': providerSignedUserAgent,
    },
  );
  assert.deepEqual(
    applyMediaProxyHeaderRules(
      'https://fsvid.lol.attacker.example/master.m3u8',
      { Referer: 'https://movix.fun/' },
    ),
    { Referer: 'https://movix.fun/' },
  );
});

test('Vidzy playback preserves the user agent used to sign playback URLs', async () => {
  const { applyMediaProxyHeaderRules } = await importTypeScript(
    'src/services/mediaProxyHeaders.ts',
  );

  assert.deepEqual(
    applyMediaProxyHeaderRules('https://u14.vidzy.cc/hls/master.m3u8', {
      Origin: 'https://vidzy.org',
      Referer: 'https://vidzy.org/',
      'sec-fetch-dest': 'video',
      'user-agent': 'okhttp/4.12.0',
    }),
    {
      Origin: 'https://vidzy.org',
      Referer: 'https://vidzy.org/',
      'Sec-Ch-Ua': providerSecChUa,
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'User-Agent': providerSignedUserAgent,
    },
  );

  // Sans Referer, le CDN Vidzy répond 403 : on en pose un par défaut.
  assert.deepEqual(
    applyMediaProxyHeaderRules('https://u14.vidzy.cc/hls/master.m3u8', {}),
    {
      Referer: 'https://vidzy.org/',
      'Sec-Ch-Ua': providerSecChUa,
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'User-Agent': providerSignedUserAgent,
    },
  );
});

test('Android registers the MediaProxy native package', async () => {
  const application = await read(
    'android/app/src/main/java/com/movix/app/MainApplication.kt',
  );
  const packageSource = await read(
    'android/app/src/main/java/com/movix/app/proxy/MediaProxyPackage.kt',
  );
  const moduleSource = await read(
    'android/app/src/main/java/com/movix/app/proxy/MediaProxyModule.kt',
  );

  assert.match(application, /add\(MediaProxyPackage\(\)\)/);
  assert.match(packageSource, /MediaProxyModule\(reactContext\)/);
  assert.match(moduleSource, /override fun getName\(\)\s*=\s*"MediaProxy"/);
  assert.match(moduleSource, /fun open\(/);
  assert.match(moduleSource, /server\.open\(/);
});

test('Android native media proxy adds browser Fetch Metadata for every provider', async () => {
  const policy = await read(
    'android/app/src/main/java/com/movix/app/proxy/MediaProxyPolicy.kt',
  );
  const castUpstream = await read(
    'android/app/src/main/java/com/movix/app/proxy/NetworkBoundMediaProxyUpstream.kt',
  );
  const localUpstream = await read(
    'android/app/src/main/java/com/movix/app/proxy/MediaProxyServer.kt',
  );

  for (const [lowercase, canonical, value] of [
    ['sec-fetch-site', 'Sec-Fetch-Site', 'cross-site'],
    ['sec-fetch-mode', 'Sec-Fetch-Mode', 'cors'],
    ['sec-fetch-dest', 'Sec-Fetch-Dest', 'empty'],
  ]) {
    assert.match(
      policy,
      new RegExp(`"${lowercase}"\\s+to\\s+"${canonical}"`),
    );
    const defaultHeaderPattern = new RegExp(
      `(?:headers|mergedHeaders)\\.putIfAbsent\\("${canonical}",\\s*"${value}"\\)`,
    );
    assert.match(castUpstream, defaultHeaderPattern);
    assert.match(localUpstream, defaultHeaderPattern);
  }
});

test('every native upstream defaults Sec-Ch-Ua, whatever the caller sent', async () => {
  const [kotlinPolicy, swiftPolicy, swiftUpstream, ...kotlinUpstreams] = await Promise.all([
    read('android/app/src/main/java/com/movix/app/proxy/MediaProxyPolicy.kt'),
    read('ios/Movix/Proxy/MediaProxyPolicy.swift').catch(() => ''),
    read('ios/Movix/Proxy/MediaProxyUpstream.swift').catch(() => ''),
    read('android/app/src/main/java/com/movix/app/proxy/MediaProxyServer.kt'),
    read('android/app/src/main/java/com/movix/app/proxy/CronetMediaProxyUpstream.kt'),
    read('android/app/src/main/java/com/movix/app/proxy/NetworkBoundMediaProxyUpstream.kt'),
  ]);

  // Sans cet en-tete, Fsvid repond 302 vers son flux leurre et Vidzy 403.
  // Il doit traverser l'allowlist...
  assert.match(kotlinPolicy, /"sec-ch-ua"\s+to\s+"Sec-Ch-Ua"/);
  assert.match(swiftPolicy, /"sec-ch-ua":\s*"Sec-Ch-Ua"/);

  // ...et surtout etre pose par defaut au niveau de l'upstream : le chemin
  // JS qui l'ajoute n'est pas emprunte par tous les appelants du proxy local.
  for (const upstream of kotlinUpstreams) {
    assert.match(
      upstream,
      /putIfAbsent\("Sec-Ch-Ua",\s*MediaProxyPolicy\.PLAYBACK_SEC_CH_UA\)/,
    );
  }
  assert.match(swiftUpstream, /headers\["Sec-Ch-Ua"\] = MediaProxyPolicy\.playbackSecChUa/);
});

test('both native media proxies reject the same reserved local host names', async () => {
  const [kotlin, swift] = await Promise.all([
    read('android/app/src/main/java/com/movix/app/proxy/MediaProxyPolicy.kt'),
    read('ios/Movix/Proxy/MediaProxyPolicy.swift').catch(() => ''),
  ]);

  // Le chemin Cast LAN ne fait que valider la syntaxe (aucune resolution DNS),
  // donc chaque plateforme doit bloquer les noms reserves elle-meme.
  assert.match(kotlin, /fun isReservedLocalHost\(/);
  assert.match(kotlin, /require\(!isReservedLocalHost\(host\)\)/);
  for (const reserved of [
    'localhost',
    'local',
    'home\\.arpa',
    'internal',
    'localdomain',
  ]) {
    assert.match(kotlin, new RegExp(`"${reserved}"`), reserved);
    if (swift) assert.match(swift, new RegExp(`"${reserved}"`), reserved);
  }
});
