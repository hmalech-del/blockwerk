// Sampler: Aufnahme, Zerlegung (gleichmäßig und nach Anschlägen), Zuordnung
// zu einer Spur, Sequenzierung über die Stufen und Persistenz.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer(8130);
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const checks = [];
const check = (label, ok, info = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok    ' : 'FEHLER'} ${label}${info ? ` (${info})` : ''}`);
};
const project = () => page.evaluate(() => window.blockwerk.project());

await page.goto(server.url, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.evaluate(() => new Promise((r) => { const d = indexedDB.deleteDatabase('blockwerk'); d.onsuccess = r; d.onerror = r; d.onblocked = r; }));
await page.reload({ waitUntil: 'networkidle' });
await page.click('#power');
await page.waitForTimeout(200);
await page.click('[data-view="sampler"]');

// Ein Testsignal mit vier klar getrennten Anschlägen bei 0, 0.5, 1.0, 1.5 s
const made = await page.evaluate(async () => {
  const rate = 44100;
  const length = rate * 2;
  const data = new Float32Array(length);
  for (let hit = 0; hit < 4; hit++) {
    const at = Math.floor((hit * length) / 4);
    for (let i = 0; i < 6000; i++) data[at + i] = Math.sin(i * 0.06) * Math.exp(-i / 900);
  }
  const sample = await window.blockwerk.addSample('Testschlag', data, rate);
  return { id: sample.id, duration: sample.duration, slices: sample.slices.length };
});
check('Sample wird angelegt und gleich zerlegt',
  made.slices === 8 && Math.abs(made.duration - 2) < 0.01, `${made.slices} Slices, ${made.duration}s`);

// ----------------------------------------------------------- Zerlegen

const chopped = await page.evaluate(async () => {
  const { samples, project } = window.blockwerk;
  const { equalSlices, detectTransients, sliceBounds } = await import('/js/samples.js');
  const sample = project().samples[0];
  const buffer = samples.get(sample.id);

  const equal = equalSlices(sample.duration, 4);
  const found = detectTransients(buffer, { sensitivity: 0.5 });
  const bounds = sliceBounds({ ...sample, slices: equal }, 1);
  return {
    equal,
    found,
    bounds,
    bufferSeconds: buffer.duration,
  };
});
check('Gleichmäßiges Zerhacken trifft die Viertel',
  JSON.stringify(chopped.equal.map((t) => Math.round(t * 100))) === JSON.stringify([0, 50, 100, 150]),
  chopped.equal.map((t) => t.toFixed(2)).join(', '));
check('Anschlagserkennung findet die vier Schläge',
  chopped.found.length === 4
  && chopped.found.every((t, i) => Math.abs(t - i * 0.5) < 0.03),
  chopped.found.map((t) => t.toFixed(3)).join(', '));
check('Slice-Grenzen stimmen',
  Math.abs(chopped.bounds.start - 0.5) < 0.001 && Math.abs(chopped.bounds.end - 1.0) < 0.001,
  `${chopped.bounds.start.toFixed(2)}–${chopped.bounds.end.toFixed(2)}`);

// Zerhacken über die Oberfläche
await page.click('[data-act="chop"][data-n="16"]');
check('Zerhacken-Knopf wirkt', (await project()).samples[0].slices.length === 16);
await page.click('[data-act="transients"]');
check('Anschläge-Knopf wirkt', (await project()).samples[0].slices.length === 4,
  `${(await project()).samples[0].slices.length} Slices`);

// --------------------------------------------------- Spur und Sequenzierung

await page.selectOption('[data-act="assign"]', 'new');
await page.waitForTimeout(150);
const assigned = await project();
const samplerTrack = assigned.tracks.at(-1);
check('Neue Spur mit dem Sample angelegt',
  samplerTrack.source.type === 'sampler' && samplerTrack.sampleId === assigned.samples[0].id,
  samplerTrack.name);

const slices = await page.evaluate(() => {
  const { engine, project } = window.blockwerk;
  const p = project();
  const track = p.tracks.at(-1);
  return [0, 1, 2, 3, 5].map((deg) => {
    const ctx = engine.sampleContext(track, deg);
    return ctx ? { deg, start: Number(ctx.slice.start.toFixed(3)), end: Number(ctx.slice.end.toFixed(3)) } : null;
  });
});
check('Die Stufe wählt den Slice',
  slices[0].start === 0 && Math.abs(slices[1].start - 0.5) < 0.03 && Math.abs(slices[2].start - 1) < 0.03,
  slices.slice(0, 3).map((s) => `${s.deg}:${s.start}`).join(' '));
check('Stufen jenseits der letzten Marke laufen rundherum',
  Math.abs(slices[4].start - slices[1].start) < 0.001, `Stufe 5 → ${slices[4].start}s`);

// Rückwärts spiegelt denselben Ausschnitt ans andere Ende
const reversed = await page.evaluate(() => {
  const { engine, project } = window.blockwerk;
  const p = project();
  const track = p.tracks.at(-1);
  track.source.params.reverse = 'on';
  const ctx = engine.sampleContext(track, 1);
  track.source.params.reverse = 'off';
  return ctx && { start: Number(ctx.slice.start.toFixed(3)), end: Number(ctx.slice.end.toFixed(3)) };
});
check('Rückwärts trifft denselben Ausschnitt',
  Math.abs(reversed.end - 1.5) < 0.03, `${reversed.start}–${reversed.end}`);

// Slices aufs Raster legen und hören
await page.click('[data-act="lay-out"]');
const laid = (await project()).tracks.at(-1).clips[0].steps;
check('„Slices aufs Raster" füllt den Clip',
  laid.every((s) => s.on > 0) && laid[0].deg === 0 && laid[1].deg === 1 && laid[4].deg === 0,
  laid.slice(0, 6).map((s) => s.deg).join(','));

const heard = await page.evaluate(async () => {
  const { engine, transport, project } = window.blockwerk;
  const p = project();
  p.tempo = 140;
  for (const t of p.tracks) t.mix.mute = t !== p.tracks.at(-1);
  transport.start();
  await new Promise((r) => setTimeout(r, 900));
  const level = engine.level();
  const voices = engine.voiceCount();
  transport.stop();
  for (const t of p.tracks) t.mix.mute = false;
  return { level, voices };
});
check('Die Slices erklingen im Lauf', heard.level > 0.001,
  `Pegel ${heard.level.toFixed(4)}, ${heard.voices} Stimmen`);

await page.click('[data-act="shuffle"]');
const shuffled = (await project()).tracks.at(-1).clips[0].steps.map((s) => s.deg);
check('„Würfeln" verteilt die Slices neu',
  shuffled.every((d) => d >= 0 && d < 4) && new Set(shuffled).size > 1, shuffled.join(','));

// Das Raster begrenzt die Stufe auf die vorhandenen Slices
const range = await page.evaluate(() => {
  const { sequencer, project } = window.blockwerk;
  return sequencer.degreeRange(project().tracks.at(-1));
});
check('Raster begrenzt die Stufe auf vorhandene Slices',
  range.min === 0 && range.max === 3, `${range.min}–${range.max}`);

// ----------------------------------------------------------- Aufnahme

const recorded = await page.evaluate(async () => {
  const { engine, transport, project } = window.blockwerk;
  const { Recorder } = await import('/js/samples.js');
  transport.start();
  const rec = new Recorder(engine.ctx);
  rec.startFrom(engine.limiter || engine.master);
  await new Promise((r) => setTimeout(r, 900));
  const during = rec.seconds;
  const result = rec.stop();
  transport.stop();
  let peak = 0;
  for (let i = 0; i < result.data.length; i++) peak = Math.max(peak, Math.abs(result.data[i]));
  return { during, seconds: result.data.length / result.sampleRate, peak, before: project().samples.length };
});
check('Mitschnitt läuft mit und zeigt die Zeit', recorded.during > 0.3, `${recorded.during.toFixed(2)} s`);
check('Mitschnitt enthält echtes Signal',
  recorded.seconds > 0.5 && recorded.peak > 0.01,
  `${recorded.seconds.toFixed(2)} s, Spitze ${recorded.peak.toFixed(3)}`);

// Aufnahmeknopf schaltet um
await page.click('[data-act="record-master"]');
await page.waitForTimeout(400);
check('Aufnahmeknopf zeigt den Lauf', await page.isVisible('.rec.on'));
await page.click('[data-act="record-master"]');
await page.waitForTimeout(400);
check('Aufnahme landet als neues Sample', (await project()).samples.length === 2,
  (await project()).samples.map((s) => s.name).join(', '));

// ------------------------------------------------- Live-Slicing per Script

const sliced = await page.evaluate(async () => {
  const { script, project, engine } = window.blockwerk;
  const p = project();
  const track = p.tracks.at(-1);
  p.script.text = [
    `bar 1  slice ${track.name} 32`,
    `bar 2  slice ${track.name} transients`,
  ].join('\n');
  p.script.enabled = true;
  script.compile();
  const errors = script.errors.map((e) => e.message);
  script.onBar(1, engine.ctx.currentTime);
  const after32 = p.samples[0].slices.length;
  script.onBar(2, engine.ctx.currentTime);
  const afterTransients = p.samples[0].slices.length;
  p.script.enabled = false;
  return { errors, after32, afterTransients };
});
check('Script zerlegt live gleichmäßig', sliced.errors.length === 0 && sliced.after32 === 32,
  sliced.errors.join(' | ') || `${sliced.after32} Slices`);
check('Script findet live die Anschläge', sliced.afterTransients === 4,
  `${sliced.afterTransients} Slices`);

// ---------------------------------------------------------- Persistenz

await page.waitForTimeout(600);
await page.reload({ waitUntil: 'networkidle' });
await page.click('#power');
await page.waitForTimeout(600);
const afterReload = await page.evaluate(() => {
  const { samples, project } = window.blockwerk;
  const p = project();
  return {
    samples: p.samples.length,
    slices: p.samples[0]?.slices.length,
    bufferThere: !!samples.get(p.samples[0]?.id),
    trackStillSampler: p.tracks.at(-1).source.type === 'sampler' && !!p.tracks.at(-1).sampleId,
  };
});
check('Samples überleben den Reload',
  afterReload.samples === 2 && afterReload.bufferThere && afterReload.trackStillSampler,
  `${afterReload.samples} Samples, Wellenform geladen: ${afterReload.bufferThere}`);
check('Schnittmarken bleiben erhalten', afterReload.slices === 4, `${afterReload.slices} Slices`);

// Löschen räumt auch die Spur auf
await page.click('[data-view="sampler"]');
await page.waitForTimeout(150);
await page.click('[data-act="delete"]');
await page.waitForTimeout(200);
const afterDelete = await project();
check('Löschen entfernt Sample und löst die Spur',
  afterDelete.samples.length === 1 && !afterDelete.tracks.at(-1).sampleId,
  `${afterDelete.samples.length} übrig`);

await browser.close();
await server.close();
errors.forEach((e) => console.log(' -', e));
const failed = checks.filter((c) => !c).length + errors.length;
console.log(failed ? `\n${failed} Fehler` : '\nSampler-Tests bestanden.');
process.exit(failed ? 1 : 0);
