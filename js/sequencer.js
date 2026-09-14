// Sequenzer-Ansicht: eine Zeile je Spur, 16 Schritte je Takt.
// Tippen schaltet einen Schritt um (aus -> an -> Akzent), senkrechtes Ziehen
// verschiebt die Tonhöhe in Skalenstufen. Beides funktioniert mit dem Finger.

import { CLIP_SLOTS, STEPS_PER_BAR } from './project.js';

const DRAG_THRESHOLD = 10;
const PIXELS_PER_DEGREE = 16;

export class Sequencer {
  constructor(el, hooks) {
    this.el = el;
    this.hooks = hooks; // getProject, getSelected, onSelect, onChange, onPreview, transport
    this.viewBar = 0;
    this.follow = true;
    this.drag = null;
    this.rows = new Map();
    this.bind();
  }

  get project() {
    return this.hooks.getProject();
  }

  // -------------------------------------------------------------- Zeichnen

  render() {
    const project = this.project;
    const selected = this.hooks.getSelected();

    const head = `
      <div class="seq-head">
        <div class="seq-head-left">
          <button class="ghost small" data-act="follow" aria-pressed="${this.follow}">
            ${this.follow ? '◉' : '○'} Folgen
          </button>
          <div class="bar-tabs" data-role="bars"></div>
        </div>
        <div class="beat-ruler">
          ${Array.from({ length: STEPS_PER_BAR }, (_, i) =>
            `<span class="${i % 4 === 0 ? 'beat' : ''}">${i % 4 === 0 ? i / 4 + 1 : ''}</span>`
          ).join('')}
        </div>
      </div>`;

    const rows = project.tracks.map((track) => this.trackMarkup(track, track.id === selected)).join('');

    this.el.innerHTML = `
      ${head}
      <div class="tracks">${rows}</div>
      <div class="seq-foot">
        <button class="ghost" data-act="add-track">+ Spur</button>
        <button class="ghost" data-act="toggle-text">Clip als Text</button>
      </div>
      <div class="clip-text" hidden></div>`;

    this.rows.clear();
    for (const row of this.el.querySelectorAll('.track')) {
      this.rows.set(row.dataset.id, {
        row,
        cells: [...row.querySelectorAll('.cell')],
        playhead: -1,
      });
    }
    this.renderBarTabs();
    if (this.textOpen) this.renderTextPanel();
  }

  trackMarkup(track, isSelected) {
    const clip = track.clips[track.clip];
    const bars = clip ? clip.bars : 1;
    const bar = Math.min(this.viewBar, bars - 1);

    const chips = CLIP_SLOTS.map((label, i) => {
      const state = track.clips[i] ? (track.clip === i ? 'active' : 'filled') : 'empty';
      const queued = track.queued === i ? ' queued' : '';
      return `<button class="clip-chip ${state}${queued}" data-act="clip" data-slot="${i}">${label}</button>`;
    }).join('');

    const cells = Array.from({ length: STEPS_PER_BAR }, (_, i) => {
      const index = bar * STEPS_PER_BAR + i;
      const step = clip?.steps[index] || { on: 0, deg: 0 };
      return this.cellMarkup(index, step, i);
    }).join('');

    return `
      <div class="track${isSelected ? ' selected' : ''}" data-id="${track.id}" style="--track:${track.color}">
        <button class="track-name" data-act="select">
          <span class="dot"></span>${track.name}
        </button>
        <div class="track-btns">
          <button class="flag${track.mix.mute ? ' on' : ''}" data-act="mute" title="Stumm">M</button>
          <button class="flag${track.mix.solo ? ' on solo' : ''}" data-act="solo" title="Solo">S</button>
        </div>
        <div class="clip-chips">${chips}</div>
        <div class="steps">${cells}</div>
      </div>`;
  }

  cellMarkup(index, step, column) {
    const cls = ['cell'];
    if (step.on) cls.push('on');
    if (step.on === 2) cls.push('accent');
    if (column % 4 === 0) cls.push('downbeat');
    return `<button class="${cls.join(' ')}" data-act="cell" data-index="${index}">
      <span class="deg">${step.on && step.deg ? step.deg : ''}</span>
    </button>`;
  }

  paintCell(cell, step) {
    cell.classList.toggle('on', step.on > 0);
    cell.classList.toggle('accent', step.on === 2);
    cell.querySelector('.deg').textContent = step.on && step.deg ? step.deg : '';
  }

  renderBarTabs() {
    const holder = this.el.querySelector('[data-role="bars"]');
    if (!holder) return;
    const bars = Math.max(...this.project.tracks.map((t) => t.clips[t.clip]?.bars || 1), 1);
    holder.innerHTML = bars <= 1
      ? ''
      : Array.from({ length: bars }, (_, i) =>
          `<button class="bar-tab${i === this.viewBar ? ' on' : ''}" data-act="bar" data-bar="${i}">${i + 1}</button>`
        ).join('');
  }

  // -------------------------------------------------------------- Eingaben

  bind() {
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const trackEl = btn.closest('.track');
      const track = trackEl ? this.project.tracks.find((t) => t.id === trackEl.dataset.id) : null;

      if (act === 'select' && track) return this.hooks.onSelect(track.id);
      if (act === 'mute' && track) {
        track.mix.mute = !track.mix.mute;
        return this.hooks.onChange({ mix: true });
      }
      if (act === 'solo' && track) {
        track.mix.solo = !track.mix.solo;
        return this.hooks.onChange({ mix: true });
      }
      if (act === 'clip' && track) {
        this.hooks.transport().queueClip(track.id, Number(btn.dataset.slot));
        this.hooks.onSelect(track.id);
        return undefined;
      }
      if (act === 'bar') {
        this.viewBar = Number(btn.dataset.bar);
        this.follow = false;
        return this.render();
      }
      if (act === 'follow') {
        this.follow = !this.follow;
        return this.render();
      }
      if (act === 'add-track') return this.hooks.onAddTrack();
      if (act === 'toggle-text') {
        this.textOpen = !this.textOpen;
        return this.renderTextPanel();
      }
      if (act === 'apply-text') {
        const field = this.el.querySelector('[data-role="clip-text"]');
        this.hooks.onClipText(this.selectedTrack(), field.value);
        return this.render();
      }
      if (act === 'clear-clip') {
        this.hooks.onClipText(this.selectedTrack(), '');
        return this.render();
      }
      if (act === 'dup-clip') {
        this.hooks.onClipCopy(this.selectedTrack());
        return this.render();
      }
      return undefined;
    });

    this.el.addEventListener('change', (e) => {
      if (e.target.dataset.act !== 'bars') return;
      this.hooks.onClipBars(this.selectedTrack(), Number(e.target.value));
      this.viewBar = 0;
      this.render();
    });

    this.el.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const trackEl = cell.closest('.track');
      const track = this.project.tracks.find((t) => t.id === trackEl.dataset.id);
      const clip = track?.clips[track.clip];
      if (!clip) return;

      e.preventDefault();
      const index = Number(cell.dataset.index);
      this.drag = { cell, track, clip, index, startY: e.clientY, startDeg: clip.steps[index].deg, moved: false };
      cell.setPointerCapture(e.pointerId);
    });

    this.el.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dy = this.drag.startY - e.clientY;
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      this.drag.moved = true;
      const step = this.drag.clip.steps[this.drag.index];
      const deg = Math.max(-21, Math.min(21, this.drag.startDeg + Math.round(dy / PIXELS_PER_DEGREE)));
      if (step.deg === deg && step.on) return;
      step.deg = deg;
      if (!step.on) step.on = 1;
      this.paintCell(this.drag.cell, step);
      this.hooks.onPreview(this.drag.track, step);
      this.hooks.onChange({ quiet: true });
    });

    const finish = () => {
      if (!this.drag) return;
      const { cell, clip, index, moved, track } = this.drag;
      this.drag = null;
      if (!moved) {
        const step = clip.steps[index];
        step.on = (step.on + 1) % 3; // aus -> an -> Akzent
        this.paintCell(cell, step);
        if (step.on) this.hooks.onPreview(track, step);
      }
      this.hooks.onChange({ quiet: true });
      if (this.textOpen) this.renderTextPanel();
    };
    this.el.addEventListener('pointerup', finish);
    this.el.addEventListener('pointercancel', finish);
  }

  selectedTrack() {
    return this.project.tracks.find((t) => t.id === this.hooks.getSelected()) || this.project.tracks[0];
  }

  // Spielkopf: läuft je Spur über deren eigene Cliplänge, damit auch
  // unterschiedlich lange Clips richtig angezeigt werden.
  tick() {
    const transport = this.hooks.transport();
    const playing = transport.playing;
    const globalStep = Math.floor(transport.position());

    if (playing && this.follow) {
      const track = this.selectedTrack();
      const bars = (track && track.clips[track.clip]?.bars) || 1;
      const bar = Math.floor((globalStep % (bars * STEPS_PER_BAR)) / STEPS_PER_BAR);
      if (bar !== this.viewBar) {
        this.viewBar = bar;
        this.render();
        return;
      }
    }

    for (const track of this.project.tracks) {
      const entry = this.rows.get(track.id);
      if (!entry) continue;
      const clip = track.clips[track.clip];
      let column = -1;
      if (playing && clip) {
        const inClip = globalStep % clip.steps.length;
        if (Math.floor(inClip / STEPS_PER_BAR) === Math.min(this.viewBar, clip.bars - 1)) {
          column = inClip % STEPS_PER_BAR;
        }
      }
      if (entry.playhead === column) continue;
      if (entry.playhead >= 0) entry.cells[entry.playhead]?.classList.remove('now');
      if (column >= 0) entry.cells[column]?.classList.add('now');
      entry.playhead = column;
    }
  }

  // ------------------------------------------------------------ Textmodus

  renderTextPanel() {
    const holder = this.el.querySelector('.clip-text');
    if (!holder) return;
    holder.hidden = !this.textOpen;
    if (!this.textOpen) return;

    const track = this.project.tracks.find((t) => t.id === this.hooks.getSelected()) || this.project.tracks[0];
    const clip = track?.clips[track.clip];
    if (!clip) {
      holder.innerHTML = '<p class="empty">Diese Spur hat im aktiven Slot keinen Clip.</p>';
      return;
    }

    holder.innerHTML = `
      <div class="clip-text-head">
        <strong>${track.name} · Clip ${CLIP_SLOTS[track.clip]}</strong>
        <label class="ctrl small">
          <span>Takte</span>
          <select data-act="bars">
            ${[1, 2, 4].map((b) => `<option value="${b}"${b === clip.bars ? ' selected' : ''}>${b}</option>`).join('')}
          </select>
        </label>
        <button class="ghost small" data-act="clear-clip">Leeren</button>
        <button class="ghost small" data-act="dup-clip">In freien Slot kopieren</button>
      </div>
      <textarea spellcheck="false" data-role="clip-text">${this.hooks.clipToText(clip)}</textarea>
      <div class="clip-text-foot">
        <button data-act="apply-text">Übernehmen</button>
        <p class="hint"><code>.</code> Pause · <code>x</code> an · <code>X</code> Akzent · <code>x3</code> Stufe 3 · <code>|</code> Trenner</p>
      </div>`;
  }
}
