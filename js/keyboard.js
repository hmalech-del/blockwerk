// Spielhilfe: Bildschirmklaviatur plus Computertastatur.
// Beide Wege melden nur noteOn/noteOff – die Engine kümmert sich um den Rest.

const WHITE_PC = [0, 2, 4, 5, 7, 9, 11];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'H'];

// Tastenbelegung für deutsche und US-Layouts (y/z beides belegt).
const KEY_MAP = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, z: 8, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ö: 16, ';': 16, "'": 17, ä: 17,
};

export function noteName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

export class Keyboard {
  constructor(el, { octaves = 2, onNoteOn, onNoteOff, onOctave } = {}) {
    this.el = el;
    this.octaves = octaves;
    this.octave = 4;
    this.onNoteOn = onNoteOn;
    this.onNoteOff = onNoteOff;
    this.onOctave = onOctave || (() => {});
    this.held = new Set();
    this.pointerNote = null;
    this.render();
    this.bind();
  }

  get base() {
    return (this.octave + 1) * 12;
  }

  render() {
    const count = this.octaves * 12 + 1;
    const whiteTotal = this.octaves * 7 + 1;
    const w = 100 / whiteTotal;
    const bw = w * 0.62;

    const whites = [];
    const blacks = [];
    let seen = 0;

    for (let i = 0; i < count; i++) {
      const midi = this.base + i;
      const pc = i % 12;
      if (WHITE_PC.includes(pc)) {
        whites.push(
          `<button class="key white" data-midi="${midi}" style="width:${w}%" aria-label="${noteName(midi)}">
             <span>${noteName(midi)}</span>
           </button>`
        );
        seen += 1;
      } else {
        const left = seen * w - bw / 2;
        blacks.push(
          `<button class="key black" data-midi="${midi}" style="left:${left}%;width:${bw}%" aria-label="${noteName(midi)}"></button>`
        );
      }
    }

    this.el.innerHTML = `<div class="keys">${whites.join('')}${blacks.join('')}</div>`;
  }

  bind() {
    this.el.addEventListener('pointerdown', (e) => {
      const key = e.target.closest('.key');
      if (!key) return;
      e.preventDefault();
      this.pointerNote = Number(key.dataset.midi);
      this.press(this.pointerNote);
    });

    const up = () => {
      if (this.pointerNote !== null) {
        this.lift(this.pointerNote);
        this.pointerNote = null;
      }
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      // Nur Texteingaben blockieren – ein fokussierter Button (z. B. nach einem
      // Klick auf "Audio starten") darf das Spielen nicht verhindern.
      if (e.target.matches('input:not([type=range]), select, textarea, [contenteditable]')) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === '<') return this.shift(-1);
      if (k === 'arrowright' || k === '>') return this.shift(1);
      if (!(k in KEY_MAP)) return;
      e.preventDefault();
      this.press(this.base + KEY_MAP[k]);
    });

    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (!(k in KEY_MAP)) return;
      this.lift(this.base + KEY_MAP[k]);
    });

    // Beim Wegklicken hängende Noten vermeiden.
    window.addEventListener('blur', () => {
      for (const midi of [...this.held]) this.lift(midi);
    });
  }

  shift(dir) {
    const next = Math.min(7, Math.max(0, this.octave + dir));
    if (next === this.octave) return;
    for (const midi of [...this.held]) this.lift(midi);
    this.octave = next;
    this.render();
    this.onOctave(this.octave);
  }

  press(midi) {
    if (this.held.has(midi)) return;
    this.held.add(midi);
    this.highlight(midi, true);
    this.onNoteOn(midi);
  }

  lift(midi) {
    if (!this.held.has(midi)) return;
    this.held.delete(midi);
    this.highlight(midi, false);
    this.onNoteOff(midi);
  }

  highlight(midi, on) {
    const key = this.el.querySelector(`.key[data-midi="${midi}"]`);
    if (key) key.classList.toggle('on', on);
  }
}
