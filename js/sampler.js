// Sampler-Ansicht: aufnehmen, Wellenform ansehen, zerhacken, Slices antippen.
//
// Die Schnittmarken sind das Herzstück: tippen hört, ziehen verschiebt,
// Doppeltippen entfernt. Alles andere (Sequenzieren, Szenen, Script) läuft
// über das vorhandene Raster, weil die Stufe eines Schritts den Slice wählt.

import { peaks, sliceBounds } from './samples.js';

const HEIGHT = 190;

export class SamplerView {
  constructor(el, hooks) {
    this.el = el;
    this.hooks = hooks;
    this.drag = null;
    this.peakCache = null;
    this.render();
    this.bind();
  }

  get project() {
    return this.hooks.getProject();
  }

  get sample() {
    const id = this.hooks.getSelectedSample();
    return this.project.samples.find((s) => s.id === id) || this.project.samples[0] || null;
  }

  // -------------------------------------------------------------- Zeichnen

  render() {
    const project = this.project;
    const sample = this.sample;
    const recording = this.hooks.isRecording();

    const list = project.samples.map((s) => `
      <button class="chip${s.id === sample?.id ? ' on' : ''}" data-act="pick" data-id="${s.id}">
        ${escapeHtml(s.name)} <i>${s.duration.toFixed(1)}s · ${s.slices.length}</i>
      </button>`).join('');

    this.el.innerHTML = `
      <div class="sampler-bar">
        <button class="${recording ? 'rec on' : 'rec'}" data-act="record-mic">
          ${recording ? '■ Aufnahme beenden' : '● Mikrofon'}
        </button>
        <button class="${recording ? 'rec on' : 'rec'}" data-act="record-master">
          ${recording ? '■ Aufnahme beenden' : '● Was du hörst'}
        </button>
        <label class="file ghost">Datei
          <input type="file" data-act="file" accept="audio/*" hidden>
        </label>
        <output class="rec-time" data-role="rec-time"></output>
      </div>

      <div class="sample-list">${list || '<p class="empty">Noch kein Sample – aufnehmen oder Datei laden.</p>'}</div>

      ${sample ? this.editorMarkup(sample) : ''}`;

    this.canvas = this.el.querySelector('.wave');
    this.ctx2d = this.canvas?.getContext('2d') || null;
    this.peakCache = null;
    if (this.canvas) this.draw();
  }

  editorMarkup(sample) {
    const track = this.project.tracks.find((t) => t.sampleId === sample.id);
    return `
      <div class="wave-wrap">
        <canvas class="wave"></canvas>
      </div>

      <div class="chop-bar">
        <span class="chop-label">Zerhacken</span>
        ${[4, 8, 16, 32].map((n) => `<button data-act="chop" data-n="${n}">${n}</button>`).join('')}
        <button data-act="transients">Anschläge finden</button>
        <label class="ctrl small">
          <span>Empfindlichkeit</span>
          <input type="range" min="0" max="100" value="${Math.round((this.sensitivity ?? 0.5) * 100)}"
                 data-act="sensitivity">
        </label>
        <button class="ghost" data-act="rename">Umbenennen</button>
        <button class="ghost danger" data-act="delete">Löschen</button>
      </div>

      <div class="chop-bar">
        <span class="chop-label">Spur</span>
        <select data-act="assign">
          <option value="">– auf welche Spur? –</option>
          ${this.project.tracks.map((t) => `
            <option value="${t.id}"${t.sampleId === sample.id && t.source.type === 'sampler' ? ' selected' : ''}>
              ${escapeHtml(t.name)}
            </option>`).join('')}
          <option value="new">＋ neue Spur</option>
        </select>
        <button data-act="lay-out"${track ? '' : ' disabled'}>Slices aufs Raster</button>
        <button data-act="shuffle"${track ? '' : ' disabled'}>Würfeln</button>
        <span class="hint">${track
          ? `Spur „${escapeHtml(track.name)}“ spielt dieses Sample – im Raster wählt die Stufe den Slice.`
          : 'Noch keiner Spur zugeordnet.'}</span>
      </div>`;
  }

  draw() {
    const sample = this.sample;
    if (!this.canvas || !sample) return;
    const buffer = this.hooks.getBuffer(sample.id);
    const width = this.canvas.clientWidth;
    if (!width) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.style.height !== `${HEIGHT}px`) this.canvas.style.height = `${HEIGHT}px`;
    if (this.canvas.width !== Math.round(width * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(HEIGHT * dpr);
      this.peakCache = null;
    }
    const ctx = this.ctx2d;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);

    if (!buffer) {
      ctx.fillStyle = 'rgba(139,147,168,.6)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Wellenform nicht geladen', 12, HEIGHT / 2);
      return;
    }

    if (!this.peakCache || this.peakCache.id !== sample.id || this.peakCache.width !== width) {
      this.peakCache = { id: sample.id, width, data: peaks(buffer, Math.round(width)) };
    }

    const mid = HEIGHT / 2;
    const toX = (time) => (time / sample.duration) * width;

    // Slices abwechselnd hinterlegen, damit man die Grenzen auch ohne Marke sieht.
    sample.slices.forEach((start, i) => {
      const { end } = sliceBounds(sample, i);
      ctx.fillStyle = i % 2 ? 'rgba(122,162,255,.07)' : 'rgba(110,231,199,.07)';
      ctx.fillRect(toX(start), 0, toX(end) - toX(start), HEIGHT);
    });

    ctx.strokeStyle = 'rgba(232,236,245,.75)';
    ctx.beginPath();
    for (let x = 0; x < this.peakCache.data.length / 2; x++) {
      const min = this.peakCache.data[x * 2];
      const max = this.peakCache.data[x * 2 + 1];
      ctx.moveTo(x + 0.5, mid - max * (mid - 6));
      ctx.lineTo(x + 0.5, mid - min * (mid - 6));
    }
    ctx.stroke();

    sample.slices.forEach((start, i) => {
      const x = Math.round(toX(start)) + 0.5;
      ctx.strokeStyle = '#6ee7c7';
      ctx.lineWidth = i === this.drag?.index ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
      ctx.fillStyle = '#6ee7c7';
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillText(String(i), x + 3, 12);
    });
  }

  // -------------------------------------------------------------- Eingaben

  bind() {
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      const sample = this.sample;

      if (act === 'pick') return this.hooks.onPick(btn.dataset.id);
      if (act === 'record-mic') return this.hooks.onRecord('mic');
      if (act === 'record-master') return this.hooks.onRecord('master');
      if (!sample) return undefined;
      if (act === 'chop') return this.hooks.onChop(sample, Number(btn.dataset.n));
      if (act === 'transients') return this.hooks.onTransients(sample, this.sensitivity ?? 0.5);
      if (act === 'rename') return this.hooks.onRename(sample);
      if (act === 'delete') return this.hooks.onDelete(sample);
      if (act === 'lay-out') return this.hooks.onLayOut(sample);
      if (act === 'shuffle') return this.hooks.onShuffle(sample);
      return undefined;
    });

    this.el.addEventListener('change', (e) => {
      const act = e.target.dataset.act;
      if (act === 'assign') return this.hooks.onAssign(this.sample, e.target.value);
      if (act === 'file' && e.target.files?.[0]) {
        const file = e.target.files[0];
        e.target.value = '';
        return this.hooks.onFile(file);
      }
      return undefined;
    });

    this.el.addEventListener('input', (e) => {
      if (e.target.dataset.act !== 'sensitivity') return;
      this.sensitivity = Number(e.target.value) / 100;
    });

    // Marken ziehen, Slices antippen.
    this.el.addEventListener('pointerdown', (e) => {
      const canvas = e.target.closest('.wave');
      const sample = this.sample;
      if (!canvas || !sample) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const time = ((e.clientX - rect.left) / rect.width) * sample.duration;

      const index = nearestSlice(sample, time, (8 / rect.width) * sample.duration);
      this.drag = { index, time, moved: false, pointerId: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      this.draw();
    });

    this.el.addEventListener('pointermove', (e) => {
      if (!this.drag || this.drag.index < 0) return;
      const sample = this.sample;
      const rect = e.target.getBoundingClientRect();
      const time = ((e.clientX - rect.left) / rect.width) * sample.duration;
      if (Math.abs(time - this.drag.time) < sample.duration * 0.002) return;
      this.drag.moved = true;
      // Marke 0 bleibt am Anfang stehen; der Rest darf wandern.
      if (this.drag.index > 0) {
        sample.slices[this.drag.index] = Math.min(Math.max(time, 0.001), sample.duration - 0.001);
        sample.slices.sort((a, b) => a - b);
        this.drag.index = sample.slices.indexOf(
          Math.min(Math.max(time, 0.001), sample.duration - 0.001));
        this.hooks.onSlicesChanged(sample, { quiet: true });
        this.draw();
      }
    });

    const finish = (e) => {
      if (!this.drag) return;
      const { index, moved, time } = this.drag;
      const sample = this.sample;
      this.drag = null;
      if (moved) {
        this.hooks.onSlicesChanged(sample);
        this.render();
        return;
      }
      if (e.detail >= 2 && index > 0) {        // Doppeltippen entfernt die Marke
        sample.slices.splice(index, 1);
        this.hooks.onSlicesChanged(sample);
        this.render();
        return;
      }
      if (index >= 0) {
        this.hooks.onAudition(sample, index);  // Marke getroffen: Slice hören
      } else {
        const at = sample.slices.findIndex((s, i) => {
          const { end } = sliceBounds(sample, i);
          return time >= s && time < end;
        });
        this.hooks.onAudition(sample, Math.max(0, at));
      }
      this.draw();
    };
    this.el.addEventListener('pointerup', finish);
    this.el.addEventListener('pointercancel', () => { this.drag = null; });

    // Marke setzen, wo man hinzeigt.
    this.el.addEventListener('dblclick', (e) => {
      const canvas = e.target.closest('.wave');
      const sample = this.sample;
      if (!canvas || !sample) return;
      const rect = canvas.getBoundingClientRect();
      const time = ((e.clientX - rect.left) / rect.width) * sample.duration;
      if (nearestSlice(sample, time, (8 / rect.width) * sample.duration) >= 0) return;
      sample.slices.push(time);
      sample.slices.sort((a, b) => a - b);
      this.hooks.onSlicesChanged(sample);
      this.render();
    });
  }

  tick() {
    const field = this.el.querySelector('[data-role="rec-time"]');
    if (!field) return;
    const seconds = this.hooks.recordingSeconds();
    const text = seconds > 0 ? `${seconds.toFixed(1)} s` : '';
    if (field.textContent !== text) field.textContent = text;
  }
}

function nearestSlice(sample, time, tolerance) {
  let best = -1;
  let bestDistance = tolerance;
  sample.slices.forEach((start, i) => {
    const distance = Math.abs(start - time);
    if (distance <= bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
