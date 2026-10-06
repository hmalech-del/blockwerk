// Taktgeber. Ein Timer allein wäre hörbar ungenau, deshalb der übliche
// Lookahead: alle 25 ms wird geschaut, welche Schritte in den nächsten 150 ms
// fällig sind, und diese werden mit exaktem AudioContext-Zeitstempel
// vorausgeplant. Die Audio-Uhr bestimmt den Groove, nicht der Timer.

import { STEPS_PER_BAR, trackMidi } from './project.js';
import { MAX_ROLL, velocityOf } from './pattern.js';
import { eventsAtStep } from './gesture.js';

const INTERVAL_MS = 25;
const LOOKAHEAD = 0.15;

// Shuffle: jede zweite Einheit des Swing-Rasters kommt später. Auf dem
// 16tel-Raster ist das der klassische MPC-Shuffle, auf dem 8tel-Raster der
// Triolen-Shuffle – und der ist einem 8tel-Groove überhaupt erst anzuhören.
// Ohne das Raster bliebe eine reine 8tel-Figur vom Swingregler unberührt,
// weil sie nie auf einem ungeraden 16tel landet.
export function swingFor(project, step, stepDur) {
  if (!project.swing) return 0;
  const unit = project.swingGrid === 8 ? 2 : 1;
  const offbeat = Math.floor(step / unit) % 2 === 1;
  return offbeat ? project.swing * stepDur * unit * 0.5 : 0;
}

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
    const swingOffset = swingFor(project, step, stepDur);

    for (const track of project.tracks) {
      const clip = track.clips[track.clip];
      if (!clip || !clip.steps.length) continue;
      const cell = clip.steps[step % clip.steps.length];
      if (!cell || !cell.on) continue;

      const midi = trackMidi(project, track, cell.deg);
      // Der Versatz je Spur ist das, was Swing nicht kann: die Snare hinter
      // dem Raster, die Hats davor. Millisekunden, nicht Prozent.
      const nudge = (track.nudge || 0) / 1000;
      const hits = Math.max(1, cell.roll >= 2 ? Math.min(MAX_ROLL, cell.roll) : 1);
      const span = stepDur / hits;

      for (let i = 0; i < hits; i++) {
        const at = time + swingOffset + nudge + i * span;
        // Ein Roll faellt zum Ende hin leicht ab, sonst klingt er wie ein Fehler.
        const taper = hits > 1 ? 1 - (i / hits) * 0.25 : 1;
        const record = this.engine.noteOn(track.id, midi, at, {
          dur: Math.max(0.02, track.gate * span),
          velocity: velocityOf(cell) * taper,
          deg: cell.deg,
        });
        if (record) this.scheduled.push({ step, time: at, trackId: track.id, record });
      }
    }

    // Gesten liegen zwischen den Schritten – deshalb mit Bruchteil planen.
    for (const track of project.tracks) {
      for (const event of eventsAtStep(track, step)) {
        const offset = (event.t - (step % Math.max(1, this.loopFor(track)))) * stepDur
          + (track.nudge || 0) / 1000;
        const midi = trackMidi(project, track, event.deg);
        const record = this.engine.noteOn(track.id, midi, time + Math.max(0, offset), {
          dur: Math.max(0.03, event.dur * stepDur),
          velocity: 0.9,
          deg: event.deg,
        });
        if (record) this.scheduled.push({ step, time: time + offset, trackId: track.id, record });
      }
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

  loopFor(track) {
    const clip = track.clips[track.clip];
    return Math.max(STEPS_PER_BAR, (clip?.bars || 1) * STEPS_PER_BAR);
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
