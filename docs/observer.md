# Contractors: agents the office didn't start

The office's own staff are the `claude` jobs it launches. Everything else
running on the same machine can show up too, as **contractors** in the guest
wing:

| Agent | How the office sees it | Setup |
|---|---|---|
| Claude Code sessions (terminal, desktop app, IDE) | Tails `~/.claude/projects/*/*.jsonl` | None |
| Claude Code "needs you" (permission prompts, questions) | Hooks post to the office | `node scripts/install-hooks.mjs` |
| OpenClaw | Tails `~/.openclaw/agents/*/sessions/*.jsonl` | None |
| Hermes | A gateway hook posts each step | `node scripts/install-adapters.mjs hermes` |
| Cron and launchd jobs | A wrapper reports start, heartbeat and exit | Prefix the command with `bin/office-run.js "<name>" --` |
| Anything else | `POST /api/observe` | See below |

A contractor goes where its latest tool says, the same as the staff: the
library to read, the server room to run commands, the research window for
the web, and the whiteboard to plan. With nothing like that, it goes to a guest
desk. Idle, it waits at the guest coffee bar. Waiting on you or failed, it
stands at the guest table with a red bubble.

## Needs you

Every contractor that is **waiting** (a permission prompt, a question, a plan to
approve) or **failed** (a cron job that exited non-zero, an OpenClaw error) goes
in the *Needs you* queue at the top right. You also get a sound and, with the
tab in the background, a desktop notification. Click an entry for its recent
steps. A Claude Code session also offers `claude --resume <id>` to copy.
**×** hides an entry until it changes again; a failure stays seen.

## When they come and go

- **Working** with no news for 10 minutes becomes idle (`OBSERVE_STALE_MIN`).
- **Idle** for 30 minutes walks out (`OBSERVE_GONE_MIN`).
- **Waiting** or **failed** stays up to 12 hours (`OBSERVE_ATTENTION_MIN`), or until you dismiss it.
- Up to 14 are on the floor at once, with whoever needs you first.

`OFFICE_OBSERVE=off` turns all of this off; `OBSERVE_OPENCLAW=off` turns off
just OpenClaw.

## Reporting from anything: `POST /api/observe`

```bash
curl -s http://127.0.0.1:4317/api/observe \
  -H "x-observe-key: $(cat ~/.agent-office/observe-key)" \
  -H 'content-type: application/json' \
  -d '{"source":"scraper","id":"leads","name":"Lead scraper","state":"working","station":"servers","activity":"Page 3 of 40"}'
```

| Field | |
|---|---|
| `source` | short lowercase name; picks the tint (`claude`, `openclaw`, `hermes` and `cron` have their own) |
| `id` | stable per agent or run; with `source` it is the contractor's identity |
| `state` | `working`, `waiting`, `idle`, `error`, `done` (same as idle) or `gone` (walks out now) |
| `name`, `project`, `activity` | what the label, queue and panel show |
| `station` | `desk`, `library`, `servers`, `window`, `whiteboard` or `lounge`; or send `tool` with a Claude Code tool name and it's worked out |

The **observe key** (`<data>/observe-key`, made on first start) is separate
from the office key. It can only report what an agent is doing: it can't open
the office, read anything or start a job, so it's fine in a crontab or a
bot's config. The endpoint takes the same `Host` and `Origin` checks as
everything else, so it's reachable from this machine (and from names in
`OFFICE_ALLOWED_HOSTS`).

Contractors are sent to your own browsers only: never to linked offices or
guests.

## Running it on an always-on Mac

`scripts/setup-mac-mini.sh` sets up a Mac (a Mac mini, say) to host the office
for your other machines:

1. builds this clone and runs it as a launchd agent, which starts at login and restarts if it stops;
2. serves it on your tailnet with `tailscale serve` (https, tailnet only, never the public internet);
3. installs the Claude Code hooks;
4. prints the link to open once on your laptop and phone.

Run it again after a `git pull` to rebuild and restart. `--uninstall` undoes
it all except the data folder.
