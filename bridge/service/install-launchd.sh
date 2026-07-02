#!/bin/bash
# Instala o bridge como LaunchAgent (macOS): sobe no login e reinicia se cair.
# Gera o plist com os caminhos da SUA máquina e carrega o serviço.
#
#   ./bridge/service/install-launchd.sh
#
# Requisitos: node, claude (Claude Code) instalado/autenticado, e ../.env com
# ACCESS_PASSWORD. Logs em ~/Library/Logs/indioflechudo-bridge.{out,err}.log
set -e

LABEL="com.gleidson.indioflechudo-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Caminhos absolutos detectados nesta máquina.
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_BIN="$(command -v node)"
CLAUDE_BIN="$(command -v claude || true)"
ENV_FILE="$PROJECT_DIR/.env"

[ -z "$NODE_BIN" ]   && { echo "node não encontrado no PATH"; exit 1; }
[ -z "$CLAUDE_BIN" ] && { echo "claude não encontrado no PATH (instale/autentique o Claude Code)"; exit 1; }
[ ! -f "$ENV_FILE" ] && { echo "$ENV_FILE não existe (copie .env.example -> .env)"; exit 1; }

NODE_DIR="$(dirname "$NODE_BIN")"
CLAUDE_DIR="$(dirname "$CLAUDE_BIN")"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>--env-file=$ENV_FILE</string>
        <string>$PROJECT_DIR/bridge/bridge.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR/bridge</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PATH</key>
        <string>$CLAUDE_DIR:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>CLAUDE_BIN</key>
        <string>$CLAUDE_BIN</string>
        <key>RELAY_URL</key>
        <string>http://localhost:3999</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/indioflechudo-bridge.out.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/indioflechudo-bridge.err.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" >/dev/null

UID_N="$(id -u)"
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_N" "$PLIST"
launchctl enable "gui/$UID_N/$LABEL"

echo "Serviço instalado: $LABEL"
echo "  status:  launchctl print gui/$UID_N/$LABEL | grep state"
echo "  log:     tail -f ~/Library/Logs/indioflechudo-bridge.out.log"
echo "  remover: ./bridge/service/uninstall-launchd.sh"
