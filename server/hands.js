// fork: the office's side of Jarvis's hands (bin/jarvis-hands.js), which
// runs on the boss's laptop and is reached through an SSH reverse tunnel on
// 127.0.0.1. Every call is short and fails soft: a laptop that's asleep or
// unplugged must never hold up the chief.

import fs from 'node:fs';
import path from 'node:path';

export class Hands {
  constructor(data) {
    this.file = path.join(data, 'hands-key');
    this.url = (process.env.JARVIS_HANDS_URL || 'http://127.0.0.1:4319').replace(/\/$/, '');
  }

  key() {
    try { return fs.readFileSync(this.file, 'utf8').trim(); } catch { return ''; }
  }

  get configured() { return !!this.key(); }

  async call(route, body, ms = 8000) {
    const key = this.key();
    if (!key) throw new Error("The laptop isn't connected to the office yet.");
    let res;
    try {
      res = await fetch(this.url + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-hands-key': key },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(ms),
      });
    } catch {
      throw new Error("I can't reach the laptop right now. It may be asleep or off the network.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `The laptop said no (${res.status}).`);
    return data;
  }

  // The chief's routing call on the laptop's Claude login.
  think(body) { return this.call('/think', body, 95_000); }

  // For the chief's context: the open tabs, or null if the laptop is away.
  async tabs() {
    if (!this.configured) return null;
    try { return (await this.call('/tabs', { op: 'list' }, 6000)).tabs; } catch { return null; }
  }
}
