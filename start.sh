#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Building and starting indioflechudo..."
docker compose up -d --build

echo ""
echo "indioflechudo is running!"
echo "  App  (localhost only):      http://127.0.0.1:3998"
echo "  HTTPS via Caddy:            https://localhost:8444"
echo "  HTTP  (redirect to HTTPS):  http://localhost:8081"
echo ""

sleep 2
echo "Password: definida em .env (ACCESS_PASSWORD)."
echo "Se nao definida, o servidor gera uma e a mostra no log:"
docker compose logs app 2>&1 | grep -i "password" | tail -1
