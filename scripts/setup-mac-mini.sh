#!/bin/bash
# Sets this Mac up as the office's always-on host, viewed from your other
# machines over Tailscale:
#
#   1. installs and builds the office from this clone;
#   2. runs it as a launchd agent (starts at login, restarts if it dies);
#   3. puts it on your tailnet with `tailscale serve` (https, tailnet only);
#   4. adds the Claude Code hooks, so sessions here show "needs you";
#   5. prints the link to open on your MacBook and phone.
#
#   OFFICE_ROOT=~/code scripts/setup-mac-mini.sh     # projects folder (default ~/workspaces)
#   scripts/setup-mac-mini.sh --uninstall
#
# Safe to run again after a `git pull`: it rebuilds and restarts.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${OFFICE_ROOT:-$HOME/workspaces}"
DATA="${OFFICE_DATA:-$HOME/.agent-office}"
PORT="${PORT:-4317}"
LABEL="com.agentoffice.office"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/agent-office.log"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"; [[ -x "$TS" ]] || TS=tailscale
  "$TS" serve reset 2>/dev/null || true
  node "$REPO/scripts/install-hooks.mjs" --uninstall || true
  say "Office service, tailnet address and hooks removed. Data is still in $DATA."
  exit 0
fi

NODE="$(command -v node)" || die "Node.js 20+ is needed (brew install node)."
[[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 20 ]] || die "Node.js 20+ is needed; this is $("$NODE" -v)."
CLAUDE="$(command -v claude)" || die "Claude Code isn't on PATH. Install it and sign in (claude, then /login)."
# The Mac app's own CLI matches its daemon; a brew CLI may be older.
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
[[ -x "$TS" ]] || TS="$(command -v tailscale)" || die "Tailscale isn't installed (brew install tailscale, or the Mac app)."
TSJSON="$("$TS" status --json 2>/dev/null)"
TSHOST="$(printf '%s' "$TSJSON" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.Self&&j.Self.DNSName||"").replace(/\.$/,""))})')"
[[ -n "$TSHOST" ]] || die "Tailscale isn't connected. Run: tailscale up"
# https needs HTTPS certificates turned on for the tailnet; without them the
# office is served over plain http, still only inside the (encrypted) tailnet.
HTTPS="$(printf '%s' "$TSJSON" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.CertDomains||[]).length?"1":"")})')"
SCHEME="$([[ -n "$HTTPS" ]] && echo https || echo http)"
mkdir -p "$ROOT" "$DATA" "$(dirname "$PLIST")" "$(dirname "$LOG")"

say "1/5  Installing and building in $REPO"
cd "$REPO"
npm ci --no-audit --no-fund
npm run build

say "2/5  Starting the office as a launchd agent ($LABEL)"
# Every tool a job may need: node, claude, git, brew's bin.
PATHS="$(dirname "$NODE"):$(dirname "$CLAUDE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO/server/supervise.js</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATHS</string>
    <key>HOME</key><string>$HOME</string>
    <key>PORT</key><string>$PORT</string>
    <key>OFFICE_ROOT</key><string>$ROOT</string>
    <key>OFFICE_DATA</key><string>$DATA</string>
    <key>OFFICE_ALLOWED_HOSTS</key><string>$TSHOST</string>
    <key>OFFICE_SERVICE</key><string>1</string>
    <key>BANTER</key><string>off</string>
    <key>CHIEF_MODEL</key><string>sonnet</string>
    <key>OFFICE_CHIEF_NAME</key><string>${OFFICE_CHIEF_NAME:-Jarvis}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
# bootout returns before the old one is gone; bootstrapping too soon fails (error 5).
for _ in $(seq 1 30); do launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
rm -f "$DATA/office-port"
launchctl bootstrap "gui/$UID" "$PLIST"
for _ in $(seq 1 30); do [[ -s "$DATA/office-port" ]] && break; sleep 1; done
[[ -s "$DATA/office-port" ]] || die "The office didn't start. See $LOG"
PORT="$(cat "$DATA/office-port")"

say "3/5  Putting it on your tailnet: $SCHEME://$TSHOST"
if [[ -n "$HTTPS" ]]; then "$TS" serve --bg "$PORT" >/dev/null
else "$TS" serve --bg --http=80 "$PORT" >/dev/null; fi

say "4/5  Adding the Claude Code hooks"
OFFICE_DATA="$DATA" "$NODE" "$REPO/scripts/install-hooks.mjs" --data "$DATA"

say "5/5  Done"
cat <<DONE

Open this once on your MacBook and phone (it signs that browser in; treat it like a password):

  $SCHEME://$TSHOST/?key=$(cat "$DATA/office-key")

Then add it to the Dock (Chrome: Install app; Safari: File > Add to Dock) or the phone's home screen.
DONE
[[ -n "$HTTPS" ]] || cat <<NOHTTPS

Served over http for now: Tailscale encrypts it anyway, but browsers only
allow notifications and app installs over https. Turn on HTTPS Certificates
at https://login.tailscale.com/admin/dns and run this script again.
NOHTTPS
cat <<DONE

  Logs:        tail -f $LOG
  Restart:     launchctl kickstart -k gui/$UID/$LABEL
  Cron jobs:   $REPO/bin/office-run.js "Nightly backup" -- /path/to/backup.sh
  Hermes:      node $REPO/scripts/install-adapters.mjs hermes
  OpenClaw:    nothing to do; its sessions in ~/.openclaw are read automatically.
DONE
