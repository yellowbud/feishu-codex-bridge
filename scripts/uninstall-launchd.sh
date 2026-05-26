#!/usr/bin/env bash
set -euo pipefail

LABEL="com.local.feishu-codex-bridge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/${LABEL}" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "Uninstalled ${LABEL}"
