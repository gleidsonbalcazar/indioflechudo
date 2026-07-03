#!/bin/bash
# Console REPL (estilo Claude CLI) para operar o repo remoto pelo terminal.
# Reusa a config do bridge (bridge/render.env: RELAY_URL + ACCESS_PASSWORD).
set -e
cd "$(dirname "$0")"

# deps do client (socket.io-client) — instala na primeira vez
[ -d client/node_modules/socket.io-client ] || ( echo "instalando deps do console…"; cd client && npm ci --silent )

# carrega RELAY_URL/ACCESS_PASSWORD (mesma fonte do bridge). Fallback: .env local.
set -a
[ -f bridge/render.env ] && . bridge/render.env
[ -z "${ACCESS_PASSWORD:-}" ] && [ -f .env ] && . .env
set +a

exec node client/console.js --relay "${RELAY_URL:-http://localhost:3998}" --password "$ACCESS_PASSWORD" "$@"
