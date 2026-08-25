import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('ranks exact title, prefix and description matches in that order', async () => {
  const modulePath = '../src/utils/settingsSearch.ts';
  let searchModule: typeof import('../src/utils/settingsSearch.ts') | null = null;
  try {
    searchModule = await import(modulePath);
  } catch {
    // Intentional RED phase while the helper is absent.
  }
  assert.ok(searchModule, 'settings search helper must exist');

  const items = [
    { id: 'subtitle-color', sectionId: 'subtitles', sectionTitle: 'Sous-titres', title: 'Couleur du texte', description: 'Jaune et cyan', keywords: [] },
    { id: 'subtitle-size', sectionId: 'subtitles', sectionTitle: 'Sous-titres', title: 'Taille du texte', description: 'Choisir la couleur du texte sans changer la taille', keywords: [] },
    { id: 'appearance', sectionId: 'appearance', sectionTitle: 'Apparence', title: 'Couleur du texte animée', description: '', keywords: [] },
  ];

  assert.deepEqual(searchModule.rankSettingsSearch('couleur du texte', items).map((item) => item.id), [
    'subtitle-color', 'appearance', 'subtitle-size',
  ]);
});

test('search is accent-insensitive and returns no entries for blank queries', async () => {
  const { rankSettingsSearch } = await import('../src/utils/settingsSearch.ts');
  const items = [{ id: 'height', sectionId: 'subtitles', sectionTitle: 'Sous-titres', title: 'Hauteur', description: 'Téléphone en paysage', keywords: ['position'] }];
  assert.equal(rankSettingsSearch('telephone', items)[0].id, 'height');
  assert.deepEqual(rankSettingsSearch('   ', items), []);
});

test('search-bar contract guards stale targets and exposes valid combobox metadata', async () => {
  const source = await readFile(
    new URL('../src/components/Settings/SettingsSearchBar.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /!target\.isConnected\s*\|\|\s*!root\.contains\(target\)/);
  assert.match(source, /titleElement\.dataset\.settingsSearchId\s*=\s*id/);
  assert.match(source, /aria-label=\{t\('settings\.search\.placeholder'\)\}/);
  assert.match(source, /setActiveIndex\(\(index\)\s*=>\s*results\.length\s*\?\s*Math\.min\(index, results\.length - 1\)\s*:\s*0\)/);
  assert.match(source, /data-settings-search-icon/);
  assert.match(source, /bg-white\/\[0\.06\][^']*text-white/);
});

test('search results use the main card layout without match badges', async () => {
  const source = await readFile(
    new URL('../src/components/Settings/SettingsSearchBar.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /section\.id === 'sessions'/);
  assert.match(source, /settings\.searchResults/);
  assert.match(source, /sm:grid-cols-2/);
  assert.match(source, /item\.description/);
  assert.doesNotMatch(source, /searchMatchTitle|searchMatchDescription|matchKind/);
  assert.doesNotMatch(source, /rankSettingsSearch\(query, items\)\.slice/);
});
