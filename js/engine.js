// Audio-Engine: AudioContext, eine Effektkette je Spur, Stimmenverwaltung.
// Die Engine liest das Projekt, hält aber keinen eigenen Bearbeitungszustand.

import { MODULES } from './modules.js';

export const MAX_VOICES_PER_TRACK = 8;

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.project = null;
    this.tracks = new Map(); // trackId -> Laufzeitobjekt
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // Browser erlauben Audio erst nach einer Nutzergeste.
  async start() {
    if (!this.ctx) {
      // Ohne das hier behandelt iOS die App als "ambient" – dann schaltet der
      // Stummschalter am Gehäuse den Ton ab, obwohl alles zu laufen scheint.
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (e) { /* nur Safari 16.4+ */ }

      const Ctor = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;
      ctx.onstatechange = () => this.onStateChange(ctx.state);

      this.master = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -6;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.2;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;

      this.master.gain.value = this.project ? this.project.master.volume : 0.7;
      this.master.connect(this.limiter).connect(this.analyser).connect(ctx.destination);
      this.sync();
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.unlock();
    return this.ctx;
  }

  // iOS gibt die Audioausgabe erst frei, wenn innerhalb einer Nutzergeste
  // tatsächlich etwas abgespielt wurde – ein stilles Sample genügt.
  unlock() {
    if (this._unlocked || !this.ctx) return;
    try {
      const source = this.ctx.createBufferSource();
      source.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      source.connect(this.ctx.destination);
      source.start(0);
      this._unlocked = true;
    } catch (e) { /* nicht schlimm */ }
  }

  // Ein hörbarer Testton – im Zweifel sagt der mehr als jede Statusanzeige.
  testTone(when) {
    if (!this.ctx) return;
    const t = when ?? this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  onStateChange() {}

  setProject(project) {
    this.project = project;
    if (!this.ctx) return;
    this.master.gain.value = project.master.volume;
    this.sync();
  }

  trackDef(trackId) {
    return this.project?.tracks.find((t) => t.id === trackId) || null;
  }

  // ------------------------------------------------------- Graph pflegen

  sync() {
    if (!this.ctx) return;
    const alive = new Set();

    for (const def of this.project.tracks) {
      alive.add(def.id);
      this.syncTrack(def);
    }
    for (const [id, rt] of [...this.tracks]) {
      if (alive.has(id)) continue;
      this.killTrack(id);
      for (const inst of rt.instances.values()) this.disposeInstance(inst);
      try { rt.out.disconnect(); } catch (e) { /* egal */ }
      this.tracks.delete(id);
    }
    this.applyMix();
  }

  syncTrack(def) {
    let rt = this.tracks.get(def.id);
    if (!rt) {
      rt = {
        chainIn: this.ctx.createGain(),
        out: this.ctx.createGain(),
        instances: new Map(),
        held: new Map(),  // midi -> Stimme, solange die Taste gehalten wird
        active: new Set(), // alle klingenden Stimmen der Spur
      };
      rt.out.connect(this.master);
      this.tracks.set(def.id, rt);
    }

    const alive = new Set();
    for (const block of def.chain) {
      alive.add(block.id);
      if (rt.instances.has(block.id)) continue;
      const mod = MODULES[block.type];
      const inst = mod.create(this.ctx);
      for (const spec of mod.params) inst.set(spec.id, block.params[spec.id]);
      rt.instances.set(block.id, inst);
    }
    for (const [id, inst] of [...rt.instances]) {
      if (alive.has(id)) continue;
      this.disposeInstance(inst);
      rt.instances.delete(id);
    }

    this.wireTrack(def, rt);
  }

  wireTrack(def, rt) {
    rt.chainIn.disconnect();
    for (const inst of rt.instances.values()) {
      try { inst.output.disconnect(); } catch (e) { /* egal */ }
    }
    let node = rt.chainIn;
    for (const block of def.chain) {
      if (block.bypass) continue;
      const inst = rt.instances.get(block.id);
      if (!inst) continue;
      node.connect(inst.input);
      node = inst.output;
    }
    node.connect(rt.out);
  }

  disposeInstance(inst) {
    try { inst.dispose?.(); } catch (e) { /* egal */ }
    try { inst.input.disconnect(); } catch (e) { /* egal */ }
    try { inst.output.disconnect(); } catch (e) { /* egal */ }
  }

  // Mute/Solo wirken zusammen: sobald irgendwo Solo an ist, schweigt der Rest.
  applyMix() {
    if (!this.ctx || !this.project) return;
    const anySolo = this.project.tracks.some((t) => t.mix.solo);
    for (const def of this.project.tracks) {
      const rt = this.tracks.get(def.id);
      if (!rt) continue;
      const audible = !def.mix.mute && (!anySolo || def.mix.solo);
      rt.out.gain.setTargetAtTime(audible ? def.mix.volume : 0, this.ctx.currentTime, 0.01);
    }
  }

  setParam(trackId, blockId, paramId, value) {
    this.tracks.get(trackId)?.instances.get(blockId)?.set(paramId, value);
  }

  setMasterVolume(v) {
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // ---------------------------------------------------------- Stimmen

  // dur in Sekunden -> die Stimme gibt sich selbst wieder frei (Sequenzer).
  // Ohne dur bleibt sie liegen, bis noteOff kommt (Klaviatur).
  noteOn(trackId, midi, when, { dur = null, velocity = 1 } = {}) {
    if (!this.ctx) return null;
    const def = this.trackDef(trackId);
    const rt = this.tracks.get(trackId);
    if (!def || !rt) return null;

    const t = Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime);
    if (rt.active.size >= MAX_VOICES_PER_TRACK) this.stealOldest(rt, t);
    if (dur === null && rt.held.has(midi)) this.noteOff(trackId, midi, t);

    const mod = MODULES[def.source.type];
    const voice = mod.spawn(this.ctx, def.source.params, midiToFreq(midi), t);
    const amp = this.ctx.createGain();
    amp.gain.value = Math.max(0, Math.min(1, velocity));
    voice.out.connect(amp).connect(rt.chainIn);

    const record = { voice, amp, midi, startedAt: t };
    rt.active.add(record);

    if (dur === null) {
      rt.held.set(midi, record);
    } else {
      const end = voice.release(t + dur);
      this.scheduleCleanup(rt, record, end);
    }
    return record;
  }

  // Nimmt eine vorausgeplante, noch nicht erklungene Stimme wieder zurueck.
  cancel(trackId, record) {
    const rt = this.tracks.get(trackId);
    if (!rt || !rt.active.delete(record)) return false;
    rt.held.delete(record.midi);
    record.voice.kill(this.ctx.currentTime);
    try { record.amp.disconnect(); } catch (e) { /* egal */ }
    return true;
  }

  noteOff(trackId, midi, when) {
    const rt = this.tracks.get(trackId);
    const record = rt?.held.get(midi);
    if (!record) return;
    rt.held.delete(midi);
    const t = Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime);
    this.scheduleCleanup(rt, record, record.voice.release(t));
  }

  stealOldest(rt, when) {
    let oldest = null;
    for (const record of rt.active) {
      if (!oldest || record.startedAt < oldest.startedAt) oldest = record;
    }
    if (!oldest) return;
    rt.active.delete(oldest);
    rt.held.delete(oldest.midi);
    oldest.voice.kill(when);
    try { oldest.amp.disconnect(); } catch (e) { /* egal */ }
  }

  // Erst nach dem Ausklingen abhängen, sonst bricht der Release ab.
  scheduleCleanup(rt, record, endTime) {
    const delay = Math.max(0, (endTime - this.ctx.currentTime) * 1000) + 80;
    setTimeout(() => {
      rt.active.delete(record);
      try { record.amp.disconnect(); } catch (e) { /* egal */ }
      try { record.voice.out.disconnect(); } catch (e) { /* egal */ }
    }, delay);
  }

  killTrack(trackId) {
    const rt = this.tracks.get(trackId);
    if (!rt || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (const record of [...rt.active]) {
      rt.active.delete(record);
      record.voice.kill(t);
      try { record.amp.disconnect(); } catch (e) { /* egal */ }
    }
    rt.held.clear();
  }

  panic() {
    if (!this.ctx) return;
    for (const id of this.tracks.keys()) this.killTrack(id);
  }

  voiceCount() {
    let n = 0;
    for (const rt of this.tracks.values()) n += rt.active.size;
    return n;
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
