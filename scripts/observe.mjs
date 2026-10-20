// Checks the observer (server/observe): transcript parsing for Claude Code
// and OpenClaw, the hook and report inputs, and the waiting/stale rules. No
// server, no tokens: a temporary data folder and made-up transcripts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Observer } from '../server/observe/index.js';
import { parseLine } from '../server/observe/claude.js';
import { parseOpenclaw } from '../server/observe/openclaw.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-observe-'));
const ok = (name) => console.log(`ok    ${name}`);
const sent = [];
const now = new Date().toISOString();

// ---------- Claude Code transcript lines ----------
const file = { sessionId: 's1', cwd: '' };
const tool = (name, input) => ({ type: 'assistant', timestamp: now, sessionId: 's1', cwd: '/w/demo', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } });
assert.equal(parseLine(tool('Grep', { pattern: 'todo' }), file).station, 'library');
assert.equal(parseLine(tool('Bash', { command: 'npm test', description: 'Run tests' }), file).activity, 'Run tests');
assert.equal(parseLine(tool('AskUserQuestion', {}), file).state, 'waiting');
assert.equal(parseLine({ ...tool('Read', {}), isSidechain: true }, file), null);
assert.equal(parseLine({ type: 'assistant', timestamp: now, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } }, file).state, 'idle');
assert.equal(parseLine({ type: 'user', timestamp: now, message: { content: '<system-reminder>x</system-reminder>' } }, file), null);
assert.equal(parseLine({ type: 'user', timestamp: now, message: { content: 'fix the login bug' } }, file).title, 'fix the login bug');
assert.deepEqual(parseLine({ type: 'agent-name', agentName: 'Login fix' }, file).meta, { name: 'Login fix' });
ok('Claude Code lines become states, stations and captions');

// ---------- OpenClaw transcript lines ----------
const oc = { sessionId: 'o1' };
const call = parseOpenclaw({ type: 'message', timestamp: now, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'exec', arguments: { command: 'ls' } }] } }, oc);
assert.equal(call.station, 'servers');
assert.equal(call.activity, '$ ls');
assert.equal(parseOpenclaw({ type: 'message', timestamp: now, message: { role: 'assistant', stopReason: 'error', errorMessage: 'rate limited', content: [] } }, oc).state, 'error');
assert.equal(parseOpenclaw({ type: 'message', timestamp: now, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Booked.' }] } }, oc).state, 'idle');
ok('OpenClaw lines become states, stations and captions');

// ---------- the observer ----------
const o = new Observer({ data: tmp, send: (m) => sent.push(m), ownSessions: () => new Set(['mine-0000-session']), claudeDir: path.join(tmp, 'none') });
assert.match(fs.readFileSync(path.join(tmp, 'observe-key'), 'utf8'), /^[0-9a-f]{64}\n$/);
assert.equal((fs.statSync(path.join(tmp, 'observe-key')).mode & 0o777).toString(8), '600');
assert.ok(o.sameKey(o.key) && !o.sameKey('nope') && !o.sameKey(''));
ok('the observe key is made private and checked in constant time');

assert.throws(() => o.report({ source: 'Not OK', id: 'x', state: 'working' }));
assert.throws(() => o.report({ source: 'cron', state: 'working' }));
assert.throws(() => o.report({ source: 'cron', id: 'x', state: 'dancing' }));
o.report({ source: 'cron', id: 'backup', name: 'Backup', state: 'working', tool: 'WebFetch', input: { url: 'https://example.com/x' } });
let a = o.list().find((x) => x.id === 'cron:backup');
assert.equal(a.station, 'window');
assert.equal(a.activity, 'Reading example.com');
o.report({ source: 'cron', id: 'backup', state: 'error', activity: 'Failed with exit 3' });
assert.equal(o.attention().length, 1);
o.dismiss('cron:backup');
assert.equal(o.attention().length, 0);
assert.equal(o.list().find((x) => x.id === 'cron:backup').state, 'idle');
o.report({ source: 'cron', id: 'backup', state: 'gone' });
assert.equal(o.list().length, 0);
ok('reports are checked, errors queue until dismissed, gone walks out');

o.hook({ hook_event_name: 'Notification', session_id: 'abcdef12-3456', cwd: '/w/portal', message: 'Claude needs your permission to use Bash' });
a = o.list().find((x) => x.id === 'claude:abcdef12-3456');
assert.equal(a.state, 'waiting');
assert.equal(a.name, 'portal');
// A transcript line from before the prompt doesn't clear it.
o.fromTranscript({ sessionId: 'abcdef12-3456', cwd: '/w/portal', at: a.updated - 1000, state: 'working', station: 'desk', activity: 'old' });
assert.equal(o.list().find((x) => x.id === a.id).state, 'waiting');
o.fromTranscript({ sessionId: 'abcdef12-3456', cwd: '/w/portal', at: Date.now() + 10, state: 'working', station: 'servers', activity: 'Run tests' });
assert.equal(o.list().find((x) => x.id === a.id).state, 'working');
o.hook({ hook_event_name: 'Stop', session_id: 'abcdef12-3456', cwd: '/w/portal' });
assert.equal(o.list().find((x) => x.id === a.id).state, 'idle');
assert.equal(o.hook({ hook_event_name: 'Notification', session_id: 'mine-0000-session', cwd: '/w' }).skipped, true);
assert.equal(o.list().some((x) => x.id === 'claude:mine-0000-session'), false);
assert.throws(() => o.hook({ hook_event_name: 'Stop', session_id: '../../etc' }));
ok('hooks set waiting and idle, and the office\'s own jobs are skipped');

o.upsert('cron:old', { source: 'cron', name: 'Old', state: 'working' }, Date.now() - 11 * 60_000);
o.tick();
assert.equal(o.list().find((x) => x.id === 'cron:old').state, 'idle');
o.upsert('cron:ancient', { source: 'cron', name: 'Ancient', state: 'idle' }, Date.now() - 181 * 60_000);
o.tick();
assert.equal(o.list().find((x) => x.id === 'cron:ancient'), undefined);
ok('quiet workers go idle, and long-idle ones walk out');

clearTimeout(o.soon);
await new Promise((r) => setTimeout(r, 300));
assert.ok(sent.length && sent.every((m) => m.t === 'external' && Array.isArray(m.agents)));
ok('changes are broadcast as { t: "external" }');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nall passed');
