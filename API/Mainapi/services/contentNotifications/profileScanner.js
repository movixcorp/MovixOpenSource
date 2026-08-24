const fs = require('fs').promises;
const path = require('path');

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

async function listDirectories(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && SAFE_SEGMENT.test(entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listProfileFiles(usersDirectory) {
  const root = path.join(usersDirectory, 'profiles');
  const files = [];

  for (const userType of ['oauth', 'bip39']) {
    const typeDirectory = path.join(root, userType);
    for (const userEntry of await listDirectories(typeDirectory)) {
      const userDirectory = path.join(typeDirectory, userEntry.name);
      const entries = await fs.readdir(userDirectory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const profileId = entry.name.slice(0, -5);
        if (!SAFE_SEGMENT.test(profileId)) continue;
        files.push({
          userType,
          userId: userEntry.name,
          profileId,
          filePath: path.join(userDirectory, entry.name),
        });
      }
    }
  }

  return files;
}

async function readProfiles(usersDirectory, logger = console) {
  const files = await listProfileFiles(usersDirectory);
  const profiles = [];

  for (const profile of files) {
    try {
      const data = JSON.parse(await fs.readFile(profile.filePath, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        profiles.push({ ...profile, data });
      }
    } catch (error) {
      logger.warn(`[ContentNotifications] Profil ignoré ${profile.filePath}: ${error.message}`);
    }
  }

  return profiles;
}

module.exports = { SAFE_SEGMENT, listProfileFiles, readProfiles };
