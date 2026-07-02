#!/bin/bash
# Liga o projeto localmente: sobe o Docker (se não estiver no ar) e ativa o ngrok.
# Uso: ./run.sh   (ou via alias `relay`)
#
# A URL fixa do ngrok vem de NGROK_DOMAIN no .env (ex.: NGROK_DOMAIN=play.ngrok.dev).
# Sem ela, o ngrok abre com URL aleatória. O bridge sobe sozinho via launchd.
set -e
cd "$(dirname "$0")"

PORT=3999
NGROK_DOMAIN="$(grep -E '^NGROK_DOMAIN=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")"

# 1. Docker: sobe só se o serviço clipboard não estiver rodando.
if docker compose ps --format '{{.Service}}={{.State}}' 2>/dev/null | grep -q '^clipboard=running$'; then
  echo "✓ Docker já está rodando."
else
  echo "↑ Subindo Docker..."
  docker compose up -d
fi

# Espera o app responder.
printf "Aguardando o app em :%s" "$PORT"
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/e2ee-salt"; then printf " ✓\n"; break; fi
  printf "."; sleep 1
done

# 2. ngrok: não abre um segundo túnel se já houver um.
if curl -s -m 2 http://127.0.0.1:4040/api/tunnels >/dev/null 2>&1; then
  echo "✓ ngrok já está rodando (painel: http://127.0.0.1:4040)."
  exit 0
fi

echo "↑ Ativando ngrok (Ctrl+C para parar)..."
if [ -n "$NGROK_DOMAIN" ]; then
  exec ngrok http --url="https://$NGROK_DOMAIN" "$PORT"
else
  exec ngrok http "$PORT"
fi
