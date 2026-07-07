# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 25565

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD node -e "require('net').createConnection({port:25565},()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
