// Samples: aufnehmen, zerlegen, zeichnen, aufbewahren.
//
// Die Audiodaten liegen bewusst NICHT im Projekt-JSON – dafür sind sie zu groß.
// Das Projekt merkt sich nur Name, Dauer und Schnittmarken; die Wellenform
// selbst liegt in IndexedDB und zur Laufzeit als AudioBuffer im Speicher.

const DB_NAME = 'blockwerk';
const STORE = 'samples';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------- Speicher

export class SampleStore {
  constructor() {
    this.buffers = new Map();   // sampleId -> AudioBuffer
    this.reversed = new Map();  // sampleId -> rückwärts gedrehte Kopie
    this.ctx = null;
  }

  attach(ctx) {
    this.ctx = ctx;
  }

  get(id) {
    return this.buffers.get(id) || null;
  }

  getReversed(id) {
    if (this.reversed.has(id)) return this.reversed.get(id);
    const buffer = this.buffers.get(id);
    if (!buffer || !this.ctx) return null;
    const copy = this.ctx.createBuffer(1, buffer.length, buffer.sampleRate);
    const from = buffer.getChannelData(0);
    const to = copy.getChannelData(0);
    for (let i = 0; i < from.length; i++) to[i] = from[from.length - 1 - i];
    this.reversed.set(id, copy);
    return copy;
  }

  // Mono reicht fürs Zerhacken und halbiert Speicher wie Ladezeit.
  put(id, channelData, sampleRate) {
    if (!this.ctx) return null;
    const buffer = this.ctx.createBuffer(1, channelData.length, sampleRate);
    buffer.copyToChannel(channelData, 0);
    this.buffers.set(id, buffer);
    this.reversed.delete(id);
    return buffer;
  }

  async persist(id, channelData, sampleRate) {
    try {
      const db = await openDb();
      await transact(db, 'readwrite', (store) =>
        store.put({ data: channelData, sampleRate }, id));
      db.close();
      return true;
    } catch (e) {
      console.warn('Sample konnte nicht gespeichert werden:', e);
      return false;
    }
  }

  async restore(ids) {
    if (!this.ctx || !ids.length) return 0;
    let count = 0;
    try {
      const db = await openDb();
      for (const id of ids) {
        const entry = await transact(db, 'readonly', (store) => store.get(id));
        if (!entry?.data) continue;
        this.put(id, entry.data instanceof Float32Array ? entry.data : new Float32Array(entry.data), entry.sampleRate);
        count += 1;
      }
      db.close();
    } catch (e) {
      console.warn('Samples konnten nicht geladen werden:', e);
    }
    return count;
  }

  async forget(id) {
    this.buffers.delete(id);
    this.reversed.delete(id);
    try {
      const db = await openDb();
      await transact(db, 'readwrite', (store) => store.delete(id));
      db.close();
    } catch (e) { /* dann bleibt es eben liegen */ }
  }

  // Datei oder Aufnahme in Mono wandeln.
  async decode(arrayBuffer) {
    const buffer = await this.ctx.decodeAudioData(arrayBuffer);
    const length = buffer.length;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    return { data: mono, sampleRate: buffer.sampleRate };
  }
}

// --------------------------------------------------------------- Aufnahme

// Nimmt rohes PCM auf statt eines komprimierten Streams: kein Codec, der auf
// einer Plattform fehlt, und das Ergebnis ist sofort schnittfähig.
export class Recorder {
  constructor(ctx) {
    this.ctx = ctx;
    this.chunks = [];
    this.node = null;
    this.source = null;
    this.stream = null;
    this.recording = false;
  }

  get seconds() {
    return this.chunks.reduce((n, c) => n + c.length, 0) / this.ctx.sampleRate;
  }

  startFrom(node) {
    if (this.recording) return;
    this.chunks = [];
    this.recording = true;

    const processor = this.ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!this.recording) return;
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    // Ohne Verbindung zum Ausgang läuft der Prozessor in manchen Browsern
    // nicht – mit Pegel 0 hört man davon nichts.
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    node.connect(processor);
    processor.connect(silent).connect(this.ctx.destination);

    this.node = processor;
    this.silent = silent;
    this.source = node;
  }

  async startFromMicrophone() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.startFrom(this.ctx.createMediaStreamSource(this.stream));
  }

  stop() {
    if (!this.recording) return null;
    this.recording = false;
    try { this.source.disconnect(this.node); } catch (e) { /* egal */ }
    try { this.node.disconnect(); } catch (e) { /* egal */ }
    try { this.silent.disconnect(); } catch (e) { /* egal */ }
    this.node.onaudioprocess = null;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    const length = this.chunks.reduce((n, c) => n + c.length, 0);
    const data = new Float32Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    return { data, sampleRate: this.ctx.sampleRate };
  }
}

// --------------------------------------------------------------- Zerlegen

export function equalSlices(duration, count) {
  const step = duration / Math.max(1, count);
  return Array.from({ length: count }, (_, i) => i * step);
}

// Anschläge finden: Energie in kurzen Fenstern, und wo sie deutlich über dem
// gleitenden Mittel springt, sitzt ein Schlag.
export function detectTransients(buffer, { sensitivity = 0.5, minGap = 0.045 } = {}) {
  const data = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const hop = Math.max(64, Math.round(rate * 0.005));
  const frames = Math.floor(data.length / hop);
  if (frames < 4) return [0];

  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const from = f * hop;
    for (let i = from; i < from + hop; i++) sum += data[i] * data[i];
    energy[f] = Math.sqrt(sum / hop);
  }

  const window = Math.max(4, Math.round(0.08 * rate / hop));
  const threshold = 1 + (1 - sensitivity) * 2.5; // 1.0 (alles) bis 3.5 (nur Spitzen)
  const minFrames = Math.round(minGap * rate / hop);
  const peak = Math.max(...energy);
  const floor = peak * 0.04;

  const times = [0];
  let last = -minFrames;
  for (let f = 1; f < frames - 1; f++) {
    if (f - last < minFrames) continue;
    if (energy[f] < floor) continue;
    let mean = 0;
    let n = 0;
    for (let k = Math.max(0, f - window); k < f; k++) { mean += energy[k]; n += 1; }
    mean = n ? mean / n : 0;
    if (energy[f] > Math.max(mean * threshold, floor) && energy[f] >= energy[f - 1] && energy[f] >= energy[f + 1]) {
      times.push((f * hop) / rate);
      last = f;
    }
  }
  return times;
}

// Spitzenwerte je Bildspalte – alles andere wäre bei Millionen Samples
// unnötige Arbeit für jedes Neuzeichnen.
export function peaks(buffer, columns) {
  const data = buffer.getChannelData(0);
  const per = data.length / columns;
  const out = new Float32Array(columns * 2);
  for (let c = 0; c < columns; c++) {
    const from = Math.floor(c * per);
    const to = Math.min(data.length, Math.floor((c + 1) * per));
    let min = 0;
    let max = 0;
    for (let i = from; i < to; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[c * 2] = min;
    out[c * 2 + 1] = max;
  }
  return out;
}

// Grenzen eines Slices in Sekunden.
export function sliceBounds(sample, index) {
  const starts = sample.slices;
  if (!starts.length) return { start: 0, end: sample.duration };
  const i = ((index % starts.length) + starts.length) % starts.length;
  return { start: starts[i], end: i + 1 < starts.length ? starts[i + 1] : sample.duration };
}
