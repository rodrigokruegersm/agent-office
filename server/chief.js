// The chief of staff: a fast model that reads each chat message and decides
// who should handle it, and on how capable a model. It never touches a
// project; it only routes.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// What the chief can actually look at. The API takes an image up to 5 MB once
// base64 has made it a third bigger, and a routing call needs a glance rather
// than a gallery; anything bigger or odder goes by name only, for the agent to
// open with the Read tool.
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE = 3.5 * 1024 * 1024;
const MAX_IMAGES = 4;

// The attachments the chief will be shown, in the order they were sent.
export function canSee(files) {
  return (files || [])
    .filter((f) => IMAGE_TYPES[path.extname(f.name || '').toLowerCase()] && f.size <= MAX_IMAGE)
    .slice(0, MAX_IMAGES);
}

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['followup', 'new', 'dismiss', 'recall', 'clear', 'standup', 'ask', 'chat', 'tabs', 'app', 'session', 'laptop'] },
    // fork: Jarvis's hands on the boss's laptop, and messages to outside sessions.
    tabOp: { type: 'string', enum: ['list', 'open', 'search', 'focus', 'close', 'reload'] },
    url: { type: 'string' },
    query: { type: 'string' },
    app: { type: 'string' },
    sessionId: { type: 'string' },
    jobId: { type: 'string' },
    agentId: { type: 'string' },
    agentIds: { type: 'array', items: { type: 'string' } },
    repo: { type: 'string' },
    brief: { type: 'string' },
    model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] },
    escalate: { type: 'boolean' },
    // More than one piece of new work from a single message, one per job.
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          repo: { type: 'string' },
          brief: { type: 'string' },
          model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] },
          say: { type: 'string' },
        },
        required: ['repo', 'brief'],
        additionalProperties: false,
      },
    },
    say: { type: 'string' },
  },
  required: ['action', 'say'],
  additionalProperties: false,
};

const BASE = `You are the chief of staff in an office of coding agents. The boss posts messages in the office chat. For each one, decide who handles it.

Actions:
- "followup": the message adds to, corrects, or asks about a job that already exists (working, queued or recently finished). Give its jobId. Prefer this whenever the message plausibly relates to an open job, especially the job of an agent the boss tagged. Set "escalate": true only when the boss is saying a finished job's work is wrong, incomplete, or that the agent missed the point — the second go then runs on a stronger model.
- "new": a new piece of work. Give "repo" (exactly one name from Projects), "brief" (the task in the boss's own words, plus any context from recent chat that the agent needs; never add requirements), "agentId" (the tagged agent's id; otherwise a free agent whose role in Staff clearly fits the work; otherwise "" for whoever is free), and "model" (see Sizing the work). Never pick a busy or dismissed agent unless the boss tagged them.
  You can hand out several jobs from one message. When the boss tags more than one agent for work, or asks for separate pieces of work, give "jobs" instead: one entry per job, each with its own "repo", "brief", "agentId", "model" and a short "say" line for that job. Every tagged agent gets a job: the same brief for each when the boss wants them all on it (e.g. two agents doing a review pass), or a part each when the work splits naturally. Never tell the boss you can only hand out one job at a time.
- "dismiss": the boss wants agents sent home (dismissed, let go for now, off the floor). Give "agentIds": the ids of exactly who they mean, worked out from Staff (e.g. "everyone who's free except Mira" means every free agent but Mira). Only free agents can go; leave out anyone working.
- "recall": the boss wants dismissed agents back in. Give "agentIds" (every dismissed agent if they say "everyone").
- "clear": the boss wants agents to clear their context (start fresh, forget the conversation so far). Do it yourself; never hand it out as a job. Give "agentIds" for the agents they name, or leave it empty when they mean everyone.
- "standup": the boss wants the team to hold a standup now (e.g. "standup time", "let's do standup", "gather everyone for a status update").
- "ask": you can't tell which project new work belongs to, or the request is too unclear to start. Ask one short question.
- "chat": greetings, thanks, or questions about the office itself (who is doing what). Answer from the context given. If your answer is about one particular job, give its jobId too, so the boss gets a link to where that job's updates are collecting.

Sizing the work. Most jobs do not need the most capable model, and a smaller one is faster and far cheaper. Pick the cheapest rung that can plausibly finish:
- "haiku": small and mechanical, where the change is already spelled out — wording and copy edits, a rename, a version bump, a log line, a tweak to one named file.
- "sonnet": the ordinary case, and your answer whenever you are unsure. Features, bug fixes, refactors, tests: work that means reading a few files and making a normal judgment call.
- "opus": genuinely hard work — a bug with no obvious cause, a design or architecture decision, security-sensitive code, a change spread across many files, or work the boss has already seen go wrong once.
A job that fails is retried automatically one rung up the ladder, so starting low costs little. Urgency is not difficulty: don't reach for "opus" because the boss sounds in a hurry.

A message you passed to an agent ("Passed to…", "Adding this to…" in the chat) is now theirs and in hand; don't say it is waiting.

Images. A screenshot or mockup the boss attaches is shown to you with the message, so look at it before you decide: it is usually the whole brief. Let what you see set the project, the agent and the model, and say it in plain words in "brief" — "the usage bar is drawn over the avatar in the sidebar" tells the agent far more than "see the screenshot". The file's path travels with the brief, so the agent can open it themselves. Attachments you were not shown (other file types, and voice notes, which reach you as their transcript) you cannot open: route on the boss's words and leave the reading to the agent.

"say" is one short, warm line for the chat, in plain words, e.g. "Ada's on it." or "Passing that to Tunde, it fits what they're doing." Refer to agents only by name or as "they"; never "he", "she", "him" or "her". Never claim work is done, and never call a job done while its agent is still waiting on the boss's answer; say it is waiting on them.`;

// fork: when the chief has a name (OFFICE_CHIEF_NAME, e.g. Jarvis), the boss
// mostly talks to it out loud, it can work the laptop, and it oversees the
// Claude sessions outside the office too.
const JARVIS = (name) => `

Your name is ${name}. You are the boss's right hand. The boss usually talks to you out loud, and your "say" is read aloud to them: one or two short spoken sentences, natural and a little dry, never lists, markdown, ids, paths or URLs unless they ask. Address the boss as "sir" now and then, not every time. The boss's words reach you through speech recognition, so read past small mishearings (a project or agent name that sounds close is that one).

More actions:
- "tabs": work the browser on the boss's laptop. Set "tabOp": "list" (to answer what's open, answer from "Laptop tabs" with "chat" instead when they're listed), "open" with "url" (a full address; for a well-known site use its real address, e.g. "open Gmail" is https://mail.google.com), "search" with "query" (a web search), "focus" to switch to a tab and "close" or "reload" a tab, each with "query": words from that tab's title or address as listed. Say what you did in a few words, e.g. "Opening Gmail."
- "app": bring an app on the laptop to the front, "app": its name (e.g. "Spotify", "WhatsApp", "Claude", "Notion Calendar").
- "session": pass a message to one of the Claude Code sessions listed under "Contractors" (sessions the boss runs outside the office, on this machine or the laptop). Give "sessionId" (exactly as listed) and "brief" (the message, in the boss's words). Only for a session that is idle; if it is working, say it's busy; if it's waiting on the boss, tell them what it is waiting for. Office staff jobs are "followup", never "session".
- "laptop": start a new Claude Code session on the boss's laptop, in one of "Laptop projects". Give "repo" (exactly one name from Laptop projects), "brief" (the task in the boss's words plus context it needs) and "model" (same sizing as office jobs). Use it when the boss says to do it on the laptop, when the project is only on the laptop, or when the context says office jobs can't run. A project in both places goes to the office unless the boss says laptop or the office can't run jobs.
For "what's everyone doing" or "status", answer with "chat" from Staff, Queued, Recently finished and Contractors together, briefly: who's busy on what, anything waiting on the boss first.`;

const systemFor = (name) => (name ? BASE + JARVIS(name) : BASE);

// Routing on the boss's words alone, or on the images too. Only streamed
// input can carry an image, and the CLI answers a stream with a stream, so
// that path reads one JSON object per line and keeps the last one.
export function route(context, { bin = 'claude', model = 'haiku', timeoutMs = 60000, images = [], env = process.env, name = '', remote = null } = {}) {
  const shown = canSee(images);
  const system = systemFor(name);
  // fork: thinking on another machine's login (see Hands.think); words only.
  if (remote) return remote({ model, schema: SCHEMA, system, input: context }).then(({ out, err }) => {
    try {
      const r = JSON.parse(out);
      const decision = r.structured_output || JSON.parse(r.result);
      return { ...decision, cost: r.total_cost_usd || 0 };
    } catch {
      throw new Error(whyNot(out, err || '', false, false, timeoutMs));
    }
  });
  if (!shown.length) return ask(context, { bin, model, timeoutMs, env, system });
  // An image the API won't take (too many pixels, a .png that isn't one)
  // shouldn't cost the boss their answer, so the words go on their own.
  return ask(context, { bin, model, timeoutMs, env, images: shown, system })
    .catch(() => ask(context, { bin, model, timeoutMs, env, system }));
}

function ask(context, { bin, model, timeoutMs, env, images, system }) {
  const streamed = !!images?.length;
  return new Promise((resolve, reject) => {
    const args = [
      '-p', '--model', model,
      '--output-format', streamed ? 'stream-json' : 'json',
      // Streamed output is only allowed with --verbose, and it is the only
      // output format streamed input is allowed with.
      ...(streamed ? ['--input-format', 'stream-json', '--verbose'] : []),
      '--json-schema', JSON.stringify(SCHEMA),
      '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
      '--system-prompt', system,
    ];
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const r = streamed ? result(out) : JSON.parse(out);
        const decision = r.structured_output || JSON.parse(r.result);
        resolve({ ...decision, cost: r.total_cost_usd || 0 });
      } catch {
        reject(new Error(whyNot(out, err, streamed, timedOut, timeoutMs)));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(streamed ? JSON.stringify(message(context, images)) + '\n' : context);
  });
}

// Images first, then the question: the models read a picture better when it
// comes before what is being asked about it.
function message(context, images) {
  const content = images.map((f) => ({
    type: 'image',
    source: { type: 'base64', media_type: IMAGE_TYPES[path.extname(f.name).toLowerCase()], data: fs.readFileSync(f.path).toString('base64') },
  }));
  content.push({ type: 'text', text: context });
  return { type: 'user', message: { role: 'user', content } };
}

// The decision is in the last line of the stream, the one the run ends on.
// Why a routing call gave no decision, in words the boss can act on. claude
// reports most failures (not signed in, out of credit, a model the account
// can't use) inside its JSON on stdout with nothing on stderr, so read that
// before falling back.
function whyNot(out, err, streamed, timedOut, timeoutMs) {
  if (timedOut) return `The chief took longer than ${Math.round(timeoutMs / 1000)} seconds to answer. Check that \`claude -p "hi"\` answers in a terminal.`;
  let r = null;
  try { r = streamed ? result(out) : JSON.parse(out); } catch {}
  const said = String(r?.is_error ? r.result || r.subtype || '' : '').trim();
  if (said) return `claude said: ${said.split('\n')[0].slice(0, 300)}`;
  const last = err.trim().split('\n').pop();
  if (last) return last.slice(0, 300);
  return out.trim() ? 'The chief could not decide.' : 'claude exited without answering. Check that `claude -p "hi"` answers in a terminal.';
}

function result(out) {
  for (const line of out.trim().split('\n').reverse()) {
    try {
      const o = JSON.parse(line);
      if (o.type === 'result') return o;
    } catch {}
  }
  throw new Error('The stream carried no result.');
}

// fork: Jarvis kept warm. One `claude` process stays up between messages, so
// a spoken request skips the CLI's startup: each message is a new turn on it,
// carrying the office as it is now. It starts over every few turns (the
// history only costs tokens), when the model changes, or if it dies.
export class WarmChief {
  constructor({ bin = 'claude', env = () => process.env, name = '', maxTurns = 12 } = {}) {
    Object.assign(this, { bin, env, name, maxTurns });
    this.child = null;
    this.chain = Promise.resolve();
  }

  start(model) {
    this.stop();
    const args = ['-p', '--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--json-schema', JSON.stringify(SCHEMA),
      '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
      '--system-prompt', systemFor(this.name) + `\n\nEach message carries the office as it is right now; earlier messages are only history. Decide on the newest one.`];
    const child = spawn(this.bin, args, { env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.model = model;
    this.turns = 0;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'result' && this.waiting) {
          const w = this.waiting;
          this.waiting = null;
          try {
            const decision = e.structured_output || JSON.parse(e.result);
            w.resolve({ ...decision, cost: e.total_cost_usd || 0 });
          } catch {
            w.reject(new Error(e.is_error ? `claude said: ${String(e.result || e.subtype).split('\n')[0].slice(0, 300)}` : 'The chief could not decide.'));
          }
        }
      }
    });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (this.child === child) {
        this.child = null;
        if (code) console.warn(`[jarvis] warm chief stopped (${code}): ${err.trim().split('\n').pop() || buf.slice(-200)}`);
      }
      if (this.waiting) { this.waiting.reject(new Error('The chief stopped mid-thought.')); this.waiting = null; }
    });
    child.on('error', () => {});
  }

  stop() {
    if (this.child) { const c = this.child; this.child = null; c.kill('SIGTERM'); }
  }

  // Ready for the first spoken word, not starting on it.
  warm(model) { if (!this.child) this.start(model); }

  ask(context, { model = 'haiku', timeoutMs = 45_000 } = {}) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.child || this.model !== model || this.turns >= this.maxTurns) this.start(model);
      const timer = setTimeout(() => { this.stop(); reject(new Error(`The chief took longer than ${Math.round(timeoutMs / 1000)} seconds to answer.`)); }, timeoutMs);
      this.waiting = {
        resolve: (v) => { clearTimeout(timer); this.turns++; resolve(v); if (this.turns >= this.maxTurns) setImmediate(() => this.start(model)); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: context } }) + '\n');
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
}
