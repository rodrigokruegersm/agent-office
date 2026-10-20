#!/usr/bin/env node
// Jarvis's hands on a laptop: a small local service the office (on another
// machine) reaches through an SSH reverse tunnel, so the chief of staff can
// work the laptop's browser tabs and apps, and pass messages to the laptop's
// own Claude Code sessions. It also reports those sessions to the office, so
// they show up as contractors next to the office machine's.
//
//   node bin/jarvis-hands.js            # listens on 127.0.0.1:4319
//
// Settings live in ~/.jarvis-hands/config.json (written by scripts/setup-macbook.sh):
//   { "key": "<hands key>", "officeUrl": "http://127.0.0.1:4317", "observeKey": "<office observe key>", "browser": "Google Chrome" }
//
// Everything is on 127.0.0.1 and needs the key. Only these actions exist:
// list, open, focus, close and reload tabs; open a web search; bring an app to
// the front; send a message to an idle Claude Code session. Nothing types into
// pages or reads them.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { TranscriptWatcher } from '../server/observe/claude.js';

const DIR = process.env.JARVIS_HANDS_DIR || path.join(os.homedir(), '.jarvis-hands');
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const PORT = Number(process.env.JARVIS_HANDS_PORT || cfg.port || 4319);
const BROWSER = cfg.browser || 'Google Chrome';
const HOST = cfg.host || os.hostname().replace(/\.local$/, '');
const CLAUDE = cfg.claude || 'claude';
const log = (...a) => console.log(new Date().toISOString(), ...a);

const same = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------- AppleScript, with arguments passed as argv, never pasted in ----------

function osa(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script, ...args.map(String)], { timeout: 10_000 }, (err, out, errOut) => {
      if (err) reject(new Error(clip(errOut || err.message, 300)));
      else resolve(out.trim());
    });
  });
}

const LIST = `on run argv
  set out to ""
  tell application (item 1 of argv)
    set wi to 0
    repeat with w in windows
      set wi to wi + 1
      set act to active tab index of w
      set ti to 0
      repeat with t in tabs of w
        set ti to ti + 1
        set out to out & wi & tab & ti & tab & (ti = act) & tab & (title of t) & tab & (URL of t) & linefeed
      end repeat
    end repeat
  end tell
  return out
end run`;

const FOCUS = `on run argv
  tell application (item 1 of argv)
    set w to window ((item 2 of argv) as integer)
    set active tab index of w to ((item 3 of argv) as integer)
    set index of w to 1
    activate
  end tell
end run`;

const CLOSE = `on run argv
  tell application (item 1 of argv) to close tab ((item 3 of argv) as integer) of window ((item 2 of argv) as integer)
end run`;

const RELOAD = `on run argv
  tell application (item 1 of argv) to reload tab ((item 3 of argv) as integer) of window ((item 2 of argv) as integer)
end run`;

const OPEN = `on run argv
  tell application (item 1 of argv)
    if (count of windows) = 0 then make new window
    tell front window to make new tab with properties {URL:(item 2 of argv)}
    activate
  end tell
end run`;

async function tabs() {
  const out = await osa(LIST, [BROWSER]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [w, t, active, title, url] = l.split('\t');
    return { window: +w, tab: +t, active: active === 'true', title: clip(title, 120), url: clip(url, 300) };
  });
}

// The tab a request means: by window and tab number, else the best match for
// words from its title or address.
async function find({ window, tab, query }) {
  const all = await tabs();
  if (window && tab) return all.find((x) => x.window === +window && x.tab === +tab);
  const words = clip(query, 120).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const score = (x) => words.filter((w) => `${x.title} ${x.url}`.toLowerCase().includes(w)).length;
  return all.map((x) => [score(x), x]).filter(([s]) => s).sort((a, b) => b[0] - a[0])[0]?.[1] || null;
}

function safeUrl(u) {
  u = clip(u, 2000);
  if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
  const p = new URL(u);
  if (!['http:', 'https:'].includes(p.protocol)) throw new Error('Only web addresses.');
  return p.toString();
}

async function tabAction(b) {
  const op = String(b.op || 'list');
  if (op === 'list') return { tabs: await tabs() };
  if (op === 'open') { const url = safeUrl(b.url); await osa(OPEN, [BROWSER, url]); return { opened: url }; }
  if (op === 'search') { const url = `https://www.google.com/search?q=${encodeURIComponent(clip(b.query, 300))}`; await osa(OPEN, [BROWSER, url]); return { opened: url }; }
  if (['focus', 'close', 'reload'].includes(op)) {
    const t = await find(b);
    if (!t) return { error: `No tab matches "${clip(b.query, 60)}".` };
    await osa(op === 'focus' ? FOCUS : op === 'close' ? CLOSE : RELOAD, [BROWSER, t.window, t.tab]);
    return { [op === 'focus' ? 'focused' : op === 'close' ? 'closed' : 'reloaded']: t };
  }
  throw new Error(`Unknown tab action: ${op}`);
}

// Apps by their name in /Applications only, so a request can't run a path.
function apps() {
  const names = new Set();
  for (const dir of ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')]) {
    try { for (const n of fs.readdirSync(dir)) if (n.endsWith('.app')) names.add(n.slice(0, -4)); } catch {}
  }
  return [...names];
}

function openApp(name) {
  const want = clip(name, 60).toLowerCase();
  const all = apps();
  const app = all.find((a) => a.toLowerCase() === want) || all.find((a) => a.toLowerCase().startsWith(want)) || all.find((a) => a.toLowerCase().includes(want));
  if (!app) return Promise.resolve({ error: `No app called "${clip(name, 40)}".` });
  return new Promise((resolve, reject) => execFile('/usr/bin/open', ['-a', app], { timeout: 10_000 }, (err) => (err ? reject(err) : resolve({ opened: app }))));
}

// ---------- this laptop's Claude Code sessions ----------

const sessions = new Map(); // sessionId -> { cwd, state, name }
const running = new Set();

async function report(body) {
  if (!cfg.officeUrl || !cfg.observeKey) return;
  try {
    await fetch(`${cfg.officeUrl}/api/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-observe-key': cfg.observeKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

const watcher = new TranscriptWatcher({
  onEvent: (ev) => {
    if (!ev.sessionId) return;
    const s = sessions.get(ev.sessionId) || {};
    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.name) s.name = ev.name;
    if (!ev.meta) s.state = ev.state;
    sessions.set(ev.sessionId, s);
    if (ev.meta) return;
    const project = path.basename(s.cwd || '') || 'claude';
    report({
      source: 'claude', id: ev.sessionId, sessionId: ev.sessionId, host: HOST, cwd: s.cwd,
      name: ev.name || project, project: `${project} · ${HOST}`, title: ev.title,
      state: ev.state, station: ev.station, tool: ev.tool, activity: ev.activity,
    });
  },
});

// A message to a session that is waiting for its next turn: run the session
// on in the background, headless, in its own folder. One at a time each, and
// never one that is mid-turn (that would fork the conversation).
function tellSession({ sessionId, message }) {
  const sid = clip(sessionId, 80);
  const s = sessions.get(sid);
  if (!/^[\w-]{8,80}$/.test(sid) || !s?.cwd) return { error: 'I don\'t know that session on this machine.' };
  if (s.state === 'working' || running.has(sid)) return { error: 'That session is busy right now.' };
  const text = String(message || '').trim().slice(0, 4000);
  if (!text) return { error: 'No message.' };
  running.add(sid);
  const child = spawn(CLAUDE, ['-p', '--resume', sid, '--permission-mode', 'acceptEdits', text], {
    cwd: s.cwd, stdio: ['ignore', 'ignore', 'pipe'], env: process.env,
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => {
    running.delete(sid);
    log(`session ${sid} turn ended (${code})${err ? ': ' + clip(err, 200) : ''}`);
  });
  child.on('error', (e) => { running.delete(sid); log('session spawn failed', e.message); });
  return { sent: true, cwd: s.cwd };
}

// ---------- the service ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 50_000) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('Bad JSON.')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  // Local callers only, with no browser in between.
  if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host || ''))) return send(403, { error: 'Local only.' });
  if (!same(req.headers['x-hands-key'], cfg.key)) return send(401, { error: 'Wrong key.' });
  try {
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, host: HOST, browser: BROWSER });
    if (req.method === 'POST' && req.url === '/tabs') return send(200, await tabAction(await readBody(req)));
    if (req.method === 'POST' && req.url === '/app') return send(200, await openApp((await readBody(req)).name));
    if (req.method === 'POST' && req.url === '/session') return send(200, tellSession(await readBody(req)));
    send(404, { error: 'No such action.' });
  } catch (err) {
    send(400, { error: clip(err.message, 300) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Jarvis's hands on ${HOST}: 127.0.0.1:${PORT}, browser ${BROWSER}`);
  watcher.start();
});
