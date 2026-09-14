// Taktgeber. Ein Timer allein wäre hörbar ungenau, deshalb der übliche
// Lookahead: alle 25 ms wird geschaut, welche Schritte in den nächsten 150 ms
// fällig sind, und diese werden mit exaktem AudioContext-Zeitstempel
// vorausgeplant. Die Audio-Uhr bestimmt den Groove, nicht der Timer.

import { degToMidi, STEPS_PER_BAR } from './project.js';

const INTERVAL_MS = 25;
const LOOKAHEAD = 0.15;

export class Transport {
  constructor(engine, getProject, { onClipChange = () => {}, onBar = () => {} } = {}) {
    this.engine = engine;
    this.getProject = getProject;
    this.onClipChange = onClipChange;
    this.onBar = onBar;
    this.playing = false;
    this.step = 0;
    this.nextTime = 0;
    this.timer = null;
    this.scheduled = [];   // vorausgeplante Stimmen, um sie zurueckholen zu koennen
    this.stepTimes = new Map();
  }

  get project() {
    return this.getProject();
  }

  stepDuration() {
    return 60 / Math.max(20, this.project.tempo) / 4; // Sechzehntel
  }

  start() {
    const ctx = this.engine.ctx;
    if (!ctx || this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.06;
    this.scheduled = [];
    this.stepTimes.clear();
    this.tick();
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    this.step = 0;
    this.engine.panic();
    // Wartende Clipwechsel greifen beim Stopp sofort.
    this.applyQueued(true);
  }

  toggle() {
    if (this.playing) this.stop();
    else this.start();
  }

  tick() {
    const ctx = this.engine.ctx;
    if (!ctx || !this.playing) return;
    let guard = 0;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD && guard++ < 256) {
      this.scheduleStep(this.step, this.nextTime);
      this.step += 1;
      this.nextTime += this.stepDuration();
    }
    this.forget(ctx.currentTime);
  }

  // Was erklungen ist, muss nicht mehr vorgehalten werden.
  forget(now) {
    if (this.scheduled.length > 64) {
      this.scheduled = this.scheduled.filter((e) => e.time > now);
    }
    if (this.stepTimes.size > 64) {
      for (const [step, time] of this.stepTimes) {
        if (time < now - 0.5) this.stepTimes.delete(step);
      }
    }
  }

  scheduleStep(step, time) {
    const project = this.project;
    // Erst das Script, dann die vorgemerkten Wechsel: was von Hand kommt,
    // ueberstimmt den Plan.
    if (step % STEPS_PER_BAR === 0) this.onBar(step / STEPS_PER_BAR + 1, time);
    const quantize = Math.max(1, project.quantize);
    if (step % quantize === 0) this.applyQueued();

    const stepDur = this.stepDuration();
    // Swing verzögert die geraden Zwischenschritte – der klassische Shuffle.
    const swingOffset = step % 2 ? project.swing * stepDur * 0.5 : 0;

    for (const track of project.tracks) {
      const clip = track.clips[track.clip];
      if (!clip || !clip.steps.length) continue;
      const cell = clip.steps[step % clip.steps.length];
      if (!cell || !cell.on) continue;

      const midi = degToMidi(cell.deg, project.root, project.scale) + track.octave * 12;
      const record = this.engine.noteOn(track.id, midi, time + swingOffset, {
        dur: Math.max(0.02, track.gate * stepDur),
        velocity: cell.on === 2 ? 1 : 0.68,
      });
      if (record) this.scheduled.push({ step, time: time + swingOffset, trackId: track.id, record });
    }
    this.stepTimes.set(step, time);
  }

  // Der Scheduler plant bis zu 150 ms voraus. Wer kurz vor der Eins tippt –
  // und genau das tun Musiker – faende seinen Wechsel sonst erst einen Takt
  // spaeter wieder. Also die schon verplanten, aber noch nicht erklungenen
  // Schritte zuruecknehmen und ab der Grenze neu planen.
  catchUp() {
    if (!this.playing || !this.engine.ctx) return false;
    const quantize = Math.max(1, this.project.quantize);
    const boundary = Math.ceil((this.position() + 0.0001) / quantize) * quantize;
    if (boundary >= this.step) return false;
    return this.rewindTo(boundary);
  }

  rewindTo(step) {
    const ctx = this.engine.ctx;
    const time = this.stepTimes.get(step);
    if (time === undefined || time <= ctx.currentTime + 0.005) return false;

    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      const entry = this.scheduled[i];
      if (entry.step < step) continue;
      if (entry.time > ctx.currentTime + 0.002) this.engine.cancel(entry.trackId, entry.record);
      this.scheduled.splice(i, 1);
    }
    this.step = step;
    this.nextTime = time;
    return true;
  }

  queueClip(trackId, slot) {
    const track = this.project.tracks.find((t) => t.id === trackId);
    if (!track || !track.clips[slot]) return;
    if (!this.playing) {
      track.clip = slot;
      track.queued = null;
    } else if (track.clip === slot) {
      track.queued = null; // Wartenden Wechsel wieder abbestellen
    } else {
      track.queued = slot;
    }
    this.catchUp();
    this.onClipChange();
  }

  // Eine Szene schaltet alle Spuren gemeinsam um – der wichtigste Griff live.
  queueScene(scene) {
    if (!scene) return;
    for (const track of this.project.tracks) {
      const slot = scene.slots[track.id];
      if (Number.isInteger(slot) && track.clips[slot]) {
        track.queued = this.playing ? slot : null;
        if (!this.playing) track.clip = slot;
      }
      const mute = scene.mutes?.[track.id];
      if (typeof mute === 'boolean') {
        if (this.playing) track.queuedMute = mute;
        else track.mix.mute = mute;
      }
    }
    this.catchUp();
    this.onClipChange();
  }

  applyQueued(force = false) {
    let changed = false;
    for (const track of this.project.tracks) {
      if (track.queued !== null) {
        if (track.clips[track.queued] || force) track.clip = track.queued;
        track.queued = null;
        changed = true;
      }
      if (track.queuedMute !== null) {
        track.mix.mute = track.queuedMute;
        track.queuedMute = null;
        changed = true;
      }
    }
    if (changed) this.onClipChange();
  }

  // Nächste Quantisierungsgrenze in Schritten – dort greifen wartende Wechsel.
  switchStep() {
    const q = Math.max(1, this.project.quantize);
    return Math.ceil((this.position() + 0.0001) / q) * q;
  }

  // Verbleibende Takte bis dahin, für den Countdown.
  barsUntilSwitch() {
    return (this.switchStep() - this.position()) / STEPS_PER_BAR;
  }

  // Fortlaufende Position in Schritten (mit Nachkommastelle) für die Anzeige.
  position() {
    const ctx = this.engine.ctx;
    if (!this.playing || !ctx) return 0;
    const ahead = (this.nextTime - ctx.currentTime) / this.stepDuration();
    return Math.max(0, this.step - ahead);
  }

  // Wie weit ist der aktuelle Quantisierungsblock? 0..1, für den Countdown.
  quantizePhase() {
    const q = Math.max(1, this.project.quantize);
    return (this.position() % q) / q;
  }
}
