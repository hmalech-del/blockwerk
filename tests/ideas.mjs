// Ideen: Melodien aus Form statt Zufall, Variation mit Gedächtnis,
// Slice-Folgen mit Motiv, und das Einsortieren gesungener Anschläge.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer(8134);
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

await page.goto(server.url, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

// ------------------------------------------------------------- Melodien

const melody = await page.evaluate(async () => {
  const { generateMelody, varyMelody, CONTOURS, MOODS } = await import('/js/ideas.js');
  const { SCALES } = await import('/js/project.js');

  const runs = Array.from({ length: 40 }, () => generateMelody({ density: 0.5, contour: 'arch' }));
  const stats = runs.map((steps) => {
    const on = steps.map((s, i) => ({ ...s, i })).filter((s) => s.on);
    const degs = on.map((s) => s.deg);
    const jumps = degs.slice(1).map((d, i) => Math.abs(d - degs[i]));
    return {
      count: on.length,
      first: degs[0],
      last: degs[degs.length - 1],
      maxJump: Math.max(...jumps, 0),
      stepwise: jumps.filter((j) => j <= 2).length / Math.max(1, jumps.length),
      accentOnDownbeat: on.filter((s) => s.on === 2).every((s) => s.i % 4 === 0),
    };
  });

  const chordTone = (d) => [0, 2, 4].includes(((d % 7) + 7) % 7);
  const rising = generateMelody({ density: 0.8, contour: 'rise' });
  const risingDegs = rising.filter((s) => s.on).map((s) => s.deg);

  const dense = generateMelody({ density: 1 }).filter((s) => s.on).length;
  const sparse = generateMelody({ density: 0.05 }).filter((s) => s.on).length;

  const base = generateMelody({ density: 0.6 });
  const varied = varyMelody(base, { amount: 0.4 });

  return {
    allStartHome: stats.every((s) => chordTone(s.first)),
    allEndHome: stats.every((s) => chordTone(s.last)),
    stepwise: stats.reduce((a, s) => a + s.stepwise, 0) / stats.length,
    accents: stats.every((s) => s.accentOnDownbeat),
    counts: [Math.min(...stats.map((s) => s.count)), Math.max(...stats.map((s) => s.count))],
    biggestJump: Math.max(...stats.map((s) => s.maxJump)),
    risingEndsHigher: risingDegs[risingDegs.length - 1] > risingDegs[0],
    dense,
    sparse,
    variedChanged: JSON.stringify(base) !== JSON.stringify(varied),
    variedSameLength: base.filter((s) => s.on).length === varied.filter((s) => s.on).length,
    moodsValid: MOODS.every((m) => !!SCALES[m.scale]),
    contours: Object.keys(CONTOURS).length,
  };
});

check('Jede Melodie beginnt auf einem tragenden Ton', melody.allStartHome);
check('Jede Melodie kommt nach Hause', melody.allEndHome);
// Beides waere falsch: dauernd springen klingt wirr, nie springen maeandert.
// Die Quote zeigt das Erste, der groesste Sprung das Zweite - eine Quote mit
// Obergrenze waere dafuer zu zappelig, weil Spruenge oft nah landen.
check('Überwiegend Schritte', melody.stepwise > 0.75,
  `${Math.round(melody.stepwise * 100)} % der Bewegungen ≤ 2 Stufen`);
check('Aber es gibt echte Sprünge', melody.biggestJump >= 3,
  `größter Sprung ${melody.biggestJump} Stufen`);
check('Akzente sitzen auf Zählzeiten', melody.accents);
check('Dichte steuert die Anzahl', melody.dense > melody.sparse,
  `${melody.sparse} bei wenig, ${melody.dense} bei viel`);
check('Die Form wirkt (steigend endet höher)', melody.risingEndsHigher);
check('Variieren ändert etwas, ohne alles zu verwerfen',
  melody.variedChanged && melody.variedSameLength);
check('Stimmungen zeigen auf echte Tonleitern', melody.moodsValid, `${melody.contours} Formen`);

// ----------------------------------------------------------- Slice-Folgen

const slices = await page.evaluate(async () => {
  const { generateSliceArrangement } = await import('/js/ideas.js');
  const runs = Array.from({ length: 30 }, () => generateSliceArrangement({ sliceCount: 6, density: 0.7 }));
  return {
    inRange: runs.every((steps) => steps.every((s) => s.deg >= 0 && s.deg < 6)),
    startsAtZero: runs.every((steps) => steps[0].on > 0 && steps[0].deg === 0),
    hasRepeats: runs.some((steps) => {
      const degs = steps.filter((s) => s.on).map((s) => s.deg);
      return degs.some((d, i) => i > 1 && d === degs[i - 1] && d === degs[i - 2]);
    }),
    notAllSame: runs.some((steps) => new Set(steps.filter((s) => s.on).map((s) => s.deg)).size > 2),
  };
});
check('Slice-Folgen bleiben im gültigen Bereich', slices.inRange);
check('Der Takt beginnt vorn im Sample', slices.startsAtZero);
check('Es entstehen Stotterer statt Gleichverteilung', slices.hasRepeats && slices.notAllSame);

// -------------------------------------------------------------- Vorsingen

const beatbox = await page.evaluate(async () => {
  const { classifyOnset, onsetsToSteps } = await import('/js/ideas.js');
  const ctx = new OfflineAudioContext(1, 44100, 44100);
  const rate = 44100;

  // Drei typische Laute: Bauch, Körper mit Rauschen, nur Zischen
  const make = (kind) => {
    const buffer = ctx.createBuffer(1, Math.floor(rate * 0.2), rate);
    const d = buffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const env = Math.exp(-i / (kind === 'kick' ? 4000 : 1200));
      if (kind === 'kick') d[i] = Math.sin((2 * Math.PI * 55 * i) / rate) * env;
      else if (kind === 'snare') {
        d[i] = ((Math.random() * 2 - 1) * 0.6 + Math.sin((2 * Math.PI * 200 * i) / rate) * 0.8) * env;
      } else {
        // Zischen: schnelles Rauschen ohne tiefen Anteil
        d[i] = (Math.random() * 2 - 1) * env * (i % 2 ? 1 : -1);
      }
    }
    return buffer;
  };

  return {
    kick: classifyOnset(make('kick'), 0),
    snare: classifyOnset(make('snare'), 0),
    hat: classifyOnset(make('hat'), 0),
    // 0.5 s bei 0.125 s je Schritt = Schritt 4; leicht daneben wird gerundet
    quantized: onsetsToSteps([0, 0.51, 1.02, 1.49], { startStep: 0, stepSeconds: 0.125, stepCount: 16 }),
    wrapped: onsetsToSteps([2.03], { startStep: 0, stepSeconds: 0.125, stepCount: 16 }),
  };
});
check('Bauchlaut wird als Kick erkannt', beatbox.kick === 'kick', beatbox.kick);
check('Körperlaut wird als Snare erkannt', beatbox.snare === 'snare', beatbox.snare);
check('Zischlaut wird als HiHat erkannt', beatbox.hat === 'hat', beatbox.hat);
check('Anschläge rasten aufs Sechzehntel', beatbox.quantized.join(',') === '0,4,8,12',
  beatbox.quantized.join(','));
check('Über den Takt hinaus wird umgebrochen', beatbox.wrapped.join(',') === '0',
  beatbox.wrapped.join(','));

// --------------------------------------------------------------- Bedienung

await page.click('[data-view="seq"]');
await page.waitForTimeout(150);
check('Ideen-Leiste ist da', await page.isVisible('.idea-bar'));
check('Stimmungen statt Tonleitern',
  (await page.textContent('#scale')).includes('Dunkel'),
  (await page.evaluate(() => document.querySelector('#scale').options[0].textContent)));

await page.evaluate(() => {
  const p = window.blockwerk.project();
  window.blockwerk.sequencer.hooks.onSelect(p.tracks[3].id);  // Bass
});
await page.waitForTimeout(150);
await page.click('[data-act="idea-roll"]');
await page.waitForTimeout(150);
const rolled = await page.evaluate(() => {
  const c = window.blockwerk.project().tracks[3].clips[0];
  return { on: c.steps.filter((s) => s.on).length, status: document.querySelector('[data-role="idea-status"]').textContent };
});
check('Würfeln schreibt eine Melodie', rolled.on >= 3, `${rolled.on} Töne · ${rolled.status}`);

// Beim Sampler würfelt derselbe Knopf Slices
await page.evaluate(async () => {
  const bw = window.blockwerk;
  const rate = 44100;
  const data = new Float32Array(rate);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.05) * Math.exp(-(i % 5000) / 900);
  const sample = await bw.addSample('Chop', data, rate);
  const track = bw.project().tracks[4];
  track.source = { type: 'sampler', params: { pitch: 0, begin: 0, length: 1, reverse: 'off', attack: 0.003, release: 0.06 } };
  track.sampleId = sample.id;
  bw.engine.sync();
  bw.sequencer.hooks.onSelect(track.id);
});
await page.waitForTimeout(200);
check('Der Würfel heißt beim Sampler anders',
  (await page.textContent('[data-act="idea-roll"]')).includes('Slices'));
await page.click('[data-act="idea-roll"]');
await page.waitForTimeout(150);
const sliceRoll = await page.evaluate(() => {
  const p = window.blockwerk.project();
  const c = p.tracks[4].clips[0];
  const count = p.samples[0].slices.length;
  return { ok: c.steps.filter((s) => s.on).every((s) => s.deg < count), on: c.steps.filter((s) => s.on).length };
});
check('Slice-Folge landet im Raster', sliceRoll.ok && sliceRoll.on > 3, `${sliceRoll.on} Anschläge`);

// Vorsingen läuft durch (das Testgerät liefert einen Dauerton, kein Beatbox)
await page.click('#power');
await page.waitForTimeout(150);
await page.click('[data-act="beatbox"]');
await page.waitForTimeout(600);
check('Vorsingen startet den Transport und hört zu',
  await page.evaluate(() => window.blockwerk.transport.playing)
  && (await page.textContent('[data-role="idea-status"]')).length > 0,
  await page.textContent('[data-role="idea-status"]'));
await page.waitForTimeout(4200);
const afterBeatbox = await page.textContent('[data-role="idea-status"]');
check('Vorsingen endet mit einer Rückmeldung',
  /Anschläge|Nichts gehört|erkannt/.test(afterBeatbox), afterBeatbox);
check('Das Mikrofon wird wieder freigegeben',
  await page.evaluate(() => !window.blockwerk.beatboxing));

await browser.close();
await server.close();
errors.forEach((e) => console.log(' -', e));
const failed = checks.filter((c) => !c).length + errors.length;
console.log(failed ? `\n${failed} Fehler` : '\nIdeen-Tests bestanden.');
process.exit(failed ? 1 : 0);
