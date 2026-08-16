// Audio-Engine: verwaltet den AudioContext, die Effektkette und die Stimmen.
// Die Engine kennt nur das Patch-Objekt – die Oberfläche ändert das Patch und
// ruft danach sync()/setParam() auf.

import { MODULES } from './modules.js';

export const MAX_VOICES = 12;

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.patch = null;
    this.instances = new Map(); // blockId -> Effekt-Instanz
    this.voices = new Map();    // midi -> Stimme
    this.onVoiceChange = () => {};
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // Browser erlauben Audio erst nach einer Nutzergeste.
  async start() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctor();
      this.ctx = ctx;

      this.chainIn = ctx.createGain();
      this.master = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -6;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.2;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;

      this.master.gain.value = this.patch ? this.patch.master.volume : 0.7;
      this.master.connect(this.limiter).connect(this.analyser).connect(ctx.destination);
      this.sync();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  setPatch(patch) {
    this.patch = patch;
    if (!this.ctx) return;
    for (const [id, inst] of this.instances) {
      this.disposeInstance(inst);
      this.instances.delete(id);
    }
    this.master.gain.value = patch.master.volume;
    this.sync();
  }

  disposeInstance(inst) {
    try { inst.dispose?.(); } catch (e) { /* egal */ }
    try { inst.input.disconnect(); } catch (e) { /* egal */ }
    try { inst.output.disconnect(); } catch (e) { /* egal */ }
  }

  // Instanzen an das Patch angleichen (neue anlegen, entfernte abbauen) und neu verdrahten.
  sync() {
    if (!this.ctx) return;
    const alive = new Set();

    for (const block of this.patch.chain) {
      alive.add(block.id);
      if (this.instances.has(block.id)) continue;
      const def = MODULES[block.type];
      const inst = def.create(this.ctx);
      for (const spec of def.params) inst.set(spec.id, block.params[spec.id]);
      this.instances.set(block.id, inst);
    }

    for (const [id, inst] of [...this.instances]) {
      if (alive.has(id)) continue;
      this.disposeInstance(inst);
      this.instances.delete(id);
    }

    this.wire();
  }

  // Kette in Patch-Reihenfolge verkabeln; Bypass-Blöcke werden übersprungen.
  wire() {
    this.chainIn.disconnect();
    for (const inst of this.instances.values()) {
      try { inst.output.disconnect(); } catch (e) { /* egal */ }
    }

    let node = this.chainIn;
    for (const block of this.patch.chain) {
      if (block.bypass) continue;
      const inst = this.instances.get(block.id);
      if (!inst) continue;
      node.connect(inst.input);
      node = inst.output;
    }
    node.connect(this.master);
  }

  setParam(blockId, paramId, value) {
    const inst = this.instances.get(blockId);
    if (inst) inst.set(paramId, value);
  }

  setMasterVolume(v) {
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // ------------------------------------------------------------- Stimmen

  noteOn(midi, when) {
    if (!this.ctx) return;
    const t = when ?? this.ctx.currentTime;
    if (this.voices.has(midi)) this.noteOff(midi, t);

    if (this.voices.size >= MAX_VOICES) {
      const oldest = this.voices.keys().next().value;
      this.noteOff(oldest, t);
    }

    const src = this.patch.source;
    const def = MODULES[src.type];
    const voice = def.spawn(this.ctx, src.params, midiToFreq(midi), t);
    voice.out.connect(this.chainIn);
    this.voices.set(midi, voice);
    this.onVoiceChange(midi, true);
  }

  noteOff(midi, when) {
    const voice = this.voices.get(midi);
    if (!voice) return;
    this.voices.delete(midi);
    const t = when ?? this.ctx.currentTime;
    const end = voice.release(t);
    // Erst nach dem Ausklingen abhängen, sonst bricht der Release ab.
    setTimeout(() => {
      try { voice.out.disconnect(); } catch (e) { /* egal */ }
    }, Math.max(0, (end - this.ctx.currentTime) * 1000) + 60);
    this.onVoiceChange(midi, false);
  }

  panic() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [midi, voice] of [...this.voices]) {
      this.voices.delete(midi);
      voice.kill(t);
      this.onVoiceChange(midi, false);
    }
  }

  // Pegel als RMS zwischen 0 und 1 für die Anzeige.
  level() {
    if (!this.analyser) return 0;
    if (!this._levelBuf || this._levelBuf.length !== this.analyser.fftSize) {
      this._levelBuf = new Uint8Array(this.analyser.fftSize);
    }
    const buf = this._levelBuf;
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }
}
