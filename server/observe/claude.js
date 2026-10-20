// Tails Claude Code's session transcripts (~/.claude/projects/<project>/<session>.jsonl)
// and turns each new line into "this session is now doing X". A transcript
// line is the same message the office reads from its own jobs' stream, so the
// captions and stations come from the same tools.js.
//
// Only the top-level <session>.jsonl files: a sub-agent's transcript sits in
// <session>/subagents/ and its work already shows as the parent's Task call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stationFor, summarizeTool } from '../tools.js';

const HOT = 30 * 60_000; // files written in the last half hour are watched
const POLL = 2000; // how often hot files are checked for new lines
const RESCAN = 30_000; // how often the folders are listed for new sessions
const TAIL = 256 * 1024; // how far back a newly found session is read
const READ_MAX = 1024 * 1024; // the most read from one file in one poll

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
// <session>.jsonl only: OpenClaw keeps <session>.trajectory.jsonl and the like beside them.
const isTranscript = (name) => name.endsWith('.jsonl') && !path.basename(name, '.jsonl').includes('.');

// Tools that stop the session until the boss answers.
const ASKS = { AskUserQuestion: 'Asking you a question', ExitPlanMode: 'Plan ready for your review' };

export function defaultClaudeDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

// One transcript line to one event, or null for lines that say nothing about
// what the session is doing (snapshots, attachments, sub-agent chatter).
export function parseLine(e, file) {
  if (!e || typeof e !== 'object' || e.isSidechain) return null;
  const at = Date.parse(e.timestamp) || Date.now();
  const base = { at, sessionId: e.sessionId || file.sessionId, cwd: e.cwd || file.cwd };
  if (e.type === 'agent-name' && e.agentName) return { ...base, meta: { name: clip(e.agentName, 40) } };
  if (e.type === 'custom-title' && e.customTitle) return { ...base, meta: { name: file.name || clip(e.customTitle, 40) } };
  if (e.type === 'last-prompt' && e.lastPrompt) return { ...base, meta: { title: clip(e.lastPrompt, 100) } };

  const m = e.message;
  if (e.type === 'assistant' && m && Array.isArray(m.content)) {
    const model = typeof m.model === 'string' ? m.model : undefined;
    const tool = m.content.findLast?.((c) => c.type === 'tool_use') ?? [...m.content].reverse().find((c) => c.type === 'tool_use');
    if (tool) {
      if (ASKS[tool.name]) return { ...base, model, state: 'waiting', tool: tool.name, station: 'whiteboard', activity: ASKS[tool.name] };
      return { ...base, model, state: 'working', tool: tool.name, station: stationFor(tool.name), activity: summarizeTool(tool.name, tool.input || {}) };
    }
    const text = m.content.find((c) => c.type === 'text' && c.text?.trim());
    if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') {
      return { ...base, model, state: 'idle', tool: '', station: 'lounge', activity: text ? clip(text.text, 120) : 'Finished — your turn' };
    }
    if (text) return { ...base, model, state: 'working', tool: '', station: 'desk', activity: clip(text.text, 120) };
    if (m.content.some((c) => c.type === 'thinking')) return { ...base, model, state: 'working', tool: '', station: 'desk', activity: 'Thinking…' };
    return null;
  }
  if (e.type === 'user' && m && !e.isMeta) {
    const c = m.content;
    const prompt = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p) => p.type === 'text')?.text : '';
    // Tool results and the harness's own notes (<system-reminder>, command
    // output) aren't the boss asking for something.
    if (prompt && !prompt.trimStart().startsWith('<')) {
      return { ...base, state: 'working', tool: '', station: 'desk', activity: 'Got a new request', title: clip(prompt, 100) };
    }
    if (Array.isArray(c) && c.some((p) => p.type === 'tool_result' && p.is_error && /permission|denied|rejected/i.test(JSON.stringify(p.content ?? '')))) {
      return { ...base, state: 'working', station: 'desk', activity: 'A tool was refused' };
    }
  }
  return null;
}

// Watches one folder of JSONL transcripts. Claude Code's are
// <dir>/<project>/<session>.jsonl; other agents pass their own layout
// (`depth`, how many folders down the files sit, and `sub`, a folder name
// between, like OpenClaw's <agent>/sessions/<id>.jsonl) and their own parse.
export class TranscriptWatcher {
  constructor({ dir = defaultClaudeDir(), skip = () => false, onEvent, parse = parseLine, sub = '', fileInfo = () => ({}) }) {
    Object.assign(this, { dir, skip, onEvent, parse, sub, fileInfo });
    this.files = new Map(); // path -> { offset, partial, sessionId, cwd, name, title, mtime }
    this.hot = new Set();
  }

  start() {
    this.rescan();
    this.pollTimer = setInterval(() => this.poll(), POLL);
    this.scanTimer = setInterval(() => this.rescan(), RESCAN);
    this.pollTimer.unref?.();
    this.scanTimer.unref?.();
    // macOS and Windows watch a whole tree; elsewhere the rescan finds new
    // sessions, just later.
    try {
      this.fsw = fs.watch(this.dir, { recursive: true }, (_, name) => {
        if (!name || !isTranscript(name) || name.split(path.sep).length !== (this.sub ? 3 : 2)) return;
        if (this.sub && name.split(path.sep)[1] !== this.sub) return;
        this.hot.add(path.join(this.dir, name));
      });
      this.fsw.on('error', () => {});
    } catch {}
  }

  stop() {
    clearInterval(this.pollTimer);
    clearInterval(this.scanTimer);
    this.fsw?.close();
  }

  rescan() {
    let projects;
    try { projects = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return; }
    const since = Date.now() - HOT;
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const pdir = path.join(this.dir, p.name, this.sub);
      let names;
      try { names = fs.readdirSync(pdir); } catch { continue; }
      for (const n of names) {
        if (!isTranscript(n)) continue;
        const f = path.join(pdir, n);
        try { if (fs.statSync(f).mtimeMs >= since) this.hot.add(f); } catch {}
      }
    }
    this.poll();
  }

  poll() {
    const since = Date.now() - HOT;
    for (const f of this.hot) {
      let st;
      try { st = fs.statSync(f); } catch { this.hot.delete(f); this.files.delete(f); continue; }
      if (st.mtimeMs < since) { this.hot.delete(f); continue; }
      let file = this.files.get(f);
      if (!file) {
        file = { offset: Math.max(0, st.size - TAIL), partial: '', sessionId: path.basename(f, '.jsonl'), cwd: '', name: '', title: '', skipFirst: st.size > TAIL, ...this.fileInfo(f) };
        this.files.set(f, file);
      }
      if (st.size < file.offset) Object.assign(file, { offset: 0, partial: '', skipFirst: false }); // rewritten
      if (st.size === file.offset) continue;
      if (this.skip(file.sessionId)) { file.offset = st.size; continue; }
      this.read(f, file, Math.min(st.size, file.offset + READ_MAX));
    }
  }

  read(f, file, end) {
    let buf;
    try {
      const fd = fs.openSync(f, 'r');
      try {
        buf = Buffer.alloc(end - file.offset);
        fs.readSync(fd, buf, 0, buf.length, file.offset);
      } finally { fs.closeSync(fd); }
    } catch { return; }
    file.offset = end;
    const lines = (file.partial + buf.toString('utf8')).split('\n');
    file.partial = lines.pop();
    // Reading from the middle of a file starts mid-line.
    if (file.skipFirst) { lines.shift(); file.skipFirst = false; }
    let last = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const ev = this.parse(e, file);
      if (!ev) continue;
      if (ev.cwd) file.cwd = ev.cwd;
      if (ev.meta) { Object.assign(file, ev.meta); continue; }
      if (ev.title) file.title = ev.title;
      last = ev;
      // Catching up on a backlog, only the newest line matters for where they
      // stand, but each step still goes in the log.
      this.onEvent({ ...ev, source: file.source, name: file.name, title: file.title });
    }
    if (!last && (file.name || file.title) && file.cwd) {
      // A rename with nothing else new still updates the label.
      this.onEvent({ at: Date.now(), source: file.source, sessionId: file.sessionId, cwd: file.cwd, name: file.name, title: file.title, meta: true });
    }
  }
}
