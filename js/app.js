// Verdrahtung: Projektzustand, Engine, Transport, Ansichten, Eingaben.

import { Engine } from './engine.js';
import { Transport } from './transport.js';
import { Rack, renderPalette } from './rack.js';
import { Sequencer } from './sequencer.js';
import { Live, macroTargets, pathToTarget } from './live.js';
import { ScriptRunner, targetSpec } from './script.js';
import { ScriptView } from './scriptview.js';
import { GestureField, columnsFor, loopSteps, makeTake, valueAtStep, MAX_TAKES } from './gesture.js';
import { SamplerView } from './sampler.js';
import {
  CONTOURS, MOODS, classifyOnset, generateMelody, generateSliceArrangement,
  onsetsToSteps, varyMelody,
} from './ideas.js';
import { SampleStore, Recorder, equalSlices, detectTransients } from './samples.js';
import { Keyboard } from './keyboard.js';
import { parseSteps, stepsToText } from './pattern.js';
import {
  CLIP_SLOTS, SCALES, TRACK_COLORS, applyPreset, degToMidi, demoProject,
  makeClip, makeProject, makeSample, makeScene, makeTrack, normalizeProject, SOUND_PRESETS,
} from './project.js';
import { defaultParams } from './modules.js';

const STORAGE_KEY = 'blockwerk.project.v2';
const LEGACY_KEY = 'blockwerk.patch.v1';

const $ = (sel) => document.querySelector(sel);

const samples = new SampleStore();
const engine = new Engine(samples);
let recorder = null;
let selectedSampleId = null;
let project = loadProject();
let selectedId = project.tracks[0]?.id || null;
let userSuspended = false;

let currentView = 'live';

const transport = new Transport(engine, () => project, {
  onClipChange: () => {
    sequencer.render();
    live.refresh();
  },
  onBar: (bar, time) => script.onBar(bar, time),
});

const script = new ScriptRunner({
  getProject: () => project,
  engine,
  transport,
  samples,
  onEvent: () => {
    sequencer.render();
    live.refresh();
    syncControls();
  },
  // Ein Script, das Effekte an- oder abbaut, muss den Graphen und die
  // Oberfläche mitziehen – sonst gäbe es Regler ohne Klang.
  onStructure: () => {
    engine.sync();
    live.render();
    sequencer.render();
    if (currentView === 'sound') rack.render();
    if (currentView === 'sampler') samplerView.render();
    save();
  },
});

const selectedTrack = () => project.tracks.find((t) => t.id === selectedId) || project.tracks[0] || null;

// ------------------------------------------------------------- Persistenz

function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY);
    if (raw) return normalizeProject(JSON.parse(raw));
  } catch (e) {
    console.warn('Gespeichertes Projekt nicht lesbar:', e);
  }
  return demoProject();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    } catch (e) {
      console.warn('Projekt konnte nicht gespeichert werden:', e);
    }
  }, 300);
}

// --------------------------------------------------------------- Ansichten

const rack = new Rack($('#rack'), {
  getTrack: selectedTrack,
  getProject: () => project,
  getSelected: () => selectedId,
  onSelectTrack: (id) => {
    selectedId = id;
    rack.render();
    sequencer.render();
    save();
  },
  onStructure: ({ light = false } = {}) => {
    engine.sync();
    if (!light) rack.render();
    sequencer.render();
    save();
  },
  onParam: (scope, blockId, paramId, value) => {
    const track = selectedTrack();
    if (!track) return;
    if (scope === 'track') {
      if (paramId === 'volume') {
        track.mix.volume = value;
        engine.applyMix();
      } else {
        track[paramId] = value;
      }
    } else if (scope === 'source') {
      track.source.params[paramId] = value;
    } else {
      const block = track.chain.find((b) => b.id === blockId);
      if (!block) return;
      block.params[paramId] = value;
      engine.setParam(track.id, blockId, paramId, value);
    }
    save();
  },
  onSourceType: (type) => {
    const track = selectedTrack();
    track.source = { type, params: defaultParams(type) };
    engine.killTrack(track.id);
    rack.render();
    save();
  },
});

const sequencer = new Sequencer($('#sequencer'), {
  getProject: () => project,
  getSelected: () => selectedId,
  transport: () => transport,
  clipToText: (clip) => stepsToText(clip.steps),
  onSelect: (id) => {
    selectedId = id;
    sequencer.render();
    rack.render();
    save();
  },
  onChange: ({ mix = false, quiet = false } = {}) => {
    if (mix) engine.applyMix();
    if (!quiet) sequencer.render();
    save();
  },
  onPreview: (track, step) => {
    ensureAudio();
    if (userSuspended) return;
    const midi = degToMidi(step.deg, project.root, project.scale) + track.octave * 12;
    engine.noteOn(track.id, midi, undefined, { dur: 0.2, velocity: step.on === 2 ? 1 : 0.7 });
  },
  onRoll: (track, options) => {
    const clip = track?.clips[track.clip];
    if (!clip) return;
    const stepCount = clip.steps.length;
    if (track.source.type === 'sampler') {
      const sample = project.samples.find((s) => s.id === track.sampleId);
      if (!sample) return sequencer.setStatus('Dieser Spur fehlt noch ein Sample.');
      clip.steps = generateSliceArrangement({
        stepCount, sliceCount: sample.slices.length, density: options.density,
      });
      sequencer.setStatus(`Neue Slice-Folge aus ${sample.slices.length} Teilen`);
    } else {
      clip.steps = generateMelody({
        stepCount,
        density: options.density,
        contour: options.contour,
        scaleLength: SCALES[project.scale].steps.length,
      });
      sequencer.setStatus(`Neue Melodie · ${CONTOURS[options.contour].label}`);
    }
    save();
    sequencer.render();
    return undefined;
  },

  onVary: (track, options) => {
    const clip = track?.clips[track.clip];
    if (!clip) return;
    clip.steps = varyMelody(clip.steps, {
      amount: 0.25 + options.density * 0.3,
      scaleLength: SCALES[project.scale].steps.length,
    });
    save();
    sequencer.render();
    sequencer.setStatus('Variiert – was gefiel, ist geblieben');
    return undefined;
  },

  onBeatbox: (track) => beatbox(track),

  onAddTrack: () => {
    if (project.tracks.length >= 8) return;
    const track = makeTrack({
      name: `Spur ${project.tracks.length + 1}`,
      color: TRACK_COLORS[project.tracks.length % TRACK_COLORS.length],
      clips: [''],
    });
    project.tracks.push(track);
    selectedId = track.id;
    engine.sync();
    sequencer.render();
    live.render();
    rack.render();
    save();
  },
  onClipText: (track, text) => {
    const clip = track.clips[track.clip];
    if (!clip) return;
    clip.steps = parseSteps(text, clip.bars);
    save();
  },
  onClipBars: (track, bars) => {
    const clip = track.clips[track.clip];
    if (!clip) return;
    const old = clip.steps;
    clip.bars = bars;
    clip.steps = parseSteps(stepsToText(old), bars); // vorhandene Takte bleiben erhalten
    save();
  },
  onClipCopy: (track) => {
    const source = track.clips[track.clip];
    const free = track.clips.findIndex((c) => !c);
    if (!source || free < 0) return;
    track.clips[free] = { ...makeClip({ bars: source.bars }), steps: source.steps.map((s) => ({ ...s })) };
    save();
  },
});

const live = new Live($('#live'), {
  getProject: () => project,
  transport: () => transport,
  onSelect: (id) => {
    selectedId = id;
    sequencer.render();
    rack.render();
    save();
  },
  onChange: ({ mix = false } = {}) => {
    if (mix) engine.applyMix();
    save();
  },
  onMacro: (target, value) => {
    script.setTarget(target, value);
    save();
  },
  onMacroTarget: (slot, path) => {
    project.macros = project.macros || [null, null, null, null];
    if (!path) {
      project.macros[slot] = null;
    } else {
      const resolved = pathToTarget(project, path);
      if (resolved.error) return;
      const spec = targetSpec(project, resolved.value);
      // Die Beschriftung muss die Spur nennen – drei Regler namens „volume“
      // sagen auf der Bühne gar nichts.
      const entry = macroTargets(project)
        .flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })))
        .find((it) => it.path === path);
      const label = entry ? `${entry.group} · ${entry.label}` : path;
      project.macros[slot] = { label, path, target: resolved.value, min: spec.min, max: spec.max };
    }
    save();
  },
  onMode: () => mountField(),
  onSceneSave: () => {
    const name = prompt('Name der Szene?', `Szene ${project.scenes.length + 1}`);
    if (name === null) return;
    project.scenes.push(makeScene(name.trim() || `Szene ${project.scenes.length + 1}`, project.tracks));
    save();
  },
});

// ------------------------------------------------------------ Vorsingen

// Der Mensch gibt den Rhythmus, die Maschine die Töne: Anschläge aus dem
// Mikrofon landen quantisiert im Raster. Sind Schlagzeugspuren da, werden
// Bauch, Körper und Zischen automatisch auf sie verteilt.
let beatboxing = false;

function drumTargets() {
  const find = (test) => project.tracks.find((t) => test(t.name.toLowerCase(), t));
  return {
    kick: find((n, t) => n.includes('kick') || n.includes('bass drum') || t.source.type === 'perc'),
    snare: find((n) => n.includes('snare') || n.includes('clap')),
    hat: find((n) => n.includes('hat') || n.includes('hi-hat')),
  };
}

async function beatbox(track) {
  if (beatboxing || !track) return;
  const clip = track.clips[track.clip];
  if (!clip) return;

  await ensureAudio();
  samples.attach(engine.ctx);
  if (!transport.playing) {
    script.reset();
    transport.start();
    updatePlay();
  }

  const recorder = new Recorder(engine.ctx);
  try {
    await recorder.startFromMicrophone();
  } catch (e) {
    sequencer.setStatus('Kein Zugriff aufs Mikrofon.');
    return;
  }

  beatboxing = true;
  const stepCount = clip.steps.length;
  const startStep = transport.position();
  const stepSeconds = 60 / project.tempo / 4;
  const seconds = stepCount * stepSeconds;
  sequencer.setStatus(`Hört zu … ${(seconds).toFixed(1)} s mitsingen`);

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 120));
  const result = recorder.stop();
  beatboxing = false;
  if (!result || result.data.length < 2000) {
    sequencer.setStatus('Nichts gehört.');
    return;
  }

  const buffer = engine.ctx.createBuffer(1, result.data.length, result.sampleRate);
  buffer.copyToChannel(result.data, 0);
  const onsets = detectTransients(buffer, { sensitivity: 0.62, minGap: stepSeconds * 0.8 })
    .filter((t, i) => i > 0 || t > 0.01);       // die führende Null ist kein Schlag

  if (!onsets.length) {
    sequencer.setStatus('Keine Anschläge erkannt – lauter und trockener.');
    return;
  }

  const targets = drumTargets();
  const useSplit = !!(targets.kick && (targets.snare || targets.hat));
  const written = { kick: 0, snare: 0, hat: 0, eigen: 0 };
  const cleared = new Set();

  for (const onset of onsets) {
    const kind = useSplit ? classifyOnset(buffer, onset) : 'eigen';
    const target = useSplit ? (targets[kind] || targets.kick) : track;
    const targetClip = target.clips[target.clip];
    if (!targetClip) continue;
    if (!cleared.has(target.id)) {
      targetClip.steps = targetClip.steps.map(() => ({ on: 0, deg: 0 }));
      cleared.add(target.id);
    }
    const [index] = onsetsToSteps([onset], {
      startStep, stepSeconds, stepCount: targetClip.steps.length,
    });
    targetClip.steps[index] = { on: index % 4 === 0 ? 2 : 1, deg: targetClip.steps[index].deg };
    written[kind] += 1;
  }

  save();
  sequencer.render();
  sequencer.setStatus(useSplit
    ? `${onsets.length} Anschläge verteilt · Kick ${written.kick} · Snare ${written.snare} · HiHat ${written.hat}`
    : `${onsets.length} Anschläge auf „${track.name}“`);
}

// ------------------------------------------------------------- Sampler

function assignedTrack(sample) {
  return project.tracks.find((t) => t.sampleId === sample.id && t.source.type === 'sampler') || null;
}

async function addSample(name, { data, sampleRate }) {
  const duration = data.length / sampleRate;
  const sample = makeSample({ name, duration, sampleRate, slices: equalSlices(duration, 8) });
  samples.attach(engine.ctx);
  samples.put(sample.id, data, sampleRate);
  samples.persist(sample.id, data, sampleRate);
  project.samples.push(sample);
  selectedSampleId = sample.id;
  save();
  samplerView.render();
  return sample;
}

const samplerView = new SamplerView($('#sampler'), {
  getProject: () => project,
  getSelectedSample: () => selectedSampleId,
  getBuffer: (id) => samples.get(id),
  isRecording: () => !!recorder?.recording,
  recordingSeconds: () => (recorder?.recording ? recorder.seconds : 0),

  onPick: (id) => {
    selectedSampleId = id;
    samplerView.render();
  },

  onRecord: async (kind) => {
    await ensureAudio();
    if (recorder?.recording) {
      const result = recorder.stop();
      recorder = null;
      if (result && result.data.length > 2000) {
        await addSample(kind === 'mic' ? 'Mikrofon' : 'Mitschnitt', result);
      } else {
        samplerView.render();
      }
      return;
    }
    recorder = new Recorder(engine.ctx);
    try {
      if (kind === 'mic') await recorder.startFromMicrophone();
      else recorder.startFrom(engine.limiter || engine.master);
    } catch (e) {
      recorder = null;
      alert('Kein Zugriff auf das Mikrofon. Im Browser die Erlaubnis erteilen und erneut versuchen.');
    }
    samplerView.render();
  },

  onFile: async (file) => {
    await ensureAudio();
    samples.attach(engine.ctx);
    try {
      const decoded = await samples.decode(await file.arrayBuffer());
      await addSample(file.name.replace(/\.[^.]+$/, ''), decoded);
    } catch (e) {
      alert('Diese Datei konnte nicht gelesen werden.');
    }
  },

  onChop: (sample, count) => {
    sample.slices = equalSlices(sample.duration, count);
    save();
    samplerView.render();
  },

  onTransients: (sample, sensitivity) => {
    const buffer = samples.get(sample.id);
    if (!buffer) return;
    sample.slices = detectTransients(buffer, { sensitivity });
    save();
    samplerView.render();
  },

  onSlicesChanged: (sample, { quiet = false } = {}) => {
    if (!sample.slices.length) sample.slices = [0];
    save();
    if (!quiet) samplerView.render();
  },

  onAudition: (sample, index) => {
    ensureAudio();
    const track = assignedTrack(sample);
    if (track) engine.noteOn(track.id, 60, undefined, { dur: 0.6, deg: index });
    else engine.auditionSlice(sample, index);
  },

  onRename: (sample) => {
    const name = prompt('Name des Samples?', sample.name);
    if (name === null) return;
    sample.name = name.trim() || sample.name;
    save();
    samplerView.render();
  },

  onDelete: (sample) => {
    project.samples = project.samples.filter((s) => s.id !== sample.id);
    for (const track of project.tracks) {
      if (track.sampleId === sample.id) track.sampleId = null;
    }
    samples.forget(sample.id);
    selectedSampleId = project.samples[0]?.id || null;
    save();
    samplerView.render();
    sequencer.render();
  },

  onAssign: (sample, value) => {
    if (!value) return;
    let track;
    if (value === 'new') {
      if (project.tracks.length >= 8) return;
      track = makeTrack({
        name: sample.name.slice(0, 12),
        color: TRACK_COLORS[project.tracks.length % TRACK_COLORS.length],
        sourceType: 'sampler',
        clips: [''],
      });
      project.tracks.push(track);
      selectedId = track.id;
    } else {
      track = project.tracks.find((t) => t.id === value);
      if (!track) return;
      track.source = { type: 'sampler', params: defaultParams('sampler') };
    }
    track.sampleId = sample.id;
    engine.sync();
    save();
    samplerView.render();
    sequencer.render();
    live.render();
    rack.render();
  },

  // Die beiden Knöpfe, die aus Zerhacken sofort Musik machen.
  onLayOut: (sample) => {
    const track = assignedTrack(sample);
    const clip = track?.clips[track.clip];
    if (!clip) return;
    clip.steps = clip.steps.map((step, i) => ({ on: i % 4 === 0 ? 2 : 1, deg: i % sample.slices.length }));
    save();
    sequencer.render();
  },

  onShuffle: (sample) => {
    const track = assignedTrack(sample);
    const clip = track?.clips[track.clip];
    if (!clip) return;
    clip.steps = clip.steps.map((step) => ({
      on: step.on,
      deg: Math.floor(Math.random() * sample.slices.length),
    }));
    save();
    sequencer.render();
  },
});

// ------------------------------------------------------------- Gestenfeld

// Der senkrechte Weg der Hand landet auf einem frei gewaehlten Ziel; die
// Spanne kommt aus der Modul-Registry, damit 0..1 ueberall sinnvoll liegt.
const targetCache = new Map();
function gestureTarget(path) {
  if (!path) return null;
  if (!targetCache.has(path)) {
    const resolved = pathToTarget(project, path);
    targetCache.set(path, resolved.error ? null : resolved.value);
  }
  return targetCache.get(path);
}

function applyGestureValue(track, y) {
  const target = gestureTarget(track?.gesture?.target);
  if (!target || y === null) return;
  const spec = targetSpec(project, target);
  const value = spec.scale === 'log'
    ? spec.min * Math.pow(spec.max / spec.min, y)
    : spec.min + (spec.max - spec.min) * y;
  script.setTarget(target, value);
}

const gestureField = new GestureField({
  getProject: () => project,
  getSelected: () => selectedId,
  targets: () => macroTargets(project),
  loopPosition: (track) => {
    if (!track || !transport.playing) return 0;
    const loop = loopSteps(track);
    return ((transport.position() % loop) + loop) % loop;
  },
  onSelect: (id) => {
    selectedId = id;
    gestureField.render();
    sequencer.render();
    rack.render();
    save();
  },
  onTrigger: (track, deg, y) => {
    if (!track || userSuspended) return;
    ensureAudio();
    applyGestureValue(track, y);
    const midi = degToMidi(deg, project.root, project.scale) + track.octave * 12;
    engine.noteOn(track.id, midi, undefined, { dur: 0.35, velocity: 0.9, deg });
  },
  onMove: (track, y) => applyGestureValue(track, y),
  onRelease: (track, points, recording, columns) => {
    if (!track || !recording || !transport.playing || points.length < 2) return;
    const takes = track.gesture.takes;
    takes.push(makeTake(points, columns, { quantize: track.gesture.quantize }));
    while (takes.length > MAX_TAKES) takes.shift();
    save();
    gestureField.render();
  },
  onUndo: (track) => {
    track.gesture.takes.pop();
    save();
    gestureField.render();
  },
  onClear: (track) => {
    track.gesture.takes = [];
    save();
    gestureField.render();
  },
  onTarget: (track, path) => {
    track.gesture.target = path || null;
    targetCache.clear();
    save();
  },
  onQuantize: (track, on) => {
    track.gesture.quantize = on;
    save();
  },
});

function mountField() {
  const host = $('#gesture-host');
  if (!host) return;
  gestureField.mount(host);
  // Auf schmalen Geräten steht die Spielfläche sonst unter der Kante.
  if (window.innerWidth < 900) host.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

const scriptView = new ScriptView($('#script'), {
  getProject: () => project,
  runner: () => script,
  onDraft: (text) => {
    project.script.text = text;
    save();
  },
  onApply: (text) => {
    project.script.text = text;
    script.compile();
    save();
  },
  onToggle: (enabled) => {
    project.script.enabled = enabled;
    script.compile();
    save();
  },
});

const keyboard = new Keyboard($('#keyboard'), {
  onNoteOn: (midi) => {
    if (userSuspended) return;
    ensureAudio();
    const track = selectedTrack();
    if (track) engine.noteOn(track.id, midi + track.octave * 12);
  },
  onNoteOff: (midi) => {
    const track = selectedTrack();
    if (track) engine.noteOff(track.id, midi + track.octave * 12);
  },
  onOctave: (oct) => { $('#octave-value').textContent = oct; },
});

// ----------------------------------------------------------------- Audio

async function ensureAudio() {
  if (userSuspended || engine.running) return;
  await engine.start();
  await restoreSamples();
  updatePower();
}

// Die Wellenformen liegen in IndexedDB und brauchen einen AudioContext –
// also erst nach der ersten Nutzergeste.
let samplesRestored = false;
async function restoreSamples() {
  if (samplesRestored || !engine.ctx) return;
  samplesRestored = true;
  samples.attach(engine.ctx);
  const ids = project.samples.map((s) => s.id);
  if (!ids.length) return;
  const count = await samples.restore(ids);
  if (count) samplerView.render();
}

function updatePower() {
  const btn = $('#power');
  btn.classList.toggle('on', engine.running);
  btn.textContent = engine.running ? 'Audio läuft' : 'Audio starten';
  updateAudioState();
}

// Sagt im Zweifel, woran es liegt: Safari kennt zusätzlich "interrupted",
// wenn ein Anruf oder eine andere App die Ausgabe übernommen hat.
function updateAudioState() {
  const el = $('#audio-state');
  if (!el) return;
  const state = engine.ctx?.state;
  const labels = {
    running: '',
    suspended: 'Audio pausiert – antippen',
    interrupted: 'Audio unterbrochen – antippen',
    closed: 'Audio geschlossen',
  };
  // Vor der ersten Geste gibt es nichts zu melden – der Power-Knopf sagt es.
  const text = state ? (labels[state] ?? state) : '';
  el.textContent = text;
  el.hidden = !text;
}

engine.onStateChange = () => updatePower();

// iOS unterbricht den Kontext bei Anrufen und beim Wegschalten.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || userSuspended || !engine.ctx) return;
  if (engine.ctx.state !== 'running') engine.start().then(updatePower).catch(() => {});
});

function useProject(next) {
  transport.stop();
  project = next;
  selectedId = project.tracks[0]?.id || null;
  selectedSampleId = project.samples[0]?.id || null;
  samplesRestored = false;
  restoreSamples();
  engine.panic();
  engine.setProject(project);
  syncControls();
  sequencer.render();
  live.render();
  rack.render();
  script.compile();
  scriptView.render();
  save();
}

function syncControls() {
  $('#project-name').value = project.name;
  $('#tempo').value = Math.round(project.tempo);
  $('#swing').value = Math.round(project.swing * 100);
  $('#swing-value').textContent = `${Math.round(project.swing * 100)} %`;
  $('#quantize').value = String(project.quantize);
  $('#scale').value = project.scale;
  $('#root').value = String(project.root);
  $('#volume').value = Math.round(project.master.volume * 100);
  $('#volume-value').textContent = `${Math.round(project.master.volume * 100)} %`;
  $('#octave-value').textContent = keyboard.octave;
}

// ------------------------------------------------------------- Bedienung

renderPalette($('#palette'), (block) => {
  const track = selectedTrack();
  if (!track) return;
  track.chain.push(block);
  engine.sync();
  rack.render();
  save();
});

$('#power').addEventListener('click', async () => {
  if (engine.running) {
    transport.stop();
    engine.panic();
    userSuspended = true;
    await engine.ctx.suspend();
  } else {
    userSuspended = false;
    await ensureAudio();
  }
  updatePower();
});

$('#play').addEventListener('click', async () => {
  if (transport.playing) {
    transport.stop();
  } else {
    userSuspended = false;
    await ensureAudio();
    script.reset();
    transport.start();
  }
  updatePlay();
});

function updatePlay() {
  const btn = $('#play');
  btn.classList.toggle('on', transport.playing);
  btn.textContent = transport.playing ? '■ Stopp' : '▶ Start';
}

$('#tempo').addEventListener('input', (e) => {
  project.tempo = Math.min(240, Math.max(40, Number(e.target.value) || 120));
  save();
});

// Tempo antippen: Mittel der letzten Abstände, ältere als 2 s zählen nicht.
let taps = [];
$('#tap').addEventListener('click', () => {
  const now = performance.now();
  taps = taps.filter((t) => now - t < 2000);
  taps.push(now);
  if (taps.length < 2) return;
  const gaps = taps.slice(1).map((t, i) => t - taps[i]);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  project.tempo = Math.min(240, Math.max(40, Math.round(60000 / avg)));
  $('#tempo').value = project.tempo;
  save();
});

$('#swing').addEventListener('input', (e) => {
  project.swing = Number(e.target.value) / 100;
  $('#swing-value').textContent = `${e.target.value} %`;
  save();
});

$('#quantize').addEventListener('change', (e) => {
  project.quantize = Number(e.target.value);
  save();
});

$('#scale').addEventListener('change', (e) => {
  project.scale = e.target.value;
  save();
});

$('#root').addEventListener('change', (e) => {
  project.root = Number(e.target.value);
  save();
});

$('#volume').addEventListener('input', (e) => {
  const v = Number(e.target.value) / 100;
  project.master.volume = v;
  engine.setMasterVolume(v);
  $('#volume-value').textContent = `${e.target.value} %`;
  save();
});

$('#panic').addEventListener('click', () => engine.panic());

// Soundcheck: sagt in einem Tipp, ob überhaupt Ton aus dem Gerät kommt.
// Bleibt es still, ist auf iOS fast immer der Stummschalter am Gehäuse schuld –
// genau dann ist der Hinweis nützlich, vorher wäre er nur Deko.
let hintTimer = null;
$('#test-tone').addEventListener('click', async () => {
  userSuspended = false;
  await ensureAudio();
  engine.testTone();
  updatePower();

  const el = $('#audio-state');
  if (engine.running && el) {
    el.hidden = false;
    el.classList.add('neutral');
    el.textContent = 'Testton gespielt – nichts gehört? Stummschalter und Lautstärke am Gerät prüfen.';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      el.classList.remove('neutral');
      updateAudioState();
    }, 6000);
  }
});
$('#oct-down').addEventListener('click', () => keyboard.shift(-1));
$('#oct-up').addEventListener('click', () => keyboard.shift(1));

$('#project-name').addEventListener('input', (e) => {
  project.name = e.target.value;
  save();
});

$('#new-project').addEventListener('click', () => useProject(makeProject('Neues Set')));
$('#demo-project').addEventListener('click', () => useProject(demoProject()));

const presetSelect = $('#presets');
SOUND_PRESETS.forEach((preset, i) => {
  const option = document.createElement('option');
  option.value = String(i);
  option.textContent = preset.name;
  presetSelect.append(option);
});
presetSelect.addEventListener('change', (e) => {
  const track = selectedTrack();
  if (!track || e.target.value === '') return;
  applyPreset(track, SOUND_PRESETS[Number(e.target.value)]);
  engine.killTrack(track.id);
  engine.sync();
  rack.render();
  save();
  e.target.value = '';
});

$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(project.name || 'set').replace(/[^\w-]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('#import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    useProject(normalizeProject(JSON.parse(await file.text())));
  } catch (err) {
    alert('Diese Datei ist kein gültiges Set.');
  }
  e.target.value = '';
});

// Ansichtswechsel zwischen Sequenzer und Klangkette.
for (const tab of document.querySelectorAll('[data-view]')) {
  tab.addEventListener('click', () => {
    const view = tab.dataset.view;
    for (const t of document.querySelectorAll('[data-view]')) t.classList.toggle('on', t === tab);
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== view;
    }
    currentView = view;
    if (view === 'sound') rack.render();
    if (view === 'live') { live.render(); mountField(); }
    if (view === 'script') scriptView.render();
    if (view === 'sampler') samplerView.render();
  });
}

// Tastenkürzel – am Laptop schneller und treffsicherer als jede Fläche.
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches('input, textarea, select')) return;

  // Leertaste startet und stoppt – die wichtigste Taste im Live-Betrieb.
  if (e.code === 'Space') {
    e.preventDefault();
    $('#play').click();
    return;
  }

  // Ziffern rufen Szenen auf, ohne dass man die Maus suchen muss.
  const digit = e.code.match(/^Digit([1-9])$/);
  if (digit) {
    const scene = project.scenes[Number(digit[1]) - 1];
    if (!scene) return;
    e.preventDefault();
    transport.queueScene(scene);
    live.refresh();
  }
});

// Erste Nutzergeste irgendwo auf der Seite startet den AudioContext – außer
// auf dem Power-Button, der seinen Zustand selbst umschaltet.
function firstGesture(e) {
  if (e.target?.closest?.('#power')) return;
  window.removeEventListener('pointerdown', firstGesture);
  window.removeEventListener('keydown', firstGesture);
  ensureAudio();
}
window.addEventListener('pointerdown', firstGesture);
window.addEventListener('keydown', firstGesture);

// ------------------------------------------------------------ Startzustand

$('#quantize').innerHTML = [
  [4, '¼ Takt'], [8, '½ Takt'], [16, '1 Takt'], [32, '2 Takte'], [64, '4 Takte'], [1, 'sofort'],
].map(([v, label]) => `<option value="${v}">${label}</option>`).join('');

// Stimmungen statt Tonleitern: die Technik steht daneben, Voraussetzung ist
// sie nicht.
$('#scale').innerHTML = MOODS
  .map((m) => `<option value="${m.scale}">${m.label} (${SCALES[m.scale].label})</option>`).join('');

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'H'];
$('#root').innerHTML = Array.from({ length: 24 }, (_, i) => {
  const midi = 36 + i;
  return `<option value="${midi}">${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}</option>`;
}).join('');

engine.setProject(project);
syncControls();
sequencer.render();
live.render();
mountField();
rack.render();
script.compile();
scriptView.render();
updatePower();
updatePlay();

window.blockwerk = {
  engine, transport, samples, gestureField, project: () => project,
  get beatboxing() { return beatboxing; },
  sequencer, live, rack, script, scriptView, samplerView, keyboard, CLIP_SLOTS,
  addSample: (name, data, rate) => addSample(name, { data, sampleRate: rate }),
};

(function frame() {
  if (transport.playing) {
    script.updateRamps(transport.position());
    // Der senkrechte Verlauf aufgenommener Gesten laeuft weich mit.
    const position = transport.position();
    for (const track of project.tracks) {
      if (!track.gesture?.takes.length || !track.gesture.target) continue;
      applyGestureValue(track, valueAtStep(track, position));
    }
  }
  if (currentView === 'sound') rack.setLevel(engine.running ? engine.level() : 0);
  if (currentView === 'seq') sequencer.tick();
  if (currentView === 'live') {
    live.tick(script);
    if (live.mode === 'field') gestureField.tick();
  }
  if (currentView === 'sampler') samplerView.tick();
  const bar = $('#position');
  if (bar) {
    const pos = transport.position();
    bar.textContent = transport.playing
      ? `${Math.floor(pos / 16) + 1}.${Math.floor((pos % 16) / 4) + 1}`
      : '–';
    $('#quantize-ring').style.setProperty('--phase', transport.playing ? transport.quantizePhase() : 0);
  }
  requestAnimationFrame(frame);
})();
