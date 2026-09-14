// Klang-Ansicht: Quelle und Effektkette der ausgewählten Spur als Blöcke.
// Umsortieren per Drag & Drop oder mit ◀ ▶ am Block.

import { MODULES, SOURCES, EFFECTS, defaultParams } from './modules.js';
import { uid } from './project.js';

const SLIDER_STEPS = 1000;

// Frequenz- und Zeitregler fühlen sich linear falsch an – daher optional
// logarithmische Abbildung zwischen Reglerposition und echtem Wert.
export function toSlider(spec, value) {
  const v = Math.min(spec.max, Math.max(spec.min, value));
  if (spec.scale === 'log') {
    return Math.round((Math.log(v / spec.min) / Math.log(spec.max / spec.min)) * SLIDER_STEPS);
  }
  return Math.round(((v - spec.min) / (spec.max - spec.min)) * SLIDER_STEPS);
}

export function fromSlider(spec, pos) {
  const r = pos / SLIDER_STEPS;
  if (spec.scale === 'log') return spec.min * Math.pow(spec.max / spec.min, r);
  return spec.min + r * (spec.max - spec.min);
}

export function formatValue(spec, value) {
  if (spec.type === 'select') return spec.options.find((o) => o.value === value)?.label ?? value;
  if (spec.unit === 'Hz') return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${Math.round(value)} Hz`;
  if (spec.unit === 's') return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
  if (spec.unit) return `${value.toFixed(0)} ${spec.unit}`;
  return spec.step === 1 ? String(Math.round(value)) : value.toFixed(2);
}

// Spureigene Regler, die nicht aus einem Audiomodul kommen.
const TRACK_PARAMS = [
  { id: 'volume', label: 'Pegel', min: 0, max: 1, def: 0.8 },
  { id: 'octave', label: 'Oktave', min: -3, max: 3, def: 0, step: 1 },
  { id: 'gate', label: 'Notenlänge', min: 0.05, max: 4, def: 0.9, scale: 'log' },
];

function paramMarkup(scope, blockId, spec, value) {
  const key = `${scope}:${blockId}:${spec.id}`;
  if (spec.type === 'select') {
    const opts = spec.options
      .map((o) => `<option value="${o.value}"${o.value === value ? ' selected' : ''}>${o.label}</option>`)
      .join('');
    return `
      <label class="param param-select" data-key="${key}">
        <span class="param-label">${spec.label}</span>
        <select data-key="${key}">${opts}</select>
      </label>`;
  }
  return `
    <label class="param" data-key="${key}">
      <span class="param-label">${spec.label}</span>
      <output class="param-value">${formatValue(spec, value)}</output>
      <input type="range" min="0" max="${SLIDER_STEPS}" step="1"
             value="${toSlider(spec, value)}" data-key="${key}">
    </label>`;
}

function blockMarkup({ scope, id, title, kind, hint, body, controls = '', color = '' }) {
  return `
    <article class="block block-${scope}" data-id="${id}" data-scope="${scope}"
             ${scope === 'fx' ? 'draggable="true"' : ''} ${color ? `style="--track:${color}"` : ''}>
      <header class="block-head">
        <div class="block-title">
          <span class="block-kind">${kind}</span>
          <h3>${title}</h3>
        </div>
        <div class="block-actions">${controls}</div>
      </header>
      ${hint ? `<p class="block-hint">${hint}</p>` : ''}
      <div class="params">${body}</div>
    </article>`;
}

export class Rack {
  constructor(el, hooks) {
    this.el = el;
    this.hooks = hooks; // getTrack, getProject, getSelected, onSelectTrack, onStructure, onParam, onSourceType
    this.picker = document.querySelector('#track-picker');
    this.dragId = null;
    this.bind();
  }

  // Ohne das müsste man zum Spurwechsel in einen anderen Reiter und zurück.
  renderPicker() {
    if (!this.picker) return;
    const selected = this.hooks.getSelected();
    this.picker.innerHTML = this.hooks.getProject().tracks.map((track) => `
      <button class="track-pick${track.id === selected ? ' on' : ''}"
              data-act="pick" data-id="${track.id}" style="--track:${track.color}">
        <span class="dot"></span>${track.name}
      </button>`).join('');
  }

  render() {
    this.renderPicker();
    const track = this.hooks.getTrack();
    if (!track) {
      this.el.innerHTML = '<p class="empty">Keine Spur ausgewählt.</p>';
      return;
    }

    const trackBlock = blockMarkup({
      scope: 'track',
      id: 'track',
      kind: 'Spur',
      title: track.name,
      color: track.color,
      hint: 'Name, Pegel und Lage dieser Spur.',
      body: `
        <label class="param param-select">
          <span class="param-label">Name</span>
          <input type="text" data-act="track-name" value="${track.name.replace(/"/g, '&quot;')}">
        </label>
        ${TRACK_PARAMS.map((spec) => paramMarkup('track', 'track', spec, spec.id === 'volume' ? track.mix.volume : track[spec.id])).join('')}`,
    });

    const srcDef = MODULES[track.source.type];
    const srcOptions = SOURCES.map(
      (m) => `<option value="${m.id}"${m.id === track.source.type ? ' selected' : ''}>${m.name}</option>`
    ).join('');

    const sourceBlock = blockMarkup({
      scope: 'source',
      id: 'source',
      kind: 'Quelle',
      title: srcDef.name,
      hint: srcDef.hint,
      body: `
        <label class="param param-select source-type">
          <span class="param-label">Typ</span>
          <select data-act="source-type">${srcOptions}</select>
        </label>
        ${srcDef.params.map((spec) => paramMarkup('source', 'source', spec, track.source.params[spec.id])).join('')}`,
    });

    const chain = track.chain
      .map((block) => {
        const def = MODULES[block.type];
        return blockMarkup({
          scope: 'fx',
          id: block.id,
          kind: 'Effekt',
          title: def.name,
          hint: def.hint,
          controls: `
            <button class="icon" data-act="move" data-dir="-1" title="Nach vorne">◀</button>
            <button class="icon" data-act="move" data-dir="1" title="Nach hinten">▶</button>
            <button class="icon ${block.bypass ? 'active' : ''}" data-act="bypass" title="Bypass">⏻</button>
            <button class="icon danger" data-act="remove" title="Entfernen">✕</button>`,
          body: def.params.map((spec) => paramMarkup('fx', block.id, spec, block.params[spec.id])).join(''),
        });
      })
      .join('<div class="link" aria-hidden="true"></div>');

    const out = `
      <article class="block block-out">
        <header class="block-head">
          <div class="block-title">
            <span class="block-kind">Ausgang</span>
            <h3>Master</h3>
          </div>
        </header>
        <div class="meter"><i></i></div>
        <p class="block-hint">Alle Spuren laufen hier zusammen, ein Limiter fängt Spitzen ab.</p>
      </article>`;

    const link = '<div class="link" aria-hidden="true"></div>';
    const empty = track.chain.length
      ? ''
      : `${link}<p class="empty">Keine Effekte – unten hinzufügen.</p>`;

    this.el.innerHTML = trackBlock + link + sourceBlock + link + chain + empty + link + out;
    this.meter = this.el.querySelector('.meter i');
    for (const block of this.el.querySelectorAll('.block-fx')) {
      const def = track.chain.find((b) => b.id === block.dataset.id);
      block.classList.toggle('bypassed', !!def?.bypass);
    }
  }

  bind() {
    this.el.addEventListener('input', (e) => {
      const target = e.target;
      if (target.dataset.act === 'track-name') {
        const track = this.hooks.getTrack();
        track.name = target.value;
        return this.hooks.onStructure({ light: true });
      }
      if (!target.dataset.key) return undefined;

      const [scope, blockId, paramId] = target.dataset.key.split(':');
      const spec = this.specFor(scope, blockId, paramId);
      if (!spec) return undefined;

      let value = spec.type === 'select' ? target.value : fromSlider(spec, Number(target.value));
      if (spec.step === 1) value = Math.round(value);
      const label = target.parentElement.querySelector('.param-value');
      if (label) label.textContent = formatValue(spec, value);
      this.hooks.onParam(scope, blockId, paramId, value);
      return undefined;
    });

    this.el.addEventListener('change', (e) => {
      if (e.target.dataset.act === 'source-type') this.hooks.onSourceType(e.target.value);
    });

    this.picker?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="pick"]');
      if (btn) this.hooks.onSelectTrack(btn.dataset.id);
    });

    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const track = this.hooks.getTrack();
      const id = btn.closest('.block').dataset.id;
      const index = track.chain.findIndex((b) => b.id === id);
      if (index < 0) return;

      if (btn.dataset.act === 'remove') track.chain.splice(index, 1);
      if (btn.dataset.act === 'bypass') track.chain[index].bypass = !track.chain[index].bypass;
      if (btn.dataset.act === 'move') {
        const to = index + Number(btn.dataset.dir);
        if (to < 0 || to >= track.chain.length) return;
        const [moved] = track.chain.splice(index, 1);
        track.chain.splice(to, 0, moved);
      }
      this.hooks.onStructure();
    });

    this.bindDrag();
  }

  bindDrag() {
    this.el.addEventListener('dragstart', (e) => {
      const block = e.target.closest('.block-fx');
      if (!block) return;
      this.dragId = block.dataset.id;
      block.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.dragId); // Firefox braucht Nutzdaten
    });

    this.el.addEventListener('dragover', (e) => {
      if (!this.dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const block = e.target.closest('.block-fx');
      this.clearDropMarks();
      if (!block || block.dataset.id === this.dragId) return;
      block.classList.add(this.dropAfter(block, e) ? 'drop-after' : 'drop-before');
    });

    this.el.addEventListener('drop', (e) => {
      if (!this.dragId) return;
      e.preventDefault();
      const block = e.target.closest('.block-fx');
      this.clearDropMarks();
      if (!block || block.dataset.id === this.dragId) return;

      const chain = this.hooks.getTrack().chain;
      const from = chain.findIndex((b) => b.id === this.dragId);
      const [moved] = chain.splice(from, 1);
      let to = chain.findIndex((b) => b.id === block.dataset.id);
      if (this.dropAfter(block, e)) to += 1;
      chain.splice(to, 0, moved);
      this.dragId = null;
      this.hooks.onStructure();
    });

    this.el.addEventListener('dragend', () => {
      this.dragId = null;
      this.clearDropMarks();
      this.el.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
    });
  }

  // Je nach Layout (Reihe am Desktop, Spalte am Handy) zählt X oder Y.
  dropAfter(block, e) {
    const rect = block.getBoundingClientRect();
    const column = getComputedStyle(this.el).flexDirection.startsWith('column');
    return column ? e.clientY > rect.top + rect.height / 2 : e.clientX > rect.left + rect.width / 2;
  }

  clearDropMarks() {
    this.el.querySelectorAll('.drop-before, .drop-after').forEach((n) => {
      n.classList.remove('drop-before', 'drop-after');
    });
  }

  specFor(scope, blockId, paramId) {
    if (scope === 'track') return TRACK_PARAMS.find((p) => p.id === paramId) || null;
    const track = this.hooks.getTrack();
    const type = scope === 'source' ? track.source.type : track.chain.find((b) => b.id === blockId)?.type;
    if (!type) return null;
    return MODULES[type].params.find((p) => p.id === paramId) || null;
  }

  setLevel(v) {
    if (this.meter) this.meter.style.transform = `scaleX(${Math.min(1, v * 2.2)})`;
  }
}

export function renderPalette(el, onAdd) {
  el.innerHTML = EFFECTS.map(
    (m) => `<button class="chip" data-type="${m.id}" title="${m.hint}">+ ${m.name}</button>`
  ).join('');
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    onAdd({ id: uid('b'), type: btn.dataset.type, bypass: false, params: defaultParams(btn.dataset.type) });
  });
}
