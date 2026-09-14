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

// ------------------------------------------------ Zuverlaessigkeit der Szenen

// Musiker tippen kurz VOR der Eins. Der Scheduler hat die Taktgrenze dann
// schon verplant – ohne Gegenmassnahme kaeme der Wechsel einen Takt zu spaet.
const reliability = await page.evaluate(async () => {
  const { transport, project } = window.blockwerk;
  const p = project();
  p.tempo = 120;                      // ein Takt = 2 s
  transport.start();
  await new Promise((r) => setTimeout(r, 300));

  const barMs = 2000;
  const results = [];
  for (let i = 0; i < 12; i++) {
    const phase = 0.75 + (i % 4) * 0.08;   // 75 %, 83 %, 91 %, 99 % des Takts
    const barsNow = transport.position() / 16;
    const target = Math.floor(barsNow) + 1 + phase;
    await new Promise((r) => setTimeout(r, Math.max(0, (target - barsNow) * barMs)));

    const scene = p.scenes[i % 2 ? 1 : 2];
    const tapBar = transport.position() / 16;
    transport.queueScene(scene);
    const expected = p.tracks.map((t) => scene.slots[t.id] ?? t.clip).join('');
    await new Promise((r) => setTimeout(r, (Math.ceil(tapBar + 0.001) - tapBar) * barMs + 250));
    results.push({
      phase: Math.round(phase * 100),
      ok: p.tracks.map((t) => t.clip).join('') === expected,
    });
  }
  transport.stop();
  return { total: results.length, failed: results.filter((r) => !r.ok) };
});
check('Szenen greifen auch bei einem Tap kurz vor der Eins',
  reliability.failed.length === 0,
  `${reliability.total - reliability.failed.length}/${reliability.total} getroffen` +
  (reliability.failed.length ? `, daneben bei ${reliability.failed.map((f) => f.phase + '%').join(', ')}` : ''));

// ------------------------------------------------------------- Live-Regler

const macros = await page.evaluate(async () => {
  const { live, project } = window.blockwerk;
  const p = project();
  live.hooks.onMacroTarget(0, 'Bass.filter.freq');
  live.render();
  const macro = p.macros[0];
  const slider = document.querySelector('.macro input[data-act="macro"]');
  slider.value = '250';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  const freq = p.tracks[3].chain.find((b) => b.type === 'filter').params.freq;
  return {
    label: macro?.label,
    min: macro?.min,
    max: macro?.max,
    freq: Math.round(freq),
    shown: document.querySelector('.macro-value')?.textContent,
    slots: document.querySelectorAll('.macro').length,
  };
});
check('Live-Regler lässt sich grafisch belegen',
  macros.label === 'Bass · Filter · Cutoff' && macros.min === 40 && macros.max === 16000,
  `${macros.label}, ${macros.min}–${macros.max}`);
check('Live-Regler wirkt auf den Parameter', macros.freq > 100 && macros.freq < 1000,
  `${macros.freq} Hz, angezeigt ${macros.shown}`);
check('Vier Reglerplätze vorhanden', macros.slots === 4);

// --------------------------------------------- Erste Geste und Standfestigkeit

// Der haeufigste Einstieg ueberhaupt: Seite oeffnen, Start druecken. Wenn sich
// dabei die Leiste verschiebt, landet der Klick auf dem Nachbarknopf.
const fresh = await browser.newPage({ viewport: { width: 1440, height: 790 } });
const freshErrors = [];
fresh.on('pageerror', (e) => freshErrors.push('pageerror: ' + e.message));
await fresh.goto(server.url, { waitUntil: 'networkidle' });
await fresh.evaluate(() => localStorage.clear());
await fresh.reload({ waitUntil: 'networkidle' });

const boxOf = async (sel) => (await (await fresh.$(sel)).boundingBox());
const playBefore = await boxOf('#play');
await fresh.click('#play');
await fresh.waitForTimeout(500);
const playAfter = await boxOf('#play');

check('Start als allererste Geste startet den Transport',
  await fresh.evaluate(() => window.blockwerk.transport.playing));
check('Bedienelemente springen beim ersten Tippen nicht',
  Math.abs(playAfter.x - playBefore.x) < 2 && Math.abs(playAfter.width - playBefore.width) < 2,
  `${Math.round(playAfter.x - playBefore.x)} px Versatz`);

// Laptopformat: Streifen und Pads muessen ohne Scrollen sichtbar sein
const laptop = await fresh.evaluate(() => {
  const pads = document.querySelector('.pads').getBoundingClientRect();
  const scenes = document.querySelector('.scene-bar').getBoundingClientRect();
  return {
    padsBottom: Math.round(pads.bottom),
    scenesRight: Math.round(scenes.right),
    scenesBesidePads: scenes.left >= pads.right - 1,
    header: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
check('Streifen und Pads passen aufs Laptop-Fenster', laptop.padsBottom <= 790,
  `Pads enden bei ${laptop.padsBottom} px`);
check('Kopfzeile bleibt einzeilig', laptop.header < 80, `${laptop.header} px`);
check('Szenen stehen neben den Pads', laptop.scenesBesidePads);
check('Kein waagerechtes Scrollen auf dem Laptop', laptop.overflowX <= 1);

// Tastenkuerzel: Ziffer ruft die Szene auf
await fresh.keyboard.press('Digit3');
await fresh.waitForTimeout(150);
const viaKey = await fresh.evaluate(() => {
  const p = window.blockwerk.project();
  return p.tracks.some((t) => t.queued !== null);
});
check('Ziffer ruft die Szene auf', viaKey);
freshErrors.forEach((e) => errors.push(e));
await fresh.close();

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
