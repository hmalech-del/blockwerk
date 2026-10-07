// Komplexitätsbudget. „Das UI ist überfrachtet" ist ein Gefühl und damit
// unverhandelbar; eine Zahl ist verhandelbar. Dieser Test zählt, wie viele
// Bedienelemente eine Ansicht gleichzeitig zeigt, und schlägt an, wenn eine
// Ansicht wächst.
//
// Der Sinn ist nicht, Funktionen zu verhindern. Der Sinn ist, dass jede neue
// Funktion eine bewusste Entscheidung erzwingt: entweder sie passt ins Budget,
// oder etwas anderes geht weg, wird zusammengefasst oder wandert eine Ebene
// tiefer. Wer das Budget hebt, muss es hier begründen – im Diff sichtbar.
//
// Gezählt wird nur, was man sieht, ohne zu scrollen oder etwas aufzuklappen:
// sichtbare Knöpfe, Regler, Felder und Auswahlen.

import { chromium } from 'playwright';
import { startServer } from './server.mjs';

// Obergrenze je Ansicht, inklusive der immer sichtbaren Kopf- und Reiterzeile.
// Begründung der Zahlen: gemessener Stand bei 0.10.0 plus etwas Luft, damit
// eine einzelne Ergänzung nicht sofort anschlägt, zwei aber schon.
const BUDGET = {
  live: 64,     // Streifen, Pads, Szenen, vier Regler
  seq: 150,     // das Raster selbst ist 16 Felder je Spur – hier zählt der Rand
  sound: 60,    // eine Blockkette ist naturgemäß reglerreich
  sampler: 40,
  script: 40,
};

// Die Kopfleiste ist auf jeder Ansicht zu sehen und hat ihr eigenes Budget.
const TOPBAR_BUDGET = 16;

const server = await startServer(8133);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(server.url, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

const checks = [];
const check = (label, ok, info = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok    ' : 'FEHLER'} ${label}${info ? ` (${info})` : ''}`);
};

const countIn = (selector) => page.evaluate((sel) => {
  const root = document.querySelector(sel);
  if (!root) return { total: 0, missing: true };
  const nodes = [...root.querySelectorAll('button, input, select, textarea, [role="button"]')];
  const visible = nodes.filter((el) => {
    if (el.hidden || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  });
  const byKind = {};
  for (const el of visible) {
    const kind = el.tagName === 'INPUT' ? `input:${el.type}` : el.tagName.toLowerCase();
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  return { total: visible.length, byKind };
}, selector);

const topbar = await countIn('.topbar');
check('Kopfleiste bleibt im Budget', topbar.total <= TOPBAR_BUDGET,
  `${topbar.total} von ${TOPBAR_BUDGET} · ${Object.entries(topbar.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}`);

const report = [];
for (const [view, budget] of Object.entries(BUDGET)) {
  await page.click(`[data-view="${view}"]`);
  await page.waitForTimeout(140);
  const panel = await countIn(`[data-panel="${view}"]`);
  report.push({ view, ...panel, budget });
  check(`Ansicht „${view}" bleibt im Budget`, panel.total <= budget,
    `${panel.total} von ${budget}`);
}

// Eine zweite Zahl, die mehr über Spielbarkeit sagt als die reine Menge: wie
// groß ist das kleinste Ziel, das man im Dunkeln treffen muss? Alles unter
// 28 px trifft auf der Bühne niemand zuverlässig – ausgenommen das Raster,
// das bewusst dicht ist und mit dem Finger gezogen wird.
const tiny = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    if (el.hidden || el.closest('[hidden]')) continue;
    if (el.classList.contains('cell') || el.classList.contains('marker')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (Math.min(r.width, r.height) < 28) {
      out.push(`${el.className || el.id || el.tagName}: ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }
  return out;
});
check('Jedes Ziel ist im Dunkeln treffbar', tiny.length === 0, tiny.slice(0, 4).join(' · '));

// Bis hier wurde nur der kalte Zustand gezaehlt – vor der ersten Geste. Der
// Zustand, in dem gespielt wird, ist der warme, und genau der gehoert gezaehlt:
// die Zuendung zeigt dann die Taktanzeige statt des Startknopfes, also ein
// Bedienelement weniger. Ein Knopf, der nur sagt, dass alles laeuft, kostet
// Platz und Aufmerksamkeit und bringt nichts.
await page.click('[data-view="live"]');
await page.click('#play');
await page.waitForTimeout(300);
const warm = await page.evaluate(() => window.blockwerk.engine.running);
const topbarWarm = await countIn('.topbar');
check('Kopfleiste ist warm kleiner als kalt', warm && topbarWarm.total === topbar.total - 1,
  `warm ${topbarWarm.total} von ${TOPBAR_BUDGET}, kalt ${topbar.total}`);
check('Kopfleiste bleibt auch warm im Budget', topbarWarm.total <= TOPBAR_BUDGET,
  `${topbarWarm.total} von ${TOPBAR_BUDGET} · ${Object.entries(topbarWarm.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}`);

// Die harte Zusage der Zuendung: ein Platz, drei Zustaende, EINE Breite. Wenn
// der Kasten beim Zustandswechsel atmet, wandert #play unter dem Finger weg –
// und der Tipper, der das Set starten sollte, beendet es.
const ZUSTAENDE = ['kalt', 'warm', 'gestoert', 'geschlossen'];
for (const width of [390, 820, 1024, 1440, 1920]) {
  const probe = await browser.newPage({ viewport: { width, height: 800 } });
  await probe.goto(server.url, { waitUntil: 'networkidle' });
  await probe.evaluate(() => localStorage.clear());
  await probe.reload({ waitUntil: 'networkidle' });
  const breite = async () => probe.evaluate(() => {
    const el = document.querySelector('.zuendung');
    return { zustand: el.dataset.state, w: el.getBoundingClientRect().width };
  });
  const gemessen = [await breite()];
  await probe.click('#play');                                           // -> warm
  await probe.waitForTimeout(250);
  gemessen.push(await breite());
  await probe.evaluate(() => window.blockwerk.engine.ctx.suspend());    // -> gestoert
  await probe.waitForTimeout(250);
  gemessen.push(await breite());
  await probe.evaluate(() => {                                          // -> geschlossen
    window.blockwerk.transport.stop();
    return window.blockwerk.engine.ctx.close();
  });
  await probe.waitForTimeout(250);
  gemessen.push(await breite());
  await probe.close();

  const reihenfolge = gemessen.map((g) => g.zustand).join(' → ');
  const spanne = Math.max(...gemessen.map((g) => g.w)) - Math.min(...gemessen.map((g) => g.w));
  const soll = width <= 1340 ? 162 : 182;
  check(`Zündung hält ihre Breite bei ${width} px`,
    spanne <= 1 && reihenfolge === ZUSTAENDE.join(' → ') && Math.abs(gemessen[0].w - soll) <= 1,
    `${gemessen.map((g) => Math.round(g.w)).join('/')} px (${reihenfolge}), Soll ${soll}, Spanne ${spanne.toFixed(1)} px`);
}

console.log('\nBudget je Ansicht:');
for (const r of report) {
  const kinds = Object.entries(r.byKind || {}).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`  ${r.view.padEnd(8)} ${String(r.total).padStart(3)} / ${r.budget}   ${kinds}`);
}

await browser.close();
await server.close();
const failed = checks.filter((c) => !c).length;
console.log(failed
  ? `\n${failed} Überschreitung(en). Entweder etwas weglassen, zusammenfassen – oder die Zahl hier bewusst heben.`
  : '\nDie Oberfläche bleibt im Budget.');
process.exit(failed ? 1 : 0);
