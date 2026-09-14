// Projektmodell: Spuren, Clips, Tonart, Tempo. Reines Datenobjekt – die Engine
// und die Oberfläche lesen daraus, niemand hält heimlich eigenen Zustand.

import { MODULES, defaultParams } from './modules.js';
import { STEPS_PER_BAR, emptySteps, parseSteps } from './pattern.js';

export const PROJECT_VERSION = 2;
export const CLIP_SLOTS = ['A', 'B', 'C', 'D'];
export { STEPS_PER_BAR };

export const SCALES = {
  minor: { label: 'Moll', steps: [0, 2, 3, 5, 7, 8, 10] },
  major: { label: 'Dur', steps: [0, 2, 4, 5, 7, 9, 11] },
  dorian: { label: 'Dorisch', steps: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { label: 'Phrygisch', steps: [0, 1, 3, 5, 7, 8, 10] },
  pentaMinor: { label: 'Pentatonik', steps: [0, 3, 5, 7, 10] },
  chromatic: { label: 'Chromatisch', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export const TRACK_COLORS = [
  '#f0a35e', '#7aa2ff', '#6ee7c7', '#e07ad8',
  '#f2d37a', '#84e06e', '#ff8a8a', '#9d8cff',
];

let counter = 0;
const uid = (prefix) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

// Skalenstufe -> MIDI-Note. Negative Stufen laufen sauber in die Oktave darunter.
export function degToMidi(deg, root, scaleName) {
  const scale = (SCALES[scaleName] || SCALES.minor).steps;
  const n = scale.length;
  const octave = Math.floor(deg / n);
  const index = ((deg % n) + n) % n;
  return root + octave * 12 + scale[index];
}

export function makeClip({ bars = 1, text = null } = {}) {
  return {
    id: uid('c'),
    bars,
    steps: text ? parseSteps(text, bars) : emptySteps(bars),
  };
}

export function makeTrack(partial = {}) {
  const type = partial.sourceType || 'osc';
  return {
    id: uid('t'),
    name: partial.name || 'Spur',
    color: partial.color || TRACK_COLORS[0],
    source: { type, params: { ...defaultParams(type), ...(partial.sourceParams || {}) } },
    chain: (partial.chain || []).map(([fxType, params]) => ({
      id: uid('b'),
      type: fxType,
      bypass: false,
      params: { ...defaultParams(fxType), ...(params || {}) },
    })),
    mix: { volume: partial.volume ?? 0.8, mute: false, solo: false },
    octave: partial.octave ?? 0,
    gate: partial.gate ?? 0.9,
    clips: CLIP_SLOTS.map((_, i) => {
      const text = partial.clips?.[i];
      return text === undefined ? null : makeClip({ bars: partial.bars || 1, text });
    }),
    clip: 0,
    queued: null,
    queuedMute: null,
  };
}

// Eine Szene ist eine Momentaufnahme: welcher Clip läuft je Spur, was ist
// stumm. Sie wird über Spur-IDs gespeichert, damit Umsortieren nichts kaputt
// macht.
export function makeScene(name, tracks) {
  return {
    id: uid('s'),
    name,
    slots: Object.fromEntries(tracks.map((t) => [t.id, t.clip])),
    mutes: Object.fromEntries(tracks.map((t) => [t.id, t.mix.mute])),
  };
}

export function makeProject(name = 'Neues Set') {
  return {
    version: PROJECT_VERSION,
    name,
    tempo: 120,
    swing: 0,
    quantize: STEPS_PER_BAR, // Schritte, an denen Clipwechsel greifen
    root: 48,
    scale: 'minor',
    tracks: [makeTrack({ name: 'Spur 1', color: TRACK_COLORS[0], clips: [''] })],
    scenes: [],
    script: { text: '', enabled: false },
    master: { volume: 0.7 },
  };
}

// Startprojekt, das sofort klingt – sonst startet man vor einem leeren Raster.
export function demoProject() {
  const project = makeProject('Erstes Set');
  project.tempo = 122;
  project.swing = 0.12;
  project.tracks = [
    makeTrack({
      name: 'Kick', color: TRACK_COLORS[0], sourceType: 'perc', octave: -1, volume: 0.9,
      sourceParams: { wave: 'sine', drop: 26, dropTime: 0.055, body: 0.4, click: 0.35 },
      clips: [
        'x . . .  x . . .  x . . .  x . . .',
        'x . . .  x . . x  . . x .  x . . .',
      ],
    }),
    makeTrack({
      name: 'Snare', color: TRACK_COLORS[6], sourceType: 'noise', volume: 0.7,
      sourceParams: { type: 'bandpass', tone: 1700, q: 1.6, track: 0, attack: 0.002, decay: 0.18, sustain: 0, release: 0.12 },
      chain: [['drive', { drive: 0.3, level: 0.7, mix: 0.6 }]],
      clips: [
        '. . . .  x . . .  . . . .  x . . .',
        '. . . .  x . . .  . . . .  x . X .',
      ],
    }),
    makeTrack({
      name: 'HiHat', color: TRACK_COLORS[4], sourceType: 'noise', volume: 0.45,
      sourceParams: { type: 'highpass', tone: 7800, q: 1, track: 0, attack: 0.001, decay: 0.05, sustain: 0, release: 0.04 },
      clips: [
        'x . X .  x . X .  x . X .  x . X .',
        'x x X x  x . X x  x x X .  x X x x',
      ],
    }),
    makeTrack({
      name: 'Bass', color: TRACK_COLORS[1], sourceType: 'osc', octave: -1, volume: 0.8, gate: 0.8,
      sourceParams: { wave: 'sawtooth', detune: 3, sub: 0.5, attack: 0.005, decay: 0.22, sustain: 0.25, release: 0.12 },
      chain: [['filter', { type: 'lowpass', freq: 620, q: 5 }]],
      clips: [
        '0 . . .  0 . . 0  . . 3 .  2 . . .',
        '0 . 0 .  3 . . .  5 . . 3  2 . 0 .',
      ],
    }),
    makeTrack({
      name: 'Lead', color: TRACK_COLORS[3], sourceType: 'fm', volume: 0.5, gate: 1.4,
      sourceParams: { ratio: 2, index: 2.5, fall: 0.3, attack: 0.006, decay: 0.5, sustain: 0.2, release: 0.5 },
      chain: [['delay', { time: 0.28, feedback: 0.4, mix: 0.35 }], ['reverb', { size: 2.4, decay: 2.4, mix: 0.3 }]],
      clips: [
        '. . . .  . . . .  7 . 5 .  . 4 . .',
        '7 . . 5  . 4 . .  3 . . 4  5 . . .',
      ],
    }),
  ];

  const [kick, snare, hat, bass, lead] = project.tracks;
  const scene = (name, slots, mutes = {}) => ({
    id: uid('s'),
    name,
    slots,
    mutes: Object.fromEntries(project.tracks.map((t) => [t.id, !!mutes[t.id]])),
  });
  project.scenes = [
    scene('Intro', { [kick.id]: 0, [snare.id]: 0, [hat.id]: 0, [bass.id]: 0, [lead.id]: 0 },
      { [snare.id]: true, [lead.id]: true }),
    scene('Groove', { [kick.id]: 0, [snare.id]: 0, [hat.id]: 0, [bass.id]: 0, [lead.id]: 0 },
      { [lead.id]: true }),
    scene('Hook', { [kick.id]: 0, [snare.id]: 1, [hat.id]: 1, [bass.id]: 1, [lead.id]: 1 }),
    scene('Break', { [kick.id]: 1, [snare.id]: 1, [hat.id]: 1, [bass.id]: 0, [lead.id]: 0 },
      { [bass.id]: true, [lead.id]: true }),
  ];

  // Liegt bereit, laeuft aber erst, wenn man es im Script-Reiter einschaltet.
  project.script = {
    enabled: false,
    text: [
      '# Beispiel-Ablauf – von Hand umschalten geht jederzeit',
      'tempo 122',
      'key C minor',
      'swing 12',
      '',
      'bar 1    scene Intro',
      'bar 5    unmute snare',
      'bar 9    scene Groove',
      'bar 13   bass.filter.freq 400 -> 2600 over 4 bars',
      'bar 17   scene Hook',
      'bar 25   scene Break',
      'bar 29   bass.filter.freq 2600 -> 400 over 2 bars',
      'bar 33   scene Hook',
      '',
    ].join('\n'),
  };
  return project;
}

// ------------------------------------------------------- Lesen und Reparieren

function normalizeClip(raw) {
  if (!raw) return null;
  const bars = [1, 2, 4].includes(raw.bars) ? raw.bars : 1;
  const want = bars * STEPS_PER_BAR;
  const steps = Array.from({ length: want }, (_, i) => {
    const s = raw.steps?.[i];
    return {
      on: s && [0, 1, 2].includes(s.on) ? s.on : 0,
      deg: Number.isInteger(s?.deg) ? s.deg : 0,
    };
  });
  return { id: raw.id || uid('c'), bars, steps };
}

function normalizeTrack(raw, index) {
  const type = MODULES[raw?.source?.type]?.kind === 'source' ? raw.source.type : 'osc';
  const track = makeTrack({
    name: raw?.name || `Spur ${index + 1}`,
    color: raw?.color || TRACK_COLORS[index % TRACK_COLORS.length],
    sourceType: type,
    sourceParams: raw?.source?.params || {},
  });
  track.id = raw?.id || track.id;
  track.chain = (Array.isArray(raw?.chain) ? raw.chain : [])
    .filter((b) => MODULES[b?.type]?.kind === 'fx')
    .map((b) => ({
      id: b.id || uid('b'),
      type: b.type,
      bypass: !!b.bypass,
      params: { ...defaultParams(b.type), ...(b.params || {}) },
    }));
  track.mix = {
    volume: clamp01(raw?.mix?.volume ?? 0.8),
    mute: !!raw?.mix?.mute,
    solo: !!raw?.mix?.solo,
  };
  track.octave = Number.isInteger(raw?.octave) ? Math.max(-3, Math.min(3, raw.octave)) : 0;
  track.gate = typeof raw?.gate === 'number' ? Math.max(0.05, Math.min(4, raw.gate)) : 0.9;
  track.clips = CLIP_SLOTS.map((_, i) => normalizeClip(raw?.clips?.[i]));
  if (!track.clips.some(Boolean)) track.clips[0] = makeClip({});
  track.clip = Number.isInteger(raw?.clip) && raw.clip >= 0 && raw.clip < CLIP_SLOTS.length ? raw.clip : 0;
  track.queued = null;
  track.queuedMute = null;
  return track;
}

// Szenen dürfen nur auf vorhandene Spuren und gefüllte Slots zeigen.
function normalizeScenes(raw, tracks) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map(tracks.map((t) => [t.id, t]));
  return raw.slice(0, 12).map((scene, i) => {
    const slots = {};
    const mutes = {};
    for (const [trackId, slot] of Object.entries(scene?.slots || {})) {
      const track = byId.get(trackId);
      if (track && Number.isInteger(slot) && track.clips[slot]) slots[trackId] = slot;
    }
    for (const [trackId, muted] of Object.entries(scene?.mutes || {})) {
      if (byId.has(trackId)) mutes[trackId] = !!muted;
    }
    return { id: scene?.id || uid('s'), name: scene?.name || `Szene ${i + 1}`, slots, mutes };
  });
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

// Nimmt v2-Projekte und die alten v1-Patches (eine Spur ohne Sequenzer).
export function normalizeProject(raw) {
  if (raw?.version === 1 || (raw?.source && !raw?.tracks)) {
    const project = makeProject(raw.name || 'Übernommenes Patch');
    project.tracks = [normalizeTrack({ name: raw.name || 'Spur 1', source: raw.source, chain: raw.chain }, 0)];
    project.scenes = [];
    project.master.volume = clamp01(raw?.master?.volume ?? 0.7);
    return project;
  }

  const project = makeProject(raw?.name || 'Set');
  project.tempo = Math.min(240, Math.max(40, Number(raw?.tempo) || 120));
  project.swing = Math.min(0.6, Math.max(0, Number(raw?.swing) || 0));
  project.quantize = [1, 4, 8, 16, 32, 64].includes(raw?.quantize) ? raw.quantize : STEPS_PER_BAR;
  project.root = Number.isInteger(raw?.root) ? Math.max(12, Math.min(84, raw.root)) : 48;
  project.scale = SCALES[raw?.scale] ? raw.scale : 'minor';
  project.master.volume = clamp01(raw?.master?.volume ?? 0.7);
  const tracks = Array.isArray(raw?.tracks) ? raw.tracks : [];
  project.tracks = tracks.length
    ? tracks.slice(0, 8).map(normalizeTrack)
    : demoProject().tracks;
  project.scenes = normalizeScenes(raw?.scenes, project.tracks);
  project.script = {
    text: typeof raw?.script?.text === 'string' ? raw.script.text.slice(0, 20000) : '',
    enabled: !!raw?.script?.enabled,
  };
  return project;
}

// Klang-Presets werden auf die ausgewählte Spur angewendet.
export const SOUND_PRESETS = [
  {
    name: 'Warmes Pad', sourceType: 'osc',
    sourceParams: { wave: 'sawtooth', detune: 14, sub: 0.4, attack: 0.6, release: 1.6, sustain: 0.8 },
    chain: [['filter', { freq: 1400, q: 0.8 }], ['chorus', { rate: 0.35, depth: 0.006, mix: 0.6 }], ['reverb', { size: 3.2, decay: 2.2, mix: 0.45 }]],
  },
  {
    name: 'Acid Lead', sourceType: 'osc',
    sourceParams: { wave: 'sawtooth', detune: 4, sub: 0.2, attack: 0.005, decay: 0.2, sustain: 0.35, release: 0.2 },
    chain: [['filter', { freq: 900, q: 12 }], ['drive', { drive: 0.6, level: 0.7 }], ['delay', { time: 0.24, feedback: 0.45, mix: 0.3 }]],
  },
  {
    name: 'Glocke', sourceType: 'fm',
    sourceParams: { ratio: 3.5, index: 6, fall: 0.4, attack: 0.004, decay: 1.2, sustain: 0.1, release: 1.4 },
    chain: [['tremolo', { rate: 0.8, depth: 0.25 }], ['reverb', { size: 4, decay: 3, mix: 0.5 }]],
  },
  {
    name: 'Kick', sourceType: 'perc',
    sourceParams: { wave: 'sine', drop: 26, dropTime: 0.055, body: 0.4, click: 0.35 },
    chain: [],
  },
  {
    name: 'Snare', sourceType: 'noise',
    sourceParams: { type: 'bandpass', tone: 1700, q: 1.6, track: 0, attack: 0.002, decay: 0.18, sustain: 0, release: 0.12 },
    chain: [['drive', { drive: 0.3, level: 0.7, mix: 0.6 }]],
  },
  {
    name: 'HiHat', sourceType: 'noise',
    sourceParams: { type: 'highpass', tone: 7800, q: 1, track: 0, attack: 0.001, decay: 0.05, sustain: 0, release: 0.04 },
    chain: [],
  },
];

export function applyPreset(track, preset) {
  track.source = { type: preset.sourceType, params: { ...defaultParams(preset.sourceType), ...preset.sourceParams } };
  track.chain = preset.chain.map(([type, params]) => ({
    id: uid('b'),
    type,
    bypass: false,
    params: { ...defaultParams(type), ...(params || {}) },
  }));
}

export { uid };
