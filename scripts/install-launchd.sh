#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/macmini/feishu-codex-bridge"
LABEL="com.local.feishu-codex-bridge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd ${ROOT} &amp;&amp; npm start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>StandardOutPath</key>
  <string>${ROOT}/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${ROOT}/logs/launchd.err.log</string>
</dict>
</plist>
PLIST

DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/${LABEL}" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    launchctl print "$DOMAIN/${LABEL}" >/dev/null 2>&1 || break
    sleep 0.2
  done
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl print "$DOMAIN/${LABEL}" | grep -E 'state =|pid =' || true
echo "Installed and loaded ${LABEL}"
