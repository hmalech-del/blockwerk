// Modul-Registry: jedes Modul beschreibt sich selbst (Name, Parameter) und
// weiss, wie es sich im AudioContext aufbaut.
//
// Quellen (kind: 'source')  -> spawn(ctx, params, freq, time) => Voice
// Effekte (kind: 'fx')      -> create(ctx) => Instance { input, output, set, dispose }
//
// Parameter-Spezifikation:
//   { id, label, type: 'range'|'select', min, max, def, unit, scale: 'log', options: [] }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- Hüllkurve

function envelope(ctx, p, t) {
  const g = ctx.createGain();
  const a = Math.max(0.002, p.attack);
  const d = Math.max(0.005, p.decay);
  const s = clamp(p.sustain, 0, 1);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(1, t + a);
  g.gain.setTargetAtTime(s, t + a, d / 3);
  return g;
}

function releaseEnvelope(ctx, g, p, t) {
  const r = Math.max(0.02, p.release);
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
  g.gain.setTargetAtTime(0.0001, t, r / 3);
  return t + r + 0.15;
}

const ENV_PARAMS = [
  { id: 'attack', label: 'Attack', min: 0.002, max: 2, def: 0.01, unit: 's', scale: 'log' },
  { id: 'decay', label: 'Decay', min: 0.01, max: 3, def: 0.25, unit: 's', scale: 'log' },
  { id: 'sustain', label: 'Sustain', min: 0, max: 1, def: 0.6 },
  { id: 'release', label: 'Release', min: 0.02, max: 4, def: 0.4, unit: 's', scale: 'log' },
];

// Weisses Rauschen einmal pro AudioContext erzeugen und wiederverwenden.
function noiseBuffer(ctx) {
  if (!ctx._noiseBuffer) {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    ctx._noiseBuffer = buf;
  }
  return ctx._noiseBuffer;
}

// ------------------------------------------------------------------ Quellen

const oscillator = {
  id: 'osc',
  kind: 'source',
  name: 'Oszillator',
  hint: 'Klassische Wellenform mit Unison-Verstimmung und Sub-Oktave.',
  params: [
    {
      id: 'wave', label: 'Welle', type: 'select', def: 'sawtooth',
      options: [
        { value: 'sawtooth', label: 'Säge' },
        { value: 'square', label: 'Rechteck' },
        { value: 'triangle', label: 'Dreieck' },
        { value: 'sine', label: 'Sinus' },
      ],
    },
    { id: 'detune', label: 'Unison', min: 0, max: 40, def: 8, unit: 'ct' },
    { id: 'sub', label: 'Sub', min: 0, max: 1, def: 0.3 },
    ...ENV_PARAMS,
  ],
  spawn(ctx, p, freq, t) {
    const env = envelope(ctx, p, t);
    const out = ctx.createGain();
    const spread = p.detune > 0.5 ? [0, -p.detune, p.detune] : [0];
    out.gain.value = 0.3 / spread.length;
    env.connect(out);

    const nodes = spread.map((cents) => {
      const o = ctx.createOscillator();
      o.type = p.wave;
      o.frequency.setValueAtTime(freq, t);
      o.detune.setValueAtTime(cents, t);
      o.connect(env);
      o.start(t);
      return o;
    });

    if (p.sub > 0.01) {
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(freq / 2, t);
      subGain.gain.value = p.sub;
      sub.connect(subGain).connect(env);
      sub.start(t);
      nodes.push(sub);
    }

    return voiceHandle(ctx, p, env, out, nodes);
  },
};

const noise = {
  id: 'noise',
  kind: 'source',
  name: 'Rauschen',
  hint: 'Gefiltertes Rauschen – Basis für Wind, Hats und Snares.',
  params: [
    {
      id: 'type', label: 'Filter', type: 'select', def: 'bandpass',
      options: [
        { value: 'bandpass', label: 'Band' },
        { value: 'lowpass', label: 'Tief' },
        { value: 'highpass', label: 'Hoch' },
      ],
    },
    { id: 'tone', label: 'Farbe', min: 80, max: 12000, def: 1800, unit: 'Hz', scale: 'log' },
    { id: 'q', label: 'Resonanz', min: 0.3, max: 20, def: 2, scale: 'log' },
    { id: 'track', label: 'Tonhöhe folgt', min: 0, max: 1, def: 0.5 },
    ...ENV_PARAMS,
  ],
  spawn(ctx, p, freq, t) {
    const env = envelope(ctx, p, t);
    const out = ctx.createGain();
    out.gain.value = 0.4;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = p.type;
    // "Tonhöhe folgt" blendet zwischen fester Farbe und Notenfrequenz.
    const target = p.tone * Math.pow(freq / 220, p.track);
    filter.frequency.setValueAtTime(clamp(target, 30, ctx.sampleRate / 2 - 1000), t);
    filter.Q.setValueAtTime(p.q, t);

    src.connect(filter).connect(env).connect(out);
    src.start(t);

    return voiceHandle(ctx, p, env, out, [src]);
  },
};

const fmVoice = {
  id: 'fm',
  kind: 'source',
  name: 'FM',
  hint: 'Zwei-Operator-FM: metallisch, glockig, bassig.',
  params: [
    { id: 'ratio', label: 'Ratio', min: 0.25, max: 12, def: 2, scale: 'log' },
    { id: 'index', label: 'Index', min: 0, max: 12, def: 3 },
    { id: 'fall', label: 'FM-Abfall', min: 0.02, max: 3, def: 0.5, unit: 's', scale: 'log' },
    ...ENV_PARAMS,
  ],
  spawn(ctx, p, freq, t) {
    const env = envelope(ctx, p, t);
    const out = ctx.createGain();
    out.gain.value = 0.3;
    env.connect(out);

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(freq, t);

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.setValueAtTime(freq * p.ratio, t);

    const modDepth = ctx.createGain();
    const peak = freq * p.index;
    modDepth.gain.setValueAtTime(peak, t);
    modDepth.gain.setTargetAtTime(peak * 0.15, t, Math.max(0.02, p.fall) / 3);

    mod.connect(modDepth).connect(carrier.frequency);
    carrier.connect(env);
    mod.start(t);
    carrier.start(t);

    return voiceHandle(ctx, p, env, out, [carrier, mod]);
  },
};

const percussion = {
  id: 'perc',
  kind: 'source',
  name: 'Perc',
  hint: 'Schlagzeugstimme: fallende Tonhöhe, Klick und Körper.',
  params: [
    {
      id: 'wave', label: 'Körper', type: 'select', def: 'sine',
      options: [
        { value: 'sine', label: 'Sinus' },
        { value: 'triangle', label: 'Dreieck' },
        { value: 'square', label: 'Rechteck' },
      ],
    },
    { id: 'drop', label: 'Tonhöhenfall', min: 0, max: 48, def: 24, unit: 'ct' },
    { id: 'dropTime', label: 'Fallzeit', min: 0.005, max: 0.5, def: 0.05, unit: 's', scale: 'log' },
    { id: 'body', label: 'Ausklang', min: 0.03, max: 2, def: 0.35, unit: 's', scale: 'log' },
    { id: 'click', label: 'Klick', min: 0, max: 1, def: 0.3 },
    { id: 'noise', label: 'Rauschanteil', min: 0, max: 1, def: 0 },
  ],
  spawn(ctx, p, freq, t) {
    const out = ctx.createGain();
    out.gain.value = 0.6;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(1, t + 0.002);
    env.gain.setTargetAtTime(0.0001, t + 0.002, Math.max(0.01, p.body) / 4);
    env.connect(out);

    const osc = ctx.createOscillator();
    osc.type = p.wave;
    const start = clamp(freq * Math.pow(2, p.drop / 12), 20, ctx.sampleRate / 2 - 100);
    osc.frequency.setValueAtTime(start, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq), t + Math.max(0.005, p.dropTime));
    osc.connect(env);
    osc.start(t);
    const nodes = [osc];

    if (p.click > 0.01 || p.noise > 0.01) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = p.noise > 0.01 ? 400 : 2000;
      const ng = ctx.createGain();
      // Der Klick ist ein sehr kurzer Rauschimpuls, der Rauschanteil folgt der Hüllkurve.
      const peak = Math.max(p.click, p.noise);
      ng.gain.setValueAtTime(peak, t);
      ng.gain.setTargetAtTime(0.0001, t, p.noise > 0.01 ? Math.max(0.01, p.body) / 4 : 0.004);
      src.connect(hp).connect(ng).connect(out);
      src.start(t);
      nodes.push(src);
    }

    let stopped = false;
    return {
      out,
      // Perc klingt von selbst aus; noteOff kürzt nur noch sanft ab.
      release(time) {
        if (stopped) return time;
        const end = time + Math.max(0.05, p.body) + 0.1;
        nodes.forEach((n) => { try { n.stop(end); } catch (e) { /* egal */ } });
        stopped = true;
        return end;
      },
      kill(time) {
        nodes.forEach((n) => { try { n.stop(time); } catch (e) { /* egal */ } });
        try { out.disconnect(); } catch (e) { /* egal */ }
        stopped = true;
      },
    };
  },
};

// Gemeinsames Stimmen-Interface für alle Quellen.
function voiceHandle(ctx, p, env, out, nodes) {
  let stopped = false;
  return {
    out,
    release(t) {
      if (stopped) return t;
      const end = releaseEnvelope(ctx, env, p, t);
      nodes.forEach((n) => {
        try { n.stop(end); } catch (e) { /* bereits gestoppt */ }
      });
      stopped = true;
      return end;
    },
    kill(t) {
      nodes.forEach((n) => {
        try { n.stop(t); } catch (e) { /* bereits gestoppt */ }
      });
      try { out.disconnect(); } catch (e) { /* schon getrennt */ }
      stopped = true;
    },
  };
}

// ------------------------------------------------------------------ Effekte

function wetDry(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  wet.connect(output);
  return { input, output, dry, wet };
}

function mixParam(dry, wet) {
  return (v) => { wet.gain.value = v; dry.gain.value = 1 - v; };
}

const filterFx = {
  id: 'filter',
  kind: 'fx',
  name: 'Filter',
  hint: 'Biquad-Filter mit Resonanz.',
  params: [
    {
      id: 'type', label: 'Typ', type: 'select', def: 'lowpass',
      options: [
        { value: 'lowpass', label: 'Tiefpass' },
        { value: 'highpass', label: 'Hochpass' },
        { value: 'bandpass', label: 'Bandpass' },
        { value: 'notch', label: 'Notch' },
      ],
    },
    { id: 'freq', label: 'Cutoff', min: 40, max: 16000, def: 2400, unit: 'Hz', scale: 'log' },
    { id: 'q', label: 'Resonanz', min: 0.3, max: 24, def: 1.2, scale: 'log' },
  ],
  create(ctx) {
    const node = ctx.createBiquadFilter();
    return {
      input: node,
      output: node,
      set(id, v) {
        if (id === 'type') node.type = v;
        if (id === 'freq') node.frequency.setTargetAtTime(v, ctx.currentTime, 0.01);
        if (id === 'q') node.Q.setTargetAtTime(v, ctx.currentTime, 0.01);
      },
    };
  },
};

const driveFx = {
  id: 'drive',
  kind: 'fx',
  name: 'Drive',
  hint: 'Weiche Sättigung bis harte Verzerrung.',
  params: [
    { id: 'drive', label: 'Drive', min: 0, max: 1, def: 0.35 },
    { id: 'level', label: 'Pegel', min: 0, max: 1.5, def: 0.8 },
    { id: 'mix', label: 'Mix', min: 0, max: 1, def: 1 },
  ],
  create(ctx) {
    const { input, output, dry, wet } = wetDry(ctx);
    const shaper = ctx.createWaveShaper();
    const level = ctx.createGain();
    shaper.oversample = '2x';
    input.connect(shaper).connect(level).connect(wet);

    const curve = (amount) => {
      const k = amount * 120;
      const n = 1024;
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
      }
      return c;
    };
    shaper.curve = curve(0.35);

    const setMix = mixParam(dry, wet);
    return {
      input,
      output,
      set(id, v) {
        if (id === 'drive') shaper.curve = curve(v);
        if (id === 'level') level.gain.value = v;
        if (id === 'mix') setMix(v);
      },
    };
  },
};

const crusherFx = {
  id: 'crusher',
  kind: 'fx',
  name: 'Crusher',
  hint: 'Reduziert die Bit-Auflösung – Lo-Fi und Digitalschmutz.',
  params: [
    { id: 'bits', label: 'Bits', min: 1, max: 12, def: 5, step: 0.1 },
    { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.7 },
  ],
  create(ctx) {
    const { input, output, dry, wet } = wetDry(ctx);
    const shaper = ctx.createWaveShaper();
    input.connect(shaper).connect(wet);

    const curve = (bits) => {
      const levels = Math.pow(2, bits);
      const n = 2048;
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = Math.round(x * levels) / levels;
      }
      return c;
    };
    shaper.curve = curve(5);

    const setMix = mixParam(dry, wet);
    return {
      input,
      output,
      set(id, v) {
        if (id === 'bits') shaper.curve = curve(v);
        if (id === 'mix') setMix(v);
      },
    };
  },
};

const chorusFx = {
  id: 'chorus',
  kind: 'fx',
  name: 'Chorus',
  hint: 'Modulierte Verzögerung – Breite und Schwebung.',
  params: [
    { id: 'rate', label: 'Tempo', min: 0.05, max: 8, def: 0.8, unit: 'Hz', scale: 'log' },
    { id: 'depth', label: 'Tiefe', min: 0, max: 0.012, def: 0.004, unit: 's' },
    { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.5 },
  ],
  create(ctx) {
    const { input, output, dry, wet } = wetDry(ctx);
    const delay = ctx.createDelay(0.1);
    delay.delayTime.value = 0.022;

    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 0.8;
    depth.gain.value = 0.004;
    lfo.connect(depth).connect(delay.delayTime);
    lfo.start();

    input.connect(delay).connect(wet);

    const setMix = mixParam(dry, wet);
    return {
      input,
      output,
      set(id, v) {
        if (id === 'rate') lfo.frequency.setTargetAtTime(v, ctx.currentTime, 0.05);
        if (id === 'depth') depth.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
        if (id === 'mix') setMix(v);
      },
      dispose() { try { lfo.stop(); } catch (e) { /* egal */ } },
    };
  },
};

const tremoloFx = {
  id: 'tremolo',
  kind: 'fx',
  name: 'Tremolo',
  hint: 'Rhythmische Lautstärkemodulation.',
  params: [
    { id: 'rate', label: 'Tempo', min: 0.1, max: 20, def: 5, unit: 'Hz', scale: 'log' },
    { id: 'depth', label: 'Tiefe', min: 0, max: 1, def: 0.6 },
    {
      id: 'shape', label: 'Form', type: 'select', def: 'sine',
      options: [
        { value: 'sine', label: 'Sinus' },
        { value: 'triangle', label: 'Dreieck' },
        { value: 'square', label: 'Rechteck' },
      ],
    },
  ],
  create(ctx) {
    const input = ctx.createGain();
    const amp = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    let d = 0.6;

    lfo.type = 'sine';
    lfo.frequency.value = 5;
    depth.gain.value = d / 2;
    amp.gain.value = 1 - d / 2;
    lfo.connect(depth).connect(amp.gain);
    lfo.start();
    input.connect(amp);

    return {
      input,
      output: amp,
      set(id, v) {
        if (id === 'rate') lfo.frequency.setTargetAtTime(v, ctx.currentTime, 0.05);
        if (id === 'shape') lfo.type = v;
        if (id === 'depth') {
          d = v;
          depth.gain.setTargetAtTime(d / 2, ctx.currentTime, 0.05);
          amp.gain.setTargetAtTime(1 - d / 2, ctx.currentTime, 0.05);
        }
      },
      dispose() { try { lfo.stop(); } catch (e) { /* egal */ } },
    };
  },
};

const delayFx = {
  id: 'delay',
  kind: 'fx',
  name: 'Delay',
  hint: 'Echo mit gedämpfter Rückkopplung.',
  params: [
    { id: 'time', label: 'Zeit', min: 0.02, max: 1.5, def: 0.3, unit: 's', scale: 'log' },
    { id: 'feedback', label: 'Feedback', min: 0, max: 0.9, def: 0.35 },
    { id: 'tone', label: 'Dämpfung', min: 300, max: 12000, def: 3500, unit: 'Hz', scale: 'log' },
    { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.35 },
  ],
  create(ctx) {
    const { input, output, dry, wet } = wetDry(ctx);
    const delay = ctx.createDelay(2);
    const feedback = ctx.createGain();
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 3500;
    feedback.gain.value = 0.35;
    delay.delayTime.value = 0.3;

    input.connect(delay);
    delay.connect(damp).connect(feedback).connect(delay);
    delay.connect(wet);

    const setMix = mixParam(dry, wet);
    return {
      input,
      output,
      set(id, v) {
        if (id === 'time') delay.delayTime.setTargetAtTime(v, ctx.currentTime, 0.05);
        if (id === 'feedback') feedback.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
        if (id === 'tone') damp.frequency.setTargetAtTime(v, ctx.currentTime, 0.02);
        if (id === 'mix') setMix(v);
      },
    };
  },
};

const reverbFx = {
  id: 'reverb',
  kind: 'fx',
  name: 'Hall',
  hint: 'Faltungshall mit erzeugter Impulsantwort.',
  params: [
    { id: 'size', label: 'Größe', min: 0.2, max: 5, def: 1.8, unit: 's', scale: 'log' },
    { id: 'decay', label: 'Abfall', min: 0.5, max: 8, def: 2.5 },
    { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.3 },
  ],
  create(ctx) {
    const { input, output, dry, wet } = wetDry(ctx);
    const convolver = ctx.createConvolver();
    input.connect(convolver).connect(wet);

    const state = { size: 1.8, decay: 2.5 };
    let timer = null;

    const makeIR = () => {
      const len = Math.max(128, Math.floor(ctx.sampleRate * state.size));
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, state.decay);
        }
      }
      convolver.buffer = buf;
    };
    makeIR();

    // Impulsantworten sind teuer – beim Schieben nur gebündelt neu berechnen.
    const scheduleIR = () => {
      clearTimeout(timer);
      timer = setTimeout(makeIR, 120);
    };

    const setMix = mixParam(dry, wet);
    return {
      input,
      output,
      set(id, v) {
        if (id === 'size') { state.size = v; scheduleIR(); }
        if (id === 'decay') { state.decay = v; scheduleIR(); }
        if (id === 'mix') setMix(v);
      },
      dispose() { clearTimeout(timer); },
    };
  },
};

export const MODULES = {
  osc: oscillator,
  noise,
  fm: fmVoice,
  perc: percussion,
  filter: filterFx,
  drive: driveFx,
  crusher: crusherFx,
  chorus: chorusFx,
  tremolo: tremoloFx,
  delay: delayFx,
  reverb: reverbFx,
};

export const SOURCES = Object.values(MODULES).filter((m) => m.kind === 'source');
export const EFFECTS = Object.values(MODULES).filter((m) => m.kind === 'fx');

export function defaultParams(type) {
  const out = {};
  for (const spec of MODULES[type].params) out[spec.id] = spec.def;
  return out;
}
