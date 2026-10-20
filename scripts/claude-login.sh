#!/bin/bash
# Signs the office in to Claude with a long-lived Claude Code token, for an
# office running as a background service (which can't reach the keychain
# login). Run it on the office machine, in a terminal, e.g. from your laptop:
#
#   ssh -t you@office-machine ~/agent-office/scripts/claude-login.sh
#
# It runs `claude setup-token`: open the link it prints, approve, paste the
# code back. The token is saved to <data>/claude-token (readable only by
# you) and the office restarts to pick it up.

set -euo pipefail
DATA="${OFFICE_DATA:-$HOME/.agent-office}"
CLAUDE="$(command -v claude || echo /opt/homebrew/bin/claude)"
LOG="$(mktemp)"; trap 'rm -f "$LOG"' EXIT

printf '\033[1mSigning the office in to Claude\033[0m\n\n'
# Wide enough that the token is printed on one line.
stty cols 400 2>/dev/null || true
script -q "$LOG" "$CLAUDE" setup-token || true
TOKEN="$(sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g' "$LOG" | grep -Eo 'sk-ant-oat[A-Za-z0-9_-]{20,}' | tail -1 || true)"
if [[ -z "$TOKEN" ]]; then
  read -rsp "Paste the token it printed (starts with sk-ant-oat): " TOKEN; echo
fi
[[ "$TOKEN" =~ ^sk-ant-oat[A-Za-z0-9_-]{20,}$ ]] || { echo "That isn't a Claude Code token."; exit 1; }
(umask 077; printf '%s\n' "$TOKEN" > "$DATA/claude-token")
launchctl kickstart -k "gui/$UID/com.agentoffice.office"
printf '\n\033[1mDone. Jarvis and the office are signed in to Claude.\033[0m\n'
