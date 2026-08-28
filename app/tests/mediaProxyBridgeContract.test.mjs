import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const providerSignedUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
// Fsvid/Vidzy renvoient leur flux leurre (302 vers .../troll/master.m3u8) ou
// une 403 tant que la requête n'a pas un Referer sur un de leurs domaines ET
// un en-tête Sec-Ch-Ua.
const providerSecChUa = '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"';
// Les trois indices client partent ensemble chez un vrai Chrome, avec une
// version majeure identique à celle de l'User-Agent.
const providerClientHints = {
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Ch-Ua': providerSecChUa,
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
};

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
      ...providerClientHints,
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
      ...providerClientHints,
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
      ...providerClientHints,
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
      ...providerClientHints,
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'User-Agent': providerSignedUserAgent,
    },
  );
});

test('media header rules never depend on the URL global', async () => {
  const { applyMediaProxyHeaderRules, hostnameOf } = await importTypeScript(
    'src/services/mediaProxyHeaders.ts',
  );

  // Le `URL` de React Native est un bouchon : ses accesseurs lèvent « not
  // implemented ». Les règles sortaient donc par leur `catch` sur l'appareil,
  // sans poser un seul en-tête, alors que tout passait ici — Node a un vrai
  // `URL`. On reproduit le bouchon pour que ça ne puisse plus se reproduire.
  const realUrl = globalThis.URL;
  globalThis.URL = class BrokenURL {
    constructor() {}
    get hostname() { throw new Error('URL.hostname is not implemented'); }
    get host() { throw new Error('URL.host is not implemented'); }
    get origin() { throw new Error('URL.origin is not implemented'); }
    get protocol() { throw new Error('URL.protocol is not implemented'); }
  };
  try {
    assert.equal(
      applyMediaProxyHeaderRules('https://u14.vidzy.cc/hls/master.m3u8', {})[
        'User-Agent'
      ],
      providerSignedUserAgent,
    );
    assert.equal(
      applyMediaProxyHeaderRules('https://Ny1kZMsN0ytR.tnmr.org/m.m3u8', {})
        .Origin,
      'https://lulustream.com',
    );
  } finally {
    globalThis.URL = realUrl;
  }

  // L'analyseur maison : ce qu'il accepte, et ce qu'il refuse plutôt que de
  // deviner — un `user:pass@` ferait passer le vrai hôte pour un chemin.
  assert.equal(hostnameOf('https://Ny1kZMsN0ytR.TNMR.org/a/b?c=1'), 'ny1kzmsn0ytr.tnmr.org');
  assert.equal(hostnameOf('https://lulustream.com.:443/e/x'), 'lulustream.com');
  assert.equal(hostnameOf('https://user:pass@evil.example/@lulustream.com/x'), 'evil.example');
  assert.equal(hostnameOf('https://[2a06:98c1:3120::6]:443/x'), '[2a06:98c1:3120::6]');
  assert.equal(hostnameOf('/relative/path'), null);
  assert.equal(hostnameOf('https:///no-host'), null);
});

test('LuluStream, Veev and Vidara media requests carry their player origin', async () => {
  const { applyMediaProxyHeaderRules } = await importTypeScript(
    'src/services/mediaProxyHeaders.ts',
  );

  // Ces trois hébergeurs répondent 403 sans Referer sur le domaine de leur
  // lecteur. Les segments partent de domaines frères — Vidara répartit les
  // siens sur *.s1q2105.com — donc la règle doit couvrir toute la grappe.
  const cases = [
    ['https://lulustream.com/e/abcd1234', 'https://lulustream.com'],
    ['https://luluvdo.com/e/abcd1234', 'https://lulustream.com'],
    ['https://streamhihi.com/hls/master.m3u8', 'https://lulustream.com'],
    // Le manifeste LuluStream n'est servi par aucun domaine du lecteur mais par
    // un sous-domaine aléatoire de tnmr.org — relevé sur un 403 de l'appareil.
    ['https://Ny1kZMsN0ytR.tnmr.org/hls2/02/03956/master.m3u8', 'https://lulustream.com'],
    ['https://veev.to/e/abcd1234', 'https://veev.to'],
    ['https://poophq.com/hls/master.m3u8', 'https://veev.to'],
    // Le flux Veev sort de son CDN, pas des domaines du lecteur — relevé sur
    // un 403 de l'appareil, exactement comme tnmr.org pour LuluStream.
    ['https://s-gb-441928.veevcdn.co/FhQBwA89kTN7mmmvgbXQ', 'https://veev.to'],
    ['https://vidara.so/e/abcd1234', 'https://vidara.to'],
    ['https://s25-wyl2.s1q2105.com/hls/seg-1.ts', 'https://vidara.to'],
  ];

  // Ces trois-là lient leur jeton à l'identité du client qui l'a obtenu : la
  // lecture doit rejouer celle de l'extraction, pas le Chrome-desktop de
  // Fsvid/Vidzy. Les indices client ne sont pas fabriqués ici — le pont les
  // pose à l'identique sur l'extraction et sur la lecture.
  const extractionUserAgent = 'Mozilla/5.0 Chrome/143.0.0.0';
  for (const [url, origin] of cases) {
    assert.deepEqual(
      applyMediaProxyHeaderRules(url, {}),
      {
        Origin: origin,
        Referer: `${origin}/`,
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'User-Agent': extractionUserAgent,
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
      },
      `en-têtes attendus pour ${url}`,
    );

    // Un Accept-Language fourni par l'appelant est écrasé, pas relayé : celui
    // de l'appareil (liste de locales du système) n'est pas celui qui a obtenu
    // le jeton, et le CDN répond 403 sur cet écart-là précisément.
    assert.deepEqual(
      applyMediaProxyHeaderRules(url, {
        'accept-language': 'fr-FR,fr;q=0.9,ka-GE;q=0.8,ka;q=0.7',
        'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131.0.0.0',
      }),
      applyMediaProxyHeaderRules(url, {}),
      `identité d'extraction rejouée pour ${url}`,
    );
  }

  const webViewUserAgent =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

  // Les indices client, eux, sont relayés tels quels : le pont les pose à
  // l'identique sur l'extraction et sur la lecture, donc les deux requêtes
  // présentent déjà les mêmes. Aucun indice Chrome-Windows n'est fabriqué
  // par-dessus — un Sec-Ch-Ua Windows sur cet User-Agent-là serait justement
  // l'incohérence que ces CDN sanctionnent.
  assert.deepEqual(
    applyMediaProxyHeaderRules('https://streamhihi.com/hls/master.m3u8', {
      'User-Agent': webViewUserAgent,
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="151", "Android WebView";v="151"',
      'Sec-Ch-Ua-Mobile': '?1',
      'Sec-Ch-Ua-Platform': '"Android"',
    }),
    {
      Origin: 'https://lulustream.com',
      Referer: 'https://lulustream.com/',
      'User-Agent': extractionUserAgent,
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Ch-Ua': '"Chromium";v="151", "Android WebView";v="151"',
      'Sec-Ch-Ua-Mobile': '?1',
      'Sec-Ch-Ua-Platform': '"Android"',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    },
  );

  // Fsvid/Vidzy gardent leur Chrome desktop imposé, identité fournie ou non.
  assert.equal(
    applyMediaProxyHeaderRules('https://u14.vidzy.cc/hls/master.m3u8', {
      'User-Agent': webViewUserAgent,
    })['User-Agent'],
    providerSignedUserAgent,
  );

  // L'apex s1q2105.com n'appartient pas à Vidara : seuls ses sous-domaines
  // servent les segments, comme le dit RE_VIDARA côté relais Python.
  assert.deepEqual(
    applyMediaProxyHeaderRules('https://s1q2105.com/hls/master.m3u8', {
      Referer: 'https://movix.fun/',
    }),
    { Referer: 'https://movix.fun/' },
  );
  // Les apex tnmr.org et veevcdn.co n'appartiennent pas à ces hébergeurs :
  // seuls leurs sous-domaines servent les flux.
  for (const apex of ['https://tnmr.org/hls2/master.m3u8', 'https://veevcdn.co/x']) {
    assert.deepEqual(
      applyMediaProxyHeaderRules(apex, { Referer: 'https://movix.fun/' }),
      { Referer: 'https://movix.fun/' },
      `apex hors règle : ${apex}`,
    );
  }
  // Et un domaine qui se contente de suffixer le nôtre reste hors règle.
  assert.deepEqual(
    applyMediaProxyHeaderRules('https://veev.to.attacker.example/master.m3u8', {
      Referer: 'https://movix.fun/',
    }),
    { Referer: 'https://movix.fun/' },
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
  // Il doit traverser l'allowlist, avec ses deux jumeaux : un vrai Chrome ne
  // les dissocie jamais, et Sec-Ch-Ua seul est une signature reconnaissable.
  assert.match(kotlinPolicy, /"sec-ch-ua"\s+to\s+"Sec-Ch-Ua"/);
  assert.match(kotlinPolicy, /"sec-ch-ua-mobile"\s+to\s+"Sec-Ch-Ua-Mobile"/);
  assert.match(kotlinPolicy, /"sec-ch-ua-platform"\s+to\s+"Sec-Ch-Ua-Platform"/);
  assert.match(swiftPolicy, /"sec-ch-ua":\s*"Sec-Ch-Ua"/);
  assert.match(swiftPolicy, /"sec-ch-ua-mobile":\s*"Sec-Ch-Ua-Mobile"/);
  assert.match(swiftPolicy, /"sec-ch-ua-platform":\s*"Sec-Ch-Ua-Platform"/);

  // La version majeure annoncee par Sec-Ch-Ua doit se retrouver dans un
  // User-Agent complet : « Mozilla/5.0 Chrome/140.0.0.0 » n'existe nulle part.
  assert.match(kotlinPolicy, /Chrome\/140\.0\.0\.0 Safari\/537\.36/);
  assert.match(swiftPolicy, /Chrome\/140\.0\.0\.0 Safari\/537\.36/);

  // ...et surtout etre pose par defaut au niveau de l'upstream : le chemin
  // JS qui l'ajoute n'est pas emprunte par tous les appelants du proxy local.
  for (const upstream of kotlinUpstreams) {
    assert.match(
      upstream,
      /putIfAbsent\(\s*"Sec-Ch-Ua",\s*MediaProxyPolicy\.PLAYBACK_SEC_CH_UA,?\s*\)/,
    );
    assert.match(
      upstream,
      /putIfAbsent\(\s*"Sec-Ch-Ua-Mobile",\s*MediaProxyPolicy\.PLAYBACK_SEC_CH_UA_MOBILE,?\s*\)/,
    );
    assert.match(
      upstream,
      /putIfAbsent\(\s*"Sec-Ch-Ua-Platform",\s*MediaProxyPolicy\.PLAYBACK_SEC_CH_UA_PLATFORM,?\s*\)/,
    );
  }
  assert.match(swiftUpstream, /headers\["Sec-Ch-Ua"\] = MediaProxyPolicy\.playbackSecChUa/);
  assert.match(
    swiftUpstream,
    /headers\["Sec-Ch-Ua-Mobile"\] = MediaProxyPolicy\.playbackSecChUaMobile/,
  );
  assert.match(
    swiftUpstream,
    /headers\["Sec-Ch-Ua-Platform"\] = MediaProxyPolicy\.playbackSecChUaPlatform/,
  );
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

test('the Cast header allow list covers every header the native proxy emits', async () => {
  const [bridge, kotlin, swift] = await Promise.all([
    read('src/services/bridge.ts'),
    read('android/app/src/main/java/com/movix/app/proxy/MediaProxyPolicy.kt'),
    read('ios/Movix/Proxy/MediaProxyPolicy.swift').catch(() => ''),
  ]);

  const allowList = bridge.match(
    /const CAST_HEADER_ALLOW_LIST = new Set\(\[([\s\S]*?)\]\)/,
  );
  assert.ok(allowList, 'CAST_HEADER_ALLOW_LIST introuvable');
  const allowed = new Set(
    [...allowList[1].matchAll(/'([^']+)'/g)].map(match => match[1]),
  );

  const nativeAllowed = kotlin.match(
    /private val allowedRequestHeaders = mapOf\(([\s\S]*?)\n {4}\)/,
  );
  assert.ok(nativeAllowed, 'allowedRequestHeaders introuvable');
  const nativeNames = [...nativeAllowed[1].matchAll(/"([^"]+)" to "/g)]
    .map(match => match[1]);
  assert.ok(nativeNames.length >= 10, 'liste native suspecte');

  // `resolveForCast` rend les en-têtes de la session telle que le natif l'a
  // constituée. Un en-tête émis là-bas mais absent ici fait rendre `null` à
  // `parsePreparedHeaders`, donc échouer tout cast en CAST_LOCAL_SOURCE_INVALID.
  const missing = nativeNames.filter(name => !allowed.has(name));
  assert.deepEqual(missing, [], `en-têtes refusés par le pont Cast : ${missing}`);

  // Le pont est du code React Native partagé : iOS passe par la même liste, donc
  // sa propre liste native doit y tenir aussi.
  if (!swift) return;
  const swiftAllowed = swift.match(
    /static let allowedRequestHeaders: \[String: String\] = \[([\s\S]*?)\n {2}\]/,
  );
  assert.ok(swiftAllowed, 'allowedRequestHeaders Swift introuvable');
  const swiftNames = [...swiftAllowed[1].matchAll(/"([^"]+)": "/g)]
    .map(match => match[1]);
  assert.deepEqual(
    swiftNames,
    nativeNames,
    'les deux proxys natifs doivent émettre les mêmes en-têtes',
  );
});
