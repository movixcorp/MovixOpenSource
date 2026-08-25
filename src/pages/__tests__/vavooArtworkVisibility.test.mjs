import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const liveTvPath = new URL('../LiveTV.tsx', import.meta.url);

test('les cartes VAVOO affichent le poster enrichi quand il est disponible', async () => {
  const source = await readFile(liveTvPath, 'utf8');
  const noImageExpression = source.match(/const isNoImage = ([^;]+);/)?.[1];

  assert.ok(noImageExpression, 'la politique d’affichage des posters doit rester explicite');
  assert.doesNotMatch(
    noImageExpression,
    /isVavoo/,
    'VAVOO ne doit pas être forcé en carte sans image',
  );
  assert.match(source, /<img src=\{channel\.poster\}/);
});
