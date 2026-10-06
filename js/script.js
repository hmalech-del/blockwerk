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

import { MODULES, EFFECTS, defaultParams } from './modules.js';
import { CLIP_SLOTS, MAX_NUDGE, MAX_SWING, STEPS_PER_BAR, uid } from './project.js';
import { parseSteps } from './pattern.js';
import { equalSlices, detectTransients } from './samples.js';

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

// Spur- und Szenennamen duerfen Leerzeichen haben – neue Spuren heissen
// „Spur 1“. Deshalb stehen in den Mustern keine \S+-Platzhalter, sondern
// sparsame (.+?)-Gruppen, die erst bis zum naechsten festen Teil wachsen.
const RAMP = /^(.+?)\s+(-?[\d.]+)\s*(?:->|→)\s*(-?[\d.]+)(?:\s+over\s+([\d.]+)\s*bars?)?$/i;
const ASSIGN = /^([^=]+?)\s*=\s*([a-dA-D])$/;
const PATTERN = /^pattern\s+(.+?)\s+([a-dA-D])\s*=\s*(.+)$/i;
// Es gibt vier Live-Regler. Frueher stand hier [1-8]: „control 5 …“ lief
// fehlerfrei durch, der Regler erschien – und war nach dem naechsten Laden weg,
// weil das Modell nur vier Plaetze hat. Lieber sofort meckern als mitten im Set.
const CONTROL = /^control\s+(\d+)\s+(.+?)(?:\s+(-?[\d.]+)\s+(-?[\d.]+))?(?:\s+as\s+(.+))?$/i;
const MACRO_SLOTS = 4;

// „master" ist im Script ein gueltiges Ziel fuer add/remove/bypass, obwohl es
// keine Spur ist. Dieser Schluessel haelt die Summe in denselben Tabellen.
const MASTER_ID = 'master';

// Namen vergleichen sich tolerant: Gross-/Kleinschreibung und Leerzeichen
// zaehlen nicht mit. „spur1“, „Spur 1“ und „SPUR  1“ sind dieselbe Spur.
export const nameKey = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, '');

// ------------------------------------------------------------------- Lesen

export function parseScript(text, project) {
  const events = [];
  const errors = [];
  const lines = String(text ?? '').split('\n');

  const trackByName = new Map(project.tracks.map((t) => [nameKey(t.name), t]));
  const sceneByName = new Map(project.scenes.map((s) => [nameKey(s.name), s]));
  const findTrack = (name) => trackByName.get(nameKey(name)) || null;
  const trackList = () => project.tracks.map((t) => t.name).join(', ') || '—';

  // Aus einer Wortliste so viele Woerter wie moeglich als Spurname lesen –
  // von lang nach kurz, damit „mute Spur 1 Spur 2“ zwei Spuren findet und
  // „add Spur 1 crusher“ den Effekt nicht zum Namen zaehlt.
  // „tail“ sagt, wie viele Woerter am Ende sicher nicht zum Namen gehoeren –
  // nur fuer die Fehlermeldung, damit die den Namen nennt und nicht den Effekt.
  function takeTrack(words, from, tail = 0, allowMaster = false) {
    if (allowMaster && nameKey(words[from]) === MASTER_ID) {
      return { track: { id: MASTER_ID, name: 'Master', chain: project.master.chain }, next: from + 1, name: 'Master' };
    }
    for (let end = words.length; end > from; end--) {
      const name = words.slice(from, end).join(' ');
      const track = findTrack(name);
      if (track) return { track, next: end, name };
    }
    const stop = Math.max(from + 1, words.length - tail);
    return { track: null, next: from + 1, name: words.slice(from, stop).join(' ') };
  }

  const unknownTrack = (name) => `Unbekannte Spur „${name}“ – vorhanden: ${trackList()}.`;

  // Vorlauf: Effekte, die das Script selbst anlegt, gelten beim Pruefen als
  // vorhanden – sonst koennte man einen frisch hinzugefuegten Effekt nicht
  // im selben Script regeln.
  const willExist = new Set();
  for (const raw of lines) {
    const clean = raw.replace(/(^|\s)(#|;|\/\/).*$/, '').replace(/^\s*bar\s+\d+\s*/i, '');
    for (const part of clean.split(',')) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      if (words[0]?.toLowerCase() !== 'add') continue;
      const { track, next } = takeTrack(words, 1, 0, true);
      const type = String(words[next] ?? '').toLowerCase();
      if (track && MODULES[type]?.kind === 'fx') willExist.add(`${track.id}|${type}`);
    }
  }

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
      // Stillschweigend den Rest der Zeile zu schlucken waere auf der Buehne
      // boesartig: „tempo 88 -> 128 over 16 bars“ saehe aus wie eine Fahrt
      // und waere in Wahrheit ein harter Sprung auf 88.
      if (words.length > 2) {
        return fail(lineNo, `„tempo“ nimmt nur eine Zahl – „${words.slice(2).join(' ')}“ ist zu viel. `
          + `Tempofahrten gibt es (noch) nicht; setze das Tempo takt­weise in Stufen.`);
      }
      return events.push({ bar, line: lineNo, type: 'tempo', value: bpm, text: command });
    }

    // swing 54          – Shuffle in Prozent
    // swing 54 on 8     – auf dem 8tel-Raster statt dem 16tel
    if (head === 'swing') {
      const percent = Number(String(words[1] ?? '').replace('%', ''));
      const maxPercent = Math.round(MAX_SWING * 100);
      if (!(percent >= 0 && percent <= maxPercent)) {
        return fail(lineNo, `Swing muss zwischen 0 und ${maxPercent} (Prozent) liegen.`);
      }
      let grid = null;
      if (words.length > 2) {
        const onGrid = /^on\s+(8|16)(?:tel|ths?)?$/i.exec(words.slice(2).join(' '));
        if (!onGrid) {
          return fail(lineNo, `Nach dem Swingwert geht nur noch „on 8“ oder „on 16“ – nicht „${words.slice(2).join(' ')}“.`);
        }
        grid = Number(onGrid[1]);
      }
      return events.push({ bar, line: lineNo, type: 'swing', value: percent / 100, grid, text: command });
    }

    if (head === 'key') {
      const note = String(words[1] ?? '').toLowerCase();
      const match = /^([a-h][#b]?)(-?\d)?$/.exec(note);
      if (!match || !(match[1] in NOTE_CLASSES)) return fail(lineNo, `Unbekannter Grundton „${words[1] ?? ''}“ – erlaubt sind C, C#, Db … B.`);
      const scaleWord = String(words[2] ?? 'minor').toLowerCase();
      const scale = SCALE_WORDS[scaleWord];
      if (!scale) return fail(lineNo, `Unbekannte Tonleiter „${words[2]}“ – erlaubt sind ${Object.keys(SCALE_WORDS).join(', ')}.`);
      if (words.length > 3) return fail(lineNo, `„key“ nimmt Grundton und Tonleiter – „${words.slice(3).join(' ')}“ ist zu viel.`);
      const octave = match[2] === undefined ? 3 : Number(match[2]);
      const root = (octave + 1) * 12 + NOTE_CLASSES[match[1]];
      if (root < 12 || root > 96) return fail(lineNo, `Die Tonart liegt außerhalb des nutzbaren Bereichs.`);
      return events.push({ bar, line: lineNo, type: 'key', root, scale, text: command });
    }

    if (head === 'scene') {
      const name = words.slice(1).join(' ').trim();
      const scene = sceneByName.get(nameKey(name));
      if (!scene) return fail(lineNo, `Unbekannte Szene „${name}“ – vorhanden: ${[...sceneByName.values()].map((s) => s.name).join(', ') || '—'}.`);
      return events.push({ bar, line: lineNo, type: 'scene', sceneId: scene.id, text: command });
    }

    if (head === 'mute' || head === 'unmute') {
      if (words.length < 2) return fail(lineNo, `„${head}“ braucht mindestens eine Spur.`);
      const ids = [];
      let at = 1;
      while (at < words.length) {
        const { track, next, name } = takeTrack(words, at);
        if (!track) return fail(lineNo, unknownTrack(name));
        ids.push(track.id);
        at = next;
      }
      return events.push({ bar, line: lineNo, type: 'mute', value: head === 'mute', trackIds: ids, text: command });
    }

    // Effekte zur Laufzeit an- und abbauen. Die Regler dafuer erscheinen
    // automatisch im Klang-Reiter, weil der die Kette aus dem Modell zeichnet.
    if (head === 'add' || head === 'remove') {
      const { track, next, name } = takeTrack(words, 1, 1, true);
      if (!track) return fail(lineNo, unknownTrack(name));
      const type = String(words[next] ?? '').toLowerCase();
      if (!MODULES[type] || MODULES[type].kind !== 'fx') {
        return fail(lineNo, `Unbekannter Effekt „${words[next] ?? ''}“ – möglich: ${EFFECTS.map((m) => m.id).join(', ')}.`);
      }
      return events.push({ bar, line: lineNo, type: head === 'add' ? 'addFx' : 'removeFx', trackId: track.id, fx: type, text: command });
    }

    if (head === 'bypass') {
      const tail = ['on', 'off'].includes(String(words[words.length - 1]).toLowerCase()) ? 2 : 1;
      const { track, next, name } = takeTrack(words, 1, tail, true);
      if (!track) return fail(lineNo, unknownTrack(name));
      const type = String(words[next] ?? '').toLowerCase();
      if (!MODULES[type] || MODULES[type].kind !== 'fx') {
        return fail(lineNo, `Unbekannter Effekt „${words[next] ?? ''}“ – möglich: ${EFFECTS.map((m) => m.id).join(', ')}.`);
      }
      const state = String(words[next + 1] ?? 'on').toLowerCase();
      if (!['on', 'off'].includes(state)) return fail(lineNo, `„bypass“ endet auf on oder off.`);
      return events.push({ bar, line: lineNo, type: 'bypassFx', trackId: track.id, fx: type, value: state === 'on', text: command });
    }

    // Muster direkt aus dem Script: pattern kick A = x . . . x . . .
    if (head === 'pattern') {
      const match = PATTERN.exec(command);
      if (!match) return fail(lineNo, `Erwartet: pattern <spur> <slot> = x . . . …`);
      const track = findTrack(match[1]);
      if (!track) return fail(lineNo, unknownTrack(match[1].trim()));
      const slot = CLIP_SLOTS.indexOf(match[2].toUpperCase());
      const tokens = match[3].trim().split(/[\s|]+/).filter(Boolean).length;
      const bars = tokens > 32 ? 4 : tokens > 16 ? 2 : 1;
      if (!tokens) return fail(lineNo, `Das Muster ist leer.`);
      return events.push({
        bar, line: lineNo, type: 'pattern', trackId: track.id, slot, bars,
        steps: parseSteps(match[3], bars), text: command,
      });
    }

    // Live-Regler belegen: control 1 bass.filter.freq [300 4000] [as Name]
    if (head === 'control') {
      const match = CONTROL.exec(command);
      if (!match) return fail(lineNo, `Erwartet: control <1-${MACRO_SLOTS}> <ziel> [min max] [as Name]`);
      const slot = Number(match[1]);
      if (!(slot >= 1 && slot <= MACRO_SLOTS)) {
        return fail(lineNo, `Es gibt ${MACRO_SLOTS} Live-Regler – „${slot}“ liegt daneben.`);
      }
      const path = match[2].trim();
      const target = resolveTarget(path, trackByName, willExist, project);
      if (target.error) return fail(lineNo, target.error);
      return events.push({
        bar, line: lineNo, type: 'control', slot: slot - 1,
        path, target: target.value,
        min: match[3] === undefined ? null : Number(match[3]),
        max: match[4] === undefined ? null : Number(match[4]),
        label: match[5]?.trim() || path,
        text: command,
      });
    }

    // Live-Slicing: dieselbe Zerlegung wie im Sampler-Reiter, nur im Ablauf.
    if (head === 'slice') {
      const { track, next, name } = takeTrack(words, 1, 1);
      if (!track) return fail(lineNo, unknownTrack(name));
      const what = String(words[next] ?? '').toLowerCase();
      if (what === 'transients') {
        return events.push({ bar, line: lineNo, type: 'slice', trackId: track.id, mode: 'transients', text: command });
      }
      const count = Number(what);
      if (!(count >= 1 && count <= 64)) {
        return fail(lineNo, `„slice“ braucht eine Zahl von 1 bis 64 oder das Wort transients.`);
      }
      return events.push({ bar, line: lineNo, type: 'slice', trackId: track.id, mode: 'equal', count, text: command });
    }

    if (head === 'end' || head === 'stop') {
      if (words.length > 1) return fail(lineNo, `„${head}“ steht allein – „${words.slice(1).join(' ')}“ ist zu viel.`);
      return events.push({ bar, line: lineNo, type: 'end', text: command });
    }

    const assign = ASSIGN.exec(command);
    if (assign) {
      const track = findTrack(assign[1]);
      if (!track) return fail(lineNo, unknownTrack(assign[1].trim()));
      const slot = CLIP_SLOTS.indexOf(assign[2].toUpperCase());
      if (!track.clips[slot]) return fail(lineNo, `Spur „${track.name}“ hat keinen Clip im Slot ${assign[2].toUpperCase()}.`);
      return events.push({ bar, line: lineNo, type: 'clip', trackId: track.id, slot, text: command });
    }

    const ramp = RAMP.exec(command);
    if (ramp) {
      const target = resolveTarget(ramp[1].trim(), trackByName, willExist, project);
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
function resolveTarget(path, trackByName, willExist = new Set(), project = null) {
  const all = String(path).split('.');
  if (nameKey(all[0]) === 'master') {
    if (all.length === 2 && nameKey(all[1]) === 'volume') return { value: { kind: 'master' } };
    // master.filter.freq – die Summe hat dieselbe Kette wie eine Spur.
    if (all.length === 3) {
      const type = all[1].toLowerCase();
      if (!MODULES[type] || MODULES[type].kind !== 'fx') return { error: `Unbekannter Effekt „${all[1]}“.` };
      const chain = project?.master?.chain || [];
      if (!chain.some((b) => b.type === type) && !willExist.has(`${MASTER_ID}|${type}`)) {
        return { error: `Der Master hat keinen Effekt „${all[1]}“ – mit „add master ${type}“ lässt er sich anlegen.` };
      }
      const spec = MODULES[type].params.find((p) => p.id.toLowerCase() === all[2].toLowerCase());
      if (!spec) {
        return { error: `„${all[1]}“ kennt „${all[2]}“ nicht – möglich: ${MODULES[type].params.map((p) => p.id).join(', ')}.` };
      }
      return { value: { kind: 'masterFx', blockType: type, param: spec.id } };
    }
    return { error: `Am Master gibt es „master.volume“ und „master.<effekt>.<parameter>“.` };
  }

  // Der Spurname steht vorn und darf selbst Punkte enthalten. Deshalb von
  // lang nach kurz probieren: „Spur 1.volume“ findet „Spur 1“, nicht „Spur 1.volume“.
  let track = null;
  let parts = all;
  for (let take = all.length - 1; take >= 1; take--) {
    const found = trackByName.get(nameKey(all.slice(0, take).join('.')));
    if (found) {
      track = found;
      parts = [all.slice(0, take).join('.'), ...all.slice(take)];
      break;
    }
  }
  if (!track && trackByName.get(nameKey(path))) {
    return { error: `„${path}“ ist eine Spur, aber noch kein Ziel – gemeint ist z. B. „${path}.volume“.` };
  }
  if (!track) return { error: `Unbekannte Spur „${all[0]}“.` };

  if (parts.length === 2) {
    const name = parts[1].toLowerCase();
    if (['volume', 'gate', 'offset', 'nudge'].includes(name)) {
      return { value: { kind: 'track', trackId: track.id, param: name } };
    }
    return { error: `„${parts[1]}“ gibt es an einer Spur nicht – möglich sind volume, gate, offset und nudge.` };
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
    if (!block && !willExist.has(`${track.id}|${type}`)) {
      return { error: `Spur „${track.name}“ hat keinen Effekt „${second}“ in der Kette – mit „add ${track.name} ${type}“ lässt er sich anlegen.` };
    }
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
  constructor({ getProject, engine, transport, samples = null, onEvent = () => {}, onStructure = () => {} }) {
    this.getProject = getProject;
    this.engine = engine;
    this.samples = samples;
    this.transport = transport;
    this.onEvent = onEvent;
    this.onStructure = onStructure;
    this.events = [];
    this.errors = [];
    this.done = new Set();
    this.firedBars = new Set();
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
    this.firedBars.clear();
    this.lastFired = null;
  }

  // Wird vom Transport an jeder Taktgrenze aufgerufen – mit dem exakten
  // Zeitstempel, damit Clipwechsel auf den Schlag sitzen.
  onBar(bar, time) {
    if (!this.enabled) return;
    // Ein Takt kann neu geplant werden (siehe Transport.rewindTo) – seine
    // Ereignisse duerfen dann nicht ein zweites Mal feuern.
    if (this.firedBars.has(bar)) return;
    this.firedBars.add(bar);
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
        if (event.grid) project.swingGrid = event.grid;
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
      case 'addFx': {
        const chain = chainFor(project, event.trackId);
        if (!chain || chain.some((b) => b.type === event.fx)) break;
        chain.push({ id: uid('b'), type: event.fx, bypass: false, params: defaultParams(event.fx) });
        this.onStructure();
        break;
      }
      case 'removeFx': {
        const chain = chainFor(project, event.trackId);
        const index = chain ? chain.findIndex((b) => b.type === event.fx) : -1;
        if (index < 0) break;
        chain.splice(index, 1);
        this.onStructure();
        break;
      }
      case 'bypassFx': {
        const block = chainFor(project, event.trackId)?.find((b) => b.type === event.fx);
        if (!block) break;
        block.bypass = event.value;
        this.onStructure();
        break;
      }
      case 'pattern': {
        const track = project.tracks.find((t) => t.id === event.trackId);
        if (!track) break;
        track.clips[event.slot] = {
          id: uid('c'),
          bars: event.bars,
          steps: event.steps.map((step) => ({ ...step })),
        };
        this.onStructure();
        break;
      }
      case 'slice': {
        const track = project.tracks.find((t) => t.id === event.trackId);
        const sample = project.samples?.find((s) => s.id === track?.sampleId);
        if (!sample) break;
        if (event.mode === 'equal') {
          sample.slices = equalSlices(sample.duration, event.count);
        } else {
          const buffer = this.samples?.get(sample.id);
          if (buffer) sample.slices = detectTransients(buffer, { sensitivity: 0.5 });
        }
        this.onStructure();
        break;
      }
      case 'control': {
        setMacro(project, event);
        this.onStructure();
        break;
      }
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
    if (target.kind === 'masterFx') {
      const block = project.master.chain.find((b) => b.type === target.blockType);
      if (!block) return;
      block.params[target.param] = value;
      this.engine.setParam(MASTER_ID, block.id, target.param, value);
      return;
    }
    const track = project.tracks.find((t) => t.id === target.trackId);
    if (!track) return;

    if (target.kind === 'track') {
      if (target.param === 'volume') {
        track.mix.volume = clamp(value, 0, 1);
        this.engine.applyMix();
      } else if (target.param === 'offset') {
        track.offset = Math.round(clamp(value, -14, 14));
      } else if (target.param === 'nudge') {
        track.nudge = Math.round(clamp(value, -MAX_NUDGE, MAX_NUDGE));
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

// Spur oder Summe – beide haben eine Kette, nur eine davon hat Stimmen.
function chainFor(project, trackId) {
  if (trackId === MASTER_ID) return project.master.chain;
  return project.tracks.find((t) => t.id === trackId)?.chain || null;
}

// Ein Live-Regler merkt sich Ziel, Bereich und Beschriftung; der Wert kommt
// aus dem aktuellen Stand des Ziels.
function setMacro(project, event) {
  const spec = targetSpec(project, event.target);
  project.macros = project.macros || [];
  project.macros[event.slot] = {
    label: event.label,
    path: event.path,
    target: event.target,
    min: event.min ?? spec.min,
    max: event.max ?? spec.max,
  };
}

// Bereich und Art eines Ziels aus der Modul-Registry ableiten.
export function targetSpec(project, target) {
  if (target.kind === 'master') return { min: 0, max: 1, scale: null };
  if (target.kind === 'masterFx') {
    const spec = MODULES[target.blockType]?.params.find((p) => p.id === target.param);
    return spec ? { min: spec.min, max: spec.max, scale: spec.scale || null, unit: spec.unit } : { min: 0, max: 1, scale: null };
  }
  const track = project.tracks.find((t) => t.id === target.trackId);
  if (!track) return { min: 0, max: 1, scale: null };
  if (target.kind === 'track') {
    if (target.param === 'volume') return { min: 0, max: 1, scale: null };
    if (target.param === 'offset') return { min: -7, max: 7, scale: null };
    if (target.param === 'nudge') return { min: -MAX_NUDGE, max: MAX_NUDGE, scale: null, unit: 'ms' };
    return { min: 0.05, max: 4, scale: 'log' };
  }
  const type = target.kind === 'source' ? track.source.type : target.blockType;
  const spec = MODULES[type]?.params.find((p) => p.id === target.param);
  return spec ? { min: spec.min, max: spec.max, scale: spec.scale || null, unit: spec.unit } : { min: 0, max: 1, scale: null };
}

export function readTarget(project, target) {
  if (target.kind === 'master') return project.master.volume;
  if (target.kind === 'masterFx') {
    return project.master.chain.find((b) => b.type === target.blockType)?.params[target.param] ?? 0;
  }
  const track = project.tracks.find((t) => t.id === target.trackId);
  if (!track) return 0;
  if (target.kind === 'track') {
    if (target.param === 'volume') return track.mix.volume;
    if (target.param === 'offset') return track.offset || 0;
    if (target.param === 'nudge') return track.nudge || 0;
    return track.gate;
  }
  if (target.kind === 'source') return track.source.params[target.param];
  return track.chain.find((b) => b.type === target.blockType)?.params[target.param] ?? 0;
}

export { resolveTarget };
