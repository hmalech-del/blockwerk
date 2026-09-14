// Textform eines Clips – die kleine Sprache, aus der später das Set-Script wird.
//
//   .      Schritt aus
//   x      Schritt an (Stufe 0)
//   X      Schritt an mit Akzent
//   x3     Schritt an auf Skalenstufe 3       (auch X3, x-2, X-2)
//   3      Kurzform für x3
//   |      Trenner, wird beim Lesen ignoriert
//
// Beispiel (ein Takt):  x . . .  x . . .  x . . x  x . . .

export const STEPS_PER_BAR = 16;

export function emptyStep() {
  return { on: 0, deg: 0 };
}

export function emptySteps(bars) {
  return Array.from({ length: bars * STEPS_PER_BAR }, emptyStep);
}

const TOKEN = /^([xX])?(-?\d+)?$/;

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
    steps.push({ on: m[1] === 'X' ? 2 : 1, deg: m[2] ? Number(m[2]) : 0 });
  }

  while (steps.length < want) steps.push(emptyStep());
  return steps;
}

export function stepToToken(step) {
  if (!step.on) return '.';
  return (step.on === 2 ? 'X' : 'x') + (step.deg ? String(step.deg) : '');
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
