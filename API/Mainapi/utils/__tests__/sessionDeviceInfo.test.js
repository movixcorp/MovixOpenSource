const test = require('node:test');
const assert = require('node:assert/strict');
const { getSessionDeviceInfo, parseStoredSessionDeviceInfo } = require('../sessionDeviceInfo');

test('detects Edge before its Chromium token', () => {
  const info = getSessionDeviceInfo({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36 Edg/134.0.3124.51',
  });
  assert.deepEqual(info, {
    version: 1,
    browser: 'Microsoft Edge',
    browserVersion: '134.0.3124.51',
    operatingSystem: 'Windows',
    deviceType: 'desktop',
  });
});

test('detects iPadOS desktop-mode Safari as a tablet', () => {
  const info = getSessionDeviceInfo({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
  });
  assert.equal(info.browser, 'Safari');
  assert.equal(info.operatingSystem, 'iPadOS');
  assert.equal(info.deviceType, 'tablet');
});

test('detects Chrome on iOS without calling it Safari', () => {
  const info = getSessionDeviceInfo({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 CriOS/133.0.6943.39 Mobile/15E148 Safari/604.1',
  });
  assert.equal(info.browser, 'Google Chrome');
  assert.equal(info.operatingSystem, 'iOS');
  assert.equal(info.deviceType, 'mobile');
});

test('uses Client Hints for reduced Chromium user agents', () => {
  const info = getSessionDeviceInfo({
    userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Safari/537.36',
    clientHints: {
      'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
      'sec-ch-ua-platform': '"Android"',
      'sec-ch-ua-mobile': '?1',
    },
  });
  assert.equal(info.browser, 'Google Chrome');
  assert.equal(info.browserVersion, '136');
  assert.equal(info.operatingSystem, 'Android');
  assert.equal(info.deviceType, 'mobile');
});

test('rejects legacy encrypted fingerprints and accepts structured metadata', () => {
  assert.equal(parseStoredSessionDeviceInfo('not-json'), null);
  assert.deepEqual(
    parseStoredSessionDeviceInfo(JSON.stringify({
      version: 1,
      browser: 'Firefox',
      browserVersion: '140.0',
      operatingSystem: 'Linux',
      deviceType: 'desktop',
    })),
    {
      version: 1,
      browser: 'Firefox',
      browserVersion: '140.0',
      operatingSystem: 'Linux',
      deviceType: 'desktop',
    },
  );
});
