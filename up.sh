#!/bin/bash
# ── indioflechudo · bootstrap do Mac (1 comando) ──
# Sobe o relay (Docker), prepara o .env com senha, instala deps do host e liga o
# bridge (Claude). Idempotente: pode rodar de novo sem quebrar nada.
set -e
cd "$(dirname "$0")"

say(){ printf "\n\033[1m%s\033[0m\n" "$1"; }
ok(){ printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn(){ printf "  \033[33m!\033[0m %s\n" "$1"; }
die(){ printf "  \033[31m✗ %s\033[0m\n" "$1"; exit 1; }

say "indioflechudo — bootstrap (Mac)"

# 1 · Pré-requisitos
command -v docker >/dev/null || die "Docker não encontrado. Instale o Docker Desktop."
docker info >/dev/null 2>&1 || die "Docker não está rodando. Abra o Docker Desktop e tente de novo."
ok "Docker rodando"
command -v node >/dev/null || die "Node não encontrado. Instale o Node 18+."
ok "Node $(node -v)"
if command -v claude >/dev/null; then ok "Claude CLI encontrado"; else warn "Claude CLI ausente no PATH — o bridge (auto-resposta) precisa dele."; fi

# 2 · .env + senha (fonte única de verdade)
if [ ! -f .env ]; then
  cp .env.example .env
  PW="$(openssl rand -base64 24 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-28)"
  if grep -q '^ACCESS_PASSWORD=' .env; then
    perl -pi -e "s|^ACCESS_PASSWORD=.*|ACCESS_PASSWORD=$PW|" .env
  else
    printf '\nACCESS_PASSWORD=%s\n' "$PW" >> .env
  fi
  ok ".env criado com senha forte gerada"
else
  ok ".env já existe (mantido)"
fi
PW="$(grep -E '^ACCESS_PASSWORD=' .env | head -1 | cut -d= -f2-)"

# 3 · Deps do host (bridge + mcp rodam no Mac, fora do Docker)
say "Instalando dependências do host (bridge, mcp)…"
( cd bridge && npm ci --silent ) && ok "bridge" || warn "falha no npm ci do bridge"
( cd mcp && npm ci --silent ) && ok "mcp" || warn "falha no npm ci do mcp"

# 4 · Relay (Docker: app + Postgres + Caddy) + gera os bundles do /dl
say "Subindo o relay (Docker) e gerando os bundles do conector…"
docker compose up -d --build
printf "  aguardando o relay"
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null http://127.0.0.1:3998/e2ee-salt; then printf " ✓\n"; break; fi
  printf "."; sleep 1
done

# 5 · Bridge como serviço (auto-restart + boot)
say "Ligando o bridge (Claude auto-resposta)…"
if [ "${SKIP_BRIDGE:-}" = "1" ]; then
  warn "SKIP_BRIDGE=1 — pulei o bridge. Manual: node --env-file=.env bridge/bridge.js"
elif command -v claude >/dev/null; then
  ./bridge/service/install-launchd.sh >/dev/null && ok "bridge instalado (launchd; reinicia sozinho)"
else
  warn "sem Claude CLI — bridge não instalado. Instale o Claude Code e rode ./up.sh de novo."
fi

# 6 · Cartão de onboarding
say "Pronto! ✅"
cat <<EOF

  ┌─ indioflechudo ────────────────────────────────────
  │ App:    http://127.0.0.1:3998
  │ Relay:  https://localhost:8444   (HTTPS via Caddy)
  │ Senha:  $PW
  │         (login + chave E2EE — guarde com cuidado)
  ├─ Máquina ALVO (bloqueada) ─────────────────────────
  │ Abra o relay no navegador e vá em  /onboard
  │ → comandos prontos p/ testar a rede e rodar o conector
  └─────────────────────────────────────────────────────

  Diagnóstico a qualquer momento:   ./doctor.sh
  Parar tudo:                        ./stop.sh
EOF
