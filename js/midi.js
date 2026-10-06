// Web MIDI: echte Regler statt Glas. Auf der Bühne ist ein Drehknopf unter dem
// Finger etwas anderes als ein Strich auf einem Display – man trifft ihn, ohne
// hinzusehen, und man kann zwei gleichzeitig bewegen.
//
// Zugeordnet wird per Lernen: Regler antippen, am Controller drehen, fertig.
// Die Zuordnung liegt im Set, damit Controller und Set zusammen reisen.

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CONTROL = 0xb0;

export const ccKey = (channel, cc) => `${channel}:${cc}`;

export class MidiIn {
  constructor({ onControl = () => {}, onNoteOn = () => {}, onNoteOff = () => {}, onStatus = () => {} } = {}) {
    this.onControl = onControl;
    this.onNoteOn = onNoteOn;
    this.onNoteOff = onNoteOff;
    this.onStatus = onStatus;
    this.access = null;
    this.learning = null;     // auf welchen Reglerplatz der naechste CC faellt
    this.lastSeen = null;
  }

  get supported() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  get open() {
    return !!this.access;
  }

  get deviceNames() {
    if (!this.access) return [];
    return [...this.access.inputs.values()].map((i) => i.name || 'MIDI');
  }

  async start() {
    if (this.access) return true;
    if (!this.supported) {
      this.onStatus({ state: 'nicht unterstützt' });
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.onStatus({ state: 'abgelehnt', error: String(e?.message || e) });
      return false;
    }
    this.access.onstatechange = () => this.bindInputs();
    this.bindInputs();
    return true;
  }

  bindInputs() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e) => this.handle(e.data);
    }
    this.onStatus({ state: 'bereit', devices: this.deviceNames });
  }

  // Lernen: der naechste Regler, der sich bewegt, gehoert diesem Platz.
  learn(slot) {
    this.learning = slot;
    this.onStatus({ state: 'lernt', slot });
  }

  cancelLearn() {
    this.learning = null;
    this.onStatus({ state: this.access ? 'bereit' : 'aus', devices: this.deviceNames });
  }

  handle(data) {
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;

    if (status === CONTROL) {
      const key = ccKey(channel, data[1]);
      this.lastSeen = key;
      if (this.learning !== null) {
        const slot = this.learning;
        this.learning = null;
        this.onControl({ key, value: data[2] / 127, learnedFor: slot });
        return;
      }
      this.onControl({ key, value: data[2] / 127, learnedFor: null });
      return;
    }

    // Anschlagstärke 0 bei Note-An ist die übliche Schreibweise für Note-Aus.
    if (status === NOTE_ON && data[2] > 0) return this.onNoteOn(data[1], data[2] / 127);
    if (status === NOTE_OFF || (status === NOTE_ON && data[2] === 0)) return this.onNoteOff(data[1]);
    return undefined;
  }
}
