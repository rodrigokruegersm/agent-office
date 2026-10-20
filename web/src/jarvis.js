// fork: Jarvis, hands-free. The microphone stays open; each phrase is cut out
// by its loudness (with half a second before it, so the first word isn't
// clipped), transcribed by the office's local whisper, and dropped unless it
// starts with the chief's name or comes right after Jarvis spoke. What's left
// goes to the chat like a typed message, and replies are read aloud.
//
// Browsers only open the microphone on https or localhost: open the office
// at http://localhost:4317 (scripts/setup-macbook.sh tunnels it there).

import './jarvis.css';
import { WAKE, NOISE, SLEEP, encodeWav } from './jarvis-core.js';

const PRE_ROLL = 0.5; // seconds kept from before a phrase starts
const END_SILENCE = 0.85; // seconds of quiet that end a phrase
const MIN_PHRASE = 0.45; // shorter than this is a cough, not a word
const MAX_PHRASE = 20;
const AWAKE_MS = 25_000; // listening without the name after a reply

const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
export class Jarvis {
  constructor({ api, speech, notify }) {
    Object.assign(this, { api, speech, notify });
    this.name = 'Jarvis';
    this.on = false;
    this.state = 'off';
    this.awakeUntil = 0;
    this.busy = false;
    this.queue = [];

    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'jarvis-pill';
    this.el.hidden = true;
    this.el.innerHTML = '<span class="jv-orb" aria-hidden="true"></span><span class="jv-text"></span>';
    this.el.addEventListener('click', () => this.toggle());
    document.body.appendChild(this.el);
    this.text = this.el.querySelector('.jv-text');
    // Any click on the page lets the browser start audio; pick up where we left off.
    addEventListener('pointerdown', () => { if (this.ctx?.state === 'suspended') this.ctx.resume().then(() => this.render()); }, { capture: true });
  }

  setName(name) {
    if (!name) { this.el.hidden = true; return; }
    this.name = name;
    this.wake = WAKE(name);
    this.el.hidden = false;
    this.render();
    // On unless turned off: the first visit asks for the microphone straight away.
    if (store('jarvis.on') !== '0' && !this.on) this.start().catch(() => this.render());
  }

  get secure() { return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia; }

  async toggle() {
    if (this.on) { this.stop(); store('jarvis.on', '0'); return; }
    store('jarvis.on', '1');
    await this.start().catch((err) => { this.error = err.message; this.render(); });
  }

  async start() {
    if (!this.secure) throw new Error('Open the office at http://localhost:4317 to talk to me.');
    this.error = '';
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is old but runs everywhere without a separate worklet file.
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.sr = this.ctx.sampleRate;
    this.ring = [];
    this.ringLen = 0;
    this.phrase = null;
    this.floor = 0.01;
    this.node.onaudioprocess = (e) => this.frame(e.inputBuffer.getChannelData(0));
    src.connect(this.node);
    this.node.connect(this.ctx.destination);
    this.on = true;
    // Replies are read aloud while Jarvis is on.
    this.speech.setOn(true);
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    this.render();
  }

  stop() {
    this.on = false;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = this.stream = this.ctx = null;
    this.phrase = null;
    this.render();
  }

  // ---------- hearing ----------

  frame(input) {
    const buf = new Float32Array(input);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const secs = buf.length / this.sr;
    // Deaf while Jarvis talks, so he doesn't answer himself.
    const talking = this.speech.busy || Date.now() < this.mutedUntil;
    if (talking) { this.phrase = null; this.ring = []; this.ringLen = 0; this.renderSoon(); return; }

    const loud = rms > Math.max(0.012, this.floor * 3);
    if (!this.phrase) {
      // The room's own level, learned while nobody speaks.
      if (!loud) this.floor = this.floor * 0.95 + rms * 0.05;
      this.ring.push(buf);
      this.ringLen += secs;
      while (this.ringLen - this.ring[0].length / this.sr > PRE_ROLL) this.ringLen -= this.ring.shift().length / this.sr;
      if (loud) {
        this.phrase = { chunks: [...this.ring], len: this.ringLen, quiet: 0, voiced: secs };
        this.ring = []; this.ringLen = 0;
        this.renderSoon();
      }
      return;
    }
    const p = this.phrase;
    p.chunks.push(buf);
    p.len += secs;
    if (loud) { p.quiet = 0; p.voiced += secs; } else p.quiet += secs;
    if (p.quiet >= END_SILENCE || p.len >= MAX_PHRASE) {
      this.phrase = null;
      if (p.voiced >= MIN_PHRASE) this.heard(p.chunks);
      this.renderSoon();
    }
  }

  async heard(chunks) {
    const wav = encodeWav(chunks, this.sr);
    this.busy = true;
    this.render();
    let text = '';
    try {
      const res = await fetch('/api/voice/listen', { method: 'POST', headers: { 'x-file-name': 'listen.wav', 'content-type': 'audio/wav' }, body: wav });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'I couldn\'t hear that.');
      text = String(data.text || '').trim();
    } catch (err) {
      this.error = err.message;
    } finally {
      this.busy = false;
      this.render();
    }
    if (text && !NOISE.test(text)) this.act(text);
  }

  async act(text) {
    const woke = this.wake.test(text);
    if (!woke && Date.now() > this.awakeUntil) return;
    const said = text.replace(this.wake, '').trim();
    this.last = said || text;
    if (!said) { this.reply('Yes, sir?'); this.awakeUntil = Date.now() + AWAKE_MS; return; }
    if (SLEEP.test(said)) { this.awakeUntil = 0; this.reply('Very good, sir.'); return; }
    this.awakeUntil = Date.now() + AWAKE_MS;
    this.render();
    try { await this.api('/api/chat', { text: said }); } catch (err) { this.reply(`Something went wrong: ${err.message}`); }
  }

  reply(text) {
    this.speech.speak(text, 'chief', { force: true });
  }

  // The office calls this for each chat message; replies keep him awake.
  onMessage(m) {
    if (!this.on || m.from === 'you') return;
    if (m.from === 'chief') this.awakeUntil = Date.now() + AWAKE_MS;
    this.mutedUntil = Date.now() + 700;
  }

  // ---------- the pill ----------

  renderSoon() {
    if (this.rt) return;
    this.rt = requestAnimationFrame(() => { this.rt = 0; this.render(); });
  }

  render() {
    const st = !this.on ? 'off'
      : this.ctx?.state === 'suspended' ? 'blocked'
      : this.speech.busy ? 'speaking'
      : this.busy ? 'thinking'
      : this.phrase ? 'hearing'
      : Date.now() < this.awakeUntil ? 'awake'
      : 'listening';
    this.el.dataset.state = st;
    const words = {
      off: `${this.name} is off. Click to wake him`,
      blocked: 'Click anywhere to let me listen',
      speaking: `${this.name} is speaking`,
      thinking: 'Got it…',
      hearing: 'Listening…',
      awake: 'Go ahead',
      listening: `Say "${this.name}…"`,
    };
    this.text.textContent = this.error && !this.on ? this.error : words[st];
    this.el.title = this.on ? `Click to stop ${this.name} listening` : `Talk to ${this.name} hands-free`;
    clearTimeout(this.tick);
    if (this.on) this.tick = setTimeout(() => this.render(), 1000);
  }
}
