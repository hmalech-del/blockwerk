// Set-Script: Parser (inklusive Fehlermeldungen), Ausführung an Taktgrenzen,
// Parameterfahrten und der Vorrang der Hand gegenüber dem Plan.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer(8129);
const browser = await chromium.launch();
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
await page.reload({ waitUntil: 'networkidle' });

// ------------------------------------------------------------------ Parser

const parsed = await page.evaluate(async () => {
  const { parseScript } = await import('/js/script.js');
  const p = window.blockwerk.project();
  const run = (text) => parseScript(text, p);

  return {
    demo: run(p.script.text),
    formats: run([
      '# Kommentar wird ignoriert',
      'bar 3   kick=A, snare = B   // auch hier Kommentar',
      'BAR 5',
      '  SCENE hook',
      '  Mute Lead Bass',
    ].join('\n')),
    key: run('key F#2 dorian\nkey c major   # Kommentar hinter dem Befehl'),
    ramp: run('bar 9 bass.filter.freq 300 -> 4000 over 8 bars\nbar 20 master.volume 0.8 -> 0.2'),
    bad: run([
      'tempo 999',
      'drums = A',
      'kick = Z',
      'scene Gibtsnicht',
      'kick.filter.freq 1 -> 2',
      'bass.filter.wobble 1 -> 2',
      'völliger unsinn hier',
      'mute',
    ].join('\n')),
  };
});

check('Demo-Script wird fehlerfrei gelesen',
  parsed.demo.errors.length === 0 && parsed.demo.events.length === 11,
  `${parsed.demo.events.length} Ereignisse`);

const f = parsed.formats;
check('Kommentare, Kommas, Groß-/Kleinschreibung und Blockform',
  f.errors.length === 0 && f.events.length === 4
  && f.events[0].bar === 3 && f.events[1].bar === 3
  && f.events[2].bar === 5 && f.events[2].type === 'scene'
  && f.events[3].type === 'mute' && f.events[3].trackIds.length === 2,
  f.errors.map((e) => `Z${e.line}: ${e.message}`).join(' | ') || `${f.events.length} Ereignisse`);

check('Tonart mit und ohne Oktave',
  parsed.key.errors.length === 0
  && parsed.key.events[0].root === 42 && parsed.key.events[0].scale === 'dorian'
  && parsed.key.events[1].root === 48 && parsed.key.events[1].scale === 'major',
  parsed.key.events.map((e) => `${e.root}/${e.scale}`).join(', '));

check('Fahrten mit und ohne Dauer',
  parsed.ramp.errors.length === 0
  && parsed.ramp.events[0].from === 300 && parsed.ramp.events[0].to === 4000 && parsed.ramp.events[0].bars === 8
  && parsed.ramp.events[1].target.kind === 'master' && parsed.ramp.events[1].bars === 0,
  parsed.ramp.errors.map((e) => e.message).join(' | '));

const badLines = parsed.bad.errors.map((e) => e.line);
check('Jeder Fehler wird mit Zeilennummer gemeldet',
  parsed.bad.events.length === 0 && badLines.join(',') === '1,2,3,4,5,6,7,8',
  badLines.join(','));
check('Fehlermeldung nennt die vorhandenen Spuren',
  /Kick/.test(parsed.bad.errors[1].message), parsed.bad.errors[1].message);
check('Fehlermeldung nennt die möglichen Parameter',
  /freq/.test(parsed.bad.errors[5].message), parsed.bad.errors[5].message);
check('Fehlende Effektkette wird erkannt',
  /keinen Effekt/.test(parsed.bad.errors[4].message), parsed.bad.errors[4].message);

// -------------------------------------------------------------- Ausführung

await page.click('#power');
await page.waitForTimeout(200);

const fired = await page.evaluate(async () => {
  const { script, project, engine } = window.blockwerk;
  const p = project();
  p.script.text = [
    'tempo 240',
    'key D major',
    'bar 1  kick=A',
    'bar 2  scene Hook',
    'bar 3  mute lead',
    'bar 4  unmute lead',
  ].join('\n');
  p.script.enabled = true;
  script.compile();

  const seen = [];
  const now = () => engine.ctx.currentTime;
  for (let bar = 1; bar <= 4; bar++) {
    script.onBar(bar, now());
    seen.push({
      bar,
      tempo: p.tempo,
      root: p.root,
      scale: p.scale,
      clips: p.tracks.map((t) => t.clip).join(''),
      leadMuted: p.tracks[4].mix.mute,
    });
  }
  return { seen, errors: script.errors.length };
});

check('Tempo und Tonart greifen bei Takt 1',
  fired.seen[0].tempo === 240 && fired.seen[0].root === 50 && fired.seen[0].scale === 'major',
  `${fired.seen[0].tempo} bpm, root ${fired.seen[0].root}`);
check('Szene greift bei Takt 2', fired.seen[1].clips === '01111', fired.seen[1].clips);
check('mute greift bei Takt 3', fired.seen[2].leadMuted === true);
check('unmute greift bei Takt 4', fired.seen[3].leadMuted === false);

// ----------------------------------------------------------------- Fahrten

const ramp = await page.evaluate(async () => {
  const { script, project } = window.blockwerk;
  const p = project();
  p.script.text = 'bar 1 bass.filter.freq 400 -> 2400 over 4 bars';
  p.script.enabled = true;
  script.compile();
  const freq = () => p.tracks[3].chain.find((b) => b.type === 'filter').params.freq;

  const at = (bars) => { script.updateRamps(bars * 16); return Math.round(freq()); };
  return { start: at(0), quarter: at(1), half: at(2), past: at(9) };
});
check('Fahrt beginnt beim Startwert', ramp.start === 400, `${ramp.start} Hz`);
check('Fahrt läuft gleichmäßig', ramp.quarter === 900 && ramp.half === 1400,
  `${ramp.quarter} Hz nach 1 Takt, ${ramp.half} Hz nach 2 Takten`);
check('Fahrt endet genau auf dem Zielwert', ramp.past === 2400, `${ramp.past} Hz`);

// ----------------------------------------------- Hand hat Vorrang vor Plan

const override = await page.evaluate(async () => {
  const { script, transport, project, engine } = window.blockwerk;
  const p = project();
  p.script.text = ['bar 1 kick=A', 'bar 8 kick=A'].join('\n');
  p.script.enabled = true;
  script.compile();

  script.onBar(1, engine.ctx.currentTime);
  const afterScript = p.tracks[0].clip;
  p.tracks[0].clip = 1;              // von Hand umgeschaltet
  script.onBar(2, engine.ctx.currentTime);
  script.onBar(3, engine.ctx.currentTime);
  const stillManual = p.tracks[0].clip;
  script.onBar(8, engine.ctx.currentTime);
  const scriptAgain = p.tracks[0].clip;
  return { afterScript, stillManual, scriptAgain };
});
check('Script setzt bei seinem Ereignis', override.afterScript === 0);
check('Zwischen den Ereignissen bleibt die Handauswahl stehen', override.stillManual === 1);
check('Beim nächsten Ereignis übernimmt das Script wieder', override.scriptAgain === 0,
  `Slot ${override.scriptAgain}`);

// ------------------------------------------------------- Echtlauf mit Uhr

const live = await page.evaluate(async () => {
  const { script, transport, project } = window.blockwerk;
  const p = project();
  p.tempo = 240;                       // ein Takt = 1 s
  p.script.text = ['tempo 240', 'bar 2 mute kick', 'bar 3 end'].join('\n');
  p.script.enabled = true;
  script.compile();
  script.reset();
  transport.start();
  await new Promise((r) => setTimeout(r, 1400));
  const mutedAfterBar2 = p.tracks[0].mix.mute;
  await new Promise((r) => setTimeout(r, 1400));
  const playing = transport.playing;
  transport.stop();
  p.tracks[0].mix.mute = false;
  return { mutedAfterBar2, playing };
});
check('Ereignis feuert im laufenden Betrieb', live.mutedAfterBar2 === true);
check('„end" hält die Wiedergabe an', live.playing === false);

// ------------------------------------- Effekte, Muster und Regler im Script

const structural = await page.evaluate(async () => {
  const { script, project, engine } = window.blockwerk;
  const p = project();
  const lead = p.tracks[4];
  p.script.text = [
    'bar 1  add lead crusher',
    'bar 2  bypass lead delay on',
    'bar 3  pattern lead C = x . . . X . . . x3 . . . . . . x',
    'bar 4  control 1 lead.crusher.bits 1 8 as Crush',
    'bar 5  remove lead crusher',
  ].join('\n');
  p.script.enabled = true;
  script.compile();
  const errors = script.errors.map((e) => e.message);

  const seen = {};
  script.onBar(1, engine.ctx.currentTime);
  seen.added = lead.chain.map((b) => b.type).join('>');
  seen.inGraph = engine.tracks.get(lead.id).instances.size;
  script.onBar(2, engine.ctx.currentTime);
  seen.bypassed = lead.chain.find((b) => b.type === 'delay')?.bypass;
  script.onBar(3, engine.ctx.currentTime);
  seen.pattern = lead.clips[2] ? lead.clips[2].steps.filter((st) => st.on).length : 0;
  seen.patternDeg = lead.clips[2]?.steps[8]?.deg;
  seen.accent = lead.clips[2]?.steps[4]?.on;
  script.onBar(4, engine.ctx.currentTime);
  seen.macro = p.macros[0] && { label: p.macros[0].label, min: p.macros[0].min, max: p.macros[0].max };
  script.onBar(5, engine.ctx.currentTime);
  seen.removed = lead.chain.map((b) => b.type).join('>');
  return { errors, seen };
});

check('Script-Befehle für Effekte werden gelesen', structural.errors.length === 0,
  structural.errors.join(' | '));
check('„add" hängt einen Effekt an und verkabelt ihn',
  structural.seen.added === 'delay>reverb>crusher' && structural.seen.inGraph === 3,
  structural.seen.added);
check('„bypass" schaltet einen Effekt stumm', structural.seen.bypassed === true);
check('„pattern" schreibt einen Clip', structural.seen.pattern === 4 && structural.seen.patternDeg === 3
  && structural.seen.accent === 2, `${structural.seen.pattern} Schritte`);
check('„control" belegt einen Live-Regler',
  structural.seen.macro?.label === 'Crush' && structural.seen.macro.min === 1 && structural.seen.macro.max === 8,
  JSON.stringify(structural.seen.macro));
check('„remove" nimmt den Effekt wieder weg',
  structural.seen.removed === 'delay>reverb', structural.seen.removed);

// Ein im Script hinzugefügter Effekt muss auch Regler bekommen
await page.evaluate(() => {
  const { script, project, engine } = window.blockwerk;
  const p = project();
  p.script.text = 'bar 1 add lead crusher';
  script.compile();
  script.reset();
  script.onBar(1, engine.ctx.currentTime);
});
await page.click('[data-view="sound"]');
await page.waitForTimeout(150);
await page.evaluate(() => {
  const p = window.blockwerk.project();
  window.blockwerk.rack.hooks.onSelectTrack(p.tracks[4].id);
});
await page.waitForTimeout(150);
const crusherBlock = await page.evaluate(() =>
  [...document.querySelectorAll('.block-fx h3')].map((h) => h.textContent.trim()));
check('Der neue Effekt ist sofort regelbar', crusherBlock.includes('Crusher'),
  crusherBlock.join(', '));
await page.click('[data-view="live"]');

// Script während der Wiedergabe ändern
const liveEdit = await page.evaluate(async () => {
  const { script, transport, project, engine } = window.blockwerk;
  const p = project();
  p.tempo = 240;
  p.script.text = 'bar 2 mute hihat';
  p.script.enabled = true;
  script.compile();
  script.reset();
  transport.start();
  await new Promise((r) => setTimeout(r, 1300));   // Takt 2 ist durch
  const mutedFirst = p.tracks[2].mix.mute;

  // im Laufen ein neues Ereignis einsetzen
  p.script.text = 'bar 2 mute hihat\nbar 4 unmute hihat';
  script.compile();
  const refiredImmediately = p.tracks[2].mix.mute;
  await new Promise((r) => setTimeout(r, 2500));
  const afterBar4 = p.tracks[2].mix.mute;
  transport.stop();
  p.tracks[2].mix.mute = false;
  return { mutedFirst, refiredImmediately, afterBar4 };
});
check('Script lässt sich im Laufen ändern', liveEdit.mutedFirst === true && liveEdit.afterBar4 === false,
  `Takt 2 stumm: ${liveEdit.mutedFirst}, nach Takt 4 frei: ${liveEdit.afterBar4 === false}`);

// -------------------------------------------------------------- Oberfläche

await page.click('[data-view="script"]');
await page.waitForTimeout(100);
await page.fill('[data-role="text"]', 'bar 1 kick=A\nbar 2 kaputt hier');
await page.click('[data-act="apply"]');
await page.waitForTimeout(100);
check('Fehler erscheinen im Reiter mit Zeilennummer',
  (await page.textContent('.script-errors')).includes('Zeile 2'),
  (await page.textContent('.script-errors')).trim().slice(0, 60));
check('Statuszeile meldet Fehler', (await page.textContent('.script-status')).includes('Fehler'));

await page.click('[data-act="example"]');
await page.waitForTimeout(150);
check('Beispiel lässt sich einsetzen und ist fehlerfrei',
  (await page.textContent('.script-status')).includes('Ereignisse'),
  await page.textContent('.script-status'));
check('Script bleibt im Projekt gespeichert',
  (await project()).script.text.includes('scene Hook'));

// Script-Vorschau in der Live-Ansicht
await page.click('[data-view="live"]');
await page.waitForTimeout(150);
check('Live-Ansicht zeigt die nächsten Script-Schritte',
  await page.isVisible('.script-next .script-step'),
  (await page.textContent('.script-next'))?.trim().replace(/\s+/g, ' ').slice(0, 50));

await page.click('[data-view="script"]');
await page.waitForTimeout(100);
check('Schalter zeigt den gespeicherten Zustand',
  await page.isChecked('[data-act="enabled"]'));
await page.uncheck('[data-act="enabled"]');
await page.click('[data-view="live"]');
await page.waitForTimeout(150);
check('Ausgeschaltetes Script zeigt keine Vorschau', !(await page.isVisible('.script-next')));

await browser.close();
await server.close();
errors.forEach((e) => console.log(' -', e));
const failed = checks.filter((c) => !c).length + errors.length;
console.log(failed ? `\n${failed} Fehler` : '\nScript-Tests bestanden.');
process.exit(failed ? 1 : 0);
