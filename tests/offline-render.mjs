// DSP-Test: rendert jede Quelle und jeden Effekt in einem OfflineAudioContext.
// Erwartet wird Signal (kein Stillstand), keine NaN/Inf-Werte und kein
// unkontrollierter Pegel – auch an den Parameter-Extremen.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer(8125);
const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });
await page.goto(server.url, { waitUntil: 'networkidle' });

const rows = await page.evaluate(async () => {
  const { MODULES, SOURCES, EFFECTS, defaultParams } = await import('/js/modules.js');

  const analyse = (buf) => {
    const d = buf.getChannelData(0);
    let peak = 0;
    let sum = 0;
    let bad = 0;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) { bad += 1; continue; }
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / d.length), bad };
  };

  const out = [];

  for (const src of SOURCES) {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const voice = src.spawn(ctx, defaultParams(src.id), 220, 0);
    voice.out.connect(ctx.destination);
    voice.release(0.6);
    out.push({ kind: 'Quelle', name: src.name, ...analyse(await ctx.startRendering()) });
  }

  const throughFx = async (fx, params, seconds) => {
    const ctx = new OfflineAudioContext(1, 44100, Math.round(44100 * seconds));
    const inst = fx.create(ctx);
    for (const spec of fx.params) inst.set(spec.id, params[spec.id]);
    const voice = MODULES.osc.spawn(ctx, defaultParams('osc'), 220, 0);
    voice.out.connect(inst.input);
    inst.output.connect(ctx.destination);
    voice.release(seconds * 0.6);
    return analyse(await ctx.startRendering());
  };

  for (const fx of EFFECTS) {
    out.push({ kind: 'Effekt', name: fx.name, ...(await throughFx(fx, defaultParams(fx.id), 1)) });
  }

  for (const fx of EFFECTS) {
    for (const edge of ['min', 'max']) {
      const params = {};
      for (const spec of fx.params) {
        params[spec.id] = spec.type === 'select'
          ? spec.options[spec.options.length - 1].value
          : spec[edge];
      }
      out.push({ kind: `Effekt/${edge}`, name: fx.name, ...(await throughFx(fx, params, 0.5)) });
    }
  }
  return out;
});

await browser.close();
await server.close();

let failed = 0;
for (const r of rows) {
  const mustSound = r.kind === 'Quelle' || r.kind === 'Effekt';
  const problem = r.bad > 0 || r.peak > 4 || (mustSound && r.rms < 0.0005);
  if (problem) failed += 1;
  console.log(
    `${problem ? 'FEHLER' : 'ok    '} ${r.kind.padEnd(12)} ${r.name.padEnd(12)}` +
    ` peak=${r.peak.toFixed(3)} rms=${r.rms.toFixed(4)} nichtEndlich=${r.bad}`
  );
}
consoleErrors.forEach((e) => console.log(' -', e));
console.log(failed || consoleErrors.length ? `\n${failed} Auffälligkeiten` : '\nAlle Bausteine liefern sauberes Signal.');
process.exit(failed || consoleErrors.length ? 1 : 0);
