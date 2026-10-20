// OpenClaw keeps a transcript per session at
// ~/.openclaw/agents/<agent>/sessions/<session>.jsonl: a `session` header,
// then `message` entries whose message has a role (user, assistant,
// toolResult) and, for the assistant, content parts of type text, thinking or
// toolCall. Its hooks (as of 2026.2) only fire on commands and startup, so the
// transcript is the only place a tool call shows up.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const base = (p) => (p ? String(p).split('/').filter(Boolean).pop() : '');

export function openclawHome() {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
}

const STATIONS = {
  read: 'library', memory_search: 'library', memory_get: 'library', sessions_history: 'library', sessions_list: 'library',
  exec: 'servers', process: 'servers', gateway: 'servers', nodes: 'servers', cron: 'servers',
  web_search: 'window', web_fetch: 'window', browser: 'window', image: 'window',
  sessions_spawn: 'whiteboard', sessions_send: 'whiteboard',
};
export const openclawStation = (name) => STATIONS[name] || 'desk';

export function openclawCaption(name, a = {}) {
  switch (name) {
    case 'read': return `Reading ${base(a.path || a.file_path)}`;
    case 'write': return `Writing ${base(a.path || a.file_path)}`;
    case 'edit': case 'apply_patch': return `Editing ${base(a.path || a.file_path) || 'a file'}`;
    case 'exec': return clip(a.command ? `$ ${a.command}` : 'Running a command', 60);
    case 'process': return 'Checking on a process';
    case 'web_search': return `Searching the web: ${clip(a.query, 45)}`;
    case 'web_fetch': try { return `Reading ${new URL(a.url).hostname}`; } catch { return 'Reading a web page'; }
    case 'browser': return 'Using the browser';
    case 'message': return `Messaging ${clip(a.to || a.target || a.channel, 30) || 'someone'}`;
    case 'memory_search': return `Searching memory: ${clip(a.query, 40)}`;
    case 'cron': return 'Scheduling a job';
    case 'sessions_spawn': return 'Starting a helper';
    case 'tts': return 'Recording a voice note';
    default: return `Using ${name}`;
  }
}

// The agent's display name from openclaw.json, else its id.
export function openclawNames(home = openclawHome()) {
  const names = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'openclaw.json'), 'utf8'));
    const def = cfg?.agents?.defaults?.identity?.name || cfg?.identity?.name;
    for (const a of cfg?.agents?.list || []) if (a?.id) names[a.id] = a.identity?.name || a.name || def;
    if (def && !names.main) names.main = def;
  } catch {}
  return names;
}

export function parseOpenclaw(e, file) {
  if (!e || typeof e !== 'object') return null;
  const m = e.message;
  const at = Date.parse(e.timestamp) || (typeof m?.timestamp === 'number' ? m.timestamp : 0) || Date.now();
  const ev = { at, sessionId: file.sessionId, cwd: file.cwd || e.cwd || '' };
  if (e.type === 'session') return e.cwd ? { ...ev, meta: { cwd: e.cwd } } : null;
  if (e.type !== 'message' || !m) return null;
  const parts = Array.isArray(m.content) ? m.content : [];
  if (m.role === 'assistant') {
    const model = typeof m.model === 'string' ? m.model : undefined;
    const call = [...parts].reverse().find((c) => c.type === 'toolCall' || c.type === 'tool_use');
    if (call) {
      const name = String(call.name || 'tool');
      return { ...ev, model, state: 'working', tool: name, station: openclawStation(name), activity: openclawCaption(name, call.arguments || call.input || {}) };
    }
    if (m.stopReason === 'error') return { ...ev, model, state: 'error', tool: '', station: 'lounge', activity: clip(m.errorMessage || 'Hit an error', 160) };
    const text = parts.find((c) => c.type === 'text' && c.text?.trim());
    if (m.stopReason === 'stop' || m.stopReason === 'end_turn') return { ...ev, model, state: 'idle', tool: '', station: 'lounge', activity: text ? clip(text.text, 120) : 'Replied' };
    if (text) return { ...ev, model, state: 'working', tool: '', station: 'desk', activity: clip(text.text, 120) };
    return null;
  }
  if (m.role === 'user') {
    const text = typeof m.content === 'string' ? m.content : parts.find((c) => c.type === 'text')?.text;
    return { ...ev, state: 'working', tool: '', station: 'desk', activity: 'Got a message', ...(text && { title: clip(text, 100) }) };
  }
  return null;
}
