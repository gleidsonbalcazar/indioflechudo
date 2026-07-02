#!/bin/bash
# Remove o LaunchAgent do bridge.
set -e
LABEL="com.gleidson.indioflechudo-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_N="$(id -u)"
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Serviço removido: $LABEL"
