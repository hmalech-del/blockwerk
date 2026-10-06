---
name: probe
description: Eine Probe – der Durchlauf Performer → UX → Developer, der Blockwerk um einen Schritt verbessert. Mit Argument wird dieses Thema geprobt, ohne Argument sucht der Performer selbst. Endet bei einem Pull Request, nie auf main.
disable-model-invocation: true
---

Führe eine **Probe** durch: einen vollen Durchlauf der drei Rollen, der genau
**einen** Schritt bringt. Thema, falls angegeben: $ARGUMENTS

Du bist dabei nicht Zuschauer, sondern der, der entscheidet. Die drei Agenten
beraten dich; die Auswahl triffst du.

## Ablauf

**0. Stand aufnehmen.** `git log --oneline -5`, `SESSIONS.md` lesen, aktuelle
Version aus `package.json`. Branch von einem aktuellen `main` abzweigen:
`git fetch origin main && git checkout -B probe/<kurzes-thema> origin/main`.

**1. Performer.** Starte den `performer`-Agenten. Gib ihm das Thema mit, falls
eines angegeben ist, sonst lass ihn selbst suchen. Er liefert eine gewichtete
Anforderungsliste mit Messwerten und eine Liste ungeprüfter Fragen.

**2. Entscheiden – das ist dein Teil.** Nimm **genau eine** Anforderung. Nicht
drei. Eine Probe, die drei Dinge anfasst, ist nicht nachvollziehbar, und
niemand kann hinterher hören, welche Änderung was bewirkt hat. Kriterien:
Steht sie in `SESSIONS.md`? Ist sie belegt oder nur plausibel? Lässt sie sich
in einem Durchlauf fertig bauen, inklusive Test? Nimm die oberste, die alle
drei erfüllt, und sag in einem Satz, warum nicht die anderen.

**3. UX.** Starte den `ux`-Agenten mit genau dieser einen Anforderung. Er
entwirft den Platz in der Oberfläche und nennt das Budget vorher/nachher.
**Legt er ein Veto ein, ist die Probe hier zu Ende** – das ist ein gültiges
Ergebnis, kein Fehlschlag. Dann dokumentiere das Veto und höre auf. Baue
nichts gegen das Veto.

**4. Developer.** Starte den `developer`-Agenten mit Anforderung und Entwurf.
Er baut, testet, gleicht die Version an.

**5. Nachprüfen – selbst, nicht auf Zusage.** Führe `npm test` aus und lies die
Ausgabe. Führe `node tests/ui-budget.mjs` aus. Berichte die Zahlen. Wenn etwas
rot ist, geht es zurück an den Developer, nicht in einen PR.

**6. Eintragen.** Hänge in `SESSIONS.md` unter dem neuesten Eintrag einen Block
**„Fragen an den Menschen"** an – die ungeprüften Punkte des Performers zu
dieser Änderung, als beantwortbare Fragen. Das ist der Rückkanal; ohne ihn
raten die nächsten Proben weiter.

**7. Pull Request, nicht Push auf main.** Commit, Branch pushen, PR öffnen.
Der PR-Text enthält, in dieser Reihenfolge:

- Was geändert wurde und **warum** – die Anforderung, nicht die Dateien.
- Die Messwerte vorher/nachher.
- Das UI-Budget vorher/nachher.
- **Was niemand gehört hat.** Ein eigener Abschnitt: welche Werte plausibel
  gewählt, aber nicht abgehört sind, und welche Frage ein Mensch mit
  Kopfhörern in zwei Minuten beantworten kann.

Nie auf `main` pushen. Es muss jemand hören, was sich geändert hat, bevor es
in einem Set landet.

## Abbruchbedingungen

Brich ab und melde dich, statt weiterzumachen, wenn:

- der Performer nichts findet, was in `SESSIONS.md` oder in einer Messung
  verankert ist – dann fehlt echtes Spielen, nicht Arbeit;
- der UX-Agent ein Veto einlegt;
- `npm test` nach zwei Runden beim Developer nicht grün ist;
- die Änderung eine der drei Entscheidungen aus `CLAUDE.md` berühren würde.

Eine abgebrochene Probe mit klarer Begründung ist ein gutes Ergebnis. Eine
Probe, die etwas Beliebiges baut, damit sie etwas gebaut hat, ist das
schlechteste mögliche Ergebnis.
