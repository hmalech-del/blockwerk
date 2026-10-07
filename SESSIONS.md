# Sessions

Notizen aus echten Sessions. **Das ist die wichtigste Datei im Repo.**

Kein Agent kann hören. Alles, was sich über Klang, Groove, Druck und Gefühl
sagen lässt, kann nur von hier kommen. Wer Anforderungen ableitet, liest
zuerst hier – und was hier steht, schlägt jede Messung und jede Vermutung.

Deshalb darf das Aufschreiben nichts kosten. Drei Zeilen nach dem Spielen sind
mehr wert als ein Konzeptpapier, das nie entsteht. Unvollständig, unsortiert,
hingeschrieben ist richtig. Formuliere nichts aus.

## So trägst du ein

Neuen Block oben anfügen. Die vier Zeilen reichen; was nicht zutrifft, weglassen.

```
## 2026-10-14 · 25 min · Wohnzimmer, Kopfhörer · 0.10.0

Gespielt: Boom-bap 88, Break gechoppt, Übergang auf 124.
Gut: Rolls auf der Hi-Hat sind genau das. Szenenwechsel sitzt jetzt.
Schlecht: Duck pumpt zu heftig, musste auf 40 % runter. Geisternote zu leise
  gegen die Snare – klingt wie aus.
Gefehlt: Wollte den Break halbtempo laufen lassen, ging nicht.
Fragen vom Agenten: Duck bei 80/220 zu stark? → ja, deutlich.
```

Nützlich zu wissen für die Agenten, wenn du es gerade weißt: Tempo,
Kopfhörer oder Boxen, Tablet oder Laptop, welche Version (steht in der
Fußzeile der App).

## Was die Agenten hier herauslesen

- **Schlecht** und **Gefehlt** werden zu Anforderungen, mit Vorrang vor allem,
  was ein Agent selbst findet.
- **Gut** schützt: was hier steht, wird beim Umbau nicht angefasst.
- **Fragen vom Agenten** ist der Rückkanal. Der Performer-Agent stellt unter
  „Ungeprüft" konkrete Fragen; deine Antwort hier schließt die Schleife. Ohne
  diese Zeile raten die Agenten weiter.

---

## Fragen an den Menschen · Probe 1 (Zündung, 0.11.1)

Die erste Probe lief ohne eine einzige Session-Notiz, also rein messverankert.
Diese Fragen kann nur jemand mit Ohren und einem Gerät beantworten. Antworte
direkt darunter, ein Wort genügt – jede Antwort spart der nächsten Probe eine
Vermutung.

**Zu dieser Änderung**

1. Die Taktanzeige steht jetzt groß auf dem Platz, wo „Audio starten" war
   (vorher 8×15 px hinter `#play`). Liest sie sich im Halbdunkel von der Seite?
   → _Antwort:_
2. Der gestörte Zustand blinkt rot mit „Audio weiter". Auf einem iPhone: kommt
   der Zustand nach einem Anruf überhaupt zurück, und fällt er dir auf?
   → _Antwort:_
3. Wird nach einer Unterbrechung wirklich eine Datei angeboten, und ist etwas
   Brauchbares drin? Nur auf einem echten Gerät prüfbar – im Test ist es
   Chromium ohne `interrupted`-Zustand.
   → _Antwort:_

**Vom Performer offen gelassen, nach Wichtigkeit**

4. Beim Kipp 88 → 124 entsteht eine Viertel von **632,3 ms**, die zu keinem
   der beiden Tempi gehört. Hörbares Stolpern, oder geht sie als Fill durch?
   Bei „geht durch" wird die Lösung viel kleiner – dann reicht Quantisierung
   auf die Taktgrenze statt einer Überblendung.
   → _Antwort:_
5. Von Hand gespielte Noten haben **genau eine** Anschlagstärke (1,0), das
   Raster hat drei. Sticht die gespielte Stimme über dem 88er-Loop heraus?
   Und falls ja: reichen zwei Stufen (untere Tastenhälfte leise) oder muss es
   stufenlos sein? Das entscheidet die halbe Umsetzung.
   → _Antwort:_
6. Halbtempo für den Break: das **ganze** Set oder nur das Schlagzeug? Das sind
   zwei völlig verschiedene Umbauten (Teiler je Spur gegen Teiler am Taktgeber).
   → _Antwort:_
7. Geisternote **0,32** gegen Akzent **1,0** – richtiger Abstand, oder
   verschwindet der Geist?
   → _Antwort:_
8. Roll-Abfall ist **25 %** über 3 bis 6 Anschläge. Zu viel, zu wenig, richtig?
   → _Antwort:_
9. `nudge` kann ±60 ms. Welcher Wert sitzt für die Snare bei 88? Mit einer Zahl
   aus einer Session ließe sich eine sinnvolle Voreinstellung setzen.
   → _Antwort:_
10. Die vier Live-Regler sind im Demo-Set alle leer. Welche vier Ziele willst
    du tatsächlich an der Hand haben? Dann kann man sie vorbelegen.
    → _Antwort:_

**Nächste Probe, schon entschieden und messverankert:** die Transportleiste
verschwindet auf dem 10-Zoll-Tablet quer, sobald man die Pads bedient –
`css/style.css` überschreibt mit `position: relative` das `position: sticky`
der Kopfzeile. Gemessen: 124 px scrollen, dann sind Start, Tempo, Wechsel,
Master und die Taktanzeige aus dem Bild. Dafür braucht es keine Ohren.
