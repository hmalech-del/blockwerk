// Script-Reiter: Texteditor mit sofortiger Rückmeldung.
// Fehler nennen Zeile und Grund – eine Sprache ohne brauchbare Fehlermeldungen
// ist auf der Bühne wertlos.

const EXAMPLE = `# Beispiel – von Hand umschalten geht jederzeit
tempo 122
key C minor
swing 12

bar 1    scene Intro
bar 5    unmute snare
bar 9    scene Groove
bar 13   bass.filter.freq 400 -> 2600 over 4 bars
bar 17   scene Hook
bar 25   scene Break
bar 29   bass.filter.freq 2600 -> 400 over 2 bars
bar 33   scene Hook
`;

export class ScriptView {
  constructor(el, hooks) {
    this.el = el;
    this.hooks = hooks; // getProject, runner, onApply, onToggle
    this.render();
    this.bind();
  }

  get project() {
    return this.hooks.getProject();
  }

  render() {
    const script = this.project.script || { text: '', enabled: false };
    this.el.innerHTML = `
      <div class="script-bar">
        <label class="switch">
          <input type="checkbox" data-act="enabled" ${script.enabled ? 'checked' : ''}>
          <span>Script aktiv</span>
        </label>
        <button data-act="apply">Übernehmen</button>
        <button class="ghost" data-act="example">Beispiel einsetzen</button>
        <output class="script-status" data-role="status"></output>
      </div>

      <textarea class="script-text" spellcheck="false" data-role="text"
        placeholder="bar 1&#10;  kick=A"></textarea>

      <div class="script-errors" data-role="errors"></div>

      <details class="script-help">
        <summary>Befehle</summary>
        <table>
          <tr><td><code>tempo 124</code></td><td>Tempo setzen (40–240)</td></tr>
          <tr><td><code>key C minor</code></td><td>Tonart: minor, major, dorian, phrygian, pentatonic, chromatic</td></tr>
          <tr><td><code>swing 12</code></td><td>Swing in Prozent (0–60)</td></tr>
          <tr><td><code>bar 17</code></td><td>alles Folgende gilt ab diesem Takt</td></tr>
          <tr><td><code>kick = B</code></td><td>Clip einer Spur setzen (A–D)</td></tr>
          <tr><td><code>scene Hook</code></td><td>Szene aufrufen</td></tr>
          <tr><td><code>mute lead bass</code></td><td>Spuren stumm schalten, <code>unmute</code> umgekehrt</td></tr>
          <tr><td><code>bass.filter.freq 300 -&gt; 4000 over 8 bars</code></td><td>Parameter fahren</td></tr>
          <tr><td><code>end</code></td><td>Wiedergabe anhalten</td></tr>
        </table>
        <p>Ziele für Fahrten: <code>spur.volume</code>, <code>spur.gate</code>,
           <code>spur.source.&lt;parameter&gt;</code>, <code>spur.&lt;effekt&gt;.&lt;parameter&gt;</code>,
           <code>master.volume</code>. Mehrere Befehle je Zeile mit Komma trennen,
           <code>#</code> leitet einen Kommentar ein.</p>
      </details>`;

    this.text = this.el.querySelector('[data-role="text"]');
    this.text.value = script.text || '';
    this.refresh();
  }

  refresh() {
    const runner = this.hooks.runner();
    const status = this.el.querySelector('[data-role="status"]');
    const errorBox = this.el.querySelector('[data-role="errors"]');
    if (!status || !errorBox) return;

    const { events, errors } = runner;
    if (errors.length) {
      status.textContent = `${errors.length} Fehler`;
      status.className = 'script-status bad';
    } else if (events.length) {
      status.textContent = `${events.length} Ereignisse · Takt 1–${runner.lastBar()}`;
      status.className = 'script-status good';
    } else {
      status.textContent = 'noch kein Ablauf';
      status.className = 'script-status';
    }

    errorBox.innerHTML = errors
      .map((e) => `<p><b>Zeile ${e.line}</b> ${e.message}</p>`)
      .join('');
    errorBox.hidden = !errors.length;
  }

  bind() {
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'apply') this.hooks.onApply(this.text.value);
      if (btn.dataset.act === 'example') {
        this.text.value = EXAMPLE;
        this.hooks.onApply(EXAMPLE);
      }
      this.refresh();
    });

    this.el.addEventListener('change', (e) => {
      if (e.target.dataset.act !== 'enabled') return;
      this.hooks.onToggle(e.target.checked);
      this.refresh();
    });

    // Beim Tippen nur still mitlesen; geschrieben wird erst beim Übernehmen.
    this.el.addEventListener('input', (e) => {
      if (e.target.dataset.role === 'text') this.hooks.onDraft(e.target.value);
    });

    this.el.addEventListener('keydown', (e) => {
      if (e.target.dataset.role !== 'text') return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        this.hooks.onApply(this.text.value);
        this.refresh();
      }
    });
  }
}

export { EXAMPLE };
