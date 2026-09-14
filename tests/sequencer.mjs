// Timing- und Modelltest: Läuft der Sequenzer im Takt, greifen Clipwechsel
// erst an der Quantisierungsgrenze, stimmen Skala und Textformat?
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const server = await startServer(8127);
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(server.url, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

const checks = [];
const check = (label, ok, info = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok    ' : 'FEHLER'} ${label}${info ? ` (${info})` : ''}`);
};

// --------------------------------------------------- Textformat und Skala

const pure = await page.evaluate(async () => {
  const { parseSteps, stepsToText } = await import('/js/pattern.js');
  const { degToMidi } = await import('/js/project.js');
  const text = 'x . . .  X . . x  3 . -2 .  x5 . . .';
  const steps = parseSteps(text, 1);
  const printed = stepsToText(steps);
  return {
    // Kurzformen werden beim Ausgeben vereinheitlicht (3 -> x3); ab da
    // muss Lesen und Schreiben aber deckungsgleich bleiben.
    roundtrip: stepsToText(parseSteps(printed, 1)).replace(/\s+/g, ' ').trim(),
    source: printed.replace(/\s+/g, ' ').trim(),
    canonical: printed.replace(/\s+/g, ' ').trim() === 'x . . . X . . x x3 . x-2 . x5 . . .',
    count: steps.length,
    accent: steps[4].on,
    negative: steps[10].deg,
    padded: parseSteps('x', 1).length,
    truncated: parseSteps(Array(40).fill('x').join(' '), 1).length,
    // Moll ab C3: Stufe 0,2,7 -> C3, D#3(=3 Halbtöne), C4
    scale: [degToMidi(0, 48, 'minor'), degToMidi(2, 48, 'minor'), degToMidi(7, 48, 'minor'), degToMidi(-1, 48, 'minor')],
  };
});
check('Kurzformen werden vereinheitlicht', pure.canonical, pure.source);
check('Text -> Schritte -> Text ist stabil', pure.roundtrip === pure.source, pure.roundtrip);
check('Akzent und negative Stufe gelesen', pure.accent === 2 && pure.negative === -2);
check('Zu kurzer Text wird aufgefüllt, zu langer beschnitten', pure.padded === 16 && pure.truncated === 16);
check('Skalenstufen rechnen richtig', JSON.stringify(pure.scale) === JSON.stringify([48, 51, 60, 46]), pure.scale.join(','));

// ------------------------------------------------------------ Timing

await page.click('#power');
await page.waitForTimeout(200);

const timing = await page.evaluate(async () => {
  const { engine, transport, project } = window.blockwerk;
  const p = project();
  p.tempo = 120;      // Sechzehntel = 0,125 s
  p.swing = 0;
  const kick = p.tracks[0];
  const log = [];
  const original = engine.noteOn.bind(engine);
  engine.noteOn = (trackId, midi, when, opts) => {
    log.push({ trackId, midi, when, dur: opts?.dur });
    return null; // nichts wirklich klingen lassen
  };
  transport.start();
  await new Promise((r) => setTimeout(r, 2100));
  transport.stop();
  engine.noteOn = original;

  const kickHits = log.filter((e) => e.trackId === kick.id).map((e) => e.when).sort((a, b) => a - b);
  const gaps = kickHits.slice(1).map((t, i) => t - kickHits[i]);
  return {
    kicks: kickHits.length,
    gaps,
    dur: log[0]?.dur,
    tracksHeard: new Set(log.map((e) => e.trackId)).size,
  };
});

// Kick liegt im Demo-Set auf jeder Viertel -> 0,5 s bei 120 bpm
const worstGap = Math.max(...timing.gaps.map((g) => Math.abs(g - 0.5)));
check('Kick trifft jede Viertel', timing.kicks >= 3, `${timing.kicks} Treffer in 2 s`);
check('Abstände sind sample-genau', worstGap < 0.0005, `max. Abweichung ${(worstGap * 1000).toFixed(3)} ms`);
check('Notenlänge folgt dem Gate', timing.dur > 0 && timing.dur < 0.2, `${timing.dur?.toFixed(3)} s`);
check('Mehrere Spuren spielen', timing.tracksHeard >= 4, `${timing.tracksHeard} Spuren`);

// --------------------------------------------------- Quantisierter Wechsel

const queueing = await page.evaluate(async () => {
  const { transport, project } = window.blockwerk;
  const p = project();
  p.tempo = 240;          // ein Takt = 1 s
  p.quantize = 16;
  const track = p.tracks[0];
  track.clip = 0;
  transport.start();
  await new Promise((r) => setTimeout(r, 120));

  transport.queueClip(track.id, 1);
  const rightAfterTap = { clip: track.clip, queued: track.queued };
  await new Promise((r) => setTimeout(r, 1300)); // über die Taktgrenze hinweg
  const afterBar = { clip: track.clip, queued: track.queued };

  // Zweiter Fall: Wechsel wieder abbestellen
  transport.queueClip(track.id, 0);
  transport.queueClip(track.id, 1);
  const cancelled = track.queued;
  transport.stop();
  return { rightAfterTap, afterBar, cancelled };
});
check('Clip wartet auf die Taktgrenze',
  queueing.rightAfterTap.clip === 0 && queueing.rightAfterTap.queued === 1);
check('Clip wechselt an der Taktgrenze',
  queueing.afterBar.clip === 1 && queueing.afterBar.queued === null,
  `Slot ${queueing.afterBar.clip}`);
check('Erneutes Tippen auf den laufenden Clip bestellt ab', queueing.cancelled === null);

// ------------------------------------------------------ Stimmen aufräumen

const voices = await page.evaluate(async () => {
  const { engine, transport, project } = window.blockwerk;
  project().tempo = 160;
  transport.start();
  await new Promise((r) => setTimeout(r, 2500));
  const during = engine.voiceCount();
  transport.stop();
  await new Promise((r) => setTimeout(r, 1200));
  return { during, after: engine.voiceCount() };
});
check('Stimmen werden nach dem Stopp freigegeben', voices.after === 0,
  `während des Laufs ${voices.during}, danach ${voices.after}`);

await browser.close();
await server.close();
errors.forEach((e) => console.log(' -', e));
const failed = checks.filter((c) => !c).length + errors.length;
console.log(failed ? `\n${failed} Fehler` : '\nSequenzer-Tests bestanden.');
process.exit(failed ? 1 : 0);
