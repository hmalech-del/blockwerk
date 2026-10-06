# Blockwerk

Modularer Klangbaukasten im Browser: Klangketten, Sequenzer, Live-Ansicht,
Set-Script, Sampler. Gebaut für ein 10-Zoll-Tablet und einen Laptop, gedacht
als **Live-Instrument** für Hip-Hop und Electro – nicht als DAW.

Keine Abhängigkeiten außer Playwright (nur zum Testen). Keine Build-Stufe.
ES-Module, direkt vom Dateisystem oder einem statischen Server.

## Was dieses Projekt anders macht als eine DAW

Drei Entscheidungen tragen den Rest. Sie sind nicht verhandelbar, ohne das
Ganze neu zu denken:

1. **Schritte sind Skalenstufen, keine Halbtöne.** Deshalb transponiert ein
   Tonartwechsel das laufende Set, und deshalb klingt jede gewürfelte Melodie
   zum Rest. Wer hier Halbtöne einführt, nimmt der App ihren Kern.
   Ausnahme: Spuren mit `tuned: false` (Schlagzeug) hängen an einem festen
   Bezugston und zählen Halbtöne.
2. **Die Hand hat Vorrang vor dem Plan.** Das Set-Script wirkt nur im Moment
   seiner Ereignisse. Wer zwischendurch von Hand umschaltet, bleibt
   umgeschaltet, bis das Script das nächste Mal etwas dazu sagt.
3. **Die Stufe eines Schritts ist beim Sampler der Slice-Index.** Deshalb
   funktioniert jedes Werkzeug, das Melodien baut, auch für Slice-Folgen.

## Pflichten bei jeder Änderung

- `npm test` muss durchlaufen. Alle neun Reihen, nicht nur die betroffene.
  Ein neues Verhalten ohne Test gilt als nicht gebaut.
- **Messen, nicht vermuten.** Behauptungen über Timing, Pegel, Layout oder
  Bildrate werden mit einer Zahl belegt, die ein Test oder ein Skript
  erzeugt hat. „Fühlt sich besser an" ist kein Befund.
- `node tests/ui-budget.mjs` ist das Komplexitätsbudget. Wer eine Ansicht
  wachsen lässt, lässt entweder etwas anderes weg – oder hebt die Zahl dort
  bewusst und begründet es im Commit.
- Bestehende Sets dürfen nicht brechen. `normalizeProject` repariert alte
  Stände; neue Felder bekommen dort eine Voreinstellung.
- Kommentare auf Deutsch, und sie erklären **warum**, nicht was. Die
  Kommentardichte des umgebenden Codes übernehmen.
- Nach jeder sichtbaren Änderung die Version in `package.json`, `index.html`
  (zweimal `?v=`) und die Fußzeile angleichen. Ohne die Kennung liefert der
  Zwischenspeicher alte Dateien aus.

## Nicht ohne Rückfrage

- Nicht auf `main` pushen, wenn die Änderung aus einem automatischen Lauf
  kommt. Dann ein Branch und ein Pull Request, damit ein Mensch hört, was
  sich geändert hat, bevor es im Set landet.
- Keine Abhängigkeit hinzufügen.
- Die drei Entscheidungen oben nicht umkehren.

## Testreihen

```
npm test                 alle neun
node tests/offline-render.mjs   DSP je Baustein, offline gerendert
node tests/sequencer.mjs        Timing, Swing, Rolls, Versatz, Clips
node tests/ideas.mjs            Generatoren: Melodien, Slices, Geister
node tests/sampler.mjs          Aufnahme, Zerlegung, Slices
node tests/gesture.mjs          Gestenfeld
node tests/script.mjs           Set-Script: Parser und Ausführung
node tests/live.mjs             Live-Ansicht, Layout, Bildrate
node tests/ui-smoke.mjs         Oberfläche von Hand durchgeklickt
node tests/ui-budget.mjs        Komplexitätsbudget, Zielgrößen
```

## Wo was liegt

`js/project.js` Datenmodell · `js/engine.js` Audiograph, Summe, Eingang,
Mitschnitt · `js/transport.js` Taktgeber · `js/pattern.js` Clip ⇄ Text,
Anschlagstärken, Rolls · `js/modules.js` Bausteine · `js/sequencer.js` Raster ·
`js/live.js` Bühnenansicht · `js/rack.js` Klangkette · `js/script.js`
Set-Script · `js/ideas.js` Generatoren · `js/midi.js` Controller ·
`js/app.js` Verdrahtung.

Ausführlich im README.

## SESSIONS.md

Die Notizen aus echten Sessions. Das ist die einzige Quelle in diesem Repo,
die tatsächlich **gehört** hat, wie die App klingt – ein Agent kann das nicht.
Wer Anforderungen ableitet, liest zuerst dort.
