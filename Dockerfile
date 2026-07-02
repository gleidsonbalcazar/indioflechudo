# ── Stage 1: bundles do conector (máquina-alvo) ──
# executor/relay-ping viram arquivos únicos (esbuild) para rodar no alvo sem npm.
# corp-ping já é zero-dependência: vai cru.
FROM node:20-alpine AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN mkdir -p /dl \
 && npx esbuild src/executor.js   --bundle --platform=node --target=node18 --outfile=/dl/executor.js \
 && npx esbuild src/relay-ping.js --bundle --platform=node --target=node18 --outfile=/dl/relay-ping.js \
 && cp corp-ping.js /dl/corp-ping.js

# ── Stage 2: app (relay) ──
FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/ ./server/
COPY public/ ./public/
# Bundles servidos em /dl pelo relay (kit da máquina-alvo).
COPY --from=client /dl ./dl/
EXPOSE 3000
CMD ["node", "server/index.js"]
