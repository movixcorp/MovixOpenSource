import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const sourceUrl = new URL('../../src/components/HLSPlayer.tsx', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const ast = ts.createSourceFile(
  sourceUrl.pathname,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function loadPublisherHelpers(window) {
  const names = new Set([
    'isCanonicalMovixNativePlaybackUrl',
    'publishMovixNativeMediaSource',
    'clearMovixNativeMediaSource',
  ]);
  const declarations = [];
  for (const statement of ast.statements) {
    if (
      ts.isFunctionDeclaration(statement)
      && statement.name
      && names.has(statement.name.text)
    ) {
      declarations.push(statement.getFullText(ast));
    }
  }
  assert.equal(declarations.length, names.size, 'publisher helpers must be real HLSPlayer declarations');
  const output = ts.transpileModule(
    `${declarations.join('\n')}\nmodule.exports = { ${[...names].join(', ')} };`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(module,exports){${output}\n})`, { URL, window })(
    module,
    module.exports,
  );
  return module.exports;
}

const loopback = `http://127.0.0.1:49152/p/${'A'.repeat(43)}/${'b'.repeat(43)}/${'_'.repeat(43)}`;

test('HLSPlayer publisher helper calls the injected facade only for canonical loopback media and clears the exact generation', () => {
  const calls = [];
  const generation = 'publisherGeneration_1234';
  const window = {
    __MOVIX_NATIVE_MEDIA_SOURCE_V1__: {
      publish: (...args) => {
        calls.push(['publish', ...args]);
        return generation;
      },
      clear: (...args) => {
        calls.push(['clear', ...args]);
        return true;
      },
    },
  };
  const helpers = loadPublisherHelpers(window);
  const video = { marker: 'main-video' };

  for (const invalid of [
    'https://cdn.example/video.m3u8',
    'blob:https://movix.example/id',
    `${loopback}?query=1`,
    loopback.replace(':49152', ':01'),
    loopback.replace(':49152', ':65536'),
    loopback.replace('/p/', '/p//'),
  ]) {
    assert.equal(helpers.publishMovixNativeMediaSource(video, invalid, 'hls'), null);
  }
  assert.deepEqual(calls, []);

  assert.equal(helpers.publishMovixNativeMediaSource(video, loopback, 'hls'), generation);
  helpers.clearMovixNativeMediaSource(video, generation);
  assert.deepEqual(calls, [
    ['publish', video, loopback, 'hls'],
    ['clear', video, generation],
  ]);
});

test('HLSPlayer publishes immediately before every main MP4/HLS/native assignment and clears captured generations', () => {
  assert.match(
    source,
    /(?:publishNativeMediaSource|publishMovixNativeMediaSource)\(\s*video,\s*normalizedSrc,\s*'mp4',?\s*\);\s*videoRef\.current\.src = normalizedSrc/,
  );
  assert.match(
    source,
    /(?:publishNativeMediaSource|publishMovixNativeMediaSource)\(\s*video,\s*normalizedSrc,\s*'hls',?\s*\);\s*hls\.loadSource\(normalizedSrc\);\s*hls\.attachMedia\(video\)/,
  );
  assert.match(
    source,
    /(?:publishNativeMediaSource|publishMovixNativeMediaSource)\(\s*video,\s*normalizedSrc,\s*'hls',?\s*\);\s*video\.src = normalizedSrc/,
  );
  assert.match(
    source,
    /clearNativeMediaSource\(video, \w+Generation\)/,
  );
  assert.match(
    source,
    /(?:publishNativeMediaSource|publishMovixNativeMediaSource)\(\s*videoRef\.current,\s*normalizedSrc,\s*'hls',?\s*\);\s*hls\.loadSource\(normalizedSrc\);\s*hls\.attachMedia\(videoRef\.current\)/,
  );
  assert.match(
    source,
    /publishNativeMediaSource\(\s*video,\s*airPlayUrl,\s*(?:isMP4Source\(airPlayUrl\) \? 'mp4' : 'hls'|'hls'),?\s*\);\s*video\.src = airPlayUrl/,
  );
});
