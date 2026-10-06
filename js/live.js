// Live-Ansicht.
//
// Die Frage auf der Bühne ist nicht "was läuft gerade" – das hört man – sondern
// "was passiert als Nächstes". Deshalb kein Raster, sondern ein Streifen, der
// durch einen festen Spielkopf läuft: links das Gespielte, rechts das Kommende.
// Ein vorgemerkter Clip steht sichtbar vor dem Spielkopf, samt Wechselmarke.

import { CLIP_SLOTS, STEPS_PER_BAR } from './project.js';
import { MODULES } from './modules.js';
import { toSlider, fromSlider, formatValue } from './rack.js';
import { resolveTarget, targetSpec, readTarget, nameKey } from './script.js';

const VISIBLE_STEPS = 32;      // zwei Takte im Bild
const PLAYHEAD_AT = 0.34;      // Spielkopf bei 34 % der Breite
const ROW_HEIGHT = 30;
const ROW_HEIGHT_FLAT = 24;    // flache Fenster: schmalere Spuren im Streifen
const MAX_GUTTER = 88;         // Platz für die Spurnamen im Streifen

export class Live {
  constructor(el, hooks) {
    this.el = el;
    this.hooks = hooks; // getProject, transport, onChange, onSelect
    this.mode = 'pads';
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
      <button class="scene" data-act="scene" data-index="${i}" title="Taste ${i + 1}">
        ${i < 9 ? `<span class="scene-key">${i + 1}</span>` : ''}
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

    const field = this.mode === 'field';

    const stripBlock = `
      <div class="strip-wrap">
        <canvas class="strip"></canvas>
        <div class="strip-legend">
          <span class="now-label">jetzt</span>
          <span class="next-label" data-role="countdown"></span>
        </div>
        <div class="script-next" data-role="script-next" hidden></div>
      </div>`;

    const modeBlock = `
      <div class="mode-switch">
        <button data-act="mode" data-mode="pads" class="${field ? '' : 'on'}">Pads</button>
        <button data-act="mode" data-mode="field" class="${field ? 'on' : ''}">Feld</button>
      </div>`;

    const sceneBlock = `
      <div class="scene-bar">
        ${scenes || '<p class="empty">Noch keine Szenen – unten aus der aktuellen Auswahl sichern.</p>'}
        <button class="ghost small" data-act="scene-save">＋ Szene sichern</button>
        ${project.scenes.length ? `<button class="ghost small" data-act="scene-edit">${this.editScenes ? 'Fertig' : 'Bearbeiten'}</button>` : ''}
      </div>`;

    // Im Feldmodus steht die Spielflaeche ganz oben: was man anfasst, gehoert
    // nach vorn. Vorschau und Szenen ruecken darunter.
    this.el.classList.toggle('field-mode', field);
    this.el.innerHTML = field
      ? modeBlock + '<div class="gesture-host" id="gesture-host"></div>' + stripBlock + sceneBlock
      : stripBlock + modeBlock + sceneBlock
        + `<div class="pads">${pads}</div><div class="macros">${this.macroMarkup()}</div>`;

    this.canvas = this.el.querySelector('.strip');
    this.ctx2d = this.canvas.getContext('2d');
    this.countdown = this.el.querySelector('[data-role="countdown"]');
    this.scriptNext = this.el.querySelector('[data-role="script-next"]');
    this.padRows = new Map(
      [...this.el.querySelectorAll('.pad-row')].map((row) => [row.dataset.id, row])
    );
  }

  get rowHeight() {
    // Im Feldmodus braucht die Spielflaeche den Platz, nicht die Vorschau.
    if (this.mode === 'field' || window.innerHeight < 720) return ROW_HEIGHT_FLAT;
    return ROW_HEIGHT;
  }

  // Vier Live-Regler auf beliebige Parameter – die grafische Seite dessen,
  // was das Script mit „control“ macht.
  macroMarkup() {
    const project = this.project;
    const macros = project.macros || [];
    return macros.map((macro, slot) => {
      if (!macro) {
        return `<div class="macro empty" data-slot="${slot}">
          <span class="macro-label">Regler ${slot + 1}</span>
          ${this.targetSelect(slot, null)}
        </div>`;
      }
      const spec = { ...targetSpec(project, macro.target), min: macro.min, max: macro.max };
      const value = readTarget(project, macro.target);
      return `<div class="macro" data-slot="${slot}">
        <div class="macro-head">
          <span class="macro-label" title="${macro.path}">${macro.label}</span>
          ${this.midiChip(slot)}
          <output class="macro-value">${formatValue(spec, value)}</output>
        </div>
        <input type="range" min="0" max="1000" step="1" value="${toSlider(spec, value)}"
               data-act="macro" data-slot="${slot}">
        ${this.targetSelect(slot, macro.path)}
      </div>`;
    }).join('');
  }

  // Ein Drehregler des Controllers wird hier gelernt: antippen, drehen, fertig.
  midiChip(slot) {
    const midi = this.midi;
    if (!midi?.open) return '';
    const bound = Object.entries(midi.map || {}).find(([, s]) => s === slot)?.[0];
    const learning = midi.learning === slot;
    const label = learning ? 'dreh …' : bound ? `CC ${bound.split(':')[1]}` : 'MIDI';
    return `<button class="midi-chip${learning ? ' learning' : ''}${bound ? ' bound' : ''}"
      data-act="midi-learn" data-slot="${slot}"
      title="Diesem Regler einen Drehregler zuordnen">${label}</button>`;
  }

  setMidi(state) {
    this.midi = state;
  }

  // Nach einer MIDI-Bewegung nur diesen einen Regler nachziehen – alles neu zu
  // zeichnen waere mitten im Set eine sichtbare Ruckelei.
  refreshMacro(slot) {
    const macro = this.project.macros?.[slot];
    const box = this.el.querySelector(`.macro[data-slot="${slot}"]`);
    if (!macro || !box) return;
    const spec = { ...targetSpec(this.project, macro.target), min: macro.min, max: macro.max };
    const value = readTarget(this.project, macro.target);
    const slider = box.querySelector('[data-act="macro"]');
    const out = box.querySelector('.macro-value');
    if (slider) slider.value = toSlider(spec, value);
    if (out) out.textContent = formatValue(spec, value);
  }

  targetSelect(slot, current) {
    const groups = macroTargets(this.project);
    const options = groups.map(({ group, items }) => `
      <optgroup label="${group}">
        ${items.map((it) => `<option value="${it.path}"${it.path === current ? ' selected' : ''}>${it.label}</option>`).join('')}
      </optgroup>`).join('');
    return `<select class="macro-pick" data-act="macro-target" data-slot="${slot}">
      <option value="">– nicht belegt –</option>${options}
    </select>`;
  }

  get compact() {
    // Im Feldmodus schrumpft die Vorschau auf ein Band: man spielt mit der
    // Hand und braucht vor allem zu wissen, wo im Takt man ist.
    return this.mode === 'field';
  }

  resizeCanvas() {
    const rows = this.project.tracks.length;
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.compact ? 46 : Math.max(80, rows * this.rowHeight + 20);
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
    ctx.shadowBlur = 0;

    // Taktlinien
    ctx.strokeStyle = 'rgba(122, 107, 255, .25)';
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
    ctx.fillStyle = 'rgba(45, 226, 255, .05)';
    ctx.fillRect(playheadX, 12, width - playheadX, height - 18);

    if (this.compact) {
      // Alle Spuren in einem Band, nach Farbe unterscheidbar.
      project.tracks.forEach((track, row) => {
        const clip = track.clips[track.clip];
        if (!clip || track.mix.mute) return;
        const y = 14 + (row % 4) * 5;
        for (let s = Math.max(0, Math.floor(originStep)); s < originStep + VISIBLE_STEPS + 1; s++) {
          const cell = clip.steps[s % clip.steps.length];
          if (!cell || !cell.on) continue;
          ctx.globalAlpha = s >= position ? 0.95 : 0.35;
          ctx.fillStyle = track.color;
          ctx.fillRect(xOf(s), y, Math.max(2, pxPerStep * 0.6), 4);
        }
      });
      ctx.globalAlpha = 1;
      ctx.strokeStyle = transport.playing ? '#e8ecf5' : 'rgba(232,236,245,.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 2);
      ctx.lineTo(playheadX, height - 2);
      ctx.stroke();
      return;
    }

    const rowHeight = this.rowHeight;
    project.tracks.forEach((track, row) => {
      const y = 14 + row * rowHeight;
      const barH = rowHeight - 10;

      ctx.fillStyle = 'rgba(234, 242, 255, .7)';
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(track.name.slice(0, Math.max(4, Math.floor(gutter / 8))), 5, y + barH / 2);

      ctx.fillStyle = 'rgba(122, 107, 255, .14)';
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
        ctx.shadowColor = track.color;
        ctx.shadowBlur = future && !muted ? 10 : 0;
        const h = cell.on === 2 ? barH : barH * 0.66;
        ctx.fillRect(x, y + (barH - h) / 2, w, h);

        // Der vorgemerkte Clip bekommt eine Kontur, damit man ihn erkennt,
        // bevor er klingt.
        if (queuedPart) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#9dff3d';
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(x) + 0.5, Math.round(y + (barH - h) / 2) + 0.5, Math.round(w), Math.round(h));
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    });

    // Wechselmarke
    if (transport.playing && project.tracks.some((t) => t.queued !== null || t.queuedMute !== null)) {
      const x = xOf(switchStep);
      if (x > gutter && x < width) {
        ctx.strokeStyle = '#9dff3d';
        ctx.shadowColor = '#9dff3d';
        ctx.shadowBlur = 12;
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
    ctx.strokeStyle = transport.playing ? '#ffffff' : 'rgba(234, 242, 255, .35)';
    ctx.shadowColor = '#2de2ff';
    ctx.shadowBlur = transport.playing ? 16 : 0;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 4);
    ctx.lineTo(playheadX, height - 2);
    ctx.stroke();

    ctx.shadowBlur = 0;
    const nowLabel = this.el.querySelector('.now-label');
    if (nowLabel && this._labelX !== playheadX) {
      nowLabel.style.marginLeft = `${Math.round(playheadX - 16)}px`;
      this._labelX = playheadX;
    }
  }

  tick(script = null) {
    this.draw();
    const transport = this.hooks.transport();
    if (!this.countdown) return;
    const pending = this.project.tracks.some((t) => t.queued !== null || t.queuedMute !== null);
    const text = transport.playing && pending
      ? `Wechsel in ${transport.barsUntilSwitch().toFixed(1)} Takten`
      : '';
    if (this.countdown.textContent !== text) this.countdown.textContent = text;
    this.showScript(script, transport);
  }

  // Das Script zeigt seine nächsten Schritte an – derselbe Gedanke wie der
  // Streifen: sichtbar machen, was kommt.
  showScript(script, transport) {
    if (!this.scriptNext) return;
    if (!script || !script.enabled) {
      if (!this.scriptNext.hidden) this.scriptNext.hidden = true;
      return;
    }
    const next = script.upcoming(transport.playing ? transport.position() : 0, 3);
    const html = next.length
      ? next.map((e, i) => `
          <span class="script-step${i === 0 ? ' soon' : ''}">
            <b>Takt ${e.bar}</b> ${escapeHtml(e.text)}
            ${transport.playing ? `<i>in ${Math.max(0, e.inBars).toFixed(1)}</i>` : ''}
          </span>`).join('')
      : '<span class="script-step">Script: nichts mehr geplant</span>';
    if (this._scriptHtml !== html) {
      this.scriptNext.innerHTML = html;
      this._scriptHtml = html;
    }
    this.scriptNext.hidden = false;
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

      if (act === 'midi-learn') {
        this.hooks.onMidiLearn?.(Number(btn.dataset.slot));
        return this.render();
      }

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
      if (act === 'mode') {
        this.mode = btn.dataset.mode;
        this.render();                 // erst den Platzhalter bauen,
        return this.hooks.onMode(this.mode); // dann das Feld einhaengen
      }
      if (act === 'scene-edit') {
        this.editScenes = !this.editScenes;
        return this.render();
      }
      return undefined;
    });

    this.el.addEventListener('input', (e) => {
      if (e.target.dataset.act !== 'macro') return;
      const slot = Number(e.target.dataset.slot);
      const macro = this.project.macros?.[slot];
      if (!macro) return;
      const spec = { ...targetSpec(this.project, macro.target), min: macro.min, max: macro.max };
      const value = fromSlider(spec, Number(e.target.value));
      this.hooks.onMacro(macro.target, value);
      const out = e.target.parentElement.querySelector('.macro-value');
      if (out) out.textContent = formatValue(spec, value);
    });

    this.el.addEventListener('change', (e) => {
      if (e.target.dataset.act !== 'macro-target') return;
      this.hooks.onMacroTarget(Number(e.target.dataset.slot), e.target.value);
      this.render();
    });
  }
}

// Alle stufenlos regelbaren Ziele des Projekts, nach Spur gruppiert.
export function macroTargets(project) {
  const masterItems = [{ path: 'master.volume', label: 'Lautstärke' }];
  for (const block of project.master?.chain || []) {
    for (const spec of MODULES[block.type].params) {
      if (spec.type === 'select' || spec.type === 'track') continue;
      masterItems.push({ path: `master.${block.type}.${spec.id}`, label: `${MODULES[block.type].name} · ${spec.label}` });
    }
  }
  const groups = [{ group: 'Master', items: masterItems }];
  for (const track of project.tracks) {
    const items = [
      { path: `${track.name}.volume`, label: 'Pegel' },
      { path: `${track.name}.gate`, label: 'Notenlänge' },
      { path: `${track.name}.offset`, label: 'Versatz (Stufen)' },
      { path: `${track.name}.nudge`, label: 'Versatz (ms)' },
    ];
    for (const spec of MODULES[track.source.type].params) {
      if (spec.type === 'select' || spec.type === 'track') continue;
      items.push({ path: `${track.name}.source.${spec.id}`, label: `Quelle · ${spec.label}` });
    }
    for (const block of track.chain) {
      for (const spec of MODULES[block.type].params) {
        if (spec.type === 'select' || spec.type === 'track') continue;
        items.push({ path: `${track.name}.${block.type}.${spec.id}`, label: `${MODULES[block.type].name} · ${spec.label}` });
      }
    }
    groups.push({ group: track.name, items });
  }
  return groups;
}

// Pfad wie „bass.filter.freq“ in ein Ziel aufloesen.
export function pathToTarget(project, path) {
  const byName = new Map(project.tracks.map((t) => [nameKey(t.name), t]));
  return resolveTarget(path, byName, new Set(), project);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
