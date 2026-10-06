// Gestenfeld: Pfad zu Anschlägen, Aufnahme als Schleife, senkrechtes Ziel,
// und dass die Spielfläche ohne Scrollen erreichbar ist.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer(8132);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 790 } });
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

// ------------------------------------------------------------------ Logik

const pure = await page.evaluate(async () => {
  const g = await import('/js/gesture.js');
  const path = [
    { t: 0, x: 0.05, y: 0.2 },   // Spalte 0
    { t: 1, x: 0.1, y: 0.4 },    // noch Spalte 0 -> kein neuer Anschlag
    { t: 2.4, x: 0.3, y: 0.6 },  // Spalte 2
    { t: 3.7, x: 0.6, y: 0.9 },  // Spalte 4
  ];
  return {
    events: g.pathToEvents(path, 8),
    quantized: g.pathToEvents(path, 8, { quantize: true }).map((e) => e.t),
    mitte: g.valueAtStep({ gesture: { takes: [{ points: path, events: [] }] }, clips: [{ bars: 1 }], clip: 0 }, 1),
    spalte: [g.degAt(0, 8), g.degAt(0.99, 8), g.degAt(0.5, 8)],
  };
});
check('Nur Spaltenwechsel lösen neu aus',
  pure.events.length === 3 && pure.events.map((e) => e.deg).join(',') === '0,2,4',
  pure.events.map((e) => `${e.t.toFixed(1)}@${e.deg}`).join(' '));
check('„im Takt" rastet auf Sechzehntel', pure.quantized.join(',') === '0,2,4', pure.quantized.join(','));
check('Senkrechter Wert wird zwischen den Punkten interpoliert',
  Math.abs(pure.mitte - 0.4) < 0.001, String(pure.mitte));
check('Spaltenzuordnung bleibt im Bereich', pure.spalte.join(',') === '0,7,4');

// -------------------------------------------------------- Feld und Aufnahme

await page.click('#power');
await page.waitForTimeout(150);
await page.click('[data-act="mode"][data-mode="field"]');
await page.waitForTimeout(200);
check('Feld erscheint in der Live-Ansicht', await page.isVisible('.field'));

const geometry = await page.evaluate(() => {
  const r = document.querySelector('.field').getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
});
check('Spielfläche ist ohne Scrollen erreichbar', geometry.bottom <= 790,
  `${geometry.top}–${geometry.bottom} px`);

// Spur ohne eigene Schritte, damit nur Gesten klingen
await page.evaluate(() => {
  const p = window.blockwerk.project();
  const track = p.tracks[3];                 // Bass
  track.clips[0].steps = track.clips[0].steps.map(() => ({ on: 0, deg: 0 }));
  window.blockwerk.gestureField.hooks.onSelect(track.id);
  p.tempo = 150;
});
await page.waitForTimeout(150);
await page.click('#play');
await page.waitForTimeout(300);

const box = await (await page.$('.field')).boundingBox();
await page.mouse.move(box.x + 40, box.y + box.height - 40);
await page.mouse.down();
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(box.x + 40 + (i * (box.width - 80)) / 10, box.y + box.height - 40 - i * 12, { steps: 2 });
  await page.waitForTimeout(45);
}
await page.mouse.up();
await page.waitForTimeout(200);

const take = await page.evaluate(() => {
  const track = window.blockwerk.project().tracks[3];
  const t = track.gesture.takes[0];
  return t && {
    takes: track.gesture.takes.length,
    points: t.points.length,
    events: t.events.length,
    degs: t.events.map((e) => e.deg),
    steigend: t.events.every((e, i, a) => i === 0 || e.deg > a[i - 1].deg),
  };
});
check('Die Geste wird als Schleife mitgeschrieben',
  take?.takes === 1 && take.points > 5 && take.events >= 3,
  `${take?.points} Punkte, ${take?.events} Anschläge`);
check('Das Wischen läuft über mehrere Spalten', take?.steigend && take.degs.length >= 3,
  take?.degs.join(','));

// Die aufgenommene Geste muss von allein weiterlaufen
const looped = await page.evaluate(async () => {
  const { engine, project } = window.blockwerk;
  const track = project().tracks[3];
  const original = engine.noteOn.bind(engine);
  let count = 0;
  engine.noteOn = (trackId, ...rest) => {
    if (trackId === track.id) count += 1;
    return original(trackId, ...rest);
  };
  await new Promise((r) => setTimeout(r, 3000));
  engine.noteOn = original;
  return count;
});
check('Die Schleife spielt ohne Zutun weiter', looped >= 3, `${looped} Anschläge in 3 s`);

// Senkrechtes Ziel – über eine volle Schleife beobachtet, denn eine Geste
// deckt nur den Abschnitt ab, über den die Hand gefahren ist.
const target = await page.evaluate(async () => {
  const { project, gestureField, transport } = window.blockwerk;
  const track = project().tracks[3];
  gestureField.hooks.onTarget(track, 'Bass.filter.freq');
  const freq = () => track.chain.find((b) => b.type === 'filter').params.freq;

  const start = freq();
  const seen = [start];
  const bars = 16 / (project().tempo / 60 / 4) / 16;   // Sekunden je Takt
  const until = Date.now() + bars * 2200;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 60));
    seen.push(freq());
  }
  return {
    start: Math.round(start),
    min: Math.round(Math.min(...seen)),
    max: Math.round(Math.max(...seen)),
    playing: transport.playing,
  };
});
check('Der senkrechte Weg regelt das gewählte Ziel',
  target.max - target.min > 20,
  `${target.min}–${target.max} Hz im Verlauf einer Schleife`);

// Rückgängig und Leeren
await page.evaluate(() => window.blockwerk.transport.stop());
await page.click('[data-act="undo"]');
check('„Letzte weg" nimmt die Geste zurück',
  (await page.evaluate(() => window.blockwerk.project().tracks[3].gesture.takes.length)) === 0);
check('Knöpfe sind ohne Gesten gesperrt',
  await page.evaluate(() => document.querySelector('[data-act="clear"]').disabled));

// Zurück zu den Pads
await page.click('[data-act="mode"][data-mode="pads"]');
await page.waitForTimeout(150);
check('Zurück zu den Pads', await page.isVisible('.pad-row') && !(await page.isVisible('.field')));

await browser.close();
await server.close();
errors.forEach((e) => console.log(' -', e));
const failed = checks.filter((c) => !c).length + errors.length;
console.log(failed ? `\n${failed} Fehler` : '\nGesten-Tests bestanden.');
process.exit(failed ? 1 : 0);
