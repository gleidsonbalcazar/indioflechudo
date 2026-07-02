#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Stopping indioflechudo..."

read -p "Apagar tambem os dados (volume Postgres 'pg_data')? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    docker compose down -v
    echo "Containers e dados (pg_data) removidos."
else
    docker compose down
    echo "Containers parados; dados preservados no volume pg_data."
fi

echo "indioflechudo parado."
