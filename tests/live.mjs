// Live-Ansicht: Pads, Szenen, Vorschau im Streifen – und die Audio-Absicherung
// (Entsperren, Testton, Erholung nach einer Unterbrechung).
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer(8128);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
await page.reload({ waitUntil: 'networkidle' });

check('Live ist die Startansicht', await page.isVisible('#live .strip'));
check('Szenen aus dem Demo-Set da', (await page.$$('.scene')).length === 4,
  (await project()).scenes.map((s) => s.name).join(', '));
check('Pads für jede Spur', (await page.$$('.pad-row')).length === 5);

// Streifen zeichnet wirklich etwas (nicht nur leere Fläche)
await page.click('#power');
await page.click('#play');
await page.waitForTimeout(800);
const painted = await page.evaluate(() => {
  const c = document.querySelector('.strip');
  const ctx = c.getContext('2d');
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) lit++;
  return { lit, total: data.length / 4 };
});
check('Streifen ist gezeichnet', painted.lit > painted.total * 0.02,
  `${((painted.lit / painted.total) * 100).toFixed(1)} % der Fläche`);

// Pad merkt einen Wechsel vor und zeigt ihn im Streifen als Zukunft
const second = (await project()).tracks[1];
await page.click(`.pad-row[data-id="${second.id}"] .pad[data-slot="1"]`);
const queued = await page.evaluate(() => {
  const { project, transport } = window.blockwerk;
  const t = project().tracks[1];
  return { queued: t.queued, switchStep: transport.switchStep(), position: transport.position() };
});
check('Pad merkt Clipwechsel vor', queued.queued === 1);
check('Wechselmarke liegt in der Zukunft', queued.switchStep > queued.position,
  `Schritt ${queued.switchStep} bei Position ${queued.position.toFixed(1)}`);
await page.waitForTimeout(120); // der Countdown wird im naechsten Frame gesetzt
check('Countdown wird angezeigt',
  /Wechsel in [\d.]+ Takten/.test(await page.textContent('[data-role="countdown"]')));
check('Pad blinkt als vorgemerkt',
  await page.isVisible(`.pad-row[data-id="${second.id}"] .pad.queued`));

await page.waitForTimeout(2500);
check('Wechsel ist ausgeführt', (await project()).tracks[1].clip === 1);

// Szene schaltet alle Spuren gemeinsam, inklusive Stummschaltung
await page.locator('.scene').first().click(); // Intro: Snare und Lead stumm
await page.waitForTimeout(2500);
const afterScene = await project();
const intro = afterScene.scenes[0];
const matches = afterScene.tracks.every((t) => {
  const slot = intro.slots[t.id];
  const mute = intro.mutes[t.id];
  return (slot === undefined || t.clip === slot) && (mute === undefined || t.mix.mute === mute);
});
check('Szene setzt Clips und Stummschaltung', matches,
  afterScene.tracks.map((t) => `${t.name}:${t.clip}${t.mix.mute ? ' (stumm)' : ''}`).join(', '));

// Eigene Szene sichern
page.once('dialog', (d) => d.accept('Testszene'));
await page.click('[data-act="scene-save"]');
await page.waitForTimeout(150);
check('Eigene Szene gesichert', (await project()).scenes.length === 5,
  (await project()).scenes.at(-1)?.name);

// Szene löschen über den Bearbeiten-Modus
await page.click('[data-act="scene-edit"]');
await page.locator('.scene-del').last().click();
check('Szene wieder gelöscht', (await project()).scenes.length === 4);

// Stumm direkt am Pad
const kick = (await project()).tracks[0];
await page.click(`.pad-row[data-id="${kick.id}"] .pad.mute`);
check('Mute am Pad wirkt sofort', (await project()).tracks[0].mix.mute === true);
await page.click(`.pad-row[data-id="${kick.id}"] .pad.mute`);

await page.click('#play');

// ------------------------------------------------------ Audio-Absicherung

const audio = await page.evaluate(() => {
  const { engine } = window.blockwerk;
  return {
    unlocked: engine._unlocked === true,
    state: engine.ctx.state,
    sampleRate: engine.ctx.sampleRate,
    hasStateHandler: typeof engine.ctx.onstatechange === 'function',
  };
});
check('AudioContext ist entsperrt und läuft', audio.unlocked && audio.state === 'running',
  `${audio.sampleRate} Hz`);
check('Zustandswechsel wird beobachtet', audio.hasStateHandler);

// Testton erzeugt messbaren Pegel am Master
const tone = await page.evaluate(async () => {
  const { engine } = window.blockwerk;
  engine.testTone();
  await new Promise((r) => setTimeout(r, 180));
  return engine.level();
});
check('Testton kommt am Master an', tone > 0.01, `Pegel ${tone.toFixed(3)}`);
await page.click('#test-tone');
check('Hinweis zum Stummschalter erscheint',
  (await page.textContent('#audio-state')).includes('Stummschalter'));

// Erholung nach Unterbrechung (auf iOS: Anruf, App-Wechsel)
const recovered = await page.evaluate(async () => {
  const { engine } = window.blockwerk;
  await engine.ctx.suspend();
  const suspended = engine.ctx.state;
  await engine.start();
  return { suspended, after: engine.ctx.state };
});
check('Nach Unterbrechung wieder aufnehmbar',
  recovered.suspended === 'suspended' && recovered.after === 'running');

// ------------------------------------------------------------- Handyformat

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const phone = await page.evaluate(() => {
  const strip = document.querySelector('.strip');
  const pad = document.querySelector('.pad');
  return {
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    stripWidth: strip.clientWidth,
    padHeight: pad.getBoundingClientRect().height,
    padWidth: pad.getBoundingClientRect().width,
  };
});
check('Kein waagerechtes Scrollen auf dem Handy', phone.overflow <= 1, `${phone.overflow} px`);
check('Pads bleiben fingertauglich', phone.padHeight >= 40 && phone.padWidth >= 40,
  `${Math.round(phone.padWidth)} × ${Math.round(phone.padHeight)} px`);

await browser.close();
await server.close();
errors.forEach((e) => console.log(' -', e));
const failed = checks.filter((c) => !c).length + errors.length;
console.log(failed ? `\n${failed} Fehler` : '\nLive-Tests bestanden.');
process.exit(failed ? 1 : 0);
