# Blockwerk

Modularer Klangbaukasten im Browser: Spuren mit Step-Sequenzer, Drum-Loops und
frei verkettbaren Klangblöcken. Kein Plugin-Format, kein Build, kein Framework –
reines HTML, CSS und JavaScript auf der Web Audio API.

Ziel ist ein Werkzeug für Live-Auftritte auf einem 10-Zoll-Tablet oder Laptop:
Loops vorbereiten, im Set umschalten, Verläufe scripten. Der Sequenzer steht,
die Live-Ansicht ist der nächste Schritt (siehe *Fahrplan*).

## Ausprobieren

Die App braucht einen Webserver, weil sie ES-Module lädt (`file://` reicht nicht):

```bash
cd blockwerk
python3 -m http.server 8080
# danach http://localhost:8080 öffnen
```

Alternativ über GitHub Pages veröffentlichen (Settings → Pages → Branch `main`, Ordner `/`).

## Bedienung

- **Audio starten** – Browser erlauben Ton erst nach einem Klick.
- **Start / Stopp** – Schaltfläche oder Leertaste.
- **Schritte setzen** – Tippen schaltet durch *aus → an → Akzent*. Senkrechtes
  Ziehen auf einem Schritt verschiebt die Tonhöhe in Skalenstufen; die Zahl im
  Feld zeigt die Stufe, `0` ist der Grundton und bleibt unbeschriftet.
- **Clips A–D** – je Spur vier Slots. Während der Wiedergabe wird ein Tipp
  *vorgemerkt* (der Chip blinkt) und erst an der eingestellten Grenze
  übernommen. Erneutes Tippen bestellt den Wechsel wieder ab.
- **Wechsel** – legt diese Grenze fest: ¼ Takt bis 4 Takte oder „sofort".
- **Tonart** – Grundton und Skala gelten für alle Spuren. Ein Wechsel während
  des Laufs transponiert das ganze Set.
- **M / S** – Stumm und Solo je Spur.
- **Klang** – zweiter Reiter: Quelle und Effektkette der ausgewählten Spur.
- **Klaviatur** – spielt die ausgewählte Spur, Tasten `A W S E D F T G Z H U J K`,
  Oktave mit `←` / `→`.

Das Set wird automatisch im Browser gespeichert; Export und Import laufen über JSON.

## Clips als Text

Jeder Clip lässt sich als Text lesen und schreiben (`Clip als Text`). Das ist der
Keim der Script-Idee – dieselbe Notation soll später das ganze Set beschreiben.

```
x . . .  x . . .  x . . x  x . . .     Kick
. . . .  X . . .  . . . .  x . . .     Snare, Akzent auf der Zwei
0 . . .  0 . . 0  . . 3 .  2 . . .     Bass in Skalenstufen
```

| Zeichen | Bedeutung |
| --- | --- |
| `.` | Pause |
| `x` | Schritt an (Stufe 0) |
| `X` | Schritt an mit Akzent |
| `x3`, `X-2` | Schritt an auf Skalenstufe 3 bzw. −2 |
| `3` | Kurzform für `x3` |
| `\|`, Zeilenumbruch | Trenner, wird beim Lesen ignoriert |

Stufen zählen in der eingestellten Skala, nicht in Halbtönen: In Moll ist `3`
die Quarte, in Pentatonik die Sexte. Dieselbe Zeile klingt in jeder Tonart richtig.

## Bausteine

| Quellen | |
| --- | --- |
| Oszillator | Säge/Rechteck/Dreieck/Sinus, Unison-Verstimmung, Sub-Oktave, ADSR |
| Rauschen | gefiltertes Rauschen, Filterfarbe folgt optional der Tonhöhe |
| FM | Zwei-Operator-FM mit Ratio, Index und abfallendem Modulationshub |
| Perc | Schlagzeugstimme: fallende Tonhöhe, Klick, Rauschanteil |

| Effekte | |
| --- | --- |
| Filter | Tief-/Hoch-/Bandpass/Notch mit Resonanz |
| Drive | weiche Sättigung bis harte Verzerrung |
| Crusher | Bit-Reduktion für Lo-Fi |
| Chorus | modulierte Verzögerung |
| Tremolo | Amplitudenmodulation mit wählbarer LFO-Form |
| Delay | Echo mit gedämpfter Rückkopplung |
| Hall | Faltungshall mit erzeugter Impulsantwort |

Jede Spur hat eine eigene Kette; am Ende laufen alle in einen Master mit Limiter.

## Aufbau

```
index.html
css/style.css
js/
  modules.js     Modul-Registry: Parameter + Audio-Aufbau je Baustein
  engine.js      AudioContext, Kette je Spur, Stimmenverwaltung
  transport.js   Taktgeber mit Lookahead-Scheduler
  project.js     Datenmodell, Skalen, Normalisierung, Presets
  pattern.js     Clip ⇄ Text
  sequencer.js   Raster, Clips, Spielkopf
  rack.js        Klangkette der ausgewählten Spur
  keyboard.js    Bildschirm- und Computertastatur
  app.js         Verdrahtung, Persistenz, Transport-Bedienung
```

Drei Entscheidungen tragen den Rest:

**Die Audio-Uhr bestimmt das Timing.** `setInterval` allein eiert hörbar.
Stattdessen schaut der Scheduler alle 25 ms, welche Schritte in den nächsten
150 ms fällig sind, und plant sie mit exaktem `AudioContext`-Zeitstempel voraus.
Gemessene Abweichung zwischen zwei Kicks: unter 0,001 ms.

**Das Projekt ist ein reines Datenobjekt.** Kein Zustand versteckt sich in der
Oberfläche oder im Audiograph. Speichern, Export, Import und später das Script
arbeiten alle auf derselben Struktur.

**Tonhöhen sind Skalenstufen, keine MIDI-Noten.** Deshalb transponiert ein
Tonartwechsel das laufende Set, und derselbe Clip passt in jeden Kontext.

## Tests

Drei Playwright-Tests laufen headless gegen einen eingebauten Mini-Webserver:

```bash
npm install
npx playwright install chromium   # einmalig
npm test
```

- `tests/offline-render.mjs` rendert jede Quelle und jeden Effekt in einem
  `OfflineAudioContext` und prüft Pegel, Stille und NaN/Inf – auch mit allen
  Parametern auf Minimum bzw. Maximum.
- `tests/sequencer.mjs` misst die Abstände der geplanten Noten, prüft
  quantisierte Clipwechsel, Skalenrechnung, Textformat und Stimmenfreigabe.
- `tests/ui-smoke.mjs` bedient die Oberfläche auf 1280 × 800 (10-Zoll-Tablet):
  Schritte setzen, ziehen, Clips, Spuren, Effekte, Textmodus, Persistenz.

## Fahrplan

**1. Live-Ansicht.** Statt eines Rasters aus 64 Zellen, das man im Dunkeln
trifft oder eben nicht: ein waagerechter Streifen, der durch einen festen
Spielkopf läuft. Links das Gespielte, rechts das *Kommende* – vorgemerkte Clips
stehen sichtbar vor dem Spielkopf, mit Countdown bis zum Wechsel. Die zentrale
Frage live ist nicht „was läuft?", sondern „was passiert als Nächstes?".
Bedienelemente bleiben ortsfest und daumengroß, damit man sie findet, ohne
hinzusehen.

**2. Set-Script.** Eine Textdatei beschreibt den Ablauf, dieselbe Notation wie
bei den Clips, eine Zeile je Ereignis:

```
tempo 124  ·  tonart C moll

takt 1    drums=A  bass=A
takt 9    + lead=A
takt 17   drums=B  filter.cutoff 300 → 4000 über 8 takte
takt 33   alle aus außer drums
```

Das Script ist der Plan, nicht der Zwang: Es läuft mit, zeigt in der
Live-Ansicht die nächsten Ereignisse an – und jeder Eingriff von Hand hat
Vorrang. Wer improvisiert, steigt einfach wieder ein. Das nimmt die Angst vor
dem Blackout auf der Bühne, ohne das Set festzunageln.

**3. Danach denkbar:** Modulationsquellen (LFO auf beliebige Parameter),
Aufnahme als WAV, MIDI-Eingang für Controller mit echten Knöpfen.

## Lizenz

MIT
