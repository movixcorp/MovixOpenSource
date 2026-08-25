const assert = require('node:assert/strict');
const test = require('node:test');

const { buildConsensus } = require('../consensus');

/** Raccourci de proposition normalisee, telle que la renvoie un fournisseur. */
const candidate = (source, type, start, end, confidence = 0.6, match = null) => ({
  source, type, start, end, confidence, match,
});

test('two agreeing sources beat a single better-ranked outlier', () => {
  const [segment, ...rest] = buildConsensus([
    candidate('skipdb', 'intro', 60, 90, 0.9, 'exact'),
    candidate('introdb', 'intro', 61, 91, 0.5),
    candidate('theintrodb', 'intro', 200, 230, 0.95),
  ]);

  assert.equal(rest.length, 0, 'un seul segment par type');
  assert.deepEqual(segment.sources.sort(), ['introdb', 'skipdb']);
  // Bornes = mediane de la grappe, pas moyenne : une valeur aberrante isolee
  // ne doit pas pouvoir tirer le segment a elle.
  assert.equal(segment.start, 60.5);
  assert.equal(segment.end, 90.5);
  assert.ok(segment.confidence > 0.9, 'la confiance monte avec l\'accord');
});

test('a lone source is kept but gets no agreement bonus', () => {
  const [segment] = buildConsensus([candidate('introdb', 'intro', 10, 40, 0.5)]);

  assert.equal(segment.sourceCount, 1);
  assert.equal(segment.confidence, 0.5);
});

test('overlapping outro and credits collapse to the most confident one', () => {
  // `outro` et `credits` designent la meme sequence selon le fournisseur :
  // les garder tous les deux afficherait deux boutons consecutifs.
  const segments = buildConsensus([
    candidate('skipdb', 'outro', 1300, 1400, 0.8),
    candidate('theintrodb', 'credits', 1305, 1398, 0.6),
  ]);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, 'outro');
});

test('a partial overlap below the merge ratio keeps both segments', () => {
  const segments = buildConsensus([
    candidate('skipdb', 'outro', 1300, 1400, 0.8),
    candidate('theintrodb', 'preview', 1390, 1500, 0.6),
  ]);

  assert.equal(segments.length, 2);
});

test('AniSkip wins ties against SkipDB on anime openings', () => {
  const [segment] = buildConsensus([
    candidate('skipdb', 'intro', 100, 130, 0.9, 'exact'),
    candidate('aniskip', 'intro', 200, 290, 1),
  ]);

  assert.equal(segment.source, 'aniskip');
});

test('clustering is greedy, not transitive', () => {
  // A~B et B~C, mais A et C divergent au-dela de la tolerance : la grappe ne
  // doit pas s'etendre de proche en proche jusqu'a une mediane qui ne
  // correspond a aucune proposition reelle.
  const [segment] = buildConsensus([
    candidate('aniskip', 'intro', 60, 90, 1),
    candidate('skipdb', 'intro', 62, 92, 0.9),
    candidate('introdb', 'intro', 64, 94, 0.9),
  ]);

  assert.ok(segment.start >= 60 && segment.start <= 62, `depart aberrant: ${segment.start}`);
});

test('segments come back in chronological order', () => {
  const segments = buildConsensus([
    candidate('skipdb', 'outro', 1300, 1400, 0.8),
    candidate('skipdb', 'intro', 60, 90, 0.8),
    candidate('skipdb', 'recap', 5, 40, 0.8),
  ]);

  assert.deepEqual(segments.map((segment) => segment.type), ['recap', 'intro', 'outro']);
});
