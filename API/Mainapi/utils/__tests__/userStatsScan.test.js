const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { aggregateUserFiles } = require('../userStatsScan');

let dir;

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'movix-users-'));
  await fsp.writeFile(path.join(dir, 'bip39-aaa.json'), JSON.stringify({
    auth: JSON.stringify({ userProfile: { provider: 'bip39', createdAt: '2026-05-30T10:00:00Z' } }),
    bip39_auth: 'true',
  }));
  await fsp.writeFile(path.join(dir, 'g123.json'), JSON.stringify({
    auth: JSON.stringify({ userProfile: { provider: 'google', createdAt: '2026-05-31T08:00:00Z' } }),
    oauth_provider: 'google',
  }));
  await fsp.writeFile(path.join(dir, 'd456.json'), JSON.stringify({
    auth: JSON.stringify({ userProfile: { provider: 'discord', createdAt: '2026-05-31T20:00:00Z' } }),
    oauth_provider: 'discord',
  }));
  // non-user file (different shape) -> skipped
  await fsp.writeFile(path.join(dir, 'cinepulse_accounts.json'), JSON.stringify({ accounts: [] }));
  // malformed JSON -> skipped, must not throw
  await fsp.writeFile(path.join(dir, 'broken.json'), '{ not valid json');
  // subdirectory -> ignored
  await fsp.mkdir(path.join(dir, 'profiles'));
});

after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

test('aggregateUserFiles: counts only valid user files', async () => {
  const agg = await aggregateUserFiles(dir);
  assert.equal(agg.total, 3);
});

test('aggregateUserFiles: splits totals by provider', async () => {
  const agg = await aggregateUserFiles(dir);
  assert.equal(agg.byProvider.bip39, 1);
  assert.equal(agg.byProvider.google, 1);
  assert.equal(agg.byProvider.discord, 1);
});

test('aggregateUserFiles: buckets registrations by UTC day', async () => {
  const agg = await aggregateUserFiles(dir);
  const map = Object.fromEntries(agg.registrationsByDate.map((r) => [r.date, r.count]));
  assert.equal(map['2026-05-30'], 1);
  assert.equal(map['2026-05-31'], 2);
});

test('aggregateUserFiles: missing dir returns empty aggregate', async () => {
  const agg = await aggregateUserFiles(path.join(dir, 'does-not-exist'));
  assert.deepEqual(agg, { total: 0, byProvider: {}, registrationsByDate: [] });
});
