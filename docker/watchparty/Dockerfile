# syntax=docker/dockerfile:1.7

FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY watchparty.js ./

ENV NODE_ENV=production

EXPOSE 25566

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
    CMD node -e "require('net').createConnection({port:25566},()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "watchparty.js"]
