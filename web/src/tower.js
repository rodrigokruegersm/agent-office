// fork: the building. One floor per area of the boss's work (server/
// departments.js), each project a room with whoever is working in it right
// now: office agents on jobs and the boss's own Claude sessions. Jarvis has
// the lobby; the cron watchdogs live in the basement. It's the main view of a
// Jarvis office; the 3D floor is a click away.

import './tower.css';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const RECENT = 6 * 60 * 60 * 1000; // finished work stays on its desk this long
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };

// Where a contractor's work lives: its folder's name.
const projectOf = (a) => (a.cwd ? a.cwd.split('/').filter(Boolean).pop() : String(a.project || '').split(' · ')[0]) || '';

export class Tower {
  constructor({ app, external, view }) {
    Object.assign(this, { app, external });
    this.building = null;
    this.on = store('tower.on') !== '0';

    this.root = el('div', 'tower');
    this.root.hidden = true;
    view.appendChild(this.root);

    this.toggle = el('div', 'tower-toggle');
    this.toggle.hidden = true;
    this.toggle.setAttribute('role', 'group');
    this.toggle.setAttribute('aria-label', 'View');
    for (const [k, label] of [['tower', 'Building'], ['office', '3D office']]) {
      const b = el('button', null, label);
      b.type = 'button';
      b.dataset.k = k;
      b.addEventListener('click', () => this.show(k === 'tower'));
      this.toggle.append(b);
    }
    view.appendChild(this.toggle);
    this.root.addEventListener('click', (e) => this.click(e));
    setInterval(() => this.render(), 1500);
  }

  handle(msg) {
    if (msg.t === 'hello') this.setBuilding(msg.building);
    if (msg.t === 'building') this.setBuilding(msg.building);
  }

  setBuilding(b) {
    this.building = b && Array.isArray(b.floors) ? b : null;
    this.toggle.hidden = !this.building;
    this.show(this.building ? this.on : false, false);
  }

  show(on, remember = true) {
    this.on = on;
    if (remember) store('tower.on', on ? '1' : '0');
    this.root.hidden = !on || !this.building;
    for (const b of this.toggle.children) b.classList.toggle('on', (b.dataset.k === 'tower') === (on && !!this.building));
    this.stamp = '';
    this.render();
  }

  // ---------- what's on each floor ----------

  rooms() {
    const jobs = [...this.app.jobs.values()];
    const outside = this.external.agents || [];
    const now = Date.now();
    const rooms = new Map(); // project -> { work: [...], done: job|null }
    const room = (name) => { if (!rooms.has(name)) rooms.set(name, { work: [], done: null }); return rooms.get(name); };
    for (const j of jobs) {
      if (!j.repo) continue;
      if (j.status === 'working' || j.status === 'queued') {
        const s = this.app.staff.find((x) => x.id === j.agentId);
        const last = [...(j.log || [])].reverse().find((e) => e.kind === 'tool' || e.kind === 'text');
        room(j.repo).work.push({
          kind: 'job', id: j.id, who: s?.name || (j.status === 'queued' ? 'Queued' : 'Agent'), color: s?.shirt || '#8a8f9c',
          state: j.status === 'queued' ? 'queued' : j.waiting || j.approval ? 'waiting' : 'working',
          doing: j.approval ? `Wants approval: ${j.approval.tool}` : last ? last.summary : j.title, title: j.title, model: j.model,
        });
      } else if (j.endedAt && now - j.endedAt < RECENT) {
        const r = room(j.repo);
        if (!r.done || r.done.endedAt < j.endedAt) r.done = j;
      }
    }
    for (const a of outside) {
      if (a.source !== 'claude') continue;
      const p = projectOf(a);
      if (!p) continue;
      if (a.state === 'idle' && now - a.updated > RECENT) continue;
      room(p).work.push({
        kind: 'session', id: a.id, who: a.name, color: '#d97757', state: a.state,
        doing: a.activity, title: a.title, host: a.host,
      });
    }
    return rooms;
  }

  // ---------- drawing ----------

  render() {
    if (this.root.hidden || !this.building) return;
    const rooms = this.rooms();
    const crons = (this.external.agents || []).filter((a) => a.source !== 'claude');
    const needs = (this.external.agents || []).filter((a) => !a.seen && (a.state === 'waiting' || a.state === 'error')).length
      + [...this.app.jobs.values()].filter((j) => j.status === 'working' && (j.waiting || j.approval)).length;
    const stamp = JSON.stringify([this.building, [...rooms], crons.map((c) => [c.id, c.state, c.activity]), needs, Math.floor(Date.now() / 60000)]);
    if (stamp === this.stamp) return;
    this.stamp = stamp;

    const tower = el('div', 'tw-building');
    const roof = el('div', 'tw-roof');
    roof.append(el('div', 'tw-sign', `${this.app.ownerName || 'The'} HQ`), el('div', 'tw-sub', this.building.laptopUp ? 'MacBook connected' : 'MacBook away: its projects wait'));
    tower.append(roof);

    this.building.floors.forEach((f, i) => tower.append(this.floor(f, this.building.floors.length - i, rooms)));
    tower.append(this.lobby(needs), this.basement(crons));
    this.root.replaceChildren(tower);
  }

  floor(f, n, rooms) {
    const floor = el('section', 'tw-floor');
    floor.style.setProperty('--fc', f.color);
    const projects = f.projects.map((p) => ({ ...p, room: rooms.get(p.name) || { work: [], done: null } }));
    // Busy rooms first, then the ones with something recent to show.
    const rank = (p) => (p.room.work.some((w) => w.state === 'waiting' || w.state === 'error') ? 0 : p.room.work.length ? 1 : p.room.done ? 2 : 3);
    projects.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const busy = projects.reduce((n, p) => n + p.room.work.filter((w) => w.state === 'working').length, 0);
    const waiting = projects.reduce((n, p) => n + p.room.work.filter((w) => w.state === 'waiting' || w.state === 'error').length, 0);

    const label = el('header', 'tw-label');
    label.append(el('span', 'tw-num', String(n)), el('span', 'tw-name', f.name));
    const counts = el('span', 'tw-counts');
    counts.textContent = [busy && `${busy} working`, waiting && `${waiting} need${waiting === 1 ? 's' : ''} you`].filter(Boolean).join(' · ') || 'quiet';
    if (waiting) counts.classList.add('alert');
    label.append(counts);
    if (f.about) label.title = f.about;

    const row = el('div', 'tw-rooms');
    for (const p of projects) row.append(this.room(p));
    if (!projects.length) row.append(el('div', 'tw-empty', 'No projects on this floor yet'));
    floor.append(label, row);
    return floor;
  }

  room(p) {
    const { work, done } = p.room;
    const state = work.some((w) => w.state === 'waiting' || w.state === 'error') ? 'waiting' : work.some((w) => w.state === 'working') ? 'working' : work.length ? 'queued' : 'idle';
    const card = el('button', `tw-room ${state}`);
    card.type = 'button';
    const head = el('div', 'tw-room-head');
    head.append(el('i', 'tw-dot'), el('span', 'tw-room-name', p.name), el('span', 'tw-host', p.host === 'laptop' ? 'MacBook' : 'Mac mini'));
    card.append(head);
    if (work.length) {
      for (const w of work.slice(0, 3)) {
        const line = el('div', `tw-worker ${w.state}`);
        line.dataset.kind = w.kind;
        line.dataset.id = w.id;
        const face = el('span', 'tw-face', (w.who || '?').slice(0, 1).toUpperCase());
        face.style.background = w.color;
        const text = el('div', 'tw-worker-text');
        text.append(el('span', 'tw-who', w.kind === 'session' ? `${w.who} · session` : w.who), el('span', 'tw-doing', w.doing || w.title || ''));
        line.append(face, text);
        line.title = w.title || '';
        card.append(line);
      }
      if (work.length > 3) card.append(el('div', 'tw-more', `+${work.length - 3} more`));
    } else if (done) {
      const line = el('div', `tw-done ${done.status}`);
      line.dataset.kind = 'job';
      line.dataset.id = done.id;
      line.textContent = `${done.status === 'done' ? '✓' : done.status === 'failed' ? '✕' : '■'} ${done.title} · ${ago(done.endedAt)}`;
      card.append(line);
    } else {
      card.append(el('div', 'tw-quiet', 'Nobody here right now'));
    }
    card.dataset.project = p.name;
    return card;
  }

  lobby(needs) {
    const lobby = el('section', 'tw-floor tw-lobby');
    lobby.style.setProperty('--fc', '#22c3ee');
    const label = el('header', 'tw-label');
    label.append(el('span', 'tw-num', 'L'), el('span', 'tw-name', 'Lobby'));
    const desk = el('div', 'tw-rooms');
    const jarvis = el('div', 'tw-room tw-jarvis');
    const face = el('span', 'tw-face', 'J');
    face.style.background = '#2b2d42';
    const t = el('div', 'tw-worker-text');
    t.append(el('span', 'tw-who', `${this.app.chiefName || 'Jarvis'} · reception`), el('span', 'tw-doing', needs ? `${needs} thing${needs === 1 ? '' : 's'} waiting on you` : 'Nothing waiting on you'));
    const line = el('div', 'tw-worker');
    line.append(face, t);
    jarvis.append(line);
    if (needs) jarvis.classList.add('waiting');
    desk.append(jarvis);
    lobby.append(label, desk);
    return lobby;
  }

  basement(crons) {
    const b = el('section', 'tw-floor tw-basement');
    b.style.setProperty('--fc', '#64748b');
    const label = el('header', 'tw-label');
    const failing = crons.filter((c) => c.state === 'error' && !c.seen).length;
    const counts = el('span', 'tw-counts', failing ? `${failing} failing` : `${crons.length} watchdogs`);
    if (failing) counts.classList.add('alert');
    label.append(el('span', 'tw-num', 'B'), el('span', 'tw-name', 'Ops'), counts);
    const racks = el('div', 'tw-racks');
    for (const c of crons.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = el('button', `tw-rack ${c.state}`);
      r.type = 'button';
      r.dataset.kind = 'session';
      r.dataset.id = c.id;
      r.append(el('i', 'tw-dot'), el('span', null, c.name));
      r.title = `${c.activity || c.state} · ${ago(c.updated)}`;
      racks.append(r);
    }
    if (!crons.length) racks.append(el('div', 'tw-empty', 'No watchdogs reporting'));
    b.append(label, racks);
    return b;
  }

  click(e) {
    const t = e.target.closest('[data-kind]');
    if (t?.dataset.kind === 'job') return this.app.openJob(t.dataset.id);
    if (t?.dataset.kind === 'session') return this.external.open(t.dataset.id);
    const room = e.target.closest('.tw-room[data-project]');
    if (room) {
      // A quiet room: the project's latest job, if it has one.
      const last = [...this.app.jobs.values()].filter((j) => j.repo === room.dataset.project).sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt))[0];
      if (last) this.app.openJob(last.id);
    }
  }
}
