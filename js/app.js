// Verdrahtung: Patch-Zustand, Oberfläche, Engine und Eingaben.

import { Engine } from './engine.js';
import { Rack, renderPalette } from './ui.js';
import { Keyboard } from './keyboard.js';
import { makePatch, normalizePatch, PRESETS } from './patch.js';
import { defaultParams } from './modules.js';

const STORAGE_KEY = 'blockwerk.patch.v1';

const engine = new Engine();
let patch = loadPatch();

const $ = (sel) => document.querySelector(sel);

const rack = new Rack($('#rack'), {
  getPatch: () => patch,
  onStructure: () => {
    engine.sync();
    rack.render();
    savePatch();
  },
  onParam: (scope, blockId, paramId, value) => {
    if (scope === 'source') {
      patch.source.params[paramId] = value;
    } else {
      const block = patch.chain.find((b) => b.id === blockId);
      if (!block) return;
      block.params[paramId] = value;
      engine.setParam(blockId, paramId, value);
    }
    savePatch();
  },
  onSourceType: (type) => {
    patch.source = { type, params: defaultParams(type) };
    engine.panic();
    rack.render();
    savePatch();
  },
});

const keyboard = new Keyboard($('#keyboard'), {
  // Nicht auf resume() warten: der Graph steht bereits synchron, die Note
  // soll ohne Umweg über einen Promise-Tick klingen.
  onNoteOn: (midi) => {
    if (userSuspended) return;
    ensureAudio();
    engine.noteOn(midi);
  },
  onNoteOff: (midi) => engine.noteOff(midi),
  onOctave: (oct) => { $('#octave-value').textContent = oct; },
});

// ------------------------------------------------------------- Persistenz

function loadPatch() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizePatch(JSON.parse(raw));
  } catch (e) {
    console.warn('Gespeichertes Patch nicht lesbar:', e);
  }
  return makePatch('Start');
}

let saveTimer = null;
function savePatch() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(patch));
    } catch (e) {
      console.warn('Patch konnte nicht gespeichert werden:', e);
    }
  }, 250);
}

function usePatch(next) {
  patch = next;
  $('#patch-name').value = patch.name;
  $('#volume').value = Math.round(patch.master.volume * 100);
  $('#volume-value').textContent = `${Math.round(patch.master.volume * 100)} %`;
  engine.panic();
  engine.setPatch(patch);
  rack.render();
  savePatch();
}

// ----------------------------------------------------------------- Audio

// Wer bewusst auf "Audio läuft" klickt, will Stille – dann darf kein
// Tastendruck den Ton wieder anschalten.
let userSuspended = false;

async function ensureAudio() {
  if (userSuspended || engine.running) return;
  await engine.start();
  updatePower();
}

function updatePower() {
  const btn = $('#power');
  const on = engine.running;
  btn.classList.toggle('on', on);
  btn.textContent = on ? 'Audio läuft' : 'Audio starten';
}

// ------------------------------------------------------------- Bedienung

renderPalette($('#palette'), (block) => {
  patch.chain.push(block);
  engine.sync();
  rack.render();
  savePatch();
});

$('#power').addEventListener('click', async () => {
  if (engine.running) {
    engine.panic();
    userSuspended = true;
    await engine.ctx.suspend();
  } else {
    userSuspended = false;
    await ensureAudio();
  }
  updatePower();
});

$('#volume').addEventListener('input', (e) => {
  const v = Number(e.target.value) / 100;
  patch.master.volume = v;
  engine.setMasterVolume(v);
  $('#volume-value').textContent = `${e.target.value} %`;
  savePatch();
});

$('#panic').addEventListener('click', () => engine.panic());
$('#oct-down').addEventListener('click', () => keyboard.shift(-1));
$('#oct-up').addEventListener('click', () => keyboard.shift(1));

$('#patch-name').addEventListener('input', (e) => {
  patch.name = e.target.value;
  savePatch();
});

$('#new-patch').addEventListener('click', () => {
  const fresh = makePatch('Neues Patch');
  fresh.chain = [];
  usePatch(fresh);
});

const presetSelect = $('#presets');
PRESETS.forEach((factory, i) => {
  const option = document.createElement('option');
  option.value = String(i);
  option.textContent = factory().name;
  presetSelect.append(option);
});
presetSelect.addEventListener('change', (e) => {
  const i = Number(e.target.value);
  if (!Number.isInteger(i) || e.target.value === '') return;
  usePatch(PRESETS[i]());
  e.target.value = '';
});

$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(patch, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(patch.name || 'patch').replace(/[^\w-]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('#import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    usePatch(normalizePatch(JSON.parse(await file.text())));
  } catch (err) {
    alert('Diese Datei ist kein gültiges Patch.');
  }
  e.target.value = '';
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

// ------------------------------------------------------------- Startzustand

$('#patch-name').value = patch.name;
$('#volume').value = Math.round(patch.master.volume * 100);
$('#volume-value').textContent = `${Math.round(patch.master.volume * 100)} %`;
$('#octave-value').textContent = keyboard.octave;
engine.setPatch(patch);
rack.render();
updatePower();

// Kleiner Haken für die Browser-Konsole (und für Smoke-Tests).
window.blockwerk = { engine, patch: () => patch, rack, keyboard };

(function meterLoop() {
  rack.setLevel(engine.running ? engine.level() : 0);
  requestAnimationFrame(meterLoop);
})();
