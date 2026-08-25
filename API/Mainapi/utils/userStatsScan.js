'use strict';
const fsp = require('fs').promises;
const path = require('path');
const { bucketIsoByDay } = require('./statsAggregate');

// data/users lives at API/Mainapi/data/users; this file is at API/Mainapi/utils.
const USERS_DIR = path.join(__dirname, '..', 'data', 'users');
const SKIP_FILES = new Set(['cinepulse_accounts.json']);
const CONCURRENCY = 20;

async function mapLimit(items, limit, fn) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

function detectProvider(data, profile, filename) {
  let provider = data.oauth_provider || (profile && profile.provider);
  if (!provider && (data.bip39_auth || /^bip39-/.test(filename))) provider = 'bip39';
  return provider || 'unknown';
}

async function parseUserFile(dir, filename) {
  try {
    const raw = await fsp.readFile(path.join(dir, filename), 'utf8');
    const data = JSON.parse(raw);
    let profile = null;
    if (typeof data.auth === 'string') {
      try { profile = JSON.parse(data.auth).userProfile || null; } catch { profile = null; }
    } else if (data.auth && typeof data.auth === 'object') {
      profile = data.auth.userProfile || null;
    }
    if (!profile) return null; // not a real user record
    return {
      provider: detectProvider(data, profile, filename),
      createdAt: typeof profile.createdAt === 'string' ? profile.createdAt : null,
    };
  } catch {
    return null;
  }
}

async function aggregateUserFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { total: 0, byProvider: {}, registrationsByDate: [] };
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !SKIP_FILES.has(e.name))
    .map((e) => e.name);

  const parsed = (await mapLimit(files, CONCURRENCY, (name) => parseUserFile(dir, name))).filter(Boolean);

  const byProvider = {};
  const createdAts = [];
  for (const u of parsed) {
    byProvider[u.provider] = (byProvider[u.provider] || 0) + 1;
    if (u.createdAt) createdAts.push(u.createdAt);
  }
  return { total: parsed.length, byProvider, registrationsByDate: bucketIsoByDay(createdAts) };
}

function scanUserStore() {
  return aggregateUserFiles(USERS_DIR);
}

module.exports = { aggregateUserFiles, scanUserStore, USERS_DIR };
