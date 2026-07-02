#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Stopping Clipboard Relay..."
docker compose down

read -p "Limpar dados (tasks + arquivos)? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf ./data/files/*
    rm -f ./data/tasks.json
    echo "Dados limpos."
fi

echo "Clipboard Relay parado."
