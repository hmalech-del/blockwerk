// Das Gestenfeld.
//
// Alles andere in Blockwerk ist Programmieren: Schritte setzen, Clips wählen,
// Script schreiben. Das Feld ist das Gegenteil – man fährt mit dem Finger
// darüber und es klingt sofort. Was die Hand tut, wird als Schleife
// mitgeschrieben und läuft weiter, bis man sie wegnimmt.
//
// Eine Geste ist ein Pfad, kein Raster: waagerecht wählt sie Slice oder
// Skalenstufe, senkrecht regelt sie ein frei gewähltes Ziel. Wandert der
// Finger über eine Spaltengrenze, löst er neu aus – deshalb fühlt sich das
// Wischen über einen zerhackten Break an wie Scratchen, nicht wie Tippen.

export const MAX_TAKES = 24;
const MAX_POINTS = 1200;

export function loopSteps(track) {
  const clip = track?.clips?.[track.clip];
  return Math.max(16, (clip?.bars || 1) * 16);
}

// Wie viele Spalten hat das Feld? Beim Sampler die Slices, sonst acht Stufen.
export function columnsFor(track, project) {
  if (track?.source.type === 'sampler') {
    const sample = project.samples.find((s) => s.id === track.sampleId);
    return Math.max(1, Math.min(32, sample?.slices.length || 1));
  }
  return 8;
}

export function degAt(x, columns) {
  return Math.max(0, Math.min(columns - 1, Math.floor(x * columns)));
}

// Aus dem Pfad werden Anschläge: jeder Spaltenwechsel ist ein neuer Ton.
export function pathToEvents(points, columns, { quantize = false } = {}) {
  const events = [];
  if (!points.length) return events;
  const snap = (t) => (quantize ? Math.round(t) : t);

  let current = null;
  for (const point of points) {
    const deg = degAt(point.x, columns);
    if (!current || current.deg !== deg) {
      if (current) current.dur = Math.max(0.05, snap(point.t) - current.t);
      current = { t: snap(point.t), deg, dur: 0.25, y: point.y };
      events.push(current);
    }
  }
  const last = points[points.length - 1];
  if (current) current.dur = Math.max(0.05, snap(last.t) - current.t || 0.25);
  return events;
}

export function makeTake(points, columns, options) {
  const trimmed = points.length > MAX_POINTS
    ? points.filter((_, i) => i % Math.ceil(points.length / MAX_POINTS) === 0)
    : points;
  return {
    id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    points: trimmed.map((p) => ({ t: p.t, x: p.x, y: p.y })),
    events: pathToEvents(trimmed, columns, options),
  };
}

// Welche Anschläge fallen in diesen Schritt? Der Transport fragt das je Schritt
// und bekommt den Bruchteil mit, damit die Zeitstempel genau bleiben.
export function eventsAtStep(track, step) {
  const takes = track.gesture?.takes;
  if (!takes?.length) return [];
  const loop = loopSteps(track);
  const position = ((step % loop) + loop) % loop;
  const out = [];
  for (const take of takes) {
    for (const event of take.events) {
      if (event.t >= position && event.t < position + 1) out.push(event);
    }
  }
  return out;
}

// Der senkrechte Wert an dieser Stelle – zuletzt aufgenommene Geste gewinnt.
export function valueAtStep(track, step) {
  const takes = track.gesture?.takes;
  if (!takes?.length) return null;
  const loop = loopSteps(track);
  const position = ((step % loop) + loop) % loop;

  for (let i = takes.length - 1; i >= 0; i--) {
    const points = takes[i].points;
    if (!points.length) continue;
    if (position < points[0].t || position > points[points.length - 1].t) continue;
    for (let k = 1; k < points.length; k++) {
      if (points[k].t < position) continue;
      const a = points[k - 1];
      const b = points[k];
      const span = b.t - a.t || 1;
      const mix = (position - a.t) / span;
      return a.y + (b.y - a.y) * mix;
    }
  }
  return null;
}

// ------------------------------------------------------------- Oberfläche

export class GestureField {
  constructor(hooks) {
    this.hooks = hooks;
    this.pointers = new Map();   // pointerId -> { points, lastDeg }
    this.recording = true;
  }

  // Die Live-Ansicht baut ihren Inhalt neu auf; das Feld haengt sich dann in
  // den frischen Platzhalter. Zuhoerer sterben mit dem alten Element.
  mount(host) {
    this.el = host;
    this.render();
    this.bind();
  }

  get project() { return this.hooks.getProject(); }

  get track() {
    const id = this.hooks.getSelected();
    return this.project.tracks.find((t) => t.id === id) || this.project.tracks[0] || null;
  }

  render() {
    const track = this.track;
    const takes = track?.gesture?.takes.length || 0;

    const chips = this.project.tracks.map((t) => `
      <button class="field-track${t.id === track?.id ? ' on' : ''}" data-act="track" data-id="${t.id}"
              style="--track:${t.color}"><span class="dot"></span>${escapeHtml(t.name)}</button>`).join('');

    this.el.innerHTML = `
      <div class="field-bar">
        <div class="field-tracks">${chips}</div>
        <button class="${this.recording ? 'rec on' : 'rec'}" data-act="arm">
          ${this.recording ? '● schreibt mit' : '○ nur spielen'}
        </button>
        <button class="ghost" data-act="undo"${takes ? '' : ' disabled'}>Letzte weg</button>
        <button class="ghost" data-act="clear"${takes ? '' : ' disabled'}>Alles weg</button>
        <label class="switch small">
          <input type="checkbox" data-act="quantize" ${track?.gesture?.quantize ? 'checked' : ''}>
          <span>im Takt</span>
        </label>
        <label class="ctrl small">
          <span>↕</span>
          <select data-act="target">
            <option value="">– ohne –</option>
            ${this.hooks.targets().map(({ group, items }) => `
              <optgroup label="${escapeHtml(group)}">
                ${items.map((it) => `<option value="${it.path}"${it.path === track?.gesture?.target ? ' selected' : ''}>${escapeHtml(it.label)}</option>`).join('')}
              </optgroup>`).join('')}
          </select>
        </label>
        <output class="field-count">${takes} Geste${takes === 1 ? '' : 'n'}</output>
      </div>
      <canvas class="field"></canvas>
      <p class="hint">Ziehen klingt sofort. Über eine Spaltengrenze gewischt, löst neu aus –
         beim Sampler ist jede Spalte ein Slice.</p>`;

    this.canvas = this.el.querySelector('.field');
    this.ctx2d = this.canvas.getContext('2d');
  }

  bind() {
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      if (act === 'track') return this.hooks.onSelect(btn.dataset.id);
      if (act === 'arm') { this.recording = !this.recording; return this.render(); }
      if (act === 'undo') return this.hooks.onUndo(this.track);
      if (act === 'clear') return this.hooks.onClear(this.track);
      return undefined;
    });

    this.el.addEventListener('change', (e) => {
      const act = e.target.dataset.act;
      if (act === 'target') return this.hooks.onTarget(this.track, e.target.value);
      if (act === 'quantize') return this.hooks.onQuantize(this.track, e.target.checked);
      return undefined;
    });

    this.el.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.field')) return;
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      const track = this.track;
      const columns = columnsFor(track, this.project);
      const at = this.readPointer(e);
      const deg = degAt(at.x, columns);
      this.pointers.set(e.pointerId, { points: [at], lastDeg: deg });
      this.hooks.onTrigger(track, deg, at.y);
    });

    this.el.addEventListener('pointermove', (e) => {
      const stroke = this.pointers.get(e.pointerId);
      if (!stroke) return;
      const track = this.track;
      const columns = columnsFor(track, this.project);
      const at = this.readPointer(e);
      stroke.points.push(at);
      const deg = degAt(at.x, columns);
      // Spaltenwechsel heisst neuer Anschlag – das ist das Scratch-Gefuehl.
      if (deg !== stroke.lastDeg) {
        stroke.lastDeg = deg;
        this.hooks.onTrigger(track, deg, at.y);
      } else {
        this.hooks.onMove(track, at.y);
      }
    });

    const end = (e) => {
      const stroke = this.pointers.get(e.pointerId);
      if (!stroke) return;
      this.pointers.delete(e.pointerId);
      this.hooks.onRelease(this.track, stroke.points, this.recording,
        columnsFor(this.track, this.project));
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  readPointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(0.999, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)),
      t: this.hooks.loopPosition(this.track),
    };
  }

  // -------------------------------------------------------------- Zeichnen

  tick() {
    const canvas = this.canvas;
    const track = this.track;
    if (!canvas || !canvas.clientWidth || !track) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight || 260;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
    if (canvas.width !== Math.round(width * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = this.ctx2d;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const columns = columnsFor(track, this.project);
    const loop = loopSteps(track);
    const position = this.hooks.loopPosition(track);
    const colWidth = width / columns;

    for (let c = 0; c < columns; c++) {
      ctx.fillStyle = c % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.015)';
      ctx.fillRect(c * colWidth, 0, colWidth, height);
      if (colWidth > 22) {
        ctx.fillStyle = 'rgba(139,147,168,.55)';
        ctx.font = '10px ui-monospace, Menlo, monospace';
        ctx.fillText(String(c), c * colWidth + 4, height - 6);
      }
    }

    // Aufgenommene Gesten als Spuren – man sieht, was die Hand getan hat.
    const takes = track.gesture?.takes || [];
    takes.forEach((take, i) => {
      if (take.points.length < 2) return;
      ctx.strokeStyle = i === takes.length - 1 ? 'rgba(110,231,199,.75)' : 'rgba(122,162,255,.4)';
      ctx.lineWidth = i === takes.length - 1 ? 2 : 1.5;
      ctx.beginPath();
      take.points.forEach((p, k) => {
        const x = p.x * width;
        const y = (1 - p.y) * height;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    // Wo im Loop stehen wir? Ein Punkt auf jeder gerade klingenden Geste.
    for (const take of takes) {
      const point = pointAt(take.points, position);
      if (!point) continue;
      ctx.fillStyle = 'rgba(110,231,199,.9)';
      ctx.beginPath();
      ctx.arc(point.x * width, (1 - point.y) * height, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const stroke of this.pointers.values()) {
      const last = stroke.points[stroke.points.length - 1];
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(last.x * width, (1 - last.y) * height, 11, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fortschritt der Schleife als schmaler Balken oben.
    ctx.fillStyle = 'rgba(110,231,199,.5)';
    ctx.fillRect(0, 0, (position / loop) * width, 3);
  }
}

function pointAt(points, position) {
  if (points.length < 2) return null;
  if (position < points[0].t || position > points[points.length - 1].t) return null;
  for (let k = 1; k < points.length; k++) {
    if (points[k].t < position) continue;
    const a = points[k - 1];
    const b = points[k];
    const mix = (position - a.t) / (b.t - a.t || 1);
    return { x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix };
  }
  return null;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
