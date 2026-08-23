import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const nativePlaybackSource = await readFile(
  new URL('../src/services/nativePlayback.ts', import.meta.url),
  'utf8',
);

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

const nativePlaybackOutput = transpile(nativePlaybackSource);

function loadNativePlayback() {
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(require,module,exports){${nativePlaybackOutput}\n})`,
    { URL },
  )(() => { throw new Error('nativePlayback has no dependencies'); }, module, module.exports);
  return module.exports;
}

const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'b'.repeat(43);
const TOKEN_C = '_'.repeat(43);
const VALID_URL = `http://127.0.0.1:49152/p/${TOKEN_A}/${TOKEN_B}/${TOKEN_C}`;
const VALID_HANDOFF_ID = 'handoff_00000001';
const MAX_POSITION_SEC = 366 * 86_400;

function validSource(overrides = {}) {
  return {
    protocolVersion: 1,
    url: VALID_URL,
    positionSec: 42.5,
    paused: false,
    playbackRate: 1,
    muted: false,
    title: 'Episode 1',
    poster: 'https://cdn.example/posters/episode-1.jpg?size=large#hero',
    ...overrides,
  };
}

test('normalizes a bounded canonical native playback source into an explicit object', () => {
  const { normalizePreparedNativePlaybackSource } = loadNativePlayback();
  const inherited = { inheritedSecret: 'must not escape' };
  const input = Object.assign(Object.create(inherited), validSource(), {
    unknownSecret: 'must not escape',
  });

  const normalized = normalizePreparedNativePlaybackSource(input);

  assert.ok(normalized);
  assert.deepEqual(Object.keys(normalized), [
    'protocolVersion',
    'url',
    'positionSec',
    'paused',
    'playbackRate',
    'muted',
    'title',
    'poster',
  ]);
  assert.equal(normalized.url, VALID_URL);
  assert.equal(normalized.positionSec, 42.5);
  assert.equal(Object.hasOwn(normalized, 'unknownSecret'), false);
  assert.equal('inheritedSecret' in normalized, false);
  assert.notEqual(Object.getPrototypeOf(normalized), inherited);
});

test('accepts inclusive numeric boundaries and omitted optional metadata', () => {
  const { normalizePreparedNativePlaybackSource } = loadNativePlayback();
  for (const [positionSec, playbackRate] of [
    [0, 0.25],
    [MAX_POSITION_SEC, 4],
  ]) {
    const source = validSource({ positionSec, playbackRate });
    delete source.title;
    delete source.poster;
    const normalized = normalizePreparedNativePlaybackSource(source);
    assert.ok(normalized);
    assert.equal(normalized.positionSec, positionSec);
    assert.equal(normalized.playbackRate, playbackRate);
    assert.deepEqual(Object.keys(normalized), [
      'protocolVersion',
      'url',
      'positionSec',
      'paused',
      'playbackRate',
      'muted',
    ]);
  }
});

test('rejects every non-canonical or non-MediaProxy loopback URL shape', () => {
  const { normalizePreparedNativePlaybackSource } = loadNativePlayback();
  const validPath = `/p/${TOKEN_A}/${TOKEN_B}/${TOKEN_C}`;
  const invalidUrls = [
    `http://127.0.0.1:0${validPath}`,
    `http://127.0.0.1:01${validPath}`,
    `http://127.0.0.1:65536${validPath}`,
    `http://127.0.0.1:49152/p/${'A'.repeat(42)}/${TOKEN_B}/${TOKEN_C}`,
    `http://127.0.0.1:49152/p/${'A'.repeat(44)}/${TOKEN_B}/${TOKEN_C}`,
    `http://127.0.0.1:49152/p/${'+'.repeat(43)}/${TOKEN_B}/${TOKEN_C}`,
    `http://127.0.0.1:49152/p/${TOKEN_A}/${TOKEN_B}/${TOKEN_C}=`,
    `${VALID_URL}?token=secret`,
    `${VALID_URL}#fragment`,
    `${VALID_URL}/`,
    `http://user:pass@127.0.0.1:49152${validPath}`,
    `http://localhost:49152${validPath}`,
    `https://127.0.0.1:49152${validPath}`,
    `http://127.0.0.1:49152\\p\\${TOKEN_A}\\${TOKEN_B}\\${TOKEN_C}`,
    `${VALID_URL}\n`,
    `\u0000${VALID_URL}`,
    'blob:https://movix.example/source-id',
    'https://cdn.example/video.m3u8',
  ];

  for (const url of invalidUrls) {
    assert.equal(
      normalizePreparedNativePlaybackSource(validSource({ url })),
      null,
      url.replace(/[\u0000-\u001f]/g, '<control>'),
    );
  }
});

test('rejects non-finite, out-of-range, and incorrectly typed playback fields', () => {
  const { normalizePreparedNativePlaybackSource } = loadNativePlayback();
  const invalidOverrides = [
    { protocolVersion: 2 },
    { positionSec: Number.NaN },
    { positionSec: Number.POSITIVE_INFINITY },
    { positionSec: -1 },
    { positionSec: MAX_POSITION_SEC + 0.001 },
    { positionSec: '42' },
    { playbackRate: Number.NaN },
    { playbackRate: Number.NEGATIVE_INFINITY },
    { playbackRate: 0.249 },
    { playbackRate: 4.001 },
    { paused: 0 },
    { muted: 'false' },
  ];

  for (const overrides of invalidOverrides) {
    assert.equal(normalizePreparedNativePlaybackSource(validSource(overrides)), null);
  }
});

test('rejects oversized title and non-canonical, credentialed, controlled, or oversized posters', () => {
  const { normalizePreparedNativePlaybackSource } = loadNativePlayback();
  const invalidOverrides = [
    { title: 'x'.repeat(257) },
    { poster: 'http://cdn.example/poster.jpg' },
    { poster: 'https://user:pass@cdn.example/poster.jpg' },
    { poster: 'HTTPS://cdn.example/poster.jpg' },
    { poster: 'https://cdn.example:443/poster.jpg' },
    { poster: 'https://cdn.example' },
    { poster: 'https://cdn.example\\poster.jpg' },
    { poster: 'https://cdn.example/poster.jpg\n' },
    { poster: `https://cdn.example/${'x'.repeat(16_384)}` },
  ];

  for (const overrides of invalidOverrides) {
    assert.equal(normalizePreparedNativePlaybackSource(validSource(overrides)), null);
  }
});

test('rejects inherited required fields and hostile property access without throwing', () => {
  const { normalizePreparedNativePlaybackSource } = loadNativePlayback();
  assert.equal(normalizePreparedNativePlaybackSource(Object.create(validSource())), null);

  const hostile = validSource();
  Object.defineProperty(hostile, 'url', {
    enumerable: true,
    get() { throw new Error('secret URL'); },
  });
  assert.doesNotThrow(() => normalizePreparedNativePlaybackSource(hostile));
  assert.equal(normalizePreparedNativePlaybackSource(hostile), null);
});

test('accepts only bounded base64url handoff identifiers', () => {
  const { isNativePlaybackHandoffId } = loadNativePlayback();
  for (const id of [
    'A'.repeat(16),
    VALID_HANDOFF_ID,
    `${'z'.repeat(126)}_-`,
  ]) {
    assert.equal(isNativePlaybackHandoffId(id), true);
  }
  for (const id of [
    '',
    'A'.repeat(15),
    'A'.repeat(129),
    'unsafe.id.000000',
    'unsafe/id/000000',
    'unsafe id 000000',
    'unsafe\n00000000',
    123,
  ]) {
    assert.equal(isNativePlaybackHandoffId(id), false);
  }
});
