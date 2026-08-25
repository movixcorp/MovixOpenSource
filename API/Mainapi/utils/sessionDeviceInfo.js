/**
 * Normalise les informations d'un navigateur et de son appareil pour les
 * sessions. Les User-Agents modernes sont rÃ©duits et certains navigateurs
 * (Edge, Opera, Chrome iOS) contiennent les tokens Chrome/Safari : l'ordre des
 * tests est donc important. Les Client Hints, quand ils sont envoyÃ©s, servent
 * de source plus fiable pour les nouvelles sessions.
 */

const DEVICE_TYPES = new Set(['desktop', 'mobile', 'tablet', 'tv', 'unknown']);

function headerValue(value) {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function cleanVersion(value) {
  if (!value) return null;
  const match = String(value).match(/\d+(?:\.\d+){0,3}/);
  return match ? match[0] : null;
}

function versionFrom(ua, expression) {
  return cleanVersion(ua.match(expression)?.[1]);
}

function parseClientHintBrands(rawBrands) {
  const brands = [];
  const expression = /"([^"\\]+)"\s*;\s*v="([^"]+)"/g;
  let match;
  while ((match = expression.exec(rawBrands)) !== null) {
    const name = match[1].trim();
    if (!/^Not.*Brand$/i.test(name)) {
      brands.push({ name, version: cleanVersion(match[2]) });
    }
  }
  return brands;
}

function detectBrowser(ua, clientHints) {
  const brands = parseClientHintBrands(clientHints.secChUa);
  const browserFromBrand = (pattern) => {
    const brand = brands.find((entry) => pattern.test(entry.name));
    return brand ? { name: brand.name, version: brand.version } : null;
  };

  // Navigateur spÃ©cifique avant leur moteur partagÃ© Chromium/Safari.
  if (/EdgA\//i.test(ua) || /EdgiOS\//i.test(ua) || /Edg\//i.test(ua)) {
    return { name: 'Microsoft Edge', version: versionFrom(ua, /(?:EdgA|EdgiOS|Edg)\/([^\s]+)/i) };
  }
  const edgeBrand = browserFromBrand(/Microsoft Edge|Edge/i);
  if (edgeBrand) return { name: 'Microsoft Edge', version: edgeBrand.version };

  if (/OPR\//i.test(ua) || /Opera\//i.test(ua)) {
    return { name: 'Opera', version: versionFrom(ua, /(?:OPR|Opera)\/([^\s]+)/i) };
  }
  const operaBrand = browserFromBrand(/Opera/i);
  if (operaBrand) return { name: 'Opera', version: operaBrand.version };

  if (/Brave\//i.test(ua)) {
    return { name: 'Brave', version: versionFrom(ua, /Brave\/([^\s]+)/i) };
  }
  const braveBrand = browserFromBrand(/Brave/i);
  if (braveBrand) return { name: 'Brave', version: braveBrand.version };

  if (/SamsungBrowser\//i.test(ua)) {
    return { name: 'Samsung Internet', version: versionFrom(ua, /SamsungBrowser\/([^\s]+)/i) };
  }
  if (/YaBrowser\//i.test(ua)) {
    return { name: 'Yandex Browser', version: versionFrom(ua, /YaBrowser\/([^\s]+)/i) };
  }
  if (/UCBrowser\//i.test(ua)) {
    return { name: 'UC Browser', version: versionFrom(ua, /UCBrowser\/([^\s]+)/i) };
  }
  if (/FxiOS\//i.test(ua) || /Firefox\//i.test(ua)) {
    return { name: 'Firefox', version: versionFrom(ua, /(?:FxiOS|Firefox)\/([^\s]+)/i) };
  }
  if (/CriOS\//i.test(ua) || /Chrome\//i.test(ua)) {
    return { name: 'Google Chrome', version: versionFrom(ua, /(?:CriOS|Chrome)\/([^\s]+)/i) };
  }
  const chromeBrand = browserFromBrand(/Google Chrome/i);
  if (chromeBrand) return { name: 'Google Chrome', version: chromeBrand.version };

  if (/Chromium\//i.test(ua)) {
    return { name: 'Chromium', version: versionFrom(ua, /Chromium\/([^\s]+)/i) };
  }
  const chromiumBrand = browserFromBrand(/^Chromium$/i);
  if (chromiumBrand) return { name: 'Chromium', version: chromiumBrand.version };

  if (/Electron\//i.test(ua)) {
    return { name: 'Electron', version: versionFrom(ua, /Electron\/([^\s]+)/i) };
  }
  if (/Version\/[^\s]+.*Safari\//i.test(ua) || /Safari\//i.test(ua)) {
    return { name: 'Safari', version: versionFrom(ua, /Version\/([^\s]+)/i) };
  }

  return { name: null, version: null };
}

function detectOperatingSystem(ua, clientHints) {
  const hintedPlatform = clientHints.secChUaPlatform.replace(/["']/g, '').trim();
  if (/android/i.test(hintedPlatform)) return 'Android';
  if (/ios/i.test(hintedPlatform)) return 'iOS';
  if (/macos|mac os/i.test(hintedPlatform)) return 'macOS';
  if (/windows/i.test(hintedPlatform)) return 'Windows';
  if (/chrome os/i.test(hintedPlatform)) return 'ChromeOS';
  if (/linux/i.test(hintedPlatform)) return 'Linux';

  if (/Windows Phone/i.test(ua)) return 'Windows Phone';
  if (/Windows NT/i.test(ua)) return 'Windows';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Macintosh/i.test(ua) && /Mobile\//i.test(ua)) return 'iPadOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return null;
}

function detectDeviceType(ua, clientHints, operatingSystem) {
  const mobileHint = clientHints.secChUaMobile.trim();
  if (/smart-tv|smarttv|hbbtv|appletv|googletv|tv;/i.test(ua)) return 'tv';
  if (/iPad|Tablet|Kindle|Silk\//i.test(ua)) return 'tablet';
  // iPadOS desktop mode exposes Macintosh but keeps the Mobile token.
  if (/Macintosh/i.test(ua) && /Mobile\//i.test(ua)) return 'tablet';
  if (/iPhone|iPod|Windows Phone/i.test(ua)) return 'mobile';
  if (operatingSystem === 'Android') {
    if (mobileHint === '?1' || /\bMobile\b/i.test(ua)) return 'mobile';
    return 'tablet';
  }
  if (mobileHint === '?1') return 'mobile';
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'desktop';
  return 'unknown';
}

function getSessionDeviceInfo({ userAgent, clientHints = {} } = {}) {
  const ua = headerValue(userAgent).slice(0, 4096);
  const hints = {
    secChUa: headerValue(clientHints.secChUa || clientHints['sec-ch-ua']),
    secChUaMobile: headerValue(clientHints.secChUaMobile || clientHints['sec-ch-ua-mobile']),
    secChUaPlatform: headerValue(clientHints.secChUaPlatform || clientHints['sec-ch-ua-platform']),
  };
  const browser = detectBrowser(ua, hints);
  const operatingSystem = detectOperatingSystem(ua, hints);

  return {
    version: 1,
    browser: browser.name,
    browserVersion: browser.version,
    operatingSystem,
    deviceType: detectDeviceType(ua, hints, operatingSystem),
  };
}

function parseStoredSessionDeviceInfo(rawDeviceInfo) {
  if (!rawDeviceInfo) return null;
  try {
    const value = typeof rawDeviceInfo === 'string' ? JSON.parse(rawDeviceInfo) : rawDeviceInfo;
    if (!value || typeof value !== 'object' || value.version !== 1) return null;
    if (value.browser !== null && typeof value.browser !== 'string') return null;
    if (value.browserVersion !== null && typeof value.browserVersion !== 'string') return null;
    if (value.operatingSystem !== null && typeof value.operatingSystem !== 'string') return null;
    if (!DEVICE_TYPES.has(value.deviceType)) return null;
    return {
      version: 1,
      browser: value.browser || null,
      browserVersion: value.browserVersion || null,
      operatingSystem: value.operatingSystem || null,
      deviceType: value.deviceType,
    };
  } catch {
    // Les anciennes sessions contiennent un fingerprint chiffrÃ© : fallback UA.
    return null;
  }
}

module.exports = {
  getSessionDeviceInfo,
  parseStoredSessionDeviceInfo,
};
