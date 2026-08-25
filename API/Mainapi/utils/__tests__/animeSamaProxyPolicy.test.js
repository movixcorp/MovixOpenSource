const assert = require('node:assert/strict');
const test = require('node:test');

const {
  shouldRotateAnimeSamaResponse,
} = require('../animeSamaProxyPolicy');

test('AnimeSama rotates to another proxy after transient HTTP responses', () => {
  for (const status of [403, 407, 408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(
      shouldRotateAnimeSamaResponse(status, ''),
      true,
      `status ${status} should rotate`,
    );
  }
});

test('AnimeSama keeps definitive client responses instead of rotating', () => {
  for (const status of [400, 401, 404, 410, 422]) {
    assert.equal(
      shouldRotateAnimeSamaResponse(status, ''),
      false,
      `status ${status} should be definitive`,
    );
  }
});
