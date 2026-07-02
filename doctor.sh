#!/bin/bash
# ── indioflechudo · diagnóstico (read-only) ──
# Checklist verde/vermelho de tudo que precisa estar no ar. Não altera nada.
cd "$(dirname "$0")"

ok(){ printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad(){ printf "  \033[31m✗\033[0m %s\n" "$1"; }
warn(){ printf "  \033[33m!\033[0m %s\n" "$1"; }

printf "\n\033[1mindioflechudo — diagnóstico\033[0m\n"

# Docker + containers
if docker info >/dev/null 2>&1; then ok "Docker rodando"; else bad "Docker não está rodando"; fi
state="$(docker compose ps --format '{{.Service}}={{.State}}' 2>/dev/null)"
printf '%s\n' "$state" | grep -q '^app=running$'   && ok "container app up"   || bad "container app não está up  (rode ./up.sh)"
printf '%s\n' "$state" | grep -q '^db=running$'    && ok "container db up"    || bad "container db não está up"
printf '%s\n' "$state" | grep -q '^caddy=running$' && ok "container caddy up" || warn "container caddy não está up"

# Relay + kit da máquina-alvo
if curl -sf -o /dev/null http://127.0.0.1:3998/e2ee-salt; then ok "relay responde (/e2ee-salt)"; else bad "relay não responde em :3998"; fi
if curl -sf -o /dev/null http://127.0.0.1:3998/dl/executor.js; then ok "/dl/executor.js disponível"; else warn "/dl/executor.js indisponível (rebuild: docker compose build)"; fi
if curl -sf -o /dev/null http://127.0.0.1:3998/onboard; then ok "página /onboard no ar"; else warn "/onboard indisponível"; fi

# Config
if [ -f .env ] && grep -q '^ACCESS_PASSWORD=' .env; then ok ".env com ACCESS_PASSWORD"; else bad ".env sem ACCESS_PASSWORD  (rode ./up.sh)"; fi

# Claude + bridge
command -v claude >/dev/null && ok "Claude CLI no PATH" || bad "Claude CLI ausente (bridge precisa dele)"
if pgrep -f "bridge/bridge.js" >/dev/null 2>&1; then ok "bridge rodando"; else warn "bridge não está rodando (./bridge/service/install-launchd.sh)"; fi

printf "\n"
