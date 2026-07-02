#!/bin/bash
set -e
cd "$(dirname "$0")"

mkdir -p data/files

echo "Building and starting Clipboard Relay v2..."
docker compose up -d --build

echo ""
echo "Clipboard Relay v2 is running!"
echo "Local (HTTPS via Caddy): https://localhost:8443"
echo "         (HTTP redirect): http://localhost:8080"
echo ""

sleep 2
echo "Password: definida em .env (ACCESS_PASSWORD)."
echo "Se nao definida, o servidor gera uma e mostra no log:"
docker compose logs clipboard 2>&1 | grep -i "password" | tail -1
echo ""
echo "Arquivos no Mac: $(pwd)/data/files/"
echo ""
echo "Para expor via ngrok (app publicado em 127.0.0.1:3999):"
echo "   ngrok http 3999"
