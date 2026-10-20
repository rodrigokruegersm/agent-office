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
console.log('\nall passed');
