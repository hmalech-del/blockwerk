// Ideen: Rhythmen, Melodien und Slice-Folgen, die von selbst musikalisch sind.
//
// Der Grundgedanke: Wer live spielt, soll keine Tonleiter kennen müssen. Nicht
// weil Theorie schlecht wäre, sondern weil sie auf der Bühne im Weg steht. Also
// steckt das Wissen hier drin – in gewichteten Rastern, Konturen und
// Schlusstönen – und draußen stehen nur Würfel, Dichte und Form.

import { STEPS_PER_BAR } from './pattern.js';

// Wie wahrscheinlich ist ein Anschlag auf diesem Sechzehntel? Die Eins trägt,
// die Achtel stützen, die Sechzehntel würzen.
const GRID_WEIGHTS = [10, 1, 3, 1, 6, 1, 4, 1, 8, 1, 3, 1, 6, 1, 4, 2];

export const CONTOURS = {
  arch: { label: 'Bogen', at: (p) => Math.sin(p * Math.PI) },
  rise: { label: 'Steigend', at: (p) => p },
  fall: { label: 'Fallend', at: (p) => 1 - p },
  wave: { label: 'Welle', at: (p) => 0.5 + 0.5 * Math.sin(p * Math.PI * 2 - Math.PI / 2) },
  calm: { label: 'Ruhig', at: () => 0.5 },
};

// Stimmungen statt Tonartnamen. Die Technik steht in Klammern daneben, wer sie
// braucht – Voraussetzung ist sie nicht.
export const MOODS = [
  { id: 'hell', label: 'Hell', scale: 'major' },
  { id: 'warm', label: 'Warm', scale: 'dorian' },
  { id: 'dunkel', label: 'Dunkel', scale: 'minor' },
  { id: 'rau', label: 'Rau', scale: 'phrygian' },
  { id: 'weit', label: 'Weit', scale: 'pentaMinor' },
  { id: 'frei', label: 'Frei', scale: 'chromatic' },
];

const rand = (n) => Math.floor(Math.random() * n);
const chance = (p) => Math.random() < p;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Gewichtet so viele Positionen ziehen, wie die Dichte vorgibt.
export function pickPositions(stepCount, density) {
  const wanted = clamp(Math.round(2 + density * (stepCount / 16) * 9), 1, stepCount);
  const pool = [];
  for (let i = 0; i < stepCount; i++) {
    pool.push({ index: i, weight: GRID_WEIGHTS[i % STEPS_PER_BAR] + Math.random() * 2 });
  }
  pool.sort((a, b) => b.weight - a.weight);
  return pool.slice(0, wanted).map((p) => p.index).sort((a, b) => a - b);
}

function chordTones(scaleLength) {
  return [0, 2, 4].filter((d) => d < scaleLength).concat([0]);
}

// Tragender Ton in der Naehe – aber nie weiter weg vom zuletzt gespielten Ton
// als noetig: ein Sprung ueber eine Oktave klingt nach Versehen, nicht nach
// Absicht.
function nearestChordTone(deg, scaleLength, from = null, pull = 1.4) {
  const tones = chordTones(scaleLength);
  let best = tones[0];
  let score = Infinity;
  for (let octave = -2; octave <= 2; octave++) {
    for (const tone of tones) {
      const candidate = tone + octave * scaleLength;
      const toTarget = Math.abs(candidate - deg);
      const toPrevious = from === null ? 0 : Math.abs(candidate - from);
      const value = toTarget + toPrevious * pull;
      if (value < score) { score = value; best = candidate; }
    }
  }
  return best;
}

// Eine Melodie entsteht aus Form, nicht aus Zufall: Die Kontur gibt den Verlauf
// vor, gegangen wird in kleinen Schritten, und der letzte Ton kommt nach Hause.
export function generateMelody({
  stepCount = 16, density = 0.45, contour = 'arch', span = 7, scaleLength = 7, accents = true,
} = {}) {
  const shape = CONTOURS[contour] || CONTOURS.arch;
  const positions = pickPositions(stepCount, density);
  const steps = Array.from({ length: stepCount }, () => ({ on: 0, deg: 0 }));
  if (!positions.length) return steps;

  const low = 0;
  const high = Math.max(2, span);
  let previous = nearestChordTone(Math.round((low + high) / 2), scaleLength);

  positions.forEach((index, i) => {
    const progress = positions.length === 1 ? 0.5 : i / (positions.length - 1);
    const target = Math.round(low + shape.at(progress) * (high - low));

    let deg;
    if (i === 0) {
      deg = nearestChordTone(target, scaleLength);               // Anfang traegt
    } else if (i === positions.length - 1) {
      deg = nearestChordTone(previous, scaleLength, previous);   // Schluss kommt nach Hause
    } else if (chance(0.16)) {
      // Ein echter Sprung – auf einen tragenden Ton, aber hoechstens eine
      // Quinte weit. Ganz ohne Spruenge maeandert eine Melodie.
      deg = clamp(nearestChordTone(target, scaleLength, previous, 0.45), previous - 4, previous + 4);
    } else {
      deg = previous + clamp(target - previous, -2, 2);          // sonst schrittweise
    }
    deg = clamp(deg, low - scaleLength, high + scaleLength);
    previous = deg;

    const downbeat = index % 4 === 0;
    steps[index] = { on: accents && downbeat ? 2 : 1, deg };
  });

  return steps;
}

// Variieren statt neu würfeln: Was gefällt, bleibt – ein paar Töne wandern.
export function varyMelody(steps, { amount = 0.3, scaleLength = 7 } = {}) {
  const on = steps.map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0);
  if (!on.length) return steps.map((s) => ({ ...s }));
  const next = steps.map((s) => ({ ...s }));
  const touch = Math.max(1, Math.round(on.length * amount));

  for (let k = 0; k < touch; k++) {
    const index = on[rand(on.length)];
    if (index === on[0] || index === on[on.length - 1]) continue; // Rahmen bleibt
    if (chance(0.45)) {
      // Ton verschieben
      next[index].deg += chance(0.5) ? 1 : -1;
    } else {
      // Anschlag verschieben
      const to = clamp(index + (chance(0.5) ? 1 : -1), 0, steps.length - 1);
      if (!next[to].on) {
        next[to] = { ...next[index] };
        next[index] = { on: 0, deg: 0 };
      }
    }
  }
  return next;
}

// Slice-Folgen klingen gut, wenn sie ein Motiv haben und es variieren –
// gleichverteilter Zufall klingt wie ein Defekt.
export function generateSliceArrangement({
  stepCount = 16, sliceCount = 8, density = 0.6, stutter = 0.25,
} = {}) {
  const steps = Array.from({ length: stepCount }, () => ({ on: 0, deg: 0 }));
  if (sliceCount < 1) return steps;

  const motif = [0, rand(sliceCount), rand(sliceCount), rand(sliceCount)];
  const beats = Math.max(1, Math.floor(stepCount / 4));

  for (let beat = 0; beat < beats; beat++) {
    const base = beat * 4;
    if (chance(stutter)) {
      // Stotterer: ein Slice vier Mal hintereinander
      const slice = beat === 0 ? 0 : rand(sliceCount);
      for (let k = 0; k < 4; k++) steps[base + k] = { on: k === 0 ? 2 : 1, deg: slice };
      continue;
    }
    for (let k = 0; k < 4; k++) {
      const strong = k === 0;
      if (!strong && !chance(density)) continue;
      let slice = motif[k];
      if (!strong && chance(0.35)) slice = (slice + 1 + rand(sliceCount - 1)) % sliceCount;
      if (beat === 0 && strong) slice = 0;        // der Takt beginnt vorn
      steps[base + k] = { on: strong ? 2 : 1, deg: slice % sliceCount };
    }
  }
  return steps;
}

// -------------------------------------------------------------- Vorsingen

// Zwei einpolige Tiefpässe hintereinander – reicht völlig, um Bauch von
// Zischen zu unterscheiden, und kostet keinen FFT.
function bandEnergies(data, from, to, sampleRate) {
  const lowA = 1 - Math.exp((-2 * Math.PI * 190) / sampleRate);
  const midA = 1 - Math.exp((-2 * Math.PI * 1800) / sampleRate);
  let low1 = 0;
  let low2 = 0;
  let mid1 = 0;
  let mid2 = 0;
  let lowE = 0;
  let midE = 0;
  let highE = 0;

  for (let i = from; i < to; i++) {
    const x = data[i];
    low1 += lowA * (x - low1);
    low2 += lowA * (low1 - low2);
    mid1 += midA * (x - mid1);
    mid2 += midA * (mid1 - mid2);
    const high = x - mid2;
    lowE += low2 * low2;
    midE += (mid2 - low2) * (mid2 - low2);
    highE += high * high;
  }
  const total = lowE + midE + highE || 1;
  return { low: lowE / total, mid: midE / total, high: highE / total };
}

// Bauch -> Kick, Rauschen mit Körper -> Snare, nur Zischen -> HiHat.
export function classifyOnset(buffer, time, { window = 0.04 } = {}) {
  const data = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const from = Math.max(0, Math.floor(time * rate));
  const to = Math.min(data.length, from + Math.floor(window * rate));
  if (to - from < 64) return 'kick';
  const { low, mid, high } = bandEnergies(data, from, to, rate);
  if (low > 0.45) return 'kick';
  if (high > 0.45 && low < 0.2) return 'hat';
  return mid > high ? 'snare' : 'hat';
}

// Gesungene Anschläge aufs Raster legen: Rundung auf Sechzehntel federt
// Eingangsverzögerung und menschliches Timing gleichermaßen ab.
export function onsetsToSteps(onsets, { startStep = 0, stepSeconds, stepCount }) {
  const hits = [];
  for (const onset of onsets) {
    const step = Math.round(startStep + onset / stepSeconds);
    const index = ((step % stepCount) + stepCount) % stepCount;
    if (!hits.includes(index)) hits.push(index);
  }
  return hits.sort((a, b) => a - b);
}
