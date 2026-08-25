# AGENTS.md - Movix

## Overview

Movix is a French streaming platform monorepo: React 18 + TypeScript frontend (Vite), Node.js/Express + Python backends, browser extensions, Rust WASM sync engine, and Cloudflare Workers.

## Setup

```bash
npm install
```

Backend services have separate dependencies:
- `cd API/Mainapi && npm install`
- `cd API/proxiesembed && pip install -r requirements.txt`

## Commands

```bash
npm run dev              # Vite dev server (localhost:3000)
npm run build            # Production build -> dist/
npm run lint             # ESLint
npm run preview          # Preview build
```

WASM (requires Rust):
```bash
npm run wasm:watchparty-sync:setup
npm run wasm:watchparty-sync:build
```

Backend (run individually):
```bash
node API/Mainapi/server.js          # Port 25565
node API/watchpartyAPI/watchparty.js # Port 25566
python API/proxiesembed/server.py    # Port 25569
```

## Repository Structure

```
src/                        # React frontend
  pages/                    # 58 page components
  components/               # 118+ components
    ui/                     # Primitives (shadcn/ui + Radix)
    *Player.tsx             # Video players (HLS, VideoJS, LiveTV, etc.)
    skeletons/              # Loading placeholders
  context/                  # 12 React Context providers
  hooks/                    # Custom hooks
  services/                 # Axios API services
  utils/                    # Business logic, helpers
    sources/providers/      # Media source providers
  config/                   # Runtime config, Firebase
  workers/                  # Web Workers
  i18n/locales/             # FR/EN translations
  types/                    # TypeScript definitions
  data/                     # Static data
  lib/                      # Utility (cn helper)
API/
  Mainapi/                  # Express API (Node.js)
    routes/                 # 24 route modules
    middleware/             # Auth, CORS, security, rate limiting
    utils/                  # Cache, proxy, concurrency
    config/                # Redis
  watchpartyAPI/            # Socket.IO WatchParty
  proxiesembed/             # Python aiohttp proxy + DRM
    drmproxy/services/      # 30+ hoster extractors
extension/
  Chrome/                   # Manifest V3
  Firefox/                  # Manifest V2
userscript/                 # Tampermonkey
wasm/watchparty-sync/       # Rust -> WASM sync engine
PreMid/                     # Discord Rich Presence
cloudflareproxy/            # Cloudflare Worker
functions/                  # Serverless edge handlers
public/                     # Static assets, SW, WASM output
```

## Code Style

### General
- ES modules everywhere (`"type": "module"`, use `import`/`export`)
- French is the primary language (UI strings, comments, route names)
- No test suite - validate with `npm run lint` and `npm run build`
- Large files exist (HLSPlayer 433KB, WatchTv 285KB, Profile 215KB) - read specific sections

### Frontend (src/)
- **Components**: PascalCase files and exports, functional only (no classes)
- **Hooks**: `use` prefix, camelCase (`useWatchParty.ts`)
- **Utils/Services**: camelCase (`extractM3u8.ts`, `commentService.ts`)
- **Constants**: SCREAMING_SNAKE_CASE
- **Imports**: use `@/` alias (maps to `src/`)
- **Styling**: Tailwind utility classes only, no CSS-in-JS
- **State**: React Context API (no Redux/Zustand)
- **UI primitives**: `src/components/ui/` follows shadcn/ui patterns with Radix
- **i18n**: all user-facing strings through `t()` from `useTranslation()`, keep `fr.json` and `en.json` in sync
- **API calls**: use service modules in `src/services/`, never raw Axios in components
- **Types**: define in `src/types/`, TypeScript strict mode enabled

### Backend - Main API (API/Mainapi/)
- Route modules export `configure(dependencies)` function receiving `{ pool, redis, io, ... }`
- MySQL via connection pool (`mysqlPool.js`) - always use parameterized queries
- Redis for caching and rate limiting
- Middleware stack: CORS -> Helmet -> Rate Limit -> Auth -> Routes
- JWT auth via `middleware/auth.js`

### Backend - Python (API/proxiesembed/)
- Async/await with aiohttp (proxiesembed)
- Each hoster extractor is a standalone module in `drmproxy/services/`
- SOCKS5 proxy pool support, memory cache with TTL

### Extensions (extension/)
- Chrome = Manifest V3 (declarativeNetRequest, service worker)
- Firefox = Manifest V2 (webRequest, background page)
- Changes must be applied to both variants
- Core logic shared: `background.js`, `content.js`, `injected.js`, `extractors.js`

## Architecture

### Service Communication
```
Frontend (3000) ──> Main API (25565)       [REST + Socket.IO]
                ──> WatchParty API (25566)  [Socket.IO /watchparty]
                ──> Proxies Embed (25569)   [HTTP proxy/DRM]
                ──> Cloudflare Workers      [CORS relay]
Main API        ──> MySQL, Redis, TMDB, 30+ scraping sources
```

### Auth
BIP39 seed phrase or OAuth (Discord/Google) -> JWT -> localStorage. Axios 401 interceptor triggers global logout.

### WatchParty
Socket.IO rooms (host/viewers) + Rust WASM sync engine (clock calibration, drift correction) bridged via Web Worker.

### Video Playback
Multiple player implementations: HLS.js (primary), Video.js, Shaka Player, Dash.js, Mpegts.js. Player choice depends on source format.

### Deployment
Frontend on Cloudflare Pages (`CF_PAGES_COMMIT_SHA` for build ID). PWA with Workbox service worker.

## Environment Variables

Frontend: `.env` with `VITE_*` prefix (see `.env.example`)
Backend: separate `.env` per service (see `API/*/. env.example`)

Key frontend vars: `VITE_MAIN_API`, `VITE_TMDB_API_KEY`, `VITE_SITE_URL`, `VITE_WATCHPARTY_API`, `VITE_PROXIES_EMBED_API`, `VITE_TURNSTILE_SITE_KEY`

## Security Rules

- Always use parameterized SQL queries (never string concatenation)
- JWT authentication required on protected routes
- Rate limiting via Redis on auth endpoints
- Turnstile CAPTCHA for bot prevention
- Helmet + CORS middleware on all backend services
- Never commit `.env` files or secrets
