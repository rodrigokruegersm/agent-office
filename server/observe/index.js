// Agents the office didn't start: interactive Claude Code sessions on this
// machine, always-on bots (OpenClaw, Hermes), and cron jobs. They show up as
// contractors in the guest wing, walking to the station of whatever they're
// doing, and the ones that need the boss go to the top of the attention queue.
//
// Three ways in:
//   - Claude Code transcripts under ~/.claude/projects, tailed (claude.js),
//     and OpenClaw's under ~/.openclaw/agents (openclaw.js);
//   - Claude Code hooks, for the states transcripts can't show (hook());
//   - POST /api/observe from anything else (report()), with the observe key.
//
// The observe key is not the office key: it can only report what an agent is
// doing, never start one, so it's safe to leave in a hook or a crontab.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TranscriptWatcher } from './claude.js';
import { parseOpenclaw, openclawHome, openclawNames } from './openclaw.js';
import { stationFor, summarizeTool } from '../tools.js';

export const STATES = new Set(['working', 'waiting', 'idle', 'error']);
const STATIONS = new Set(['desk', 'library', 'servers', 'window', 'whiteboard', 'lounge']);
const SOURCE = /^[a-z][a-z0-9-]{0,23}$/;
const LOG_KEEP = 30;
const MAX_AGENTS = 60;

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const minutes = (env, fallback) => {
  const n = Number(process.env[env]);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60_000;
};

// How long an agent may stay quiet before it changes state. Working with no
// word for STALE becomes idle (a crashed cron job, a closed laptop lid); idle
// for GONE walks out. Errors and waits stay until dismissed or GONE_ATTENTION.
const STALE = minutes('OBSERVE_STALE_MIN', 10);
const GONE = minutes('OBSERVE_GONE_MIN', 30);
const GONE_ATTENTION = minutes('OBSERVE_ATTENTION_MIN', 12 * 60);

export function observeKey(data) {
  const file = path.join(data, 'observe-key');
  try {
    const k = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(k)) return k;
  } catch {}
  const k = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(file, k + '\n', { mode: 0o600 });
  return k;
}

export class Observer {
  constructor({ data, send, ownSessions = () => new Set(), claudeDir }) {
    this.data = data;
    this.send = send;
    this.ownSessions = ownSessions;
    this.key = observeKey(data);
    this.agents = new Map(); // id -> agent
    this.dismissed = new Map(); // id -> updated at dismissal; a newer update brings it back
    this.dirty = false;
    this.watcher = new TranscriptWatcher({
      dir: claudeDir,
      skip: (sessionId) => this.ownSessions().has(sessionId),
      onEvent: (ev) => this.fromTranscript(ev),
    });
    const names = openclawNames();
    this.openclaw = new TranscriptWatcher({
      dir: path.join(openclawHome(), 'agents'),
      sub: 'sessions',
      parse: parseOpenclaw,
      fileInfo: (f) => {
        const agent = path.basename(path.dirname(path.dirname(f)));
        return { source: 'openclaw', agent, name: names[agent] || agent.charAt(0).toUpperCase() + agent.slice(1) };
      },
      onEvent: (ev) => this.fromTranscript(ev),
    });
  }

  start() {
    this.watcher.start();
    if (process.env.OBSERVE_OPENCLAW !== 'off') this.openclaw.start();
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.watcher.stop();
    this.openclaw.stop();
  }

  sameKey(k) {
    const a = Buffer.from(String(k || '')), b = Buffer.from(this.key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // `seen`: dismissed from the queue, and nothing new since. They stay on the floor.
  list() {
    return [...this.agents.values()].map(({ log, ...a }) => ({ ...a, seen: this.dismissed.get(a.id) >= a.updated, log: log.slice(-12) }));
  }

  // Waiting and failed agents, newest first: the boss's to-do list.
  attention() {
    return this.list().filter((a) => !a.seen && (a.state === 'waiting' || a.state === 'error')).sort((a, b) => b.updated - a.updated);
  }

  dismiss(id) {
    const a = this.agents.get(id);
    if (!a) return false;
    // An error is done with once seen; a waiting session still waits, so it
    // only leaves the queue (until it next changes).
    if (a.state === 'error') { a.state = 'idle'; a.activity = 'Seen'; }
    this.dismissed.set(id, a.updated);
    this.changed();
    return true;
  }

  // ---------- inputs ----------

  // From POST /api/observe. Anything can send this, so check it all.
  report(body = {}) {
    const source = clip(body.source, 24).toLowerCase();
    if (!SOURCE.test(source)) throw new Error('source must be a short lowercase name, like "cron" or "openclaw".');
    const rawId = clip(body.id, 80);
    if (!rawId) throw new Error('id is required.');
    const state = STATES.has(body.state) ? body.state : body.state === 'done' ? 'idle' : null;
    if (!state && body.state !== 'gone') throw new Error('state must be working, waiting, idle, error, done or gone.');
    const id = `${source}:${rawId}`;
    if (body.state === 'gone') { this.remove(id); return { ok: true }; }
    const tool = clip(body.tool, 80);
    const station = STATIONS.has(body.station) ? body.station : tool ? stationFor(tool) : state === 'working' ? 'desk' : 'lounge';
    const activity = clip(body.activity, 200) || (tool ? summarizeTool(tool, body.input || {}) : '');
    this.upsert(id, {
      source,
      name: clip(body.name, 40) || rawId.slice(0, 40),
      project: clip(body.project, 60),
      state, station, activity, tool,
      // A laptop's sessions (bin/jarvis-hands.js) say where they live, so the
      // chief can send them messages.
      ...(body.host && { host: clip(body.host, 40) }),
      ...(body.cwd && { cwd: clip(body.cwd, 400) }),
      ...(body.sessionId && /^[\w-]{8,80}$/.test(body.sessionId) && { sessionId: body.sessionId }),
      ...(body.title && { title: clip(body.title, 100) }),
    });
    return { ok: true, id };
  }

  // From the Claude Code hook script (bin/office-observe.js): the raw hook
  // input, which carries the session id and the event.
  hook(body = {}) {
    const sid = clip(body.session_id, 80);
    if (!/^[\w-]{8,80}$/.test(sid)) throw new Error('Bad session id.');
    if (this.ownSessions().has(sid)) return { ok: true, skipped: true };
    const id = `claude:${sid}`;
    const cwd = clip(body.cwd, 400);
    const host = clip(body.host, 40);
    const base = { source: 'claude', name: this.agents.get(id)?.name || projectName(cwd) || 'Claude', project: host ? `${projectName(cwd)} · ${host}` : projectName(cwd), sessionId: sid, ...(host && { host }), ...(cwd && { cwd }) };
    const ev = String(body.hook_event_name || '');
    const msg = clip(body.message, 200);
    if (ev === 'PermissionRequest') {
      const tool = clip(body.tool_name, 80);
      this.upsert(id, { ...base, state: 'waiting', station: tool ? stationFor(tool) : 'desk', tool, activity: `Needs permission: ${tool ? summarizeTool(tool, body.tool_input || {}) : 'a tool'}` });
    } else if (ev === 'Notification') {
      // "Claude needs your permission…" and "Claude is waiting for your input".
      const permission = /permission/i.test(msg) || body.notification_type === 'permission_prompt';
      this.upsert(id, { ...base, state: 'waiting', activity: permission ? msg || 'Needs permission' : msg || 'Waiting for your input' });
    } else if (ev === 'Stop') {
      this.upsert(id, { ...base, state: 'idle', station: 'lounge', activity: 'Finished — your turn' });
    } else if (ev === 'UserPromptSubmit' || ev === 'PreToolUse' || ev === 'PostToolUse') {
      const tool = clip(body.tool_name, 80);
      this.upsert(id, { ...base, state: 'working', ...(tool && { tool, station: stationFor(tool), activity: summarizeTool(tool, body.tool_input || {}) }), ...(!tool && { activity: 'Got a new request' }) });
    } else if (ev === 'SessionEnd') {
      this.remove(id);
    } else {
      return { ok: true, ignored: ev };
    }
    return { ok: true };
  }

  fromTranscript(ev) {
    const source = ev.source || 'claude';
    const id = `${source}:${ev.sessionId}`;
    const cur = this.agents.get(id);
    const label = { source, name: ev.name || projectName(ev.cwd) || 'Claude', project: projectName(ev.cwd), sessionId: ev.sessionId, title: ev.title || '', cwd: ev.cwd || '' };
    if (ev.meta) {
      if (cur && (cur.name !== label.name || (label.title && cur.title !== label.title))) {
        cur.name = label.name;
        if (label.title) cur.title = label.title;
        this.changed();
      }
      return;
    }
    // A hook already said this session waits on the boss; a transcript line
    // older than that can't take it back.
    if (cur?.state === 'waiting' && ev.at <= cur.updated && ev.state !== 'waiting') return;
    this.upsert(id, { ...label, state: ev.state, station: ev.station, tool: ev.tool ?? '', activity: ev.activity, model: ev.model }, ev.at);
  }

  // ---------- bookkeeping ----------

  upsert(id, fields, at = Date.now()) {
    let a = this.agents.get(id);
    if (!a) {
      if (this.agents.size >= MAX_AGENTS) this.evict();
      a = { id, source: fields.source, name: '', project: '', state: 'idle', station: 'lounge', activity: '', tool: '', since: at, updated: at, log: [] };
      this.agents.set(id, a);
    }
    if (fields.state && fields.state !== a.state) a.since = at;
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') a[k] = v;
    if (fields.tool === '') a.tool = '';
    a.updated = Math.max(a.updated, at);
    if (fields.activity && a.log.at(-1)?.summary !== fields.activity) {
      a.log.push({ at, state: a.state, station: a.station, summary: fields.activity });
      if (a.log.length > LOG_KEEP) a.log.splice(0, a.log.length - LOG_KEEP);
    }
    this.changed();
  }

  remove(id) {
    if (this.agents.delete(id)) { this.dismissed.delete(id); this.changed(); }
  }

  evict() {
    const oldest = [...this.agents.values()].filter((a) => a.state === 'idle').sort((a, b) => a.updated - b.updated)[0]
      || [...this.agents.values()].sort((a, b) => a.updated - b.updated)[0];
    if (oldest) this.agents.delete(oldest.id);
  }

  tick() {
    const now = Date.now();
    for (const a of this.agents.values()) {
      const quiet = now - a.updated;
      if (a.state === 'working' && quiet > STALE) {
        a.state = 'idle'; a.station = 'lounge'; a.since = now; a.activity = 'Gone quiet'; this.dirty = true;
      }
      const limit = a.state === 'idle' ? GONE : GONE_ATTENTION;
      if (quiet > limit) { this.agents.delete(a.id); this.dismissed.delete(a.id); this.dirty = true; }
    }
    this.flush();
  }

  // Many lines can land in one tick (a transcript catching up); one broadcast.
  changed() {
    this.dirty = true;
    if (this.soon) return;
    this.soon = setTimeout(() => { this.soon = null; this.flush(); }, 250);
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.send({ t: 'external', agents: this.list() });
  }
}

export function projectName(cwd) {
  const parts = String(cwd || '').split('/').filter(Boolean);
  return clip(parts.at(-1) || '', 40);
}
