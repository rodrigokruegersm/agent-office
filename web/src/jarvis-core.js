// fork: the parts of Jarvis's hearing that don't need a browser, so they
// can be tested in node (scripts/jarvis.mjs).

const RATE = 16000;

// Whisper's ways of hearing "Jarvis", and its notes for silence and noise.
export const WAKE = (name) => new RegExp(`^\\W*(?:(?:hey|hi|ok|okay|yo)\\W+)?(?:${[name, 'jarvis', 'jervis', 'jarvi', 'jarvus', 'travis', 'javis', 'jarves', 'charvis'].map((w) => w.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean).join('|')})\\b[\\s,.!?:;-]*`, 'i');
export const NOISE = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|you|thank you\.?|thanks for watching!?|\.+)\s*$/i;
export const SLEEP = /^(stop listening|go to sleep|that'?s all|goodnight|good night|sleep)\W*$/i;

// Mono 16 kHz 16-bit WAV, which whisper wants and ffmpeg passes straight through.
export function encodeWav(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / RATE;
  const n = Math.floor(total / ratio);
  const flat = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { flat.set(c, o); o += c.length; }
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (at, s) => { for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // Average the samples each output sample covers: a cheap low-pass.
    const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += flat[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([out], { type: 'audio/wav' });
}
