// Oberflächentest: Audio an/aus, Schritte setzen, Clips, Spuren, Klangkette,
// Textmodus, Persistenz. Bricht bei jedem Konsolenfehler ab.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer(8126);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); // 10-Zoll-Tablet
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const checks = [];
const check = (label, ok, info = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok    ' : 'FEHLER'} ${label}${info ? ` (${info})` : ''}`);
};
const project = () => page.evaluate(() => window.blockwerk.project());
const state = () => page.evaluate(() => window.blockwerk.engine.ctx?.state);

await page.goto(server.url, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

// Startzustand
const start = await project();
check('Demo-Set geladen', start.tracks.length === 5, start.tracks.map((t) => t.name).join(', '));
check('Raster gezeichnet', (await page.$$('.track')).length === 5);

// Audio und Transport
await page.click('#power');
await page.waitForTimeout(200);
check('Audio startet', (await state()) === 'running');

await page.click('#play');
await page.waitForTimeout(900);
const playing = await page.evaluate(() => ({
  playing: window.blockwerk.transport.playing,
  position: window.blockwerk.transport.position(),
  voices: window.blockwerk.engine.voiceCount(),
  level: window.blockwerk.engine.level(),
}));
check('Transport läuft und erzeugt Signal',
  playing.playing && playing.position > 1 && playing.level > 0.001,
  `Position ${playing.position.toFixed(1)}, Pegel ${playing.level.toFixed(3)}`);
check('Spielkopf sichtbar', (await page.$$('.cell.now')).length > 0);

// Clipwechsel über die Chips
const secondTrack = start.tracks[1].id;
await page.click(`.track[data-id="${secondTrack}"] .clip-chip[data-slot="1"]`);
check('Wechsel ist vorgemerkt', (await project()).tracks[1].queued === 1);
await page.waitForTimeout(2200);
check('Wechsel ist ausgeführt', (await project()).tracks[1].clip === 1);

await page.click('#play');
await page.waitForTimeout(200);
check('Transport stoppt', !(await page.evaluate(() => window.blockwerk.transport.playing)));

// Schritt setzen: tippen schaltet aus -> an -> Akzent -> aus
const cell = page.locator('.track').first().locator('.cell').nth(1);
const stepState = async () => (await project()).tracks[0].clips[0].steps[1].on;
await cell.click();
const afterFirst = await stepState();
await cell.click();
const afterSecond = await stepState();
await cell.click();
const afterThird = await stepState();
check('Tippen schaltet Schritt durch', afterFirst === 1 && afterSecond === 2 && afterThird === 0,
  `${afterFirst} -> ${afterSecond} -> ${afterThird}`);

// Ziehen ändert die Tonhöhe
const bassCell = page.locator('.track').nth(3).locator('.cell').first();
const box = await bassCell.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 50, { steps: 6 });
await page.mouse.up();
const dragged = (await project()).tracks[3].clips[0].steps[0];
check('Senkrechtes Ziehen verschiebt die Stufe', dragged.deg > 0 && dragged.on > 0,
  `Stufe ${dragged.deg}`);

// Mute und Solo
await page.click('.track[data-id="' + start.tracks[2].id + '"] [data-act="mute"]');
check('Mute gesetzt', (await project()).tracks[2].mix.mute === true);
await page.click('.track[data-id="' + start.tracks[2].id + '"] [data-act="solo"]');
check('Solo gesetzt', (await project()).tracks[2].mix.solo === true);

// Spur hinzufügen
await page.click('[data-act="add-track"]');
check('Spur hinzugefügt', (await project()).tracks.length === 6);

// Textmodus
await page.click('[data-act="toggle-text"]');
await page.fill('[data-role="clip-text"]', 'x . x .  X . . .  x3 . . .  . . . x');
await page.click('[data-act="apply-text"]');
const fromText = (await project()).tracks[5].clips[0].steps;
check('Text wird in Schritte übersetzt',
  fromText[0].on === 1 && fromText[4].on === 2 && fromText[8].deg === 3 && fromText[15].on === 1);

await page.click('[data-act="toggle-text"]');
await page.click('[data-act="toggle-text"]');
const shown = await page.inputValue('[data-role="clip-text"]');
check('Schritte werden wieder als Text angezeigt', shown.includes('x3'), shown.split('\n')[0]);

// Mehrtaktige Clips
await page.selectOption('[data-act="bars"]', '2');
const twoBars = (await project()).tracks[5].clips[0];
check('Clip auf zwei Takte verlängert', twoBars.bars === 2 && twoBars.steps.length === 32);
check('Taktreiter erscheinen', (await page.$$('.bar-tab')).length === 2);

// Klang-Ansicht der ausgewählten Spur
await page.click('[data-view="sound"]');
await page.waitForTimeout(100);
check('Klang-Ansicht zeigt die gewählte Spur',
  (await page.textContent('.block-track h3')).trim() === (await project()).tracks[5].name);

const chipCount = (await page.$$('#palette .chip')).length;
for (const chip of await page.$$('#palette .chip')) { await chip.click(); await page.waitForTimeout(20); }
check('Alle Effekte anhängbar', (await project()).tracks[5].chain.length === chipCount,
  (await project()).tracks[5].chain.map((b) => b.type).join(' > '));

await page.evaluate(() => {
  document.querySelectorAll('#rack input[type=range]').forEach((el, i) => {
    el.value = i % 2 ? el.max : Math.round(Number(el.max) * 0.25);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.querySelectorAll('#rack select').forEach((el) => {
    el.selectedIndex = el.options.length - 1;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
});
await page.waitForTimeout(150);
check('Regler und Quellenwechsel ohne Fehler', true);

await page.selectOption('#presets', '3'); // Kick
await page.waitForTimeout(100);
check('Klang-Preset angewendet', (await project()).tracks[5].source.type === 'perc');

// Klaviatur spielt die gewählte Spur
await page.click('[data-view="seq"]');
await page.keyboard.down('a');
await page.waitForTimeout(200);
const held = await page.evaluate(() => window.blockwerk.engine.voiceCount());
await page.keyboard.up('a');
check('Klaviatur spielt', held >= 1, `${held} Stimmen`);

// Tempo, Swing, Tonart
await page.fill('#tempo', '140');
await page.selectOption('#scale', 'major');
await page.evaluate(() => {
  const s = document.querySelector('#swing');
  s.value = '30';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
const settings = await project();
check('Tempo, Skala und Swing übernommen',
  settings.tempo === 140 && settings.scale === 'major' && Math.abs(settings.swing - 0.3) < 0.001);

// Persistenz
await page.waitForTimeout(500);
const before = await project();
await page.reload({ waitUntil: 'networkidle' });
const after = await project();
check('Set überlebt den Reload',
  after.tracks.length === before.tracks.length && after.tempo === 140 && after.tracks[5].source.type === 'perc');

// Leeres Set
await page.click('#new-project');
check('Neues Set startet leer', (await project()).tracks.length === 1);
await page.click('#demo-project');
check('Demo-Set wieder ladbar', (await project()).tracks.length === 5);

await page.screenshot({ path: 'tests/screenshot.png', fullPage: true });
await browser.close();
await server.close();

errors.forEach((e) => console.log(' -', e));
const failed = checks.filter((c) => !c).length + errors.length;
console.log(failed ? `\n${failed} Fehler` : '\nAlle Oberflächentests bestanden.');
process.exit(failed ? 1 : 0);
