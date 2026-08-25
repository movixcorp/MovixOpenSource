# CLAUDE.md - Movix Project Guide

## Model selection — important for agents and subagents

**Don't default to Opus 4.7 for everything.** Opus 4.7 is the most expensive and slowest tier — it should only run on tasks that genuinely need deep reasoning. When you dispatch a subagent (Agent tool) or pick a model for a delegated task, match the model to the work:

| Model | When to pick it |
|---|---|
| **`claude-haiku-4-5`** | Fast/cheap. Use for: mechanical rewrites, file moves, single-file edits where the spec is already clear, formatting, search-and-replace, simple lookups, i18n string additions, log/output filtering, dotfile tweaks. |
| **`claude-sonnet-4-6`** | Balanced default. Use for: most coding tasks (multi-file edits, refactors, new features with a clear spec, bug fixes), code review, exploration agents, writing tests, building React components, wiring contexts/providers. |
| **`claude-opus-4-7`** | Slow + expensive. Reserve for: architecture decisions, novel system design, debugging gnarly cross-layer bugs, writing long specs, security analysis with multiple unknowns, ambiguous user requirements that need real interpretation. |

**Default rule:** if you can describe the task to a junior dev in under 3 sentences and they'd know what to do, use **Sonnet** or **Haiku**. Reach for Opus only when the task itself is "figure out *what* to build", not just "build *this*".

Concretely for Movix:
- Adding a settings toggle, an i18n key, a small CSS rule → **Haiku**
- Implementing a feature with existing patterns (new context, new tool, new route) → **Sonnet**
- Designing the MCP architecture, deciding OAuth scope structure, debugging the sync race → **Opus**

When in doubt, **start with Sonnet** and escalate to Opus only if the model visibly struggles.

## Project Overview

Movix is an open-source French streaming platform monorepo. It includes a React frontend, multiple Node.js/Python backend services, browser extensions, a Rust WASM sync engine, Cloudflare Workers, and a Discord Rich Presence integration.

**License**: CC BY-NC 4.0

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + TypeScript + Vite 5 |
| Styling | Tailwind CSS 3 + Radix UI + Headless UI |
| State | React Context API (12 providers) |
| Routing | React Router DOM 6 (58+ routes) |
| i18n | i18next (FR primary, EN secondary) |
| Video | HLS.js, Video.js, Shaka Player, Dash.js, Mpegts.js |
| Real-time | Socket.IO (client + server) |
| Backend (Main) | Node.js + Express 5 + MySQL + Redis |
| Backend (Proxy) | Python + aiohttp (async) |
| WASM | Rust (watchparty sync engine) |
| Extensions | Chrome (MV3) + Firefox (MV2) + Tampermonkey |
| Edge | Cloudflare Workers |
| Auth | BIP39 seed phrases, Discord OAuth, Google OAuth |
| Payments | BTC/LTC (BlockCypher), PayGate |

## Repository Structure

```
movix-main/
├── src/                    # React frontend (Vite)
│   ├── pages/              # 58 page components
│   ├── components/         # 118+ reusable components
│   │   ├── ui/             # Primitives (button, dialog, select, etc.)
│   │   ├── *Player.tsx     # Video player variants (7)
│   │   └── skeletons/      # Loading placeholders
│   ├── context/            # React Context providers (12)
│   ├── hooks/              # Custom hooks (8)
│   ├── services/           # Axios API services (13)
│   ├── utils/              # Utility functions (24 files)
│   │   └── sources/        # Media source providers
│   ├── config/             # Runtime config, Firebase
│   ├── workers/            # Web Workers (WASM integration)
│   ├── i18n/               # Translations (fr.json, en.json)
│   ├── types/              # TypeScript type definitions
│   ├── data/               # Static data (avatars, countries)
│   ├── lib/                # Library utilities (cn helper)
│   ├── styles/             # Global CSS
│   └── assets/             # Static assets
├── API/
│   ├── Mainapi/            # Primary Express API (port 25565)
│   │   ├── routes/         # 24 route modules
│   │   ├── middleware/     # Auth, CORS, security, rate limiting
│   │   ├── utils/          # Cache, proxy, concurrency helpers
│   │   └── config/         # Redis config
│   ├── watchpartyAPI/      # Socket.IO WatchParty service (port 25566)
│   └── proxiesembed/       # Python aiohttp proxy (port 25569)
│       └── drmproxy/       # DRM/embed extractors (30+ services)
├── extension/
│   ├── Chrome/             # Manifest V3 extension
│   └── Firefox/            # Manifest V2 extension
├── userscript/             # Tampermonkey userscript
├── wasm/
│   └── watchparty-sync/    # Rust sync engine -> WebAssembly
├── PreMid/                 # Discord Rich Presence (TypeScript)
├── cloudflareproxy/        # Cloudflare Worker CORS relay
├── functions/              # Serverless edge handlers
├── others/                 # Misc (bad domains, redirections)
└── public/                 # Static assets, service worker, WASM output
```

## Commands

```bash
# Frontend
npm run dev            # Vite dev server on http://localhost:3000
npm run build          # Production build -> dist/
npm run lint           # ESLint check
npm run preview        # Preview production build

# WASM (requires Rust toolchain)
npm run wasm:watchparty-sync:setup      # Install Rust target + wasm-bindgen
npm run wasm:watchparty-sync:build      # Release build -> public/wasm/
npm run wasm:watchparty-sync:build:dev  # Debug build

# Backend (run separately)
# API/Mainapi: node server.js (cluster mode, port 25565)
# API/watchpartyAPI: node watchparty.js (port 25566)
# API/proxiesembed: python server.py (port 25569)
```

## Environment Variables

Frontend (`.env`):
- `VITE_MAIN_API` - Main API URL
- `VITE_TMDB_API_KEY` - TMDB metadata API key
- `VITE_SITE_URL` - Site base URL
- `VITE_WATCHPARTY_API` - WatchParty Socket.IO URL
- `VITE_PROXIES_EMBED_API` - Python proxy service URL
- `VITE_TURNSTILE_SITE_KEY` / `VITE_TURNSTILE_INVISIBLE_SITEKEY` - Cloudflare Turnstile
- `VITE_SUPPORT_TELEGRAM_URL` - Support link

Backend: see `API/Mainapi/.env.example` (~100 variables) and `API/proxiesembed/.env.example`

## Code Conventions

### Naming
- **Components**: PascalCase files and exports (`MovieDetails.tsx`)
- **Hooks**: `use` prefix, camelCase (`useWatchParty.ts`)
- **Utils/Services**: camelCase (`extractM3u8.ts`, `commentService.ts`)
- **Constants**: SCREAMING_SNAKE_CASE (`COMMENT_LENGTH_LIMITS`)
- **UI primitives**: lowercase (`button.tsx`, `dialog.tsx`) following shadcn/ui pattern

### Frontend Patterns
- Functional components with hooks only (no class components)
- React Context for global state (no Redux/Zustand)
- `src/services/` for all API calls via Axios
- `src/utils/` for business logic and helpers
- `src/components/ui/` for reusable primitives (shadcn/ui style with Radix)
- Tailwind utility-first styling (no CSS-in-JS)
- `@` alias maps to `src/` (configured in vite.config.ts)
- French is the primary language; comments and UI text are often in French
- localStorage sync to backend via `/api/sync` endpoint

### Backend Patterns (Mainapi)
- Express middleware chain: CORS -> Helmet -> Rate Limit -> Auth -> Routes
- Route modules export a `configure(dependencies)` function for DI
- MySQL connection pool (`mysqlPool.js`)
- Redis for caching and rate limiting (`config/redis.js`)
- Cluster mode with graceful shutdown in `server.js`
- Disk-based JSON cache in `cache/` directory

### TypeScript
- Strict mode enabled
- ES2020 target, ESNext modules
- Type definitions in `src/types/`
- No unused variables or parameters (enforced by tsconfig)

### Linting
- ESLint 9 with TypeScript support
- `eslint-plugin-unused-imports` enforced
- React Hooks rules + React Refresh plugin

## Architecture Notes

### Service Communication
```
Browser -> Vite Dev Server (3000) -> React SPA
React SPA -> Main API (25565)      [REST + Socket.IO]
React SPA -> WatchParty API (25566) [Socket.IO /watchparty namespace]
React SPA -> Proxies Embed (25569) [HTTP proxy/DRM]
React SPA -> Cloudflare Workers    [CORS relay]
Main API  -> MySQL, Redis, TMDB, 30+ scraping sources
```

### Authentication Flow
1. User creates account with BIP39 seed phrase (12 words) or OAuth (Discord/Google)
2. JWT issued on login, stored in localStorage
3. Axios 401 interceptor triggers full logout + redirect to `/`
4. Multi-profile system (profiles per account, age restrictions)

### WatchParty Sync
1. Socket.IO room created with host/viewer roles
2. WASM sync engine (Rust) handles clock calibration and drift correction
3. Web Worker bridges WASM and main thread
4. Statuses: calibrating -> adjusting -> perfect | unstable

### Video Playback
Multiple player implementations depending on source type:
- `HLSPlayer.tsx` (433KB) - Primary HLS player with extensive settings
- `VideoJSPlayer.tsx` - Video.js wrapper
- `LiveTVPlayer.tsx` - Live stream player
- Shaka Player, Dash.js, Mpegts.js for specific formats

### Service Worker Fallback Domain

Quand `movix.tax` devient injoignable (blocage FAI), le SW (`public/sw.js`) intercepte les navigations et redirige vers un miroir alive :

1. SW race `fetch(req)` contre timeout 3s
2. Sur échec réseau (TypeError/AbortError) → load mirrors list
3. Mirrors fetch depuis `rentry.co/movix` (HTML rendu, pas `/raw` car rentry impose `SECRET_RAW_ACCESS_CODE`) à chaque appel avec timeout 3s. Fallback sur `DEFAULT_MIRRORS` hardcodé au build via `VITE_DEFAULT_MIRRORS` si fetch échoue. Pas de cache SW — toujours frais, une modif rentry est visible immédiatement. `parseConfig` accepte JSON ou HTML (extrait les `<a href>` dans `<article>`).
4. Redirige vers `https://${nextMirror}/` (racine, pas de path preservation — origine courante exclue)

Complément côté React : `src/services/blockDetection.ts` pose un interceptor axios. Après 3 network errors consécutives + `navigator.onLine === true`, `postMessage` au SW qui répond avec l'URL cible, puis `location.replace`.

Admin : éditer la paste rentry pour ajouter/retirer un miroir. Nouveaux clients voient la liste immédiatement ; clients existants après ≤ 24h (TTL cache SW).

Scope : ne sauve QUE les users ayant déjà visité `movix.tax` au moins une fois avant le blocage (sinon SW pas installé). Les nouveaux utilisateurs passent par Telegram `@movix_site`.

### Deployment
- Frontend: Cloudflare Pages (uses `CF_PAGES_COMMIT_SHA` for build ID)
- Build ID injected as `VITE_APP_BUILD_ID`
- PWA with Workbox service worker for offline support
- `public/_redirects` and `public/_routes.json` for Cloudflare routing

## Key Files (Entry Points)

| File | Purpose |
|------|---------|
| `src/main.tsx` | Frontend entry point |
| `src/App.tsx` | Router, auth sync, global handlers (1600+ lines) |
| `API/Mainapi/server.js` | Backend entry (cluster master) |
| `API/Mainapi/app.js` | Express app setup, route mounting |
| `API/watchpartyAPI/watchparty.js` | WatchParty Socket.IO server |
| `API/proxiesembed/server.py` | Python proxy service |
| `vite.config.ts` | Frontend build config |
| `tailwind.config.js` | Tailwind theme/animations |
| `manifest.json` | PWA manifest |

## Important Notes

- The `next.config.js` at root is legacy/unused - the project uses Vite, not Next.js
- Some files are very large (HLSPlayer.tsx: 433KB, WatchTv.tsx: 285KB, Profile.tsx: 215KB) - read specific line ranges
- Backend services have separate `package.json` and `.env.example` files
- The `functions/` directory contains Cloudflare Functions (edge handlers)
- No test suite exists - manual testing workflow
- ES modules throughout (`"type": "module"` in package.json)
