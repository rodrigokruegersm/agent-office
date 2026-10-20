#!/usr/bin/env node
// Sends one message to the office chat, as if spoken to Jarvis, and prints
// the chief's reply. For checking Jarvis from a terminal:
//
//   OFFICE_URL=http://localhost:4317 OFFICE_KEY=... node scripts/ask-jarvis.mjs "what's everyone doing?"

import WebSocket from 'ws';

const base = (process.env.OFFICE_URL || 'http://localhost:4317').replace(/\/$/, '');
const key = process.env.OFFICE_KEY;
const text = process.argv.slice(2).join(' ');
if (!key || !text) { console.error('usage: OFFICE_KEY=... ask-jarvis.mjs <message>'); process.exit(64); }

const login = await fetch(`${base}/?key=${key}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { cookie, origin: base } });
const timer = setTimeout(() => { console.log('(no reply in 90 s)'); process.exit(1); }, 90_000);
let sent = false;
ws.on('message', async (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'hello' && !sent) {
    sent = true;
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) { console.log('send failed', res.status, await res.text()); process.exit(1); }
  }
  if (m.t === 'chat' && m.msg?.from === 'chief') {
    console.log(`Jarvis: ${m.msg.text}`);
    clearTimeout(timer);
    setTimeout(() => process.exit(0), 300);
  }
});
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
