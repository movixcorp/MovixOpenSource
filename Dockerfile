# syntax=docker/dockerfile:1.7

# ==============================================================
# Stage 1 — Builder : install all deps + Vite production build
# ==============================================================
FROM node:22-alpine AS builder
WORKDIR /app

# 1) Lockfile-only first => layer cached as long as deps don't change
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=movix-npm-builder,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline --no-audit --no-fund

# 2) Build-time env vars (Vite bakes them into the bundle)
#    Inject these from Coolify -> Configuration -> Build Variables
ARG VITE_MAIN_API
ARG VITE_TMDB_API_KEY
ARG VITE_SITE_URL
ARG VITE_WATCHPARTY_API
ARG VITE_PROXIES_EMBED_API
ARG VITE_TURNSTILE_SITE_KEY
ARG VITE_TURNSTILE_INVISIBLE_SITEKEY
ARG VITE_VAPID_PUBLIC_KEY
ARG VITE_SUPPORT_TELEGRAM_URL
ARG VITE_APP_BUILD_ID

ENV VITE_MAIN_API=$VITE_MAIN_API \
    VITE_TMDB_API_KEY=$VITE_TMDB_API_KEY \
    VITE_SITE_URL=$VITE_SITE_URL \
    VITE_WATCHPARTY_API=$VITE_WATCHPARTY_API \
    VITE_PROXIES_EMBED_API=$VITE_PROXIES_EMBED_API \
    VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY \
    VITE_TURNSTILE_INVISIBLE_SITEKEY=$VITE_TURNSTILE_INVISIBLE_SITEKEY \
    VITE_VAPID_PUBLIC_KEY=$VITE_VAPID_PUBLIC_KEY \
    VITE_SUPPORT_TELEGRAM_URL=$VITE_SUPPORT_TELEGRAM_URL \
    VITE_APP_BUILD_ID=$VITE_APP_BUILD_ID

# 3) Source code (.dockerignore strips backends, extensions, mobile, etc.)
COPY . .

# 4) Vite build with persistent transform cache
RUN --mount=type=cache,id=movix-vite,target=/app/node_modules/.cache \
    npm run build:coolify

# ==============================================================
# Stage 2 — Runner : minimal Node image to serve dist/ + Hono SSR
# ==============================================================
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001

# Install only the Hono workspace dependencies required by the runtime.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN --mount=type=cache,id=movix-npm-runner,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --workspace=server --include-workspace-root=false \
    --prefer-offline --no-audit --no-fund

# Built static assets + Hono server + helper imported by server/index.js
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/functions/_lib ./functions/_lib

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=2s --retries=3 \
    CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

USER node

CMD ["node", "server/index.js"]
