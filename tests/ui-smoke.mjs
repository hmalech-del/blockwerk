// Oberflächentest: Audio an/aus, Schritte setzen, Clips, Spuren, Klangkette,
// Textmodus, Persistenz. Bricht bei jedem Konsolenfehler ab.
import { stat } from 'node:fs/promises';
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

// Startansicht ist Live – fuer diesen Test in den Sequenzer wechseln.
await page.click('[data-view="seq"]');
check('Reiterwechsel zum Sequenzer', await page.isVisible('#sequencer .track'));

// Die erste Geste irgendwo auf der Seite startet den Ton bereits – hier war
// das der Reiterwechsel.
await page.waitForTimeout(200);
check('Erste Geste startet Audio', (await state()) === 'running');

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

// Schritt setzen: tippen schaltet aus -> an -> Akzent -> Geist -> aus
const cell = page.locator('.track').first().locator('.cell').nth(1);
const stepState = async () => (await project()).tracks[0].clips[0].steps[1].on;
await cell.click();
const afterFirst = await stepState();
await cell.click();
const afterSecond = await stepState();
await cell.click();
const afterThird = await stepState();
await cell.click();
const afterFourth = await stepState();
check('Die Geisternote ist ein eigener Zustand', afterThird === 3,
  `dritter Tipp ergibt ${afterThird}`);
check('Tippen schaltet Schritt durch',
  afterFirst === 1 && afterSecond === 2 && afterFourth === 0,
  `${afterFirst} -> ${afterSecond} -> ${afterThird} -> ${afterFourth}`);

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

// Spurwechsel direkt im Klang-Reiter
await page.click('.track-pick:nth-child(2)');
await page.waitForTimeout(100);
check('Spurauswahl im Klang-Reiter',
  (await page.textContent('.block-track h3')).trim() === (await project()).tracks[1].name,
  await page.textContent('.block-track h3'));
// Der letzte Eintrag im Waehler ist der Master – die letzte Spur steht davor.
await page.locator('.track-pick:not(.master)').last().click();
await page.waitForTimeout(100);

await page.selectOption('#presets', '3'); // Kick
await page.waitForTimeout(100);
check('Klang-Preset angewendet', (await project()).tracks[5].source.type === 'perc');
const trackControls = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.block-track .param-label')].map((e) => e.textContent.trim());
  const scaleSelect = [...document.querySelectorAll('.block-track select')]
    .find((s) => s.options[0]?.textContent.includes('wie das Set'));
  return { labels, hatStimmung: !!scaleSelect, erste: scaleSelect?.options[0].textContent };
});
check('Spur hat Versatz und eigene Stimmung',
  trackControls.labels.includes('Versatz') && trackControls.hatStimmung,
  trackControls.labels.join(', '));

const octaveText = await page.evaluate(() => {
  const label = [...document.querySelectorAll('.block-track .param')]
    .find((el) => el.querySelector('.param-label')?.textContent.trim() === 'Oktave');
  return label?.querySelector('.param-value')?.textContent.trim();
});
check('Ganzzahlige Regler ohne Nachkommastellen', /^-?\d+$/.test(octaveText || ''), octaveText);

// Klaviatur spielt die gewählte Spur
await page.click('[data-view="seq"]');
await page.waitForTimeout(100);
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

// ------------------------------------------------ Summe, Duck, MIDI, Tape

await page.click('[data-view="sound"]');
await page.waitForTimeout(100);
await page.click('.track-pick.master');
await page.waitForTimeout(120);
const masterView = await page.evaluate(() => ({
  titel: document.querySelector('.block-master h3')?.textContent.trim(),
  keineQuelle: !document.querySelector('.block-source'),
  pegel: !!document.querySelector('.block-master input[type="range"]'),
}));
check('Der Master ist ein eigenes Ziel im Klang-Reiter',
  masterView.titel === 'Master' && masterView.keineQuelle && masterView.pegel,
  `${masterView.titel}, Quelle versteckt ${masterView.keineQuelle}`);

await page.click('.palette button[data-type="filter"]');
await page.waitForTimeout(150);
const masterChain = await page.evaluate(() => {
  const p = window.blockwerk.project();
  return {
    kette: p.master.chain.map((b) => b.type).join(','),
    spurUnberuehrt: p.tracks.every((t) => !t.chain.some((b) => b.id === p.master.chain[0]?.id)),
    bloecke: document.querySelectorAll('.block-fx').length,
    verdrahtet: window.blockwerk.engine.masterChain?.instances.size ?? -1,
  };
});
check('Ein Effekt landet in der Summe, nicht auf einer Spur',
  masterChain.kette === 'filter' && masterChain.spurUnberuehrt
  && masterChain.bloecke === 1 && masterChain.verdrahtet === 1,
  `Kette ${masterChain.kette}, ${masterChain.bloecke} Block, ${masterChain.verdrahtet} verdrahtet`);

// Der Duck braucht eine Quellspur – die Liste kommt aus dem Set.
await page.click('.palette button[data-type="duck"]');
await page.waitForTimeout(150);
const duckUi = await page.evaluate(() => {
  const sel = [...document.querySelectorAll('.block-fx select')]
    .find((s) => [...s.options].some((o) => o.textContent === 'Kick'));
  if (sel) {
    sel.value = [...sel.options].find((o) => o.textContent === 'Kick').value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const p = window.blockwerk.project();
  const block = p.master.chain.find((b) => b.type === 'duck');
  const inst = [...(window.blockwerk.engine.masterChain?.instances.values() || [])].find((i) => i.duck);
  return {
    hatAuswahl: !!sel,
    gesetzt: block?.params.source === p.tracks[0].id,
    engineHoert: inst?.listensTo === p.tracks[0].id,
  };
});
check('Der Duck lässt sich auf eine Spur hören',
  duckUi.hatAuswahl && duckUi.gesetzt && duckUi.engineHoert,
  `Auswahl ${duckUi.hatAuswahl}, Modell ${duckUi.gesetzt}, Engine ${duckUi.engineHoert}`);

// Die Masterkette muss den Reload überleben – sonst ist sie im Set nichts wert.
await page.waitForTimeout(400);
await page.reload({ waitUntil: 'networkidle' });
const nachReload = await page.evaluate(() => {
  const p = window.blockwerk.project();
  return {
    kette: p.master.chain.map((b) => b.type).join(','),
    quelle: p.master.chain.find((b) => b.type === 'duck')?.params.source === p.tracks[0].id,
  };
});
check('Die Masterkette überlebt den Reload',
  nachReload.kette === 'filter,duck' && nachReload.quelle,
  `${nachReload.kette}, Quelle gemerkt ${nachReload.quelle}`);

// MIDI: ohne Controller laesst sich nichts lernen, aber eine gespeicherte
// Zuordnung muss greifen – das pruefen wir am Modell und am Regler.
const midiTest = await page.evaluate(async () => {
  const { ccKey } = await import('/js/midi.js');
  const p = window.blockwerk.project();
  p.macros[0] = {
    label: 'Sweep', path: 'master.filter.freq',
    target: { kind: 'masterFx', blockType: 'filter', param: 'freq' },
    min: 200, max: 12000,
  };
  p.midi.map[ccKey(0, 74)] = 0;
  window.blockwerk.live.setMidi({ open: true, learning: null, map: p.midi.map });
  window.blockwerk.live.render();
  return {
    schluessel: ccKey(0, 74),
    chip: document.querySelector('.midi-chip')?.textContent.trim(),
    gebunden: !!document.querySelector('.midi-chip.bound'),
  };
});
check('Ein zugeordneter Drehregler steht am Live-Regler',
  midiTest.schluessel === '0:74' && midiTest.chip === 'CC 74' && midiTest.gebunden,
  `${midiTest.chip}`);

const tape = await page.evaluate(() => ({
  knopf: !!document.querySelector('#tape'),
  moeglich: typeof MediaRecorder !== 'undefined',
}));
check('Der Mitschnitt ist erreichbar', tape.knopf && tape.moeglich);

await page.click('#play');
await page.click('#tape');
await page.waitForTimeout(1200);
const taping = await page.evaluate(() => ({
  laeuft: window.blockwerk.engine.taping,
  uhr: document.querySelector('#tape-time')?.hidden === false,
  punkt: document.querySelector('#tape')?.classList.contains('taping'),
}));
check('Der Mitschnitt läuft und zeigt seine Laufzeit', taping.laeuft && taping.uhr,
  `läuft ${taping.laeuft}, Uhr sichtbar ${taping.uhr}`);

// Der Mitschnitt darf nicht luegen. Haelt der Kontext an – Anruf, Tabwechsel –,
// nahm das Band vorher weiter Stille auf: gemessen blieb taping true und die
// Uhr stand bei 0:01, waehrend der rote Punkt blinkte. Jetzt endet der
// Mitschnitt, gibt heraus, was er hat, und sagt es.
const datei = page.waitForEvent('download', { timeout: 8000 }).then(
  async (d) => ({ name: d.suggestedFilename(), pfad: await d.path() }), () => null);
await page.evaluate(() => window.blockwerk.engine.ctx.suspend());
await page.waitForTimeout(1200);
const gerettet = await datei;
const danach = await page.evaluate(() => ({
  laeuft: window.blockwerk.engine.taping,
  uhr: document.querySelector('#tape-time')?.hidden === false,
  punkt: document.querySelector('#tape')?.classList.contains('taping'),
  meldung: document.querySelector('#audio-state')?.hidden === false
    ? document.querySelector('#audio-state').textContent : '',
  zuendung: document.querySelector('#zuendung')?.dataset.state,
}));
check('Der rote Punkt leuchtet nie, ohne dass aufgenommen wird',
  taping.punkt && !danach.laeuft && !danach.punkt && !danach.uhr,
  `vorher Punkt ${taping.punkt}, danach läuft ${danach.laeuft}, Punkt ${danach.punkt}, Uhr ${danach.uhr}`);
check('Das Aufgenommene wird als Datei herausgegeben',
  !!gerettet && /\.webm$/.test(gerettet.name) && (await stat(gerettet.pfad)).size > 0,
  gerettet ? `${gerettet.name}, ${(await stat(gerettet.pfad)).size} Bytes` : 'keine Datei');
check('Die Unterbrechung meldet sich und die Zündung zeigt sie',
  danach.meldung.includes('Mitschnitt') && danach.zuendung === 'gestoert',
  `„${danach.meldung}", Zündung ${danach.zuendung}`);

// Zurueck aus der Stoerung: ein Tipper auf die Zuendung, kein Neustart des Sets.
const vorher = await page.evaluate(() => window.blockwerk.transport.step);
await page.click('#power');
await page.waitForTimeout(400);
const zurueck = await page.evaluate(() => ({
  ctx: window.blockwerk.engine.ctx.state,
  playing: window.blockwerk.transport.playing,
  step: window.blockwerk.transport.step,
  zuendung: document.querySelector('#zuendung')?.dataset.state,
}));
check('„Audio weiter" holt den Ton zurück, ohne das Set von vorn zu beginnen',
  zurueck.ctx === 'running' && zurueck.playing && zurueck.step >= vorher
    && zurueck.zuendung === 'warm',
  `Schritt ${vorher} → ${zurueck.step}, ${zurueck.zuendung}`);

// Die Zusage gilt auch, wenn das Band nie ordentlich zu Ende kommt. Zwei Wege
// dorthin, beide auf iOS denkbar, wenn der Stream mit dem Kontext verschwindet:
// stop() wirft, weil der Recorder sich selbst beendet hat – oder onstop bleibt
// einfach aus. Frueher haette das Versprechen in beiden Faellen gehangen, und
// weil engine.taping schon vorher false ist, waeren roter Punkt und Uhr
// stehengeblieben, waehrend nichts mehr aufnimmt.
const abbruch = async (name, kaputterRecorder) => {
  await page.click('#tape');
  await page.waitForTimeout(1300);   // lang genug fuer den ersten Datenbrocken
  const an = await page.evaluate(() => ({
    laeuft: window.blockwerk.engine.taping,
    punkt: document.querySelector('#tape').classList.contains('taping'),
    uhr: document.querySelector('#tape-time').hidden === false,
  }));
  await page.evaluate(kaputterRecorder);
  const t0 = Date.now();
  await page.evaluate(() => window.blockwerk.engine.ctx.suspend());
  await page.waitForFunction(
    () => !window.blockwerk.engine.taping
      && !document.querySelector('#tape').classList.contains('taping'),
    null, { timeout: 4000 },
  ).catch(() => {});
  const dauer = Date.now() - t0;
  const aus = await page.evaluate(() => ({
    laeuft: window.blockwerk.engine.taping,
    punkt: document.querySelector('#tape').classList.contains('taping'),
    uhr: document.querySelector('#tape-time').hidden === false,
    abgriff: window.__abgriff ?? null,
  }));
  check(`Punkt und Uhr gehen aus, auch wenn ${name}`,
    an.laeuft && an.punkt && an.uhr && !aus.laeuft && !aus.punkt && !aus.uhr && dauer < 2000,
    `vorher Punkt ${an.punkt}/Uhr ${an.uhr}, danach Punkt ${aus.punkt}/Uhr ${aus.uhr} nach ${dauer} ms`);
  await page.click('#power');          // zurueck aus der Stoerung
  await page.waitForTimeout(300);
  return aus;
};

await abbruch('stop() wirft', () => {
  window.blockwerk.engine.tape.rec = {
    stop() { throw new DOMException('schon inactive', 'InvalidStateError'); },
  };
});

// Zweiter Fall zusaetzlich mit Blick auf den Abgriff: er muss auch im
// Fristpfad geloest werden, sonst haengt die Abzweigung am Analyser.
const ohneOnstop = await abbruch('onstop nie feuert', () => {
  const engine = window.blockwerk.engine;
  window.__abgriff = 0;
  const original = engine.analyser.disconnect.bind(engine.analyser);
  engine.analyser.disconnect = (...args) => { window.__abgriff += 1; return original(...args); };
  engine.tape.rec = { stop() { /* schweigt */ } };
});
check('Der Abgriff wird auch im Fristpfad gelöst', ohneOnstop.abgriff === 1,
  `${ohneOnstop.abgriff}× disconnect`);

await page.screenshot({ path: 'tests/screenshot.png', fullPage: true });
await browser.close();
await server.close();

errors.forEach((e) => console.log(' -', e));
const failed = checks.filter((c) => !c).length + errors.length;
console.log(failed ? `\n${failed} Fehler` : '\nAlle Oberflächentests bestanden.');
process.exit(failed ? 1 : 0);
