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

# Effekt im Lauf anbauen und auf einen Live-Regler legen
bar 17   add lead crusher, control 1 lead.crusher.bits 1 8 as Crush
bar 41   remove lead crusher
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

  // Die Namen des Sets zum Antippen: Tippfehler sind der häufigste Grund,
  // warum ein Script nicht läuft – also muss man sie nicht tippen.
  namesMarkup() {
    const chip = (kind, name) =>
      `<button class="name-chip" data-act="insert" data-kind="${kind}" data-name="${escapeAttr(name)}">${escapeHtml(name)}</button>`;
    const tracks = this.project.tracks.map((t) => chip('track', t.name)).join('');
    const scenes = (this.project.scenes || []).map((s) => chip('scene', s.name)).join('');
    return `
      <div class="script-names" data-role="names">
        <span class="name-label">Spuren</span>${tracks}
        ${scenes ? `<span class="name-label">Szenen</span>${scenes}` : ''}
      </div>`;
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

      ${this.namesMarkup()}

      <textarea class="script-text" spellcheck="false" data-role="text"
        placeholder="bar 1&#10;  kick=A"></textarea>

      <div class="script-errors" data-role="errors"></div>

      <details class="script-help">
        <summary>Befehle</summary>
        <table>
          <tr><td><code>tempo 124</code></td><td>Tempo setzen (40–240)</td></tr>
          <tr><td><code>key C minor</code></td><td>Tonart: minor, major, dorian, phrygian, pentatonic, chromatic</td></tr>
          <tr><td><code>swing 54 on 8</code></td><td>Shuffle in Prozent (0–75); <code>on 8</code> / <code>on 16</code> wählt das Raster</td></tr>
          <tr><td><code>bar 17</code></td><td>alles Folgende gilt ab diesem Takt</td></tr>
          <tr><td><code>kick = B</code></td><td>Clip einer Spur setzen (A–D)</td></tr>
          <tr><td><code>scene Hook</code></td><td>Szene aufrufen</td></tr>
          <tr><td><code>mute lead bass</code></td><td>Spuren stumm schalten, <code>unmute</code> umgekehrt</td></tr>
          <tr><td><code>bass.filter.freq 300 -&gt; 4000 over 8 bars</code></td><td>Parameter fahren</td></tr>
          <tr><td><code>add lead crusher</code></td><td>Effekt anhängen – die Regler dafür erscheinen sofort im Klang-Reiter</td></tr>
          <tr><td><code>remove lead crusher</code></td><td>Effekt wieder entfernen</td></tr>
          <tr><td><code>bypass lead delay on</code></td><td>Effekt überbrücken (<code>on</code> / <code>off</code>)</td></tr>
          <tr><td><code>pattern kick C = x . . . x . . .</code></td><td>Clip aus dem Script schreiben (1, 2 oder 4 Takte)</td></tr>
          <tr><td><code>slice chop 16</code></td><td>Sample der Spur neu zerlegen – auch <code>slice chop transients</code></td></tr>
          <tr><td><code>control 1 lead.delay.mix as Delay</code></td><td>Live-Regler belegen; Bereich optional: <code>… 0 0.8 as Delay</code></td></tr>
          <tr><td><code>end</code></td><td>Wiedergabe anhalten</td></tr>
        </table>
        <p>Ziele für Fahrten: <code>spur.volume</code>, <code>spur.gate</code>,
           <code>spur.offset</code>, <code>spur.source.&lt;parameter&gt;</code>,
           <code>spur.&lt;effekt&gt;.&lt;parameter&gt;</code>,
           <code>master.volume</code>. Mehrere Befehle je Zeile mit Komma trennen,
           <code>#</code> leitet einen Kommentar ein.</p>
        <p>Namen dürfen Leerzeichen haben: <code>mute Spur 1</code> und
           <code>Spur 1.volume 0.2 -&gt; 0.9</code> gehen genauso wie
           <code>spur1</code>. Groß- und Kleinschreibung zählt nicht.</p>
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

  // An der Schreibmarke einsetzen, nicht hinten anhängen – sonst müsste man
  // den Namen wieder von Hand an die richtige Stelle schieben.
  insert(word) {
    const at = this.text.selectionStart ?? this.text.value.length;
    const to = this.text.selectionEnd ?? at;
    const before = this.text.value.slice(0, at);
    const space = before && !/[\s=.,]$/.test(before) ? ' ' : '';
    this.text.value = before + space + word + this.text.value.slice(to);
    const caret = at + space.length + word.length;
    this.text.focus();
    this.text.setSelectionRange(caret, caret);
    this.hooks.onDraft(this.text.value);
    this.refresh();
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
      if (btn.dataset.act === 'insert') {
        const word = btn.dataset.kind === 'scene' ? `scene ${btn.dataset.name}` : btn.dataset.name;
        this.insert(word);
        return;
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

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const escapeAttr = escapeHtml;

export { EXAMPLE };
