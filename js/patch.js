// Patch = kompletter Zustand des Racks. Reines Datenobjekt, damit Speichern,
// Laden und Export ohne Sonderfälle funktionieren.

import { MODULES, defaultParams } from './modules.js';

export const PATCH_VERSION = 1;

let counter = 0;
export function blockId() {
  counter += 1;
  return `b${Date.now().toString(36)}${counter.toString(36)}`;
}

export function makeBlock(type) {
  return { id: blockId(), type, bypass: false, params: defaultParams(type) };
}

export function makePatch(name = 'Neues Patch') {
  return {
    version: PATCH_VERSION,
    name,
    source: { type: 'osc', params: defaultParams('osc') },
    chain: [makeBlock('filter'), makeBlock('delay')],
    master: { volume: 0.7 },
  };
}

// Unbekannte Module und fehlende Parameter tolerieren, damit ältere oder von
// Hand bearbeitete Patches nicht die App zerlegen.
export function normalizePatch(raw) {
  const patch = makePatch(raw?.name || 'Importiertes Patch');

  if (raw?.source && MODULES[raw.source.type]?.kind === 'source') {
    patch.source = {
      type: raw.source.type,
      params: { ...defaultParams(raw.source.type), ...(raw.source.params || {}) },
    };
  }

  if (Array.isArray(raw?.chain)) {
    patch.chain = raw.chain
      .filter((b) => MODULES[b?.type]?.kind === 'fx')
      .map((b) => ({
        id: blockId(),
        type: b.type,
        bypass: !!b.bypass,
        params: { ...defaultParams(b.type), ...(b.params || {}) },
      }));
  }

  if (typeof raw?.master?.volume === 'number') {
    patch.master.volume = Math.min(1, Math.max(0, raw.master.volume));
  }
  return patch;
}

function preset(name, sourceType, sourceParams, chain) {
  const patch = makePatch(name);
  patch.source = { type: sourceType, params: { ...defaultParams(sourceType), ...sourceParams } };
  patch.chain = chain.map(([type, params]) => ({
    id: blockId(),
    type,
    bypass: false,
    params: { ...defaultParams(type), ...params },
  }));
  return patch;
}

export const PRESETS = [
  () => preset('Warmes Pad', 'osc', { wave: 'sawtooth', detune: 14, sub: 0.4, attack: 0.6, release: 1.6, sustain: 0.8 }, [
    ['filter', { freq: 1400, q: 0.8 }],
    ['chorus', { rate: 0.35, depth: 0.006, mix: 0.6 }],
    ['reverb', { size: 3.2, decay: 2.2, mix: 0.45 }],
  ]),
  () => preset('Acid Lead', 'osc', { wave: 'sawtooth', detune: 4, sub: 0.2, attack: 0.005, decay: 0.2, sustain: 0.35, release: 0.2 }, [
    ['filter', { freq: 900, q: 12 }],
    ['drive', { drive: 0.6, level: 0.7 }],
    ['delay', { time: 0.24, feedback: 0.45, mix: 0.3 }],
  ]),
  () => preset('Glocke', 'fm', { ratio: 3.5, index: 6, fall: 0.4, attack: 0.004, decay: 1.2, sustain: 0.1, release: 1.4 }, [
    ['tremolo', { rate: 0.8, depth: 0.25 }],
    ['reverb', { size: 4, decay: 3, mix: 0.5 }],
  ]),
  () => preset('Lo-Fi Rauschen', 'noise', { type: 'bandpass', tone: 900, q: 4, track: 0.8, attack: 0.01, decay: 0.3, sustain: 0.2, release: 0.3 }, [
    ['crusher', { bits: 3.5, mix: 0.8 }],
    ['filter', { type: 'lowpass', freq: 3200, q: 1 }],
    ['delay', { time: 0.42, feedback: 0.5, tone: 1800, mix: 0.4 }],
  ]),
];
