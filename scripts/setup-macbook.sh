#!/bin/bash
# Connects this laptop to the office running on another Mac (see
# setup-mac-mini.sh), so you can talk to Jarvis from here:
#
#   1. an SSH tunnel, kept up by launchd, that brings the office to
#      http://localhost:4317 (a browser only allows the microphone on
#      https or localhost) and gives the office a way back to Jarvis's hands;
#   2. Jarvis's hands (bin/jarvis-hands.js): this laptop's browser tabs and
#      apps, and its Claude Code sessions;
#   3. Claude Code hooks, so this laptop's sessions show "needs you" too;
#   4. opens the office in your browser, signed in.
#
#   scripts/setup-macbook.sh jarvis@rodrigos-mac-mini-1
#   scripts/setup-macbook.sh --uninstall
#
# Needs SSH key login to the office machine already working.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$HOME/.jarvis-hands"
TUNNEL="com.agentoffice.tunnel"
HANDS="com.agentoffice.hands"
AGENTS="$HOME/Library/LaunchAgents"
PORT=4317
HANDS_PORT=4319
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  for l in "$TUNNEL" "$HANDS"; do launchctl bootout "gui/$UID/$l" 2>/dev/null || true; rm -f "$AGENTS/$l.plist"; done
  node "$REPO/scripts/install-hooks.mjs" --uninstall || true
  say "Tunnel, hands and hooks removed from this laptop. $DIR is left in place."
  exit 0
fi

REMOTE="${1:?usage: setup-macbook.sh user@office-host}"
NODE="$(command -v node)" || die "Node.js is needed."
CLAUDE="$(command -v claude || true)"
KEY="$HOME/.ssh/id_ed25519"
SSH=(/usr/bin/ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" -o ConnectTimeout=10)
"${SSH[@]}" "$REMOTE" true || die "Can't log in to $REMOTE with $KEY. Set up key login first."
mkdir -p "$DIR/office" "$AGENTS" "$HOME/Library/Logs"
chmod 700 "$DIR"

say "1/4  Linking this laptop to the office on $REMOTE"
# A key for the hands, shared with the office; and the office's observe key,
# for reporting this laptop's sessions.
[[ -s "$DIR/key" ]] || (umask 077; openssl rand -hex 32 > "$DIR/key")
"${SSH[@]}" "$REMOTE" 'umask 077; cat > ~/.agent-office/hands-key' < "$DIR/key"
OBSERVE="$("${SSH[@]}" "$REMOTE" 'cat ~/.agent-office/observe-key')"
OFFICE_KEY="$("${SSH[@]}" "$REMOTE" 'cat ~/.agent-office/office-key')"
(umask 077
 printf '%s\n' "$OBSERVE" > "$DIR/office/observe-key"
 printf '%s' "$PORT" > "$DIR/office/office-port"
 "$NODE" -e 'const [key, observeKey, claude, host] = process.argv.slice(1); process.stdout.write(JSON.stringify({ key, officeUrl: "http://127.0.0.1:" + process.env.PORT, observeKey, browser: "Google Chrome", claude: claude || "claude", host }, null, 2) + "\n")' \
   "$(cat "$DIR/key")" "$OBSERVE" "$CLAUDE" "MacBook" > "$DIR/config.json")

say "2/4  Keeping a tunnel to the office open (launchd: $TUNNEL)"
cat > "$AGENTS/$TUNNEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$TUNNEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string><string>-N</string>
    <string>-o</string><string>BatchMode=yes</string>
    <string>-o</string><string>IdentitiesOnly=yes</string>
    <string>-i</string><string>$KEY</string>
    <string>-o</string><string>ServerAliveInterval=20</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-L</string><string>127.0.0.1:$PORT:127.0.0.1:$PORT</string>
    <string>-R</string><string>127.0.0.1:$HANDS_PORT:127.0.0.1:$HANDS_PORT</string>
    <string>$REMOTE</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/agent-office-tunnel.log</string>
</dict>
</plist>
PLIST

say "3/4  Starting Jarvis's hands (launchd: $HANDS)"
cat > "$AGENTS/$HANDS.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$HANDS</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO/bin/jarvis-hands.js</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):${CLAUDE:+$(dirname "$CLAUDE"):}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/jarvis-hands.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/jarvis-hands.log</string>
</dict>
</plist>
PLIST
for l in "$TUNNEL" "$HANDS"; do
  launchctl bootout "gui/$UID/$l" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$AGENTS/$l.plist"
done
for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
curl -s -o /dev/null "http://127.0.0.1:$PORT/" || die "The tunnel didn't come up. See ~/Library/Logs/agent-office-tunnel.log"

say "4/4  Adding the Claude Code hooks here"
"$NODE" "$REPO/scripts/install-hooks.mjs" --data "$DIR/office"

open "http://localhost:$PORT/?key=$OFFICE_KEY"
cat <<DONE

The office is open at http://localhost:$PORT (the tunnel keeps it there).
Click the "$(printf 'Jarvis')" pill at the bottom, allow the microphone, and say
"Jarvis, what's everyone working on?"

The first time Jarvis touches a tab, macOS asks whether "node" may control
Google Chrome: click OK.

  Logs:  ~/Library/Logs/jarvis-hands.log, ~/Library/Logs/agent-office-tunnel.log
DONE
