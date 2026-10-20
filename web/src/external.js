import * as THREE from 'three';
import { Agent } from './agent.js';
import './external.css';

// fork: agents the office didn't start (server/observe), as contractors. The
// server sends `{ t: 'external', agents: [...] }` whenever one changes.
//
// They have no desk of their own. Working, they go where their latest tool
// says (library, server room, research window, whiteboard) or to a guest
// desk; waiting on the boss or failed, they stand at the guest table with a
// red bubble; idle, they hang about the guest coffee bar. The ones waiting or
// failed are also listed in the "Needs you" queue at the top of the screen.

const MAX = 14;
const TINTS = { claude: '#d97757', openclaw: '#e5484d', hermes: '#8b5cf6', cron: '#3b82f6' };
const OTHER = ['#0e9f9a', '#c98a12', '#65a30d', '#d9488f'];
const LOOKS = [
  { shirt: '#f2efe9', hair: '#2b2118', skin: '#e0b48f' },
  { shirt: '#3d4a5c', hair: '#5a3b22', skin: '#c68e63' },
  { shirt: '#6b8f71', hair: '#1c1714', skin: '#8d5a3b' },
  { shirt: '#b5654a', hair: '#d8b26e', skin: '#f0cfae' },
  { shirt: '#4b5ea8', hair: '#3b2f2a', skin: '#a8704c' },
];
const SOURCES = { claude: 'Claude Code', openclaw: 'OpenClaw', hermes: 'Hermes', cron: 'Scheduled job' };
const STATIONS = new Set(['library', 'servers', 'window', 'whiteboard']);
const STATE_WORDS = { working: 'Working', waiting: 'Needs you', idle: 'Idle', error: 'Failed' };

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

class Contractor extends Agent {
  constructor(info, tint, world, labels, instant) {
    const look = LOOKS[hash(info.id) % LOOKS.length];
    super({ id: 'contractor', name: '', ...look }, world, labels, { desk: { seat: world.door.clone(), seatY: 0 } });
    this.key = info.id;
    this.id = info.id;
    this.root.traverse((o) => { o.userData.agentId = this.key; o.userData.external = this.key; });
    this.tint = tint;
    this.chatAt = Infinity; // they're here to work, not for small talk

    this.ring.material.color.set(tint);
    this.ring.material.opacity = 0.7;
    this.ring.visible = true;

    this.label.classList.add('external');
    this.label.style.setProperty('--tint', tint);
    const name = this.label.querySelector('.name');
    name.replaceChildren();
    const dot = el('i');
    dot.style.background = tint;
    this.nameEl = el('span');
    this.srcEl = el('span', 'handle');
    name.append(dot, this.nameEl, this.srcEl);
    this.set(info);
    if (instant) { this.teleport(this.want); return; }
    this.teleport('door');
  }

  set(info) {
    const was = this.info;
    this.info = info;
    this.name = info.name;
    if (this.nameEl.textContent !== info.name) { this.nameEl.textContent = info.name; this.labelDirty = true; }
    const src = ` · ${SOURCES[info.source] || info.source}`;
    if (this.srcEl.textContent !== src) { this.srcEl.textContent = src; this.labelDirty = true; }
    this.label.classList.toggle('alert', info.state === 'waiting' || info.state === 'error');
    if (this.leaving) this.leaving = false;
    this.want = this.place(info);
    if (was?.activity === info.activity && was?.state === info.state) return;
    const text = info.activity || STATE_WORDS[info.state];
    if (info.state === 'waiting') this.say(text.length > 40 ? 'Needs you' : text, 'warn', 0);
    else if (info.state === 'error') this.say('Hit a wall', 'warn', 0);
    else if (info.state === 'working') this.say(text.length > 34 ? text.slice(0, 33) + '…' : text, info.station === 'desk' && /^Thinking/.test(text) ? 'thinking' : '', 6000);
    else this.say('', '', 0);
  }

  place(info) {
    if (info.state === 'working') {
      const order = STATIONS.has(info.station) ? [info.station, 'hotdesk'] : ['hotdesk', 'huddle'];
      return order.find((k) => this.roomAt(k)) || 'hotdesk';
    }
    if (info.state === 'waiting' || info.state === 'error') return this.roomAt('huddle') ? 'huddle' : 'coffee';
    return this.roomAt('coffee') ? 'coffee' : 'lounge';
  }

  roomAt(key) {
    const s = this.world.stations[key];
    return !!s && s.spots.some((p) => !p.game && (!p.taken || p.taken === this.id));
  }

  resolve(key, fresh) {
    // Nowhere free: wait in the lobby rather than take someone's desk.
    const r = key === 'desk' ? null : super.resolve(key, fresh);
    if (r && r.key !== 'desk') return r;
    if (this.spot) { this.spot.taken = null; this.spot = null; }
    const lobby = this.world.door.clone().add(new THREE.Vector3(1.4 + Math.random() * 1.8, 0, -1.6 + Math.random() * 0.8));
    return { key, pos: lobby, face: Math.atan2(-lobby.x, -lobby.z), pose: 'stand' };
  }

  animate(pose, dt, t) {
    // Typing at a guest desk while working, like the staff.
    this.job = this.info?.state === 'working' ? { id: 'ext' } : null;
    super.animate(pose, dt, t);
  }
}

export class External {
  constructor({ world, labels, camera, canvas, api, notify, sound }) {
    Object.assign(this, { world, labels, camera, canvas, api, notify, sound });
    this.on = new Map();
    this.agents = [];
    this.list = [];
    this.first = true;
    this.tints = new Map();
    this.openId = null;

    this.card = el('div', 'visitor-card');
    this.card.hidden = true;
    labels.appendChild(this.card);
    this.ray = new THREE.Raycaster();
    canvas.addEventListener('pointermove', (e) => this.hover(e));
    canvas.addEventListener('pointerleave', () => { this.card.hidden = true; });
    canvas.addEventListener('pointerup', (e) => this.click(e));

    this.queue = el('section', 'needs-you');
    this.queue.hidden = true;
    this.queue.setAttribute('aria-live', 'polite');
    // Inside the office view, so on a phone they sit above the bottom bar.
    const view = canvas.closest('.view') || document.body;
    view.appendChild(this.queue);

    this.panel = el('aside', 'ext-panel');
    this.panel.hidden = true;
    view.appendChild(this.panel);
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.panel.hidden) this.close(); });
    // Ages in the queue and panel go stale; redraw them now and then.
    setInterval(() => { this.renderQueue(true); if (this.openId) this.renderPanel(true); }, 30_000);
  }

  handle(msg) {
    if (msg.t === 'external') { this.receive(msg.agents); return true; }
    if (msg.t === 'hello') { this.receive(msg.external || [], this.first); this.first = false; }
    return false;
  }

  tintOf(source) {
    if (TINTS[source]) return TINTS[source];
    if (!this.tints.has(source)) this.tints.set(source, OTHER[this.tints.size % OTHER.length]);
    return this.tints.get(source);
  }

  receive(raw, instant = false) {
    const before = new Map(this.agents.map((a) => [a.id, a.state]));
    this.agents = (Array.isArray(raw) ? raw : []).filter((a) => a && typeof a.id === 'string').map((a) => ({
      id: clip(a.id, 120), source: clip(a.source, 24), name: clip(a.name, 40) || 'Agent', project: clip(a.project, 60),
      title: clip(a.title, 120), state: STATE_WORDS[a.state] ? a.state : 'idle', station: clip(a.station, 20),
      activity: clip(a.activity, 200), tool: clip(a.tool, 80), model: clip(a.model, 40), sessionId: clip(a.sessionId, 80),
      since: +a.since || Date.now(), updated: +a.updated || Date.now(), seen: a.seen === true,
      log: (Array.isArray(a.log) ? a.log : []).slice(-12).map((l) => ({ at: +l.at || 0, summary: clip(l.summary, 200), state: clip(l.state, 12) })),
    }));

    // Newly waiting or failed: tell the boss, even with the tab in the background.
    if (!instant) {
      for (const a of this.agents) {
        const was = before.get(a.id);
        if (was === a.state || a.seen || (a.state !== 'waiting' && a.state !== 'error')) continue;
        this.sound?.knock?.();
        this.notify?.(a.state === 'waiting' ? `${a.name} needs you` : `${a.name} failed`, a.activity || SOURCES[a.source] || a.source);
      }
    }

    // On the floor: whoever needs the boss first, then working, then the
    // most recent idlers, up to MAX.
    const rank = { waiting: 0, error: 0, working: 1, idle: 2 };
    const shown = this.agents.slice().sort((a, b) => rank[a.state] - rank[b.state] || b.updated - a.updated).slice(0, MAX);
    const keep = new Set(shown.map((a) => a.id));
    for (const c of this.on.values()) if (!keep.has(c.key)) c.leave();
    for (const a of shown) {
      const c = this.on.get(a.id);
      if (c) c.set(a);
      else this.on.set(a.id, new Contractor(a, this.tintOf(a.source), this.world, this.labels, instant));
    }
    this.list = [...this.on.values()];
    this.renderQueue();
    if (this.openId) this.renderPanel();
  }

  update(dt, t) {
    for (const c of this.on.values()) {
      c.update(dt, t);
      if (!c.gone) continue;
      c.dispose();
      this.on.delete(c.key);
      this.list = [...this.on.values()];
    }
  }

  // ---------- the "Needs you" queue ----------

  // Only redrawn when what it shows changes: busy sessions send updates
  // every few seconds, and a list rebuilt under the pointer eats clicks.
  renderQueue(force = false) {
    const need = this.agents.filter((a) => !a.seen && (a.state === 'waiting' || a.state === 'error')).sort((a, b) => b.updated - a.updated);
    const stamp = JSON.stringify(need.map((a) => [a.id, a.state, a.activity, a.name]));
    if (!force && stamp === this.queueStamp) return;
    this.queueStamp = stamp;
    this.queue.hidden = !need.length;
    if (!need.length) { this.queue.replaceChildren(); return; }
    const head = el('header', null);
    head.append(el('strong', null, 'Needs you'), el('span', 'count', String(need.length)));
    const items = need.slice(0, 6).map((a) => {
      const row = el('div', `nq-item ${a.state}`);
      row.style.setProperty('--tint', this.tintOf(a.source));
      const open = el('button', 'nq-open');
      open.type = 'button';
      open.append(el('span', 'nq-who', `${a.name} · ${SOURCES[a.source] || a.source}`), el('span', 'nq-what', a.activity || STATE_WORDS[a.state]), el('span', 'nq-when', ago(a.updated)));
      open.addEventListener('click', () => this.open(a.id));
      const dismiss = el('button', 'nq-dismiss', '×');
      dismiss.type = 'button';
      dismiss.title = a.state === 'error' ? 'Mark as seen' : 'Hide until it changes';
      dismiss.setAttribute('aria-label', dismiss.title);
      dismiss.addEventListener('click', () => this.api('/api/external/dismiss', { id: a.id }).catch(() => {}));
      row.append(open, dismiss);
      return row;
    });
    if (need.length > 6) items.push(el('div', 'nq-more', `+${need.length - 6} more`));
    this.queue.replaceChildren(head, ...items);
  }

  // ---------- detail panel ----------

  open(id) {
    this.openId = id;
    this.renderPanel(true);
    const c = this.on.get(id);
    if (c) c.say(c.bubbleText || '👋', c.bubbleEl.className.includes('warn') ? 'warn' : '', 2500);
  }

  close() {
    this.openId = null;
    this.panel.hidden = true;
  }

  renderPanel(force = false) {
    const a = this.agents.find((x) => x.id === this.openId);
    if (!a) { this.close(); return; }
    const stamp = JSON.stringify(a);
    if (!force && stamp === this.panelStamp && !this.panel.hidden) return;
    this.panelStamp = stamp;
    this.panel.hidden = false;
    this.panel.style.setProperty('--tint', this.tintOf(a.source));
    const close = el('button', 'xp-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.close());
    const head = el('header');
    head.append(el('div', 'xp-who', a.name), close);
    const meta = el('div', 'xp-meta', [SOURCES[a.source] || a.source, a.project, a.model].filter(Boolean).join(' · '));
    const state = el('div', `xp-state ${a.state}`, `${STATE_WORDS[a.state]} · since ${ago(a.since)}`);
    const parts = [head, meta, state];
    if (a.title) parts.push(el('div', 'xp-title', a.title));
    if (a.activity) parts.push(el('div', 'xp-now', a.activity));
    if (a.sessionId && a.source === 'claude') {
      const cmd = `claude --resume ${a.sessionId}`;
      const copy = el('button', 'xp-copy', cmd);
      copy.type = 'button';
      copy.title = 'Copy: run it on the machine where the session lives to pick it up';
      copy.addEventListener('click', () => navigator.clipboard?.writeText(cmd).then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = cmd; }, 1500); }).catch(() => {}));
      parts.push(copy);
    }
    const log = el('ol', 'xp-log');
    for (const l of a.log.slice().reverse()) {
      const li = el('li', l.state);
      li.append(el('span', 'xp-at', new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), el('span', null, l.summary));
      log.append(li);
    }
    parts.push(el('div', 'xp-sub', 'Recent'), log);
    if ((a.state === 'error' || a.state === 'waiting') && !a.seen) {
      const b = el('button', 'xp-dismiss', a.state === 'error' ? 'Mark as seen' : 'Hide from the queue');
      b.type = 'button';
      b.addEventListener('click', () => this.api('/api/external/dismiss', { id: a.id }).catch(() => {}));
      parts.push(b);
    }
    this.panel.replaceChildren(...parts);
  }

  // ---------- pointer ----------

  pick(e) {
    if (!this.list.length) return null;
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = this.ray.intersectObjects(this.list.map((c) => c.root), true)[0];
    return hit ? this.on.get(hit.object.userData.external) : null;
  }

  click(e) {
    if (e.button !== 0) return;
    const c = this.pick(e);
    if (c) this.open(c.key);
  }

  hover(e) {
    if (e.buttons) { this.card.hidden = true; return; }
    const c = this.pick(e);
    if (!c) { this.card.hidden = true; return; }
    const a = c.info;
    this.card.style.setProperty('--tint', c.tint);
    this.card.replaceChildren(
      el('div', 'vc-who', `${a.name} · ${SOURCES[a.source] || a.source}`),
      el('div', 'vc-role', a.project || a.title || 'Contractor'),
      el('div', 'vc-job', a.activity || STATE_WORDS[a.state]),
      el('div', 'vc-state', `${STATE_WORDS[a.state]} · ${ago(a.updated)} · click for details`),
    );
    this.card.hidden = false;
    const r = this.canvas.getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    if (x + this.card.offsetWidth > r.width - 8) x -= this.card.offsetWidth + 28;
    if (y + this.card.offsetHeight > r.height - 8) y -= this.card.offsetHeight + 28;
    this.card.style.transform = `translate(${x}px, ${y}px)`;
    this.canvas.style.cursor = 'pointer';
  }
}
