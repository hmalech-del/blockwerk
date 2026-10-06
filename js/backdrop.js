// Der Hintergrund atmet mit.
//
// Kein Dekor-Bild, sondern eine Leinwand hinter der Oberfläche, die aus dem
// Master-Analyser zeichnet: eine Neonwelle, ein Spektrumband und ein
// Gitterhorizont. Läuft nichts, bewegt sie sich langsam weiter – ein
// Instrument soll auch im Leerlauf lebendig aussehen.
//
// Gezeichnet wird mit halber Auflösung und hochskaliert: billiger und der
// weiche Rand ist genau der Glow, den man will.

const SCALE = 0.5;

export class Backdrop {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.engine = engine;
    this.ctx = canvas.getContext('2d');
    this.phase = 0;
    this.wave = null;
    this.spectrum = null;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  resize() {
    const width = Math.round(window.innerWidth * SCALE);
    const height = Math.round(window.innerHeight * SCALE);
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.fillStyle = '#070b1e';
    this.ctx.fillRect(0, 0, width, height);
  }

  draw() {
    this.resize();
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    this.phase += this.reduced ? 0 : 0.011;

    // Nachleuchten statt harter Löschung – das ergibt die Schleier.
    ctx.fillStyle = 'rgba(7, 11, 30, .34)';
    ctx.fillRect(0, 0, w, h);

    this.grid(ctx, w, h);
    this.waveLine(ctx, w, h);
    this.spectrumBand(ctx, w, h);
  }

  // Fluchtlinien zum Horizont – das Bild, das jede Synthwave-Platte hat.
  grid(ctx, w, h) {
    const horizon = h * 0.62;
    ctx.save();
    ctx.strokeStyle = 'rgba(45, 226, 255, .10)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let i = -14; i <= 14; i++) {
      const x = w / 2 + i * (w / 12);
      ctx.moveTo(w / 2 + i * 6, horizon);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    // Querlinien laufen auf den Horizont zu und scrollen langsam.
    ctx.strokeStyle = 'rgba(255, 43, 209, .09)';
    ctx.beginPath();
    for (let i = 0; i < 14; i++) {
      const t = ((i + (this.phase * 0.35) % 1) / 14) ** 2.2;
      const y = horizon + t * (h - horizon);
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Die Wellenform des Masters, zweifarbig gespiegelt.
  waveLine(ctx, w, h) {
    const analyser = this.engine.analyser;
    const mid = h * 0.38;
    let data = null;

    if (analyser && this.engine.running) {
      if (!this.wave || this.wave.length !== analyser.fftSize) this.wave = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(this.wave);
      data = this.wave;
    }

    const points = 110;
    const amplitude = h * 0.12;
    const path = (offset, squash) => {
      ctx.beginPath();
      for (let i = 0; i <= points; i++) {
        const p = i / points;
        let v;
        if (data) {
          const sample = data[Math.floor(p * (data.length - 1))];
          v = (sample - 128) / 128;
        } else {
          v = Math.sin(p * 7 + this.phase * 2 + offset) * 0.25 * Math.sin(p * Math.PI);
        }
        const y = mid + offset * 14 + v * amplitude * squash;
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(p * w, y);
      }
      ctx.stroke();
    };

    ctx.save();
    ctx.lineWidth = 2;
    ctx.shadowBlur = 18;

    ctx.strokeStyle = 'rgba(45, 226, 255, .75)';
    ctx.shadowColor = '#2de2ff';
    path(0, 1);

    ctx.strokeStyle = 'rgba(255, 43, 209, .55)';
    ctx.shadowColor = '#ff2bd1';
    path(1.6, -0.8);
    ctx.restore();
  }

  // Spektrum als Balkenband knapp über dem Horizont.
  spectrumBand(ctx, w, h) {
    const analyser = this.engine.analyser;
    const base = h * 0.62;
    const bars = 64;
    const width = w / bars;

    let data = null;
    if (analyser && this.engine.running) {
      if (!this.spectrum || this.spectrum.length !== analyser.frequencyBinCount) {
        this.spectrum = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(this.spectrum);
      data = this.spectrum;
    }

    ctx.save();
    ctx.shadowBlur = 10;
    for (let i = 0; i < bars; i++) {
      const p = i / bars;
      const value = data
        ? data[Math.floor(p ** 1.6 * (data.length - 1))] / 255
        : 0.12 + 0.1 * Math.sin(p * 9 + this.phase * 1.6);
      const height = Math.max(1, value * h * 0.18);
      ctx.fillStyle = p < 0.4 ? 'rgba(157, 255, 61, .35)' : 'rgba(122, 107, 255, .35)';
      ctx.shadowColor = p < 0.4 ? '#9dff3d' : '#7a6bff';
      ctx.fillRect(i * width + 1, base - height, width - 2, height);
    }
    ctx.restore();
  }
}
