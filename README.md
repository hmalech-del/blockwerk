# Blockwerk

Modularer Klangbaukasten im Browser: Klangerzeuger und Effekte sind Blöcke, die
sich frei zu einer Signalkette anordnen lassen. Kein Plugin-Format, kein Build,
kein Framework – reines HTML, CSS und JavaScript auf der Web Audio API.

## Ausprobieren

Die App braucht einen Webserver, weil sie ES-Module lädt (`file://` reicht nicht):

```bash
cd blockwerk
python3 -m http.server 8080
# danach http://localhost:8080 öffnen
```

Alternativ direkt über GitHub Pages veröffentlichen (Settings → Pages → Branch `main`, Ordner `/`).

## Bedienung

- **Audio starten** – Browser erlauben Ton erst nach einem Klick.
- **Spielen** – Bildschirmklaviatur oder Computertastatur:
  `A W S E D F T G Z H U J K …`, Oktave mit `←` / `→`.
- **Kette bauen** – Effektblöcke unten hinzufügen, per Drag & Drop oder ◀ ▶ sortieren,
  mit ⏻ überbrücken, mit ✕ entfernen.
- **Patches** – werden automatisch im Browser gespeichert; Export/Import als JSON,
  vier Presets als Startpunkt.

## Bausteine

| Quellen | |
| --- | --- |
| Oszillator | Säge/Rechteck/Dreieck/Sinus, Unison-Verstimmung, Sub-Oktave, ADSR |
| Rauschen | gefiltertes Rauschen, Filterfarbe folgt optional der Tonhöhe |
| FM | Zwei-Operator-FM mit Ratio, Index und abfallendem Modulationshub |

| Effekte | |
| --- | --- |
| Filter | Tief-/Hoch-/Bandpass/Notch mit Resonanz |
| Drive | weiche Sättigung bis harte Verzerrung |
| Crusher | Bit-Reduktion für Lo-Fi |
| Chorus | modulierte Verzögerung |
| Tremolo | Amplitudenmodulation mit wählbarer LFO-Form |
| Delay | Echo mit gedämpfter Rückkopplung |
| Hall | Faltungshall mit erzeugter Impulsantwort |

Am Ende der Kette sitzt fest ein Master mit Limiter und Pegelanzeige.

## Aufbau

```
index.html
css/style.css
js/
  modules.js    Modul-Registry: Parameter + Audio-Aufbau je Baustein
  engine.js     AudioContext, Kette verdrahten, Stimmenverwaltung
  patch.js      Patch-Datenmodell, Normalisierung, Presets
  ui.js         Rack-Darstellung, Regler, Drag & Drop
  keyboard.js   Bildschirm- und Computertastatur
  app.js        Verdrahtung, Persistenz, Transport
```

Ein Modul beschreibt sich selbst – Name, Parameterliste und wie es sich im
AudioContext aufbaut. Ein neuer Effekt ist damit ein Eintrag in `modules.js`,
Oberfläche und Speicherformat ziehen automatisch mit.

Das Patch ist ein reines Datenobjekt:

```json
{
  "version": 1,
  "name": "Acid Lead",
  "source": { "type": "osc", "params": { "wave": "sawtooth" } },
  "chain": [{ "id": "b1", "type": "filter", "bypass": false, "params": { "freq": 900 } }],
  "master": { "volume": 0.7 }
}
```

Die Engine kennt nur `noteOn(midi)` / `noteOff(midi)` – wer die Noten auslöst,
ist ihr egal.

## Tests

Zwei Playwright-Tests laufen headless gegen einen eingebauten Mini-Webserver:

```bash
npm install
npx playwright install chromium   # einmalig
npm test
```

- `tests/offline-render.mjs` rendert jede Quelle und jeden Effekt in einem
  `OfflineAudioContext` und prüft Pegel, Stille und NaN/Inf – auch mit allen
  Parametern auf Minimum bzw. Maximum.
- `tests/ui-smoke.mjs` klickt die Oberfläche durch: Audio an/aus, Kette bauen,
  sortieren, Bypass, spielen, Presets, Persistenz nach Reload.

## Nächste Schritte

1. **Sequenzer** – Step-Grid mit Transport und Tempo, der die vorhandene
   `noteOn`/`noteOff`-Schnittstelle zeitgenau bedient (Lookahead-Scheduler auf
   `AudioContext.currentTime`).
2. **Drum-Machine** – mehrere Spuren mit eigenen Quellen (Rauschen/FM sind schon
   da) und je Spur eine eigene kurze Effektkette vor dem Master.
3. Danach denkbar: Modulationsquellen (LFO/Envelope auf beliebige Parameter),
   Aufnahme als WAV, MIDI-Eingang.

## Lizenz

MIT
