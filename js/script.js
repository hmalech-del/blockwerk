// Set-Script: der Ablauf als Text.
//
// Das Script ist der Plan, nicht der Zwang. Es feuert an Taktgrenzen und setzt
// dort Clips, Szenen, Stummschaltungen, Tempo, Tonart und Parameterfahrten.
// Zwischen zwei Ereignissen hat immer die Hand Vorrang – wer von Hand umschaltet,
// bleibt umgeschaltet, bis das Script das nächste Mal etwas dazu sagt.
//
//   tempo 124
//   key C minor
//   swing 12
//
//   bar 1    kick=A, bass=A
//   bar 9    lead=A
//   bar 17   scene Hook
//   bar 25   bass.filter.freq 300 -> 4000 over 8 bars
//   bar 33   mute lead bass
//   bar 49   end

import { MODULES } from './modules.js';
import { CLIP_SLOTS, STEPS_PER_BAR } from './project.js';

const SCALE_WORDS = {
  minor: 'minor', min: 'minor', moll: 'minor',
  major: 'major', maj: 'major', dur: 'major',
  dorian: 'dorian', phrygian: 'phrygian',
  pentatonic: 'pentaMinor', penta: 'pentaMinor',
  chromatic: 'chromatic',
};

const NOTE_CLASSES = {
  c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, f: 5, 'f#': 6,
  gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11, h: 11,
};

const RAMP = /^([\w.]+)\s+(-?[\d.]+)\s*(?:->|→)\s*(-?[\d.]+)(?:\s+over\s+([\d.]+)\s*bars?)?$/i;
const ASSIGN = /^([^=]+?)\s*=\s*([a-dA-D])$/;

// ------------------------------------------------------------------- Lesen

export function parseScript(text, project) {
  const events = [];
  const errors = [];
  const lines = String(text ?? '').split('\n');

  const trackByName = new Map(project.tracks.map((t) => [t.name.trim().toLowerCase(), t]));
  const sceneByName = new Map(project.scenes.map((s) => [s.name.trim().toLowerCase(), s]));
  const trackList = () => project.tracks.map((t) => t.name).join(', ') || '—';

  let currentBar = 1;

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    // Ein Kommentarzeichen zaehlt nur am Zeilenanfang oder nach einem
    // Leerzeichen – sonst zerlegt es Notennamen wie F#2.
    let line = raw.replace(/(^|\s)(#|;|\/\/).*$/, '').trim();
    if (!line) return;

    const bar = /^bar\s+(\d+)\s*(.*)$/i.exec(line);
    if (bar) {
      currentBar = Math.max(1, Number(bar[1]));
      line = bar[2].trim();
      if (!line) return;
    }

    for (const part of line.split(',')) {
      const command = part.trim();
      if (command) parseCommand(command, currentBar, lineNo);
    }
  });

  function fail(lineNo, message) {
    errors.push({ line: lineNo, message });
  }

  function parseCommand(command, bar, lineNo) {
    const words = command.split(/\s+/);
    const head = words[0].toLowerCase();

    if (head === 'tempo') {
      const bpm = Number(words[1]);
      if (!(bpm >= 40 && bpm <= 240)) return fail(lineNo, `Tempo muss zwischen 40 und 240 liegen, nicht „${words[1] ?? ''}“.`);
      return events.push({ bar, line: lineNo, type: 'tempo', value: bpm, text: command });
    }

    if (head === 'swing') {
      const percent = Number(String(words[1] ?? '').replace('%', ''));
      if (!(percent >= 0 && percent <= 60)) return fail(lineNo, `Swing muss zwischen 0 und 60 (Prozent) liegen.`);
      return events.push({ bar, line: lineNo, type: 'swing', value: percent / 100, text: command });
    }

    if (head === 'key') {
      const note = String(words[1] ?? '').toLowerCase();
      const match = /^([a-h][#b]?)(-?\d)?$/.exec(note);
      if (!match || !(match[1] in NOTE_CLASSES)) return fail(lineNo, `Unbekannter Grundton „${words[1] ?? ''}“ – erlaubt sind C, C#, Db … B.`);
      const scaleWord = String(words[2] ?? 'minor').toLowerCase();
      const scale = SCALE_WORDS[scaleWord];
      if (!scale) return fail(lineNo, `Unbekannte Tonleiter „${words[2]}“ – erlaubt sind ${Object.keys(SCALE_WORDS).join(', ')}.`);
      const octave = match[2] === undefined ? 3 : Number(match[2]);
      const root = (octave + 1) * 12 + NOTE_CLASSES[match[1]];
      if (root < 12 || root > 96) return fail(lineNo, `Die Tonart liegt außerhalb des nutzbaren Bereichs.`);
      return events.push({ bar, line: lineNo, type: 'key', root, scale, text: command });
    }

    if (head === 'scene') {
      const name = words.slice(1).join(' ').trim();
      const scene = sceneByName.get(name.toLowerCase());
      if (!scene) return fail(lineNo, `Unbekannte Szene „${name}“ – vorhanden: ${[...sceneByName.values()].map((s) => s.name).join(', ') || '—'}.`);
      return events.push({ bar, line: lineNo, type: 'scene', sceneId: scene.id, text: command });
    }

    if (head === 'mute' || head === 'unmute') {
      const names = words.slice(1).filter(Boolean);
      if (!names.length) return fail(lineNo, `„${head}“ braucht mindestens eine Spur.`);
      const ids = [];
      for (const name of names) {
        const track = trackByName.get(name.toLowerCase());
        if (!track) return fail(lineNo, `Unbekannte Spur „${name}“ – vorhanden: ${trackList()}.`);
        ids.push(track.id);
      }
      return events.push({ bar, line: lineNo, type: 'mute', value: head === 'mute', trackIds: ids, text: command });
    }

    if (head === 'end' || head === 'stop') {
      return events.push({ bar, line: lineNo, type: 'end', text: command });
    }

    const assign = ASSIGN.exec(command);
    if (assign) {
      const track = trackByName.get(assign[1].trim().toLowerCase());
      if (!track) return fail(lineNo, `Unbekannte Spur „${assign[1].trim()}“ – vorhanden: ${trackList()}.`);
      const slot = CLIP_SLOTS.indexOf(assign[2].toUpperCase());
      if (!track.clips[slot]) return fail(lineNo, `Spur „${track.name}“ hat keinen Clip im Slot ${assign[2].toUpperCase()}.`);
      return events.push({ bar, line: lineNo, type: 'clip', trackId: track.id, slot, text: command });
    }

    const ramp = RAMP.exec(command);
    if (ramp) {
      const target = resolveTarget(ramp[1], trackByName);
      if (target.error) return fail(lineNo, target.error);
      const bars = ramp[4] === undefined ? 0 : Number(ramp[4]);
      return events.push({
        bar, line: lineNo, type: 'ramp', target: target.value,
        from: Number(ramp[2]), to: Number(ramp[3]), bars, text: command,
      });
    }

    return fail(lineNo, `Unverständlich: „${command}“.`);
  }

  events.sort((a, b) => a.bar - b.bar || a.line - b.line);
  return { events, errors };
}

// „bass.filter.freq“, „bass.volume“, „bass.source.detune“, „master.volume“
function resolveTarget(path, trackByName) {
  const parts = path.split('.');
  if (parts[0].toLowerCase() === 'master') {
    if (parts[1]?.toLowerCase() !== 'volume' || parts.length !== 2) {
      return { error: `Am Master gibt es nur „master.volume“.` };
    }
    return { value: { kind: 'master' } };
  }

  const track = trackByName.get(parts[0].toLowerCase());
  if (!track) return { error: `Unbekannte Spur „${parts[0]}“.` };

  if (parts.length === 2) {
    const name = parts[1].toLowerCase();
    if (name === 'volume' || name === 'gate') {
      return { value: { kind: 'track', trackId: track.id, param: name } };
    }
    return { error: `„${parts[1]}“ gibt es an einer Spur nicht – möglich sind volume und gate.` };
  }

  if (parts.length === 3) {
    const [, second, param] = parts;
    if (second.toLowerCase() === 'source') {
      const spec = MODULES[track.source.type].params.find((p) => p.id.toLowerCase() === param.toLowerCase());
      if (!spec) {
        const ids = MODULES[track.source.type].params.map((p) => p.id).join(', ');
        return { error: `Die Quelle „${MODULES[track.source.type].name}“ kennt „${param}“ nicht – möglich: ${ids}.` };
      }
      return { value: { kind: 'source', trackId: track.id, param: spec.id } };
    }

    const type = second.toLowerCase();
    if (!MODULES[type] || MODULES[type].kind !== 'fx') {
      return { error: `Unbekannter Effekt „${second}“.` };
    }
    const block = track.chain.find((b) => b.type === type);
    if (!block) return { error: `Spur „${track.name}“ hat keinen Effekt „${second}“ in der Kette.` };
    const spec = MODULES[type].params.find((p) => p.id.toLowerCase() === param.toLowerCase());
    if (!spec) {
      const ids = MODULES[type].params.map((p) => p.id).join(', ');
      return { error: `„${second}“ kennt „${param}“ nicht – möglich: ${ids}.` };
    }
    return { value: { kind: 'fx', trackId: track.id, blockType: type, param: spec.id } };
  }

  return { error: `Unverständliches Ziel „${path}“.` };
}

// ----------------------------------------------------------------- Spielen

export class ScriptRunner {
  constructor({ getProject, engine, transport, onEvent = () => {} }) {
    this.getProject = getProject;
    this.engine = engine;
    this.transport = transport;
    this.onEvent = onEvent;
    this.events = [];
    this.errors = [];
    this.done = new Set();
    this.lastFired = null;
  }

  get project() {
    return this.getProject();
  }

  get enabled() {
    return !!this.project.script?.enabled && this.events.length > 0;
  }

  compile() {
    const { events, errors } = parseScript(this.project.script?.text || '', this.project);
    this.events = events;
    this.errors = errors;
    this.reset();
    return { events, errors };
  }

  reset() {
    this.done.clear();
    this.lastFired = null;
  }

  // Wird vom Transport an jeder Taktgrenze aufgerufen – mit dem exakten
  // Zeitstempel, damit Clipwechsel auf den Schlag sitzen.
  onBar(bar, time) {
    if (!this.enabled) return;
    for (const event of this.events) {
      if (event.bar !== bar || event.type === 'ramp') continue;
      this.fire(event, time);
    }
  }

  fire(event, time) {
    const project = this.project;
    switch (event.type) {
      case 'tempo':
        project.tempo = event.value;
        break;
      case 'swing':
        project.swing = event.value;
        break;
      case 'key':
        project.root = event.root;
        project.scale = event.scale;
        break;
      case 'clip': {
        const track = project.tracks.find((t) => t.id === event.trackId);
        if (track && track.clips[event.slot]) {
          track.clip = event.slot;
          track.queued = null;
        }
        break;
      }
      case 'scene': {
        const scene = project.scenes.find((s) => s.id === event.sceneId);
        if (!scene) break;
        for (const track of project.tracks) {
          const slot = scene.slots[track.id];
          if (Number.isInteger(slot) && track.clips[slot]) {
            track.clip = slot;
            track.queued = null;
          }
          const mute = scene.mutes?.[track.id];
          if (typeof mute === 'boolean') track.mix.mute = mute;
        }
        this.engine.applyMix();
        break;
      }
      case 'mute':
        for (const id of event.trackIds) {
          const track = project.tracks.find((t) => t.id === id);
          if (track) track.mix.mute = event.value;
        }
        this.engine.applyMix();
        break;
      case 'end':
        // Erst nach diesem Takt anhalten, sonst verschluckt es den letzten Schlag.
        setTimeout(() => this.transport.stop(), Math.max(0, (time - this.engine.ctx.currentTime) * 1000));
        break;
      default:
        break;
    }
    this.lastFired = event;
    this.onEvent(event);
  }

  // Parameterfahrten laufen weich mit der Bildwiederholung, nicht im Raster.
  updateRamps(positionSteps) {
    if (!this.enabled) return;
    const nowBars = positionSteps / STEPS_PER_BAR;
    for (const event of this.events) {
      if (event.type !== 'ramp') continue;
      const start = event.bar - 1;
      const end = start + (event.bars || 0);
      const key = `${event.line}:${event.bar}`;

      if (nowBars < start) continue;
      if (nowBars >= end) {
        if (this.done.has(key)) continue;
        this.done.add(key);
        this.setTarget(event.target, event.to);
        continue;
      }
      this.done.delete(key);
      const progress = event.bars > 0 ? (nowBars - start) / event.bars : 1;
      this.setTarget(event.target, event.from + (event.to - event.from) * progress);
    }
  }

  setTarget(target, value) {
    const project = this.project;
    if (target.kind === 'master') {
      project.master.volume = clamp(value, 0, 1);
      this.engine.setMasterVolume(project.master.volume);
      return;
    }
    const track = project.tracks.find((t) => t.id === target.trackId);
    if (!track) return;

    if (target.kind === 'track') {
      if (target.param === 'volume') {
        track.mix.volume = clamp(value, 0, 1);
        this.engine.applyMix();
      } else {
        track.gate = clamp(value, 0.05, 4);
      }
      return;
    }
    if (target.kind === 'source') {
      track.source.params[target.param] = value;
      return;
    }
    const block = track.chain.find((b) => b.type === target.blockType);
    if (!block) return;
    block.params[target.param] = value;
    this.engine.setParam(track.id, block.id, target.param, value);
  }

  // Die nächsten Ereignisse – dasselbe Prinzip wie der Streifen: zeigen,
  // was kommt, nicht nur was ist.
  upcoming(positionSteps, count = 3) {
    if (!this.events.length) return [];
    const nowBars = positionSteps / STEPS_PER_BAR;
    return this.events
      .filter((e) => e.bar - 1 > nowBars - 0.001)
      .slice(0, count)
      .map((e) => ({ ...e, inBars: e.bar - 1 - nowBars }));
  }

  lastBar() {
    return this.events.reduce((max, e) => Math.max(max, e.bar), 0);
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
