#!/bin/bash
# Desliga o que o run.sh ligou: para o ngrok DO RELAY e (opcional) o Docker.
# Uso: ./relay-stop.sh   (ou via alias `relay-stop`)
cd "$(dirname "$0")"

PORT=3999
NGROK_DOMAIN="$(grep -E '^NGROK_DOMAIN=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")"

# 1. ngrok: mata só o túnel do relay (casa pelo domínio, ou pela porta) — não
#    mexe em outros túneis ngrok que você possa ter aberto.
if [ -n "$NGROK_DOMAIN" ]; then PAT="ngrok.*$NGROK_DOMAIN"; else PAT="ngrok http.*$PORT"; fi
if pgrep -f "$PAT" >/dev/null 2>&1; then
  pkill -f "$PAT" && echo "✓ ngrok do relay parado."
else
  echo "• ngrok do relay não estava rodando."
fi

# 2. Docker: pergunta (stop preserva containers/dados; nada é apagado).
read -p "Parar também o Docker do relay? (y/N) " -n 1 -r; echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  docker compose stop
  echo "✓ Docker parado (dados preservados; suba de novo com 'relay')."
else
  echo "• Docker mantido no ar."
fi
