// Live-Ansicht.
//
// Die Frage auf der Bühne ist nicht "was läuft gerade" – das hört man – sondern
// "was passiert als Nächstes". Deshalb kein Raster, sondern ein Streifen, der
// durch einen festen Spielkopf läuft: links das Gespielte, rechts das Kommende.
// Ein vorgemerkter Clip steht sichtbar vor dem Spielkopf, samt Wechselmarke.

import { CLIP_SLOTS, STEPS_PER_BAR } from './project.js';

const VISIBLE_STEPS = 32;      // zwei Takte im Bild
const PLAYHEAD_AT = 0.34;      // Spielkopf bei 34 % der Breite
const ROW_HEIGHT = 30;
const MAX_GUTTER = 88;         // Platz für die Spurnamen im Streifen

export class Live {
  constructor(el, hooks) {
    this.el = el;
    this.hooks = hooks; // getProject, transport, onChange, onSelect
    this.editScenes = false;
    this.render();
    this.bind();
  }

  get project() {
    return this.hooks.getProject();
  }

  // -------------------------------------------------------------- Zeichnen

  render() {
    const project = this.project;

    const scenes = project.scenes.map((scene, i) => `
      <button class="scene" data-act="scene" data-index="${i}">
        <span>${scene.name}</span>
        ${this.editScenes ? '<i class="scene-del" data-act="scene-del" data-index="' + i + '">✕</i>' : ''}
      </button>`).join('');

    const pads = project.tracks.map((track) => `
      <div class="pad-row" data-id="${track.id}" style="--track:${track.color}">
        <button class="pad-name" data-act="select">${track.name}</button>
        ${CLIP_SLOTS.map((label, i) => {
          const filled = !!track.clips[i];
          const cls = ['pad'];
          if (!filled) cls.push('empty');
          if (track.clip === i) cls.push('active');
          if (track.queued === i) cls.push('queued');
          return `<button class="${cls.join(' ')}" data-act="pad" data-slot="${i}" ${filled ? '' : 'disabled'}>${label}</button>`;
        }).join('')}
        <button class="pad mute${track.mix.mute ? ' on' : ''}" data-act="mute" title="Stumm">M</button>
      </div>`).join('');

    this.el.innerHTML = `
      <div class="strip-wrap">
        <canvas class="strip"></canvas>
        <div class="strip-legend">
          <span class="now-label">jetzt</span>
          <span class="next-label" data-role="countdown"></span>
        </div>
      </div>

      <div class="scene-bar">
        ${scenes || '<p class="empty">Noch keine Szenen – unten aus der aktuellen Auswahl sichern.</p>'}
        <button class="ghost small" data-act="scene-save">＋ Szene sichern</button>
        ${project.scenes.length ? `<button class="ghost small" data-act="scene-edit">${this.editScenes ? 'Fertig' : 'Bearbeiten'}</button>` : ''}
      </div>

      <div class="pads">${pads}</div>`;

    this.canvas = this.el.querySelector('.strip');
    this.ctx2d = this.canvas.getContext('2d');
    this.countdown = this.el.querySelector('[data-role="countdown"]');
    this.padRows = new Map(
      [...this.el.querySelectorAll('.pad-row')].map((row) => [row.dataset.id, row])
    );
  }

  resizeCanvas() {
    const rows = this.project.tracks.length;
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = Math.max(90, rows * ROW_HEIGHT + 24);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.style.height !== `${cssHeight}px`) this.canvas.style.height = `${cssHeight}px`;
    const w = Math.round(cssWidth * dpr);
    const h = Math.round(cssHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: cssWidth, height: cssHeight };
  }

  // Welcher Clip klingt an diesem Schritt? Nach der Wechselmarke der
  // vorgemerkte – genau das macht die Zukunft sichtbar.
  clipAt(track, step, switchStep) {
    if (track.queued !== null && step >= switchStep) return track.clips[track.queued];
    return track.clips[track.clip];
  }

  mutedAt(track, step, switchStep) {
    if (track.queuedMute !== null && step >= switchStep) return track.queuedMute;
    return track.mix.mute;
  }

  draw() {
    if (!this.canvas || !this.canvas.clientWidth) return;
    const { width, height } = this.resizeCanvas();
    const ctx = this.ctx2d;
    const transport = this.hooks.transport();
    const project = this.project;

    const position = transport.playing ? transport.position() : 0;
    const switchStep = transport.playing ? transport.switchStep() : Infinity;
    // Auf dem Handy darf die Namensspalte nicht den halben Streifen fressen.
    const gutter = Math.min(MAX_GUTTER, Math.max(44, width * 0.18));
    const lane = width - gutter;
    const pxPerStep = lane / VISIBLE_STEPS;
    const playheadX = gutter + lane * PLAYHEAD_AT;
    const originStep = position - (playheadX - gutter) / pxPerStep;
    const xOf = (step) => gutter + (step - originStep) * pxPerStep;

    ctx.clearRect(0, 0, width, height);

    // Taktlinien
    ctx.strokeStyle = 'rgba(139, 147, 168, .22)';
    ctx.lineWidth = 1;
    const firstBar = Math.floor(originStep / STEPS_PER_BAR) * STEPS_PER_BAR;
    for (let s = firstBar; s < originStep + VISIBLE_STEPS + STEPS_PER_BAR; s += STEPS_PER_BAR) {
      const x = Math.round(xOf(s)) + 0.5;
      if (x < gutter) continue;
      ctx.beginPath();
      ctx.moveTo(x, 12);
      ctx.lineTo(x, height - 6);
      ctx.stroke();
    }

    // Zukunft leicht abheben
    ctx.fillStyle = 'rgba(122, 162, 255, .05)';
    ctx.fillRect(playheadX, 12, width - playheadX, height - 18);

    project.tracks.forEach((track, row) => {
      const y = 16 + row * ROW_HEIGHT;
      const barH = ROW_HEIGHT - 12;

      ctx.fillStyle = 'rgba(232, 236, 245, .62)';
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(track.name.slice(0, Math.max(4, Math.floor(gutter / 8))), 5, y + barH / 2);

      ctx.fillStyle = 'rgba(139, 147, 168, .10)';
      ctx.fillRect(gutter, y, lane, barH);

      for (let s = Math.max(0, Math.floor(originStep)); s < originStep + VISIBLE_STEPS + 1; s++) {
        const clip = this.clipAt(track, s, switchStep);
        if (!clip) continue;
        const cell = clip.steps[s % clip.steps.length];
        if (!cell || !cell.on) continue;

        const future = s >= position;
        const queuedPart = track.queued !== null && s >= switchStep;
        const muted = this.mutedAt(track, s, switchStep);

        const x = xOf(s);
        const w = Math.max(3, pxPerStep * 0.72);
        ctx.globalAlpha = muted ? 0.18 : (future ? 0.95 : 0.4);
        ctx.fillStyle = track.color;
        const h = cell.on === 2 ? barH : barH * 0.66;
        ctx.fillRect(x, y + (barH - h) / 2, w, h);

        // Der vorgemerkte Clip bekommt eine Kontur, damit man ihn erkennt,
        // bevor er klingt.
        if (queuedPart) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#6ee7c7';
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(x) + 0.5, Math.round(y + (barH - h) / 2) + 0.5, Math.round(w), Math.round(h));
        }
      }
      ctx.globalAlpha = 1;
    });

    // Wechselmarke
    if (transport.playing && project.tracks.some((t) => t.queued !== null || t.queuedMute !== null)) {
      const x = xOf(switchStep);
      if (x > gutter && x < width) {
        ctx.strokeStyle = '#6ee7c7';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 8);
        ctx.lineTo(x, height - 4);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Spielkopf
    ctx.strokeStyle = transport.playing ? '#e8ecf5' : 'rgba(232, 236, 245, .35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 4);
    ctx.lineTo(playheadX, height - 2);
    ctx.stroke();

    const nowLabel = this.el.querySelector('.now-label');
    if (nowLabel && this._labelX !== playheadX) {
      nowLabel.style.marginLeft = `${Math.round(playheadX - 16)}px`;
      this._labelX = playheadX;
    }
  }

  tick() {
    this.draw();
    const transport = this.hooks.transport();
    if (!this.countdown) return;
    const pending = this.project.tracks.some((t) => t.queued !== null || t.queuedMute !== null);
    const text = transport.playing && pending
      ? `Wechsel in ${transport.barsUntilSwitch().toFixed(1)} Takten`
      : '';
    if (this.countdown.textContent !== text) this.countdown.textContent = text;
  }

  // Nur die Zustände der Pads nachziehen, ohne alles neu zu bauen.
  refresh() {
    for (const track of this.project.tracks) {
      const row = this.padRows.get(track.id);
      if (!row) continue;
      row.querySelectorAll('.pad[data-slot]').forEach((pad) => {
        const slot = Number(pad.dataset.slot);
        pad.classList.toggle('active', track.clip === slot);
        pad.classList.toggle('queued', track.queued === slot);
      });
      row.querySelector('.pad.mute')?.classList.toggle('on', track.mix.mute);
    }
  }

  bind() {
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const transport = this.hooks.transport();
      const row = btn.closest('.pad-row');
      const track = row ? this.project.tracks.find((t) => t.id === row.dataset.id) : null;

      if (act === 'pad' && track) {
        transport.queueClip(track.id, Number(btn.dataset.slot));
        return this.refresh();
      }
      if (act === 'mute' && track) {
        track.mix.mute = !track.mix.mute;
        this.hooks.onChange({ mix: true });
        return this.refresh();
      }
      if (act === 'select' && track) return this.hooks.onSelect(track.id);
      if (act === 'scene-del') {
        e.stopPropagation();
        this.project.scenes.splice(Number(btn.dataset.index), 1);
        this.hooks.onChange({});
        return this.render();
      }
      if (act === 'scene') {
        transport.queueScene(this.project.scenes[Number(btn.dataset.index)]);
        return this.refresh();
      }
      if (act === 'scene-save') {
        this.hooks.onSceneSave();
        return this.render();
      }
      if (act === 'scene-edit') {
        this.editScenes = !this.editScenes;
        return this.render();
      }
      return undefined;
    });
  }
}
