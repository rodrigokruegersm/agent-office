// Checks Jarvis's hearing (web/src/jarvis-core.js): the wake word as whisper
// spells it, the noise it reports for silence, and the WAV it sends.

import assert from 'node:assert/strict';
import { WAKE, NOISE, SLEEP, encodeWav } from '../web/src/jarvis-core.js';

const wake = WAKE('Jarvis');
const strip = (t) => t.replace(wake, '').trim();
for (const t of ['Jarvis, open Gmail.', 'Hey Jarvis open Gmail', 'jarvis: open Gmail', 'Okay, Jarvis. Open Gmail.', 'Jervis, open Gmail']) {
  assert.ok(wake.test(t), t);
  assert.match(strip(t), /^open gmail\.?$/i, t);
}
for (const t of ['Can you pass me the salt?', 'I told Jarvis yesterday', 'Jarvisson is here']) assert.ok(!wake.test(t), t);
assert.equal(strip('Jarvis.'), '');
assert.ok(WAKE('Friday').test('Friday, status'));
console.log('ok    the wake word is heard the ways whisper spells it, and only at the start');

for (const t of ['[BLANK_AUDIO]', '(music)', ' you ', 'Thank you.', '...', '*coughs*']) assert.ok(NOISE.test(t), t);
assert.ok(!NOISE.test('Jarvis, thank you'));
assert.ok(SLEEP.test('stop listening') && SLEEP.test('go to sleep.') && !SLEEP.test('stop the build'));
console.log('ok    silence, noise and "go to sleep" are told apart from requests');

globalThis.Blob ||= (await import('node:buffer')).Blob;
const sr = 48000, chunk = new Float32Array(sr / 2).map((_, i) => Math.sin(i / 10) * 0.5);
const blob = encodeWav([chunk, chunk], sr);
const buf = Buffer.from(await blob.arrayBuffer());
assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
assert.equal(buf.readUInt32LE(24), 16000);
assert.equal(buf.readUInt16LE(22), 1);
assert.equal(buf.readUInt32LE(40), 16000 * 2); // one second, 16-bit
console.log('ok    phrases are sent as 16 kHz mono WAV');

// ---------- reflexes (server/fastpath.js) ----------
const { parse, fastPath } = await import('../server/fastpath.js');
const P = (t) => JSON.stringify(parse(t));
assert.equal(P('open Gmail.'), JSON.stringify({ verb: 'open', what: 'gmail' }));
assert.equal(P('Can you open my email please'), JSON.stringify({ verb: 'open', what: 'email' }));
assert.equal(P('switch back to the office.'), JSON.stringify({ verb: 'focus', what: 'office' }));
assert.equal(P('Go to the launch bible tab'), JSON.stringify({ verb: 'focus', what: 'launch bible' }));
assert.equal(P('close the YouTube tab'), JSON.stringify({ verb: 'close', what: 'youtube' }));
assert.equal(P('search for flights to Lisbon'), JSON.stringify({ verb: 'search', what: 'flights to lisbon' }));
assert.equal(P('Jarvis, open Pinterest'), JSON.stringify({ verb: 'open', what: 'pinterest' }));
assert.equal(parse("what's everyone working on?"), null);
assert.equal(parse('tell the bridged-product session to run the tests'), null);
console.log('ok    plain tab and app commands are recognised; everything else is left to the chief');

const calls = [];
const hands = { call: async (route, body) => { calls.push([route, body]); if (body?.query === 'nothing') throw new Error('No tab matches "nothing".'); return { focused: { title: 'Brez Launch Bible - Google Docs' } }; } };
const apps = async () => ['Spotify', 'WhatsApp', 'Google Chrome'];
assert.equal(await fastPath('open spotify', hands, apps), 'Opening Spotify.');
assert.deepEqual(calls.at(-1), ['/app', { name: 'Spotify' }]);
assert.equal(await fastPath('open example dot com', hands, apps), 'Opening example.com.');
assert.deepEqual(calls.at(-1), ['/tabs', { op: 'open', url: 'https://example.com' }]);
assert.equal(await fastPath('switch to the launch bible', hands, apps), "Here's Brez Launch Bible.");
assert.equal(await fastPath('switch to nothing', hands, apps), null);
assert.equal(await fastPath('open the quarterly plan', hands, apps), null);
console.log('ok    apps beat their websites, sites open, unknown tabs go to the chief');
console.log('\nall passed');
