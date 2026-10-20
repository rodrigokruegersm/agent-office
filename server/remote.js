// fork: a claude process on the boss's laptop, run through Jarvis's hands
// (bin/jarvis-hands.js, /run). It looks enough like a ChildProcess for the
// job code to treat it as one: stdout/stderr streams, stdin.write/end, kill,
// and 'close' with the exit code.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';

export function remoteSpawn(hands, { cwd, args, env }) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.exitCode = null;
  const pending = [];
  let open = false;
  let closed = false;
  const ws = new WebSocket(hands.url.replace(/^http/, 'ws') + '/run', { headers: { 'x-hands-key': hands.key() } });
  const send = (m) => { if (open && ws.readyState === 1) ws.send(JSON.stringify(m)); else pending.push(m); };
  const finish = (code) => {
    if (closed) return;
    closed = true;
    child.exitCode = code;
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  };
  child.stdin = new EventEmitter();
  child.stdin.write = (data) => { send({ i: String(data) }); return true; };
  child.stdin.end = (data) => { if (data) child.stdin.write(data); send({ end: 1 }); };
  child.kill = (sig = 'SIGTERM') => { send({ kill: sig }); setTimeout(() => ws.close(), 5000).unref(); return true; };

  ws.on('open', () => {
    open = true;
    ws.send(JSON.stringify({ cwd, args, env }));
    for (const m of pending.splice(0)) ws.send(JSON.stringify(m));
  });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.pid) child.pid = undefined; // a pid on the laptop means nothing here
    if (typeof m.o === 'string') child.stdout.write(m.o);
    if (typeof m.e === 'string') child.stderr.write(m.e);
    if (m.x !== undefined) finish(m.x);
  });
  ws.on('error', (err) => {
    if (!open) { child.emit('error', new Error(`the laptop isn't reachable (${err.message})`)); finish(1); }
  });
  ws.on('close', () => finish(child.exitCode ?? 1));
  return child;
}
