#!/usr/bin/env node
/**
 * Prepare Movix Docker environment:
 * - copies .env.docker.example -> .env.docker
 * - generates service .env files wired for docker-compose networking
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

const force = process.argv.includes('--force');

function writeEnv(path, content) {
  if (existsSync(path) && !force) {
    console.log(`skip (exists): ${path}`);
    return false;
  }
  writeFileSync(path, content, 'utf8');
  console.log(`${existsSync(path) && force ? 'updated' : 'created'}: ${path}`);
  return true;
}

const dockerExample = join(root, '.env.docker.example');
const dockerEnv = join(root, '.env.docker');
if (!existsSync(dockerEnv)) {
  if (!existsSync(dockerExample)) {
    console.error('Missing .env.docker.example');
    process.exit(1);
  }
  copyFileSync(dockerExample, dockerEnv);
  console.log(`created: ${dockerEnv}`);
} else {
  console.log(`skip (exists): ${dockerEnv}`);
}

const shared = readEnvFile(dockerEnv);
const jwtSecret = randomBytes(32).toString('hex');
const tmdbKey = shared.TMDB_API_KEY || '';

const frontendEnv = `# Movix frontend — Docker local
VITE_MAIN_API=http://localhost:25565
VITE_SITE_URL=http://localhost:3000
VITE_TMDB_API_KEY=${tmdbKey}
VITE_WATCHPARTY_API=http://localhost:25566
VITE_PROXY_BASE_URL=http://localhost:25569
VITE_API_PROXY_BASE_URL=http://localhost:25568
VITE_PROXIES_EMBED_API=http://localhost:25569
VITE_RIVESTREAM_PROXIES=
VITE_TURNSTILE_SITE_KEY=
VITE_TURNSTILE_INVISIBLE_SITEKEY=
VITE_SUPPORT_TELEGRAM_URL=https://t.me/movix_site
VITE_DEFAULT_MIRRORS=movix.health
VITE_MIRRORS_CONFIG_URL=https://rentry.co/movix
`;

const mainapiEnv = `# Movix Main API — Docker local
JWT_SECRET=${jwtSecret}
TMDB_API_KEY=${tmdbKey}
OPENROUTER_API_KEY=
UQLOAD_API_KEY=
DB_HOST=mysql
DB_PORT=3306
DB_USER=${shared.MYSQL_USER || 'movix'}
DB_PASSWORD=${shared.MYSQL_PASSWORD || 'movix_dev'}
DB_NAME=${shared.MYSQL_DATABASE || 'movix'}
FRONTEND_BASE_URL=http://localhost:3000
DISCORD_SYNC_ERROR_WEBHOOK_URL=
DISCORD_SCRAPER_WEBHOOK=
SCRAPER_BLOCKED_IPS=
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=${shared.REDIS_PASSWORD || 'movix_redis_dev'}
NUM_WORKERS=1
PROXY_SERVER_URL=http://localhost:25569
CF_PROXY_403_URL=http://localhost:25568
BYPASS403_SERVER_URL=http://localhost:25568
CLOUDFLARE_WORKERS_PROXIES=
PROXYSCRAPE_API_TOKEN=
PROXYSCRAPE_ACCOUNT_ID=
SOCKS5_PROXIES=[]
HTTP_PROXIES=[]
WITV_SOCKS5_PROXY_URL=
DARKIWORLD_BASE_URL=
CINESTREAM_BASE_URL=
HYDRACKER_LIVE_ENABLED=false
DARKIWORLD_SQLITE_DIR=
TURNSTILE_SECRET_KEY=
TURNSTILE_INVISIBLE_SECRETKEY=
VIP_PAYBLIS_ENABLED=false
VIP_PAYGATE_ENABLED=false
BLOCKCYPHER_TOKEN=
FSTREAM_LOGIN_NAME=
FSTREAM_LOGIN_PASSWORD=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:local@movix.local
XTREAM_URL=
XTREAM_USER=
XTREAM_PASS=
`;

const watchpartyEnv = `# Movix WatchParty — Docker local
WATCHPARTY_PORT=25566
WATCHPARTY_CORS_CREDENTIALS=true
WATCHPARTY_REST_CORS_ORIGIN=http://localhost:3000
WATCHPARTY_SOCKET_CORS_ORIGIN=http://localhost:3000
WATCHPARTY_SOCKET_CORS_METHODS=GET,POST
`;

const proxiesembedEnv = `# Movix Proxies Embed — Docker local
DB_HOST=mysql
DB_PORT=3306
DB_USER=${shared.MYSQL_USER || 'movix'}
DB_PASSWORD=${shared.MYSQL_PASSWORD || 'movix_dev'}
DB_NAME=${shared.MYSQL_DATABASE || 'movix'}
PROXY_BASE=http://localhost:25569
PROXIES_SOCKS5_JSON=[]
SIBNET_PROXY_SOCKS5_JSON=
FRANCETV_EMAIL=
FRANCETV_PASSWORD=
DEEPBRID_API_KEY=
REAL_DEBRID_API_KEY=
`;

const miscsEnv = `# Movix bypass403 — Docker local
BYPASS403_SOCKS5_PROXY_URL=
`;

writeEnv(join(root, '.env'), frontendEnv);
writeEnv(join(root, 'API', 'Mainapi', '.env'), mainapiEnv);
writeEnv(join(root, 'API', 'watchpartyAPI', '.env'), watchpartyEnv);
writeEnv(join(root, 'API', 'proxiesembed', '.env'), proxiesembedEnv);
writeEnv(join(root, 'API', 'miscs', '.env'), miscsEnv);

console.log('\nDocker env ready.');
console.log('Tip: re-run with --force to regenerate service .env files.');
console.log('1. Edit .env.docker and set TMDB_API_KEY (then re-run: node scripts/docker-setup.mjs --force)');
console.log('2. docker compose up -d --build');
console.log('3. Open http://localhost:3000\n');
