// Rack-Oberfläche: zeichnet die Blöcke, ihre Regler und übernimmt das
// Umsortieren per Drag & Drop oder Pfeiltasten am Block.

import { MODULES, SOURCES, EFFECTS } from './modules.js';
import { makeBlock } from './patch.js';

const SLIDER_STEPS = 1000;

// Frequenz- und Zeitregler fühlen sich linear falsch an – daher optional
// logarithmische Abbildung zwischen Reglerposition und echtem Wert.
export function toSlider(spec, value) {
  const v = Math.min(spec.max, Math.max(spec.min, value));
  if (spec.scale === 'log') {
    const r = Math.log(v / spec.min) / Math.log(spec.max / spec.min);
    return Math.round(r * SLIDER_STEPS);
  }
  return Math.round(((v - spec.min) / (spec.max - spec.min)) * SLIDER_STEPS);
}

export function fromSlider(spec, pos) {
  const r = pos / SLIDER_STEPS;
  if (spec.scale === 'log') return spec.min * Math.pow(spec.max / spec.min, r);
  return spec.min + r * (spec.max - spec.min);
}

export function formatValue(spec, value) {
  if (spec.type === 'select') {
    return spec.options.find((o) => o.value === value)?.label ?? value;
  }
  if (spec.unit === 'Hz') {
    return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${Math.round(value)} Hz`;
  }
  if (spec.unit === 's') {
    return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
  }
  if (spec.unit) return `${value.toFixed(0)} ${spec.unit}`;
  return value.toFixed(2);
}

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

function blockMarkup({ scope, id, def, params, bypass, extraHeader = '', typeSelect = '' }) {
  const controls = scope === 'fx'
    ? `<button class="icon" data-act="move" data-dir="-1" title="Nach vorne">◀</button>
       <button class="icon" data-act="move" data-dir="1" title="Nach hinten">▶</button>
       <button class="icon ${bypass ? 'active' : ''}" data-act="bypass" title="Bypass">⏻</button>
       <button class="icon danger" data-act="remove" title="Entfernen">✕</button>`
    : extraHeader;

  const body = def.params.map((spec) => paramMarkup(scope, id, spec, params[spec.id])).join('');

  return `
    <article class="block block-${scope} ${bypass ? 'bypassed' : ''}" data-id="${id}" data-scope="${scope}"
             ${scope === 'fx' ? 'draggable="true"' : ''}>
      <header class="block-head">
        <div class="block-title">
          <span class="block-kind">${scope === 'source' ? 'Quelle' : 'Effekt'}</span>
          <h3>${def.name}</h3>
        </div>
        <div class="block-actions">${controls}</div>
      </header>
      ${typeSelect}
      <p class="block-hint">${def.hint}</p>
      <div class="params">${body}</div>
    </article>`;
}

export class Rack {
  constructor(el, { getPatch, onStructure, onParam, onSourceType }) {
    this.el = el;
    this.getPatch = getPatch;
    this.onStructure = onStructure;
    this.onParam = onParam;
    this.onSourceType = onSourceType;
    this.dragId = null;
    this.bind();
  }

  render() {
    const patch = this.getPatch();
    const srcDef = MODULES[patch.source.type];
    const srcOptions = SOURCES.map(
      (m) => `<option value="${m.id}"${m.id === patch.source.type ? ' selected' : ''}>${m.name}</option>`
    ).join('');

    const source = blockMarkup({
      scope: 'source',
      id: 'source',
      def: srcDef,
      params: patch.source.params,
      bypass: false,
      typeSelect: `
        <label class="param param-select source-type">
          <span class="param-label">Typ</span>
          <select data-act="source-type">${srcOptions}</select>
        </label>`,
    });

    const chain = patch.chain
      .map((b) => blockMarkup({
        scope: 'fx',
        id: b.id,
        def: MODULES[b.type],
        params: b.params,
        bypass: b.bypass,
      }))
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
        <p class="block-hint">Limiter aktiv, damit die Kette nicht clippt.</p>
      </article>`;

    const empty = patch.chain.length
      ? ''
      : '<div class="link" aria-hidden="true"></div><p class="empty">Kette ist leer – unten Effekte hinzufügen.</p>';

    this.el.innerHTML =
      source +
      '<div class="link" aria-hidden="true"></div>' +
      chain +
      empty +
      '<div class="link" aria-hidden="true"></div>' +
      out;

    this.meter = this.el.querySelector('.meter i');
  }

  bind() {
    this.el.addEventListener('input', (e) => {
      const target = e.target;
      if (!target.dataset.key) return;
      const [scope, blockId, paramId] = target.dataset.key.split(':');
      const spec = this.specFor(scope, blockId, paramId);
      if (!spec) return;

      const value = spec.type === 'select' ? target.value : fromSlider(spec, Number(target.value));
      const label = target.parentElement.querySelector('.param-value');
      if (label) label.textContent = formatValue(spec, value);
      this.onParam(scope, blockId, paramId, value);
    });

    this.el.addEventListener('change', (e) => {
      if (e.target.dataset.act === 'source-type') this.onSourceType(e.target.value);
    });

    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const block = btn.closest('.block');
      const id = block.dataset.id;
      const patch = this.getPatch();
      const index = patch.chain.findIndex((b) => b.id === id);
      if (index < 0) return;

      if (btn.dataset.act === 'remove') patch.chain.splice(index, 1);
      if (btn.dataset.act === 'bypass') patch.chain[index].bypass = !patch.chain[index].bypass;
      if (btn.dataset.act === 'move') {
        const to = index + Number(btn.dataset.dir);
        if (to < 0 || to >= patch.chain.length) return;
        const [moved] = patch.chain.splice(index, 1);
        patch.chain.splice(to, 0, moved);
      }
      this.onStructure();
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

      const patch = this.getPatch();
      const from = patch.chain.findIndex((b) => b.id === this.dragId);
      const [moved] = patch.chain.splice(from, 1);
      let to = patch.chain.findIndex((b) => b.id === block.dataset.id);
      if (this.dropAfter(block, e)) to += 1;
      patch.chain.splice(to, 0, moved);
      this.dragId = null;
      this.onStructure();
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
    const patch = this.getPatch();
    const type = scope === 'source'
      ? patch.source.type
      : patch.chain.find((b) => b.id === blockId)?.type;
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
    if (btn) onAdd(makeBlock(btn.dataset.type));
  });
}
