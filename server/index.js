import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSocialPreviewResponse } from '../functions/_lib/socialPreview.js';
import { registerGracefulShutdown } from './gracefulShutdown.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const INDEX_HTML = join(DIST, 'index.html');

if (!existsSync(DIST)) {
  console.error(`[server] dist/ introuvable (${DIST}). Lance "npm run build" avant "npm start".`);
  process.exit(1);
}

const app = new Hono();

// Médias et polices servis depuis public/ : leur nom ne porte pas de hash, on
// ne peut donc pas les déclarer immuables — mais ils ne changent quasiment
// jamais. Le `no-cache` qui s'appliquait à eux était le pire des cas : le
// serveur statique n'émet ni ETag ni Last-Modified, donc le navigateur n'avait
// aucun moyen de revalider et retéléchargeait le fichier *en entier* à chaque
// page. Le logo seul pèse près de 800 Ko, et sert de favicon partout.
const MEDIA_ASSET_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|m4v|mp3|wasm)$/i;

// Fichiers de pilotage : ils doivent pouvoir changer sans délai, sinon un
// déploiement met des heures à atteindre les clients.
const ALWAYS_REVALIDATE = new Set([
  '/sw.js',
  '/manifest.json',
  '/robots.txt',
  '/sitemap.xml',
  '/index.html',
  '/_redirects',
  '/_routes.json',
]);

app.use('/*', async (c, next) => {
  await next();
  if (c.res.headers.has('cache-control')) return;
  const path = new URL(c.req.url).pathname;
  const isOk = c.res.status === 200;

  if (path.startsWith('/assets/') && isOk) {
    // Nom hashé par Vite : le contenu ne changera jamais sous cette URL.
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (isOk && MEDIA_ASSET_RE.test(path) && !ALWAYS_REVALIDATE.has(path)) {
    // Une journée de cache ferme, puis une semaine où la version en cache est
    // servie immédiatement pendant que le navigateur va chercher la nouvelle.
    c.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  } else {
    c.header('Cache-Control', 'no-cache, must-revalidate');
  }
});

app.get('/health', (c) => c.json({ ok: true, runtime: 'node', app: 'movix-hono' }));

const toCloudflareCtx = (c) => ({
  request: new Request(c.req.url, { method: c.req.method, headers: c.req.raw.headers }),
  env: process.env,
  next: async () => {
    const html = await readFile(INDEX_HTML, 'utf8');
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
});

const socialPreviewHandler = async (c) => {
  const res = await buildSocialPreviewResponse(toCloudflareCtx(c));
  return res;
};

app.get('/movie/:id', socialPreviewHandler);
app.get('/tv/:id', socialPreviewHandler);

app.use('/*', serveStatic({ root: './dist' }));

app.get('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  if (/\.[^/]+$/.test(path)) {
    return c.text('Not Found', 404);
  }
  const html = await readFile(INDEX_HTML, 'utf8');
  return c.html(html);
});

const port = Number(process.env.PORT) || 3001;
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[server] Movix Hono → http://0.0.0.0:${info.port}`);
});

registerGracefulShutdown(server);
