# Test auf dem Test-PC: Signaturkarte im Stick unter Docker Desktop

Auf dem Dev-PC ist der Stick-Betrieb geprüft: Echttest mit der Karte, Simulator, Integration und E2E. **Ungeprüft ist
nur der Weg aus dem Docker-Container zur Kartenbrücke am PC.** Genau das klärt dieser Test.
Dauer: etwa 20 Minuten.

Voraussetzung: Der Branch `feat/signaturkarte` liegt auf GitHub, der Stick mit der Karte ist zur Hand.

## 1. Stand installieren

Im Ordner der Kassa, als Administrator:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\kassa-pos\ops\install.ps1 -Branch feat/signaturkarte
```

Bestehende `.env` und Daten bleiben erhalten (Update-Modus).

## 2. Stick anstecken, Brücke einrichten

Stick bzw. Kartenleser mit der Karte anstecken, dann als Administrator:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\kassa-pos\ops\kartenbruecke\installiere-kartenbruecke.ps1
```

- [ ] Selbsttest zeigt den Leser und „Karte gesteckt (ATR 3BDF97…)"
- [ ] In der `.env` stehen `KARTENBRUECKE_URL` und `KARTENBRUECKE_SCHLUESSEL`

Danach im Ordner der Kassa: `docker compose up -d`

## 3. Der entscheidende Punkt: erreicht der Container die Brücke?

```powershell
cd C:\kassa-pos
docker compose exec backend node -e "fetch(process.env.KARTENBRUECKE_URL+'/leser',{headers:{Authorization:'Bearer '+process.env.KARTENBRUECKE_SCHLUESSEL}}).then(r=>r.text()).then(console.log,e=>console.error('FEHLER',e.cause??e))"
```

- [ ] Antwort ist JSON mit `"leser"` und dem ATR der Karte. Dann weiter mit Punkt 4.
- [ ] Kommt dagegen `FEHLER … ECONNREFUSED`: Die Brücke ist aus dem Container nicht erreichbar.
      Ausgabe notieren und **hier abbrechen**. Dann muss die Brücke zusätzlich auf der Adresse des
      WSL-/Docker-Netzes lauschen. Das baue ich nach, sobald die Ausgabe vorliegt.

## 4. Neuen Betrieb mit dem Stick einrichten

Als Betreiber: **Einstellungen → System → „Weiteren Mandanten anlegen"**. Das ist dasselbe Formular wie die Ersteinrichtung.

- UID: **die UID auf der Karte**. „Karte prüfen" zeigt sie an, und die Kassa lehnt eine abweichende UID ab.
- **FinanzOnline-Felder leer lassen** (provisorisch). So wird die echte Karte beim Test nirgends gemeldet.
- Umgebung: Test
- Signatur: **„Signaturkarte im Stick (lokal)"** → „Karte prüfen (ohne PIN)" → PIN eintragen → „Kasse einrichten"

Prüfen:

- [ ] „Karte prüfen" zeigt „A-Trust ACOS-ID 4.1, Zertifikat …"
- [ ] Erfolgsseite: der maschinenlesbare Code beginnt mit `_R1-AT1_`

## 5. Betrieb

Am neuen Betrieb anmelden.

- [ ] Ein Verkauf geht durch, der Beleg-QR beginnt mit `_R1-AT1_`. Ein Verkauf dauert etwa eine halbe Sekunde länger als mit Software.
- [ ] **Stick abziehen** → ein Verkauf geht trotzdem durch, der rote Ausfall-Banner erscheint.
- [ ] **Stick wieder anstecken** → innerhalb von etwa einer Minute stellt die Kassa von selbst wieder her (Sammelbeleg, Banner weg).
- [ ] Einstellungen → RKSV → Signaturerstellungseinheit zeigt „Aktuell: Signaturkarte · ZDA AT1".

## 6. Neustart

- [ ] PC neu starten, ohne sich um die Brücke zu kümmern. Danach geht ein Verkauf mit Signatur durch. Die geplante Aufgabe „Kassa Kartenbruecke" startet sie mit Windows.

## 7. Protokoll

`C:\Program Files\KassaPOS\Kartenbruecke\kartenbruecke.log` (als Administrator öffnen):

- [ ] Nur Zeilen wie `Sitzung …: 9 APDUs, SW 9000 …`. Keine langen Hex-Folgen, keine PIN.

## Nicht testen

Eine **falsche PIN** absichtlich probieren: Jeder Versuch zählt auf der echten Karte. Der Schutz dagegen ist mit dem
Simulator getestet.
