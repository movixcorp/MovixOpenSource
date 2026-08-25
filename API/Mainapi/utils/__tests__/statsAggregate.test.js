const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dayKeyUTC, rangeDayKeys, zeroFillSeries, bucketIsoByDay } = require('../statsAggregate');

test('dayKeyUTC: formats epoch ms to UTC YYYY-MM-DD', () => {
  assert.equal(dayKeyUTC(Date.parse('2026-05-31T23:30:00Z')), '2026-05-31');
});

test('rangeDayKeys: returns N ordered UTC days ending today', () => {
  const keys = rangeDayKeys(3, Date.parse('2026-05-31T12:00:00Z'));
  assert.deepEqual(keys, ['2026-05-29', '2026-05-30', '2026-05-31']);
});

test('zeroFillSeries: fills missing days with 0 and coerces string counts', () => {
  const rows = [{ date: '2026-05-31', count: '4' }]; // count as string (mysql BIGINT)
  const out = zeroFillSeries(rows, 3, Date.parse('2026-05-31T12:00:00Z'));
  assert.deepEqual(out, [
    { date: '2026-05-29', count: 0 },
    { date: '2026-05-30', count: 0 },
    { date: '2026-05-31', count: 4 },
  ]);
});

test('zeroFillSeries: drops dates outside the range', () => {
  const rows = [{ date: '2020-01-01', count: 9 }];
  const out = zeroFillSeries(rows, 2, Date.parse('2026-05-31T12:00:00Z'));
  assert.equal(out.reduce((a, b) => a + b.count, 0), 0);
});

test('bucketIsoByDay: counts ISO timestamps per UTC day, ignoring invalid', () => {
  const out = bucketIsoByDay([
    '2026-05-30T01:00:00Z', '2026-05-30T22:00:00Z', '2026-05-31T05:00:00Z', 'not-a-date',
  ]);
  const map = Object.fromEntries(out.map((r) => [r.date, r.count]));
  assert.equal(map['2026-05-30'], 2);
  assert.equal(map['2026-05-31'], 1);
});
