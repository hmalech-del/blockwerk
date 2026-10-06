// Textform eines Clips – die kleine Sprache, aus der später das Set-Script wird.
//
//   .      Schritt aus
//   x      Schritt an (Stufe 0)
//   X      Schritt an mit Akzent
//   o      Geisternote – leise; davon atmet der Groove
//   x3     Schritt an auf Skalenstufe 3       (auch X3, o3, x-2)
//   3      Kurzform für x3
//   x*3    Roll: drei Anschläge im Schritt    (auch X*4, o*2, x3*6)
//   |      Trenner, wird beim Lesen ignoriert
//
// Beispiel (ein Takt):  x . o .  X . . o  x . . x*3  X . o .

export const STEPS_PER_BAR = 16;

// Vier Zustände je Schritt. Die Reihenfolge ist auch die Tippreihenfolge im
// Raster: aus -> an -> Akzent -> Geist -> aus.
export const OFF = 0;
export const ON = 1;
export const ACCENT = 2;
export const GHOST = 3;
export const STEP_STATES = 4;

// Geisternoten sind der Grund, warum ein Hi-Hat-Muster nach Hand klingt und
// nicht nach Stempel. Mit nur zwei Stufen bleibt jeder Groove eine Maschine.
export const VELOCITY = { [ON]: 0.68, [ACCENT]: 1, [GHOST]: 0.32 };

// Rolls: so viele Anschläge passen in einen Schritt. 3 ergibt auf dem
// 16tel-Raster Sextolen – die Trap-Hi-Hat, ohne das Raster anzufassen.
export const ROLLS = [0, 2, 3, 4, 6];
export const MAX_ROLL = 6;

export function velocityOf(step) {
  return VELOCITY[step?.on] ?? VELOCITY[ON];
}

export function emptyStep() {
  return { on: 0, deg: 0 };
}

export function emptySteps(bars) {
  return Array.from({ length: bars * STEPS_PER_BAR }, emptyStep);
}

const TOKEN = /^([xXo])?(-?\d+)?(?:\*(\d+))?$/;

export function parseSteps(text, bars) {
  const want = bars * STEPS_PER_BAR;
  const tokens = String(text).split(/[\s|]+/).filter(Boolean);
  const steps = [];

  for (const raw of tokens) {
    if (steps.length >= want) break;
    if (raw === '.' || raw === '-' || raw === '_') {
      steps.push(emptyStep());
      continue;
    }
    const m = TOKEN.exec(raw);
    if (!m || (!m[1] && !m[2])) {
      steps.push(emptyStep()); // Unbekanntes still als Pause lesen
      continue;
    }
    const step = {
      on: m[1] === 'X' ? ACCENT : m[1] === 'o' ? GHOST : ON,
      deg: m[2] ? Number(m[2]) : 0,
    };
    const roll = m[3] ? Math.min(MAX_ROLL, Number(m[3])) : 0;
    if (roll >= 2) step.roll = roll;
    steps.push(step);
  }

  while (steps.length < want) steps.push(emptyStep());
  return steps;
}

export function stepToToken(step) {
  if (!step.on) return '.';
  const head = step.on === ACCENT ? 'X' : step.on === GHOST ? 'o' : 'x';
  const deg = step.deg ? String(step.deg) : '';
  const roll = step.roll >= 2 ? `*${step.roll}` : '';
  return head + deg + roll;
}

// Gibt Takte zeilenweise und Viertel gruppiert aus, damit man das Raster liest.
export function stepsToText(steps) {
  const bars = Math.max(1, Math.round(steps.length / STEPS_PER_BAR));
  const lines = [];
  for (let bar = 0; bar < bars; bar++) {
    const beats = [];
    for (let beat = 0; beat < 4; beat++) {
      const from = bar * STEPS_PER_BAR + beat * 4;
      beats.push(steps.slice(from, from + 4).map(stepToToken).join(' '));
    }
    lines.push(beats.join('  '));
  }
  return lines.join('\n');
}
