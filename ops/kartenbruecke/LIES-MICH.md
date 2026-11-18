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

Unterstützt werden:

- **A-Trust ACOS-ID 4.1:** einzige Generation ohne Einschränkung.
- **ACOS-ID V2/2.1 und CardOS 5.3:** müssen laut A-Trust bis Mai 2027 getauscht werden. Die Kassa weist darauf hin.

## Einrichten

1. Kartenleser anstecken (getestet: ACS ACR39U) und die Karte einlegen.
2. Als Administrator ausführen:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\kassa-pos\ops\kartenbruecke\installiere-kartenbruecke.ps1
   ```
   Der Installer richtet die Brücke als geplante Aufgabe ein: Start mit Windows, unter SYSTEM, Neustart nach Absturz.
   Er erzeugt den Schlüssel, trägt `KARTENBRUECKE_URL`/`KARTENBRUECKE_SCHLUESSEL` in die `.env` ein und
   zeigt im Selbsttest Leser und Karte an.
3. Kassa neu starten: `docker compose up -d` (im Ordner der Kassa).
4. In der Kassa: **Einstellungen → RKSV → Signaturerstellungseinheit → „Signaturkarte (lokal)"**.
   - **„Karte prüfen (ohne PIN)":** zeigt Kartentyp und Zertifikat.
   - **PIN eintragen → „Speichern":** Die Kassa prüft die PIN mit **einer** Probesignatur. Erst dann speichert sie die PIN verschlüsselt.
   - Das Zertifikat der Karte muss auf die UID des Betriebs lauten.

## Die PIN

- Die PIN steht im PIN-Brief von A-Trust.
- **Eine falsche PIN zählt als Fehlversuch der Karte.** Nach wenigen Fehlversuchen ist die Karte für immer gesperrt.
- Lehnt die Karte die gespeicherte PIN ab, merkt sich die Kassa das. Sie versucht es nie wieder von selbst, weder beim
  Verkauf noch bei der automatischen Wiederherstellung. Ein roter Hinweis in den Einstellungen fordert die richtige PIN an.

## Im Betrieb

| Lage | Verhalten |
|---|---|
| Karte steckt, PIN stimmt | Belege mit ZDA `AT1`, etwa 230 ms je Signatur (gemessen mit ACOS-ID 4.1 und ACR39U) |
| Karte gezogen, Leser oder Brücke weg | SEE-Ausfall: Belege laufen mit Ausfallmarker weiter. Steckt die eingerichtete Karte wieder, stellt die Kassa innerhalb einer Minute von selbst wieder her (Sammelbeleg), sofern der Ausfall unter 48 h liegt. |
| PIN falsch | Kein Beleg, Fehlermeldung, PIN gesperrt (siehe oben) |
| andere Karte gesteckt | Kein Beleg. Abbruch **vor** der PIN-Prüfung, die fremde Karte verliert keinen Versuch. |

FinanzOnline: Die Einheit wird als `SIGNATURKARTE` mit `vda_id` `AT1` gemeldet.

## Prüfen und Fehlersuche

- Protokoll: `C:\ProgramData\KassaPOS\kartenbruecke\kartenbruecke.log`. Lesbar nur für Administratoren, enthält nur die Anzahl der Befehle und die Statuswörter der Karte.
- Echttest mit Karte, für Entwickler (fragt die PIN verdeckt ab, **ein** Versuch):
  `node packages/rksv/scripts/signaturkarte-echttest.mjs http://127.0.0.1:47110 <schlüsseldatei>`
- Entfernen: `installiere-kartenbruecke.ps1 -Entfernen`

## Bekannte Grenzen

- Die Brücke gibt es nur für Windows. Für Linux und Raspberry Pi fehlt die Anbindung über `pcscd`.
- Der Startbeleg einer neuen Kasse wird noch mit der Software-Signatur erstellt. Die Kasse wird erst danach auf die Karte umgestellt, wie bei A-Trust online.
- Docker Desktop leitet `host.docker.internal` auf den PC weiter. Dass die Brücke, die nur auf 127.0.0.1 lauscht, dabei erreicht wird, ist auf dem Test-PC zu bestätigen.
