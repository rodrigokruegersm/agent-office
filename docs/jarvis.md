# Jarvis

Give the chief of staff a name (`OFFICE_CHIEF_NAME=Jarvis`, which
`scripts/setup-mac-mini.sh` sets) and it becomes someone you talk to out loud.
It runs the office as before (hands out jobs, follows up, holds standup) and
also:

- **answers for every agent**, the office's staff and the contractors outside
  it: "Jarvis, what's everyone working on?" covers both, with anything waiting
  on you first;
- **passes messages to your Claude Code sessions**: "tell the bridged-portal
  session to run the tests". A session on the office machine is picked up as an
  office job on the same session. One on your laptop runs its next turn there,
  headless, with edits allowed. Only idle sessions take messages; a busy one is
  left alone;
- **starts new agents on your laptop**: "in bridged-portal, fix the login
  redirect" starts a fresh Claude Code session in `~/workspaces/bridged-portal`
  there (edits allowed, up to 4 at once). It shows up as a contractor, and you
  can follow up with it by name. Office projects still go to office staff, unless
  you say "on the laptop" or the office machine isn't signed in to Claude yet;
- **works your laptop's browser**: "open Gmail", "search for flights to
  Lisbon", "switch to the launch bible doc", "close the YouTube tab", "reload
  the dashboard";
- **brings apps to the front**: "open Spotify".

## Talking to him

Open the office at **http://localhost:4317** on your laptop (browsers only
allow the microphone on https or localhost; the tunnel below puts it there).
Click the **Jarvis** pill at the bottom once and allow the microphone. From then
on he listens all the time:

- Start with his name: "Jarvis, …". Everything else in the room is ignored.
- After he answers, he stays awake for 25 seconds for a follow-up without the
  name.
- "Jarvis, go to sleep" stops the follow-up window; click the pill to stop
  listening altogether.
- He doesn't listen while he's talking, so he won't answer himself.

Each phrase is transcribed by whisper on the office machine and thrown away
afterwards. Nothing goes to a cloud speech service.

**His voice** is Piper's British "Alan", recorded on the office machine (about
a second a line) and played in the office tab, even from a background tab. His
stock lines ("Yes, sir?", "One moment, sir.") are recorded once and kept.
Without Piper he falls back to the Mac's "Daniel". To install Piper on the
office machine:

```bash
python3.12 -m venv ~/.agent-office/piper/venv
~/.agent-office/piper/venv/bin/pip install piper-tts
~/.agent-office/piper/venv/bin/python -m piper.download_voices --data-dir ~/.agent-office/piper/voices en_GB-alan-medium
```

then turn on the speaker button in the office's top right.

## How fast he is

- **Browser and app commands** ("open Gmail", "switch to the launch doc",
  "close the YouTube tab", "search for …", "open Spotify") skip the model:
  `server/fastpath.js` matches them and acts at once. About a second, voice
  included.
- **Everything else** goes to one `claude` process kept running between
  messages (`WarmChief`), on Haiku (`CHIEF_MODEL`). It's restarted every few
  turns so its history stays short. The laptop's tab list only goes in when
  you're talking about tabs. Answers take about 5 seconds; if one isn't back in
  1.5, he says "One moment, sir."
- The work itself runs on whichever model each job needs, as before.

The pill's dot: blue, listening for his name; cyan, awake or hearing you;
amber, working it out; green, speaking; red, click the page so the browser
lets him listen.

## How the laptop is connected

`scripts/setup-macbook.sh user@office-machine` installs two launchd agents on
the laptop:

- **com.agentoffice.tunnel**: one SSH connection to the office machine. It brings
  the office to `localhost:4317` here and lets the office reach Jarvis's hands
  at `127.0.0.1:4319` there. Nothing new listens on the network.
- **com.agentoffice.hands**: `bin/jarvis-hands.js`, the only thing that touches
  the laptop. It can list, open, switch, close and reload Chrome tabs, open a
  web search, bring an app to the front, and pass a message to an idle Claude
  Code session. It can't type into pages or read them. Every call needs the
  hands key, which is shared only with the office (`<data>/hands-key`). It also
  reports the laptop's Claude Code sessions to the office, labelled with the
  laptop's name.

The first time Jarvis touches a tab, macOS may ask whether `node` can control
Google Chrome. Click OK.

## Signing the office in to Claude

An office running as a service can't use the keychain login. Run
`scripts/claude-login.sh` on the office machine once, in a terminal (over
`ssh -t` is fine). It runs `claude setup-token`, saves the token to
`<data>/claude-token` (readable only by you) and restarts the office.

Until then Jarvis still works: he notices at startup, thinks on the laptop's
Claude login instead (the laptop must be awake), and starts new work on the
laptop rather than office jobs that would fail.

## Checking him from a terminal

```bash
OFFICE_KEY=… node scripts/ask-jarvis.mjs "what's everyone working on?"
```
