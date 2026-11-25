# Signaturkarte (A-Trust a.sign RK CHIP) — lokal signieren, ohne Internet

Für Kleininstallationen (eine oder zwei Kassen): Die Kassa signiert mit der RKSV-Signaturkarte im
Kartenleser am Kassen-PC statt über A-Trust online. Beide Kassen dürfen dieselbe Karte nutzen.

## Aufbau

```
Kassa (Docker-Container) ──HTTP──▶ Kartenbrücke (Windows, 127.0.0.1:47110) ──PC/SC──▶ Kartenleser + Karte
```

Docker Desktop kann keinen USB-Leser in den Container durchreichen. Die **Kartenbrücke**
(`kartenbruecke.ps1`) läuft deshalb direkt unter Windows:

- Sie reicht nur Kartenbefehle durch. Alles Fachliche (Kartentyp, Zertifikat, PIN-Schutz) macht die Kassa.
- Sie lauscht nur auf 127.0.0.1 und verlangt einen Schlüssel.
- Sie arbeitet die Anfragen nacheinander ab.
- Nach jeder Sitzung setzt sie die Karte zurück.
- Sie protokolliert nie Befehlsinhalte, die PIN steht also nie im Protokoll.
- **PIN-Wächter:** Eine PIN-Prüfung, die die Karte abgelehnt hat, schickt die Brücke nie wieder an die
  Karte, egal von welcher Kasse und wie oft. Zusätzlich sperrt die Kassa die Karte für alle Kassen, die sie
  nutzen, bis jemand in den Einstellungen die richtige PIN speichert.
- Vor der PIN-Prüfung prüft sie in derselben Sitzung, dass die eingerichtete Karte steckt. Eine fremde Karte
  bekommt die PIN nie zu sehen. Stecken mehrere Signaturkarten, nimmt die Kassa die eingerichtete.

Unterstützt werden:

- **A-Trust ACOS-ID 4.1:** einzige Generation ohne Einschränkung.
- **ACOS-ID V2/2.1 und CardOS 5.3:** müssen laut A-Trust bis Mai 2027 getauscht werden. Die Kassa weist darauf hin.

## Einrichten

1. Kartenleser anstecken (getestet: ACS ACR39U) und die Karte einlegen.
2. **Kassa-Setup** ausführen (online oder offline). Findet es einen Kartenleser und noch keine Brücke, fragt es, ob es sie
   einrichten soll (Enter = nein). Ohne Rückfrage: `install.ps1 -Kartenbruecke`. Dann weiter mit Punkt 4, die Container startet Kassa-Setup selbst.
   Auf einer schon laufenden Kassa geht es auch einzeln, als Administrator:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\kassa-pos\ops\kartenbruecke\installiere-kartenbruecke.ps1
   ```
   Der Installer legt die Brücke nach `C:\Program Files\KassaPOS\Kartenbruecke` und richtet sie als geplante Aufgabe ein:
   Start mit Windows, unter SYSTEM, Neustart nach Absturz.
   Er erzeugt den Schlüssel, trägt (ohne die übrigen Zeilen zu verändern) `KARTENBRUECKE_URL`/`KARTENBRUECKE_SCHLUESSEL` in die `.env` ein und
   zeigt im Selbsttest Leser und Karte an.
3. Kassa neu starten: `docker compose up -d` (im Ordner der Kassa).
4. **Neue Kassa:** Bei der Einrichtung unter **„Signatur (RKSV)"** die Möglichkeit **„Signaturkarte im Stick (lokal)"** wählen, dort
   „Karte prüfen (ohne PIN)" und die PIN eintragen. Die Kassa prüft Karte und PIN, *bevor* sie FinanzOnline meldet. Schon der
   Startbeleg ist mit der Karte signiert, gemeldet wird die Einheit als `SIGNATURKARTE`/`AT1`. Weitere Kassen übernehmen
   die Karte automatisch.

   **Bestehende Kassa umstellen:** **Einstellungen → RKSV → Signaturerstellungseinheit → „Signaturkarte (lokal)"**.
   - **„Karte prüfen (ohne PIN)":** zeigt Kartentyp und Zertifikat.
   - **PIN eintragen → „Speichern":** Die Kassa prüft die PIN mit **einer** Probesignatur. Erst dann speichert sie die PIN verschlüsselt, für alle Kassen mit dieser Karte.
   - Das Zertifikat der Karte muss auf die UID des Betriebs lauten.

## Aktualisieren

Die Brücke läuft außerhalb der Container und mit vollen Windows-Rechten. **„Jetzt aktualisieren" in der Kassa erneuert sie
darum bewusst nicht.** Der Update-Container darf kein Programm austauschen, das unter SYSTEM läuft.

- **Kassa-Setup** aktualisiert eine eingerichtete Brücke bei jedem Lauf. Schlüssel, Port, Karte und PIN bleiben.
  Überspringen: `install.ps1 -OhneKartenbruecke`.
- Ist die Brücke älter als die Kassa, steht das unter **Einstellungen → RKSV → Signaturerstellungseinheit**.
- Wer `kartenbruecke.ps1` ändert, erhöht `$VERSION` und `KARTENBRUECKE_VERSION` (`packages/rksv/src/see/karte/einheit.ts`).
  Ein Test hält beide gleich.

**Nicht zurück auf einen Stand vor der Signaturkarte:** Ältere Versionen kennen die Karte nicht und signieren dann mit dem
Software-Schlüssel, geben aber weiter das Kartenzertifikat an. Solche Belege sind ungültig.

## Die PIN

- Die PIN steht im PIN-Brief von A-Trust.
- **Eine falsche PIN zählt als Fehlversuch der Karte.** Nach wenigen Fehlversuchen ist die Karte für immer gesperrt.
- Lehnt die Karte die gespeicherte PIN ab, merkt sich die Kassa das. Sie versucht es nie wieder von selbst, weder beim
  Verkauf noch bei der automatischen Wiederherstellung. Ein roter Hinweis in den Einstellungen fordert die richtige PIN an.

## Im Betrieb

| Lage | Verhalten |
|---|---|
| Karte steckt, PIN stimmt | Belege mit ZDA `AT1`, etwa 0,4 s je Signatur samt Identitätsprüfung der Karte (gemessen mit ACOS-ID 4.1 und ACR39U) |
| Karte gezogen, Leser oder Brücke weg | SEE-Ausfall: Belege laufen mit Ausfallmarker weiter. Steckt die eingerichtete Karte wieder, stellt die Kassa innerhalb einer Minute von selbst wieder her (Sammelbeleg), sofern der Ausfall unter 48 h liegt. |
| PIN falsch | Kein Beleg, Fehlermeldung, PIN gesperrt (siehe oben) |
| andere Karte gesteckt | Kein Beleg. Abbruch **vor** der PIN-Prüfung, die fremde Karte verliert keinen Versuch. |

FinanzOnline: Die Einheit wird als `SIGNATURKARTE` mit `vda_id` `AT1` gemeldet.

## Prüfen und Fehlersuche

- Protokoll: `C:\Program Files\KassaPOS\Kartenbruecke\kartenbruecke.log`. Lesbar nur für Administratoren, enthält nur die Anzahl der Befehle und die Statuswörter der Karte.
- Echttest mit Karte, für Entwickler (fragt die PIN verdeckt ab, **ein** Versuch):
  `node packages/rksv/scripts/signaturkarte-echttest.mjs http://127.0.0.1:47110 <schlüsseldatei>`
- Entfernen: `installiere-kartenbruecke.ps1 -Entfernen`

- Tests der Skripte (ohne Karte, ohne Installation): `powershell -NoProfile -ExecutionPolicy Bypass -File ops\kartenbruecke\test-kartenbruecke.ps1`

Checkliste für den ersten Test unter Docker Desktop: [`TEST-PC.md`](TEST-PC.md).

## Bekannte Grenzen

- Die Brücke gibt es nur für Windows. Für Linux und Raspberry Pi fehlt die Anbindung über `pcscd`.
- Docker Desktop leitet `host.docker.internal` auf den PC weiter und erreicht die Brücke, obwohl sie nur auf 127.0.0.1 lauscht (Test-PC, 2026-11-19).
