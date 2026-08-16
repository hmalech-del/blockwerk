// Oberflächentest: Audio an/aus, Kette bauen, sortieren, spielen, Presets,
// Persistenz. Bricht bei jedem Konsolenfehler ab.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer(8126);
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const checks = [];
const check = (label, ok, info = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok    ' : 'FEHLER'} ${label}${info ? ` (${info})` : ''}`);
};
const state = () => page.evaluate(() => window.blockwerk.engine.ctx?.state);
const patch = () => page.evaluate(() => window.blockwerk.patch());

await page.goto(server.url, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

// Power-Button schaltet um statt sich selbst zu überholen
await page.click('#power');
await page.waitForTimeout(200);
check('Audio startet', (await state()) === 'running');
await page.click('#power');
await page.waitForTimeout(150);
check('Audio pausiert', (await state()) === 'suspended');
await page.click('#power');
await page.waitForTimeout(150);
check('Audio startet erneut', (await state()) === 'running');

// Alle Effekte anhängen
const chips = await page.$$('#palette .chip');
for (const chip of chips) { await chip.click(); await page.waitForTimeout(20); }
check('Alle Blöcke hinzugefügt', (await patch()).chain.length === 2 + chips.length,
  (await patch()).chain.map((b) => b.type).join(' > '));

// Spielen über Computertastatur (auch mit fokussiertem Button)
await page.keyboard.down('a');
await page.waitForTimeout(350);
const voices = await page.evaluate(() => window.blockwerk.engine.voices.size);
const level = await page.evaluate(() => window.blockwerk.engine.level());
await page.keyboard.up('a');
check('Note klingt', voices === 1 && level > 0.001, `Stimmen=${voices}, Pegel=${level.toFixed(4)}`);

await page.waitForTimeout(1200);
check('Stimme wird nach Loslassen freigegeben',
  (await page.evaluate(() => window.blockwerk.engine.voices.size)) === 0);

// Bildschirmklaviatur
const key = (await page.$$('.key.white'))[2];
await key.hover();
await page.mouse.down();
await page.waitForTimeout(120);
const clickVoices = await page.evaluate(() => window.blockwerk.engine.voices.size);
await page.mouse.up();
check('Bildschirmtaste spielt', clickVoices === 1);

// Alle Regler und Auswahlfelder durchfahren
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
await page.waitForTimeout(200);
check('Regler ohne Fehler bedienbar', true);

// Quellen wechseln und jeweils anspielen
for (const type of ['noise', 'fm', 'osc']) {
  await page.selectOption('select[data-act="source-type"]', type);
  await page.waitForTimeout(60);
  await page.keyboard.down('s');
  await page.waitForTimeout(120);
  await page.keyboard.up('s');
}
check('Quellenwechsel', (await patch()).source.type === 'osc');

// Sortieren, Bypass, Entfernen
const firstType = (await patch()).chain[0].type;
await page.locator('.block-fx [data-act="move"][data-dir="1"]').first().click();
check('Block verschoben', (await patch()).chain[1].type === firstType);
await page.locator('.block-fx [data-act="bypass"]').first().click();
check('Bypass gesetzt', (await patch()).chain[0].bypass === true);
const before = (await patch()).chain.length;
await page.locator('.block-fx [data-act="remove"]').first().click();
check('Block entfernt', (await patch()).chain.length === before - 1);

// Presets
const presetCount = await page.evaluate(() => document.querySelectorAll('#presets option').length - 1);
for (let i = 0; i < presetCount; i++) {
  await page.selectOption('#presets', String(i));
  await page.waitForTimeout(80);
  await page.keyboard.down('d');
  await page.waitForTimeout(120);
  await page.keyboard.up('d');
}
check('Presets geladen', (await patch()).chain.length > 0, (await patch()).name);

// Leeres Patch bleibt spielbar
await page.click('#new-patch');
await page.waitForTimeout(80);
await page.keyboard.down('f');
await page.waitForTimeout(150);
const dryVoices = await page.evaluate(() => window.blockwerk.engine.voices.size);
await page.keyboard.up('f');
check('Leere Kette spielt direkt in den Master', dryVoices === 1 && (await patch()).chain.length === 0);

// Persistenz
await page.waitForTimeout(400);
const name = (await patch()).name;
await page.reload({ waitUntil: 'networkidle' });
check('Patch überlebt Reload', (await patch()).name === name);

await browser.close();
await server.close();

errors.forEach((e) => console.log(' -', e));
const failed = checks.filter((c) => !c).length + errors.length;
console.log(failed ? `\n${failed} Fehler` : '\nAlle Oberflächentests bestanden.');
process.exit(failed ? 1 : 0);
