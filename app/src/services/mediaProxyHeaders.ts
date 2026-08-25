// Un vrai Chrome n'émet jamais Sec-Ch-Ua seul : les trois indices client
// partent ensemble, et la version majeure de l'User-Agent correspond à celle
// qu'annonce Sec-Ch-Ua. Nous envoyions Sec-Ch-Ua seul, avec un User-Agent
// tronqué qu'aucun navigateur ne produit — une signature reconnaissable à
// laquelle fsvid répond par son flux leurre. Le relais Python a été aligné de
// la même façon (API/proxiesembed/server.py, FSVID_VIDZY_CLIENT_HINTS) : les
// deux chemins doivent présenter le même client à l'amont.
const PROVIDER_SIGNED_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Fsvid/Vidzy refusent une requête HLS qui n'a pas à la fois un Referer sur un
// de leurs domaines et un en-tête Sec-Ch-Ua : fsvid répond alors par une 302
// vers son flux leurre (s1.fsvid.lol/troll/master.m3u8) et vidzy par une 403.
const PROVIDER_SEC_CH_UA =
  '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"';
const PROVIDER_SEC_CH_UA_MOBILE = '?0';
const PROVIDER_SEC_CH_UA_PLATFORM = '"Windows"';
const PROVIDER_ACCEPT_LANGUAGE = 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7';

// User-Agent émis par l'extraction LuluStream/Veev/Vidara. Volontairement
// tronqué : c'est celui de l'extracteur et du relais Python, et pour ces trois
// hébergeurs c'est l'identité rejouée qui compte, pas sa vraisemblance.
const PROVIDER_EXTRACTION_USER_AGENT = 'Mozilla/5.0 Chrome/143.0.0.0';

// LuluStream, Veev et Vidara refusent eux aussi une requête média sans Referer
// sur le domaine de leur lecteur, et servent leurs segments depuis des domaines
// frères — Vidara répartit les siens sur « s25-wyl2.s1q2105.com » et consorts.
// Le navigateur reçoit ces en-têtes de l'extension (declarativeNetRequest) et le
// relais Python les pose lui-même (server.py, `_build_target_headers`) : seule
// l'application n'avait rien, d'où trois hébergeurs cassés sur mobile alors
// qu'ils fonctionnent partout ailleurs. Les valeurs reprennent celles du relais.
// Un suffixe commençant par un point ne matche que les sous-domaines, comme la
// RE_VIDARA côté Python : « s1q2105.com » n'est pas un domaine de Vidara.
const PROVIDER_ORIGINS: ReadonlyArray<readonly [readonly string[], string]> = [
  [
    [
      'lulustream.com', 'luluvdo.com', 'luluvdoo.com', 'luluvid.com', 'lulu.st',
      'streamhihi.com', 'cdn1.site', 'd00ds.site', '732eg54de642sa.sbs',
      // Les manifestes et segments ne sont servis par aucun de ces domaines-là,
      // mais par « <aléatoire>.tnmr.org » — que cette liste ignorait, si bien
      // que la règle sortait sans rien poser et que le manifeste repartait avec
      // l'identité de la WebView au lieu de celle de l'extraction : 403.
      // L'extension ne s'en aperçoit pas, sa règle étant calculée sur le
      // domaine enregistrable de l'URL extraite. Sous-domaines seulement :
      // l'apex tnmr.org n'appartient pas à LuluStream.
      '.tnmr.org',
    ],
    'https://lulustream.com',
  ],
  // Même écart que pour LuluStream : le flux ne vient d'aucun domaine du
  // lecteur mais de « s-<région>-<id>.veevcdn.co », relevé sur un 403 de
  // l'appareil. Sous-domaines seulement, l'apex n'étant pas le leur.
  [
    ['veev.to', 'veev.pro', 'poophq.com', 'doods.to', '.veevcdn.co'],
    'https://veev.to',
  ],
  // Vidara répartit ses segments sur au moins deux grappes CDN — relevées dans
  // les journaux de l'appareil : s25-wyl4.97bf1.com et s25-wyl7.s1q2105.com.
  [
    ['vidara.to', 'vidara.so', '.s1q2105.com', '.97bf1.com'],
    'https://vidara.to',
  ],
];

function matchesHost(hostname: string, suffix: string): boolean {
  if (suffix.startsWith('.')) return hostname.endsWith(suffix);
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function providerOriginFor(hostname: string): string | null {
  for (const [hosts, origin] of PROVIDER_ORIGINS) {
    if (hosts.some(suffix => matchesHost(hostname, suffix))) return origin;
  }
  return null;
}

const CLIENT_HINT_HEADERS = [
  'Sec-Ch-Ua',
  'Sec-Ch-Ua-Mobile',
  'Sec-Ch-Ua-Platform',
] as const;

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lowered = name.toLowerCase();
  return Object.keys(headers).some(existing => existing.toLowerCase() === lowered);
}

function getHeader(
  headers: Record<string, string>,
  name: string,
): string | null {
  const lowered = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lowered) return headers[existing];
  }
  return null;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) {
      delete headers[existing];
    }
  }
}

function setCanonicalHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  deleteHeader(headers, name);
  headers[name] = value;
}

/**
 * Hôte d'une URL absolue, sans passer par `URL`.
 *
 * Le `URL` de React Native est un bouchon : `hostname`, `host`, `origin`,
 * `protocol` et les autres accesseurs lèvent « not implemented »
 * (react-native/Libraries/Blob/URL.js), et rien ici n'installe de polyfill.
 * `new URL(url).hostname` jetait donc à chaque appel, toute la fonction
 * ci-dessous sortait par son `catch` et pas un en-tête n'était posé — sur
 * aucun hébergeur. Aucun test ne pouvait le voir : Node a un vrai `URL`.
 *
 * D'où cet analyseur, volontairement strict — il rend `null` sur tout ce qu'il
 * ne sait pas lire, et l'appelant s'abstient alors plutôt que de deviner.
 */
export function hostnameOf(url: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url.trim());
  if (!match) return null;
  const authority = match[1];
  // Un `user:pass@` ferait passer le vrai hôte pour un chemin à la lecture.
  const credentialsEnd = authority.lastIndexOf('@');
  const hostPort = credentialsEnd >= 0
    ? authority.slice(credentialsEnd + 1)
    : authority;
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    return end < 0 ? null : hostPort.slice(0, end + 1).toLowerCase();
  }
  const portStart = hostPort.indexOf(':');
  const host = portStart >= 0 ? hostPort.slice(0, portStart) : hostPort;
  if (!host) return null;
  // « lulustream.com. » et « lulustream.com » désignent le même hôte.
  return host.toLowerCase().replace(/\.+$/, '');
}

export function applyMediaProxyHeaderRules(
  url: string,
  input: Record<string, string>,
): Record<string, string> {
  const headers = { ...input };
  const hostname = hostnameOf(url);
  if (!hostname) {
    return headers;
  }

  const isFsvidHost = hostname === 'fsvid.lol' || hostname.endsWith('.fsvid.lol');
  const isVidzyHost =
    hostname === 'vidzy.org'
    || hostname.endsWith('.vidzy.org')
    || hostname === 'vidzy.cc'
    || hostname.endsWith('.vidzy.cc');
  const providerOrigin = providerOriginFor(hostname);
  if (!isFsvidHost && !isVidzyHost && !providerOrigin) {
    return headers;
  }

  if (isFsvidHost) {
    const origin = hostname === 'fsvid.lol'
      ? 'https://fs13.lol'
      : 'https://fsvid.lol';
    setCanonicalHeader(headers, 'Origin', origin);
    setCanonicalHeader(headers, 'Referer', `${origin}/`);
  } else if (isVidzyHost) {
    // Le CDN Vidzy renvoie 403 sans Referer sur un de ses domaines.
    if (!hasHeader(headers, 'Referer')) {
      setCanonicalHeader(headers, 'Referer', 'https://vidzy.org/');
    }
  } else if (providerOrigin) {
    setCanonicalHeader(headers, 'Origin', providerOrigin);
    setCanonicalHeader(headers, 'Referer', `${providerOrigin}/`);
  }
  // LuluStream, Veev et Vidara lient le jeton de leur manifeste à l'identité du
  // client qui l'a obtenu — mesuré sur le web : deux requêtes identiques à un
  // Accept-Language près donnent 200 et 403. La lecture doit donc rejouer
  // exactement l'identité de l'extraction, qui émet ce User-Agent-ci pour les
  // trois (extractors.js, `extractLuluStream`/`extractVeev`/`extractVidara`) —
  // c'est aussi celui du relais Python sur /lulustream-proxy, le chemin dont on
  // sait qu'il passe. Surtout pas le déguisement Chrome-desktop de Fsvid/Vidzy,
  // ni l'User-Agent de la WebView : ni l'un ni l'autre n'a obtenu le jeton.
  //
  // Les indices client, eux, sont relayés tels quels : le pont les pose à
  // l'identique sur l'extraction et sur la lecture (bridge-runtime.ts), donc
  // les deux requêtes présentent déjà les mêmes.
  if (providerOrigin) {
    setCanonicalHeader(headers, 'User-Agent', PROVIDER_EXTRACTION_USER_AGENT);
    setCanonicalHeader(headers, 'Accept-Language', PROVIDER_ACCEPT_LANGUAGE);
    for (const hint of CLIENT_HINT_HEADERS) {
      const value = getHeader(headers, hint);
      if (value) setCanonicalHeader(headers, hint, value);
      else deleteHeader(headers, hint);
    }
  } else {
    // Fsvid/Vidzy exigent au contraire ce Chrome desktop cohérent, aligné sur le
    // relais Python. Un navigateur envoie toujours un Accept-Language ;
    // l'omettre est une anomalie de plus, pas une précaution. Une version de ce
    // fichier l'effaçait pour LuluStream, sur la foi d'une mesure faite en curl
    // — or ces hébergeurs classent leurs clients, et le même essai depuis un
    // vrai Chromium donne l'inverse : en-tête présent, lecture 200 ; en-tête
    // vide, refus.
    setCanonicalHeader(headers, 'Accept-Language', PROVIDER_ACCEPT_LANGUAGE);
    setCanonicalHeader(headers, 'Sec-Ch-Ua', PROVIDER_SEC_CH_UA);
    setCanonicalHeader(headers, 'Sec-Ch-Ua-Mobile', PROVIDER_SEC_CH_UA_MOBILE);
    setCanonicalHeader(headers, 'Sec-Ch-Ua-Platform', PROVIDER_SEC_CH_UA_PLATFORM);
    setCanonicalHeader(headers, 'User-Agent', PROVIDER_SIGNED_USER_AGENT);
  }
  setCanonicalHeader(headers, 'Sec-Fetch-Site', 'cross-site');
  setCanonicalHeader(headers, 'Sec-Fetch-Mode', 'cors');
  setCanonicalHeader(headers, 'Sec-Fetch-Dest', 'empty');
  return headers;
}
