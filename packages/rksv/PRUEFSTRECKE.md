# RKSV-Prüfstrecke — unabhängige Gegenproben

Stand: 2026-11-02 (angelegt zur Karte „RKSV-Prüfstrecke", Kassa v0.8.74).

## Warum es das gibt

Die RKSV-Tests der Kassa prüfen den Code überwiegend **gegen sich selbst**: `chain.test.ts` rechnet SHA-256 mit derselben
Lesart nach wie der Produktivcode, der eigene Burn-in-Prüfer (`packages/backend/tests/burnin/rksv-pruefer.ts`) teilt die
Spezifikations-Lesart des Produktivcodes, FinanzOnline, A-Trust und das BMF-Prüftool waren gemockt oder nie dabei. Ein
Denkfehler im Code ist dann auch im Test — und bleibt unentdeckt (Vorgänger: DER statt P1363 bei ~0,8 % der Signaturen,
Storno bei halbem Cent, jeweils erst spät durch Zufall gefunden).

Die Prüfstrecke schafft Gegenproben, die **nicht** vom Kassa-Code abhängen: fremd erzeugte Referenzdaten, amtliche Schemas,
ein Prüfer in anderer Sprache mit eigener Kryptografie, das BMF-Prüftool.

## Übersicht

| Gegenprobe | Prüft | Unabhängig von | Wo | Läuft |
|---|---|---|---|---|
| **BMF-Referenzdaten** | Verkettung, Umsatzzähler (AES), Signaturen, QR↔JWS der Kassa-Funktionen gegen Belege des BMF-Mustercodes | Kassa-Code (fremd erzeugt) | `packages/rksv/tests/bmf-referenz.test.ts`, Daten in `tests/fixtures/bmf-mustercode` | jede CI |
| **XSD-Validierung** | Requests des FinanzOnline-Clients gegen `session.xsd`/`regKasseWs.xsd` (libxml2), Antworten im Client | Kassa-Code (amtliche Schemas) | `packages/rksv/tests/fon-xsd.test.ts`, Schemas in `tests/fixtures/fon-xsd` | jede CI; Schema-Drift nachts |
| **Python-Zweitprüfer** | DEP7: JWS/ES256, Verkettung, AES-Zähler, Format, Belegnummern, Zeit | Node, OpenSSL, Kassa-Code (reine Standardbibliothek, eigene ES256-/AES-Rechnung) | `scripts/rksv/dep7_pruefer.py`; Tests `packages/rksv/tests/dep7-zweitpruefer.test.ts`, `packages/backend/tests/integration/rksv-externe-pruefer.test.ts` | jede CI (Python 3 vorhanden); Burn-in nachts |
| **BMF-Prüftool** (Java) | DEP-Export wie die Finanzprüfung: Verkettung, Umsatzzähler, Belegtyp-Abfolge, Chronologie, Einzelbelegprüfung | Kassa-Code (amtliches Werkzeug, nicht verbindlich) | `scripts/rksv/bmf-pruefer.mjs`; Aufruf aus Burn-in und Integrationstest | nachts (`rksv-nacht`), Java 8 |
| **Burn-in** | Dauer-/Rechtssicherheitstest gegen PostgreSQL, am Ende Export an beide externen Prüfer | — | `pnpm test:burnin` im Ordner `packages/backend` | nachts, 1000 Belege (sonntags 45 min) |
| **Zeit-Matrix** | Beleg-Datum für 9 Server-Zeitzonen × 16 heikle Zeitpunkte | Kassa-Code (Wiener Wanduhr per `Intl`) | `packages/rksv/tests/zeit-matrix.test.ts` | nachts (`RKSV_ZEITMATRIX=1`) |
| **Mutationstests** | Welche Behauptungen im Kern kein Test festnagelt | — | `pnpm --filter @kassa/rksv test:mutation` | wöchentlich (`rksv-mutation`) |

Workflows: `.github/workflows/rksv-nacht.yml`, `rksv-mutation.yml` (die reguläre `ci.yml` ist unverändert).

## Befunde (Stand 2026-11-02)

Befunde, die der Produktivcode noch nicht behoben hat, sind in den Tests als **`it.fails`** festgehalten: grün, solange der
Mangel besteht; sobald er behoben ist, meldet vitest „Expect test to fail" — dann an der Stelle das `.fails` entfernen
(und in den Zweitprüfer-Tests die Ausnahme `--ignoriere zksn-format` für Befund D streichen). Befund A ist so behoben worden.

### A — Verkettung der Folgebelege war falsch (BEHOBEN; Altketten im Selbsttest als „Altformat" ausgewiesen)

* Befund: `Sig-Voriger-Beleg` = Base64(SHA-256(**QR-Code** des Vorbelegs)[0..7]) — QR-Code = `payload + "_" + Signatur in Standard-Base64`
  (`beleg.service.ts` speichert `letzterBelegCode = signed.maschinenlesbareCode`; `beleg.ts signiereBeleg` → `crypto/chain.ts`).
* Spezifikation (RKSV Anlage 1 Z 4/Z 6): gehasht wird das Ergebnis der Signaturerstellung = **JWS-Compact-Form** des Vorbelegs
  (`header.payload.signatur`, base64url). Startbeleg: Kassen-ID.
* BMF-Referenzdaten (Release V1.0.0 des Mustercodes, 16 Szenarien): **1284 von 1284** Folgebelege passen zur JWS-Form, **0** zur QR-Form.
* **Das BMF-Prüftool selbst bestätigte es** (CI-Probelauf 2026-11-02, Export der Kassa als offenes System, 60 Belege): `DEP_CHAINING_VALUE` — „Die Verkettung
  zwischen dem vorigen Beleg und dem aktuellen Beleg ist ungültig" — bei **59 von 59** Folgebelegen; als Eingabe der Verkettung nennt das Tool die JWS-Compact-Form des
  Vorbelegs (`CHAINING_INPUT = eyJhbGciOiJFUzI1NiJ9.…`). Die Einzelbelegprüfung (Code, Signatur, Zähler) besteht bei allen 60 Belegen (`N_cashbox` 60× PASS).
* Folge (bis zur Korrektur): Ab dem 2. Beleg war die Kette in jedem DEP-Export ungültig (BMF-Prüftool „Gültige Verkettung", Finanzprüfung). Die
  BMF-Belegcheck-App sieht es nicht (Einzelbeleg, kein Vorgänger).
* Warum unentdeckt: Selbstreferenz (siehe oben). Die einzige externe Referenz (`cg8hNU5ihto=`, Startbeleg) betrifft nur den ersten Beleg.
* Behoben: `verkettungswertFolgebeleg` (`crypto/chain.ts`) nimmt weiter den gespeicherten QR-Code des Vorbelegs, rechnet ihn aber in die JWS-Compact-Form um (`crypto/jws.ts`)
  und hasht diese; `signiereBeleg` und `pruefeKette` rufen es unverändert auf. Die reine Hash-Eingabe der Spezifikation ist `verkettungswertAusJwsCompact`. Gespeichert bleibt
  der QR-Code (`kassen.letzter_beleg_code`), die Signaturberechnung ist unverändert. Der Übergang ist nahtlos: schon der erste Beleg nach der Umstellung hasht die JWS-Form
  seines (noch alt verketteten) Vorgängers und stimmt.
* **Altbelege:** Belege 2…n einer vor der Korrektur betriebenen Kasse tragen die alte Verkettung. Sie ist Teil des signierten Codes und lässt sich nicht ändern — DEP-Export
  und Prüfwerkzeuge (BMF-Prüftool, Zweitprüfer, `pruefeKette`) melden in dieser Strecke weiter Verkettungsfehler, je einen pro Altbeleg ab dem 2. **Entschieden (User, 2026-11-02):**
  die Altstrecke wird weder verändert noch neu begonnen, sondern im Signatur-Selbsttest aus den Daten erkannt und ausgewiesen (wie `der_altformat` und `zeit_altformat`, ohne Migration).
  Umsetzung: `analysiereKette` (`crypto/chain.ts`) erkennt je Folgebeleg die Altform (Hash des QR-Codes) oder die Form nach Spezifikation; beides gilt als geschlossene Kette, alles andere
  ist ein Kettenbruch. Altform NACH einem Beleg nach Spezifikation (ältere Programmversion eingespielt) bricht die Kette nicht (die Signatur schützt den Wert, die Verkettung dient dem
  Erkennen gelöschter oder vertauschter Belege), wird aber als „gemischt" gelb ausgewiesen. Der Selbsttest liefert `ketteAltformat`, `ketteAltformatVon/-Bis`, `ketteGemischt`,
  `ketteBruchBeleg`; die Seite zeigt die Altstrecke blau mit Belegbereich, das CSV-Protokoll hat eine Zusammenfassung (`ops/DEPLOYMENT.md`, Troubleshooting). `pruefeKette` bleibt streng.
* **Das BMF-Prüftool bestätigt die Korrektur** (CI-Probelauf 2026-11-02 auf dem Wegwerf-Branch `trial/verkettung-jws`, Export der Kassa als offenes System, 60 Belege):
  keine einzige Beanstandung (vorher `DEP_CHAINING_VALUE` bei 59 von 59). **Altkette** (Belege 2…30 nach der alten Lesart, ab 31 nach der Spezifikation): das Tool meldet genau die
  29 Altbelege (`DEP_CHAINING_VALUE`, dazu das Sammelurteil `DEP_RECEIPT_LIST`), der Übergang und alles danach besteht. **DEP-Auszug ohne Startbeleg** (gleich ob Altkette): das Tool
  lehnt schon den Beginn ab (`DEP_STATE` „kein gültiger Startbeleg", dazu `STATE_CASHBOX`, `VERIFICATION_FROM_APP`), die Verkettung beanstandet es dabei nicht — ein Teilexport
  ab dem Update ist also kein Ausweg; ein vollständig akzeptierter DEP braucht einen Startbeleg am Anfang und damit eine neue Kette.
* Tests: `bmf-referenz.test.ts`, `dep7-zweitpruefer.test.ts` (auch die Altkette), `rksv-externe-pruefer.test.ts` (laufen streng, kein `.fails` mehr), `bmf-prueftool.test.ts` (nachts, Java; Altkette und Auszug als Aussagen über das Tool).

### B — Beleg-Zeit in der Zeitzone des Prozesses (Karte „RKSV-Kern") — BEHOBEN

* Befund: `formatDatum` (`beleg.ts`) las lokale Getter; die Spezifikation verlangt österreichische Lokalzeit. Im Container (kein `TZ`) ist
  das UTC → Beleg-Zeit 1–2 h daneben. `zeit-matrix.test.ts`: 128 von 145 Fällen rot (alle Zonen außer Europe/Vienna).
* Behoben mit dem Fix der Karte „RKSV-Kern" (`rksv/src/zeit.ts`: Zeit fest Europe/Vienna über `Intl`, unabhängig von `TZ`; zusätzlich `TZ=Europe/Vienna` im
  Compose/Image; Bon und Bonierbon ebenso): 145/145 grün, der Test läuft jetzt in jeder CI (kein `RKSV_ZEITMATRIX` mehr nötig). Altbelege mit der
  Zeit in UTC bleiben gültig; der Signatur-Selbsttest führt sie als „QR-Zeit in UTC" (`zeit_altformat`).
* Eigenheit des Formats (kein Defekt): In der Herbst-Umstellungsstunde läuft die Wanduhr zurück (02:50 Sommerzeit, 20 min später 02:10 Winterzeit).
  Ein Prüfer, der die Zeiten als Text liest, sieht „rückwärts" (`zeit-rueckwaerts` im Zweitprüfer, „chronologische Abfolge" im BMF-Prüftool).

### C — FinanzOnline-Client erzeugt keinen schema-gültigen Request

Alle Requests des Clients scheitern an den amtlichen Schemas (`fon-xsd.test.ts`, 9× `it.fails` + 4× `it.fails` bei Antworten):

| # | Befund |
|---|---|
| F-1 | `login`: Wurzelelement muss `loginRequest` heißen (Client: `login`) |
| F-2 | `logout`: Wurzelelement muss `logoutRequest` heißen |
| F-3 | rkdb-Datensätze (`registrierung_se`, `status_kasse` …) sind globale Elemente → Namespace `https://finanzonline.bmf.gv.at/rkdb`; der Client sendet sie ohne Namespace |
| F-4 | Pflichtfelder `paket_nr`, `ts_erstellung` (rkdb, status_*) und `satznr` (status_*) fehlen |
| F-5 | `status_se` heißt im Schema `status_see` |
| F-6 | Je `rkdb` nur **eine** Datensatzart (xs:choice): `registrierung_se` und `registrierung_kasse` brauchen getrennte Aufrufe |
| F-7 | Ausfall/Wiederinbetriebnahme/Außerbetriebnahme: falsche Namen/Felder (`ausserbetriebnahme_kasse` gibt es nicht → `ausfall_kasse` mit `ausserbetriebnahme/begruendung`; `ausfall_se` braucht `ausfall{begruendung, beginn_ausfall}`; `wiederinbetriebnahme_se` braucht `ende_ausfall`) |
| F-8 | Antwort: `abfrage_ergebnis` hat Kinder (`ts_registrierung`, `status`, `ts_status`); der Client liest den ganzen Inhalt als Status — die Statusabfrage kann nie „REGISTRIERT" erkennen |
| F-9 | Antwort: mehrere `result`/`rkdbMessage` sind erlaubt; nur der erste `rc` wird ausgewertet (ein abgelehnter zweiter Datensatz gilt als Erfolg) |
| F-10 | `herstellerid`: Muster `[0-9A-Za-z]{10,24}`; der Standardwert `ATU_KASSA_RKSV_0001` (Unterstriche) ist ungültig |
| F-11 | `vda_id`: Muster `[A-Z]{2}[1-9][0-9]?` schließt `AT0` aus — die Software-SEE kann nicht als `registrierung_se` gemeldet werden (Schema: `registrierung_ggs` mit `art_se_ggs` SW_GGS) |

Endpunkte, SOAPAction und document/literal stimmen mit den WSDL-Dateien überein; Werte (Seriennummer dezimal, AES-Schlüssel 44 Zeichen Base64) passen in die Muster.
Die Mocks in `finanz-online.test.ts` sind selbst nicht schema-gültig und haben das verdeckt; `FINANZONLINE-ABGLEICH.md` („verifiziert gegen die offiziellen Schemas") stimmt so nicht.
`tests/fixtures/fon-beispiele.ts` enthält für jede Nachricht ein **schema-gültiges Soll-Beispiel** (Requests und Antworten) — Grundlage für die Reparatur.

Zusatzfund: Das Schema kennt `belegpruefung` (amtliche Belegprüfung inkl. `verificationResultList`) über den Webservice. Der Client nutzt sie nicht („Startbeleg nur per App" stimmt so nicht). Mit Webservice-Zugang wäre das die amtliche Gegenprobe für **jeden** Beleg.

### D — Software-SEE (AT0): Seriennummer im Beleg

Laut RIS § 20 Abs. 3 steht bei geschlossenen Gesamtsystemen (AT0) statt der Zertifikats-Seriennummer der „Ordnungsbegriff des Unternehmers"
(BMF-Beispiel: `U:ATU12345678-K1`). Die Kassa trägt die Hex-Seriennummer ihres selbstsignierten Zertifikats ein.

**Das BMF-Prüftool beanstandet jeden Beleg** (CI-Probelauf 2026-11-02, Burn-in-Export mit 214 Belegen, Zertifikat- und Public-Key-Container): `FORMAT_CLOSED_SYSTEM_SERIAL` bei
214 von 214 Belegen — auch beim Startbeleg —, daraus folgt im DEP `DEP_STATE` („Am Beginn des exportierten RKSV-DEP befindet sich kein gültiger Startbeleg"). Das Tool kommt bei
AT0 nie zu Verkettung, Zähler und Signatur. Folgen: Belege der Software-SEE bestehen die amtliche Belegprüfung nicht; echter Betrieb braucht ein offenes System (A-Trust). Und
der Wechsel von AT0 auf A-Trust innerhalb einer Kette mischt geschlossenes und offenes System in einem DEP (Prüfung „keine Vermischung von Systemtypen").
Als offenes System gelesen (ZDA `AT100`, Zertifikat im Container) besteht dagegen die Einzelbelegprüfung aller Belege; dort blieb nur Befund A (inzwischen behoben).

### Bestätigt (positive Gegenproben)

* AES-256-ICM des Umsatzzählers: IV = SHA-256(Kassen-ID ‖ Belegnummer)[0..15] — **764 von 764** BMF-Zähler passen zur laufenden Summe (Training zählt nicht, Storno schon). Länge dort 6 Byte; die Spezifikation verlangt ≥ 5, wir nehmen 8.
* Signaturen: alle 57 nicht ausgefallenen BMF-Signaturen des offenen Systems bestätigt `verifiziereQrCode`; P1363 ↔ DER verlustfrei.
* QR ↔ JWS-Compact (`qrCodeZuJwsCompact`) liefert exakt die JWS-Form des BMF für alle 81 Belege.
* Startbeleg-Verkettung (Hash der Kassen-ID) stimmt mit dem BMF überein.
* Der Python-Zweitprüfer besteht alle 16 BMF-Szenarien (offen mit Ausnahme der Generator-Eigenheit bei der Seriennummer) und erkennt 12 gezielte Verfälschungen (Betrag, Signatur, gelöschter/vertauschter Beleg, Zähler, Kassen-ID, Datum, Header, Schlüssel …).
* Für die echten Kassa-Daten (API → PostgreSQL → DEP7) fand er **nur** die Verkettung (A, behoben) und findet das AT0-Seriennummernformat (D): Signaturen, Zähler, Format, Belegnummern, Zeit, Sammelbeleg nach Ausfall sind sauber.
* Das BMF-Prüftool besteht seine 16 eigenen Beispiele (Kontrolllauf) und bestätigte für den Kassa-Export im offenen System: Einzelbeleg (Code, Signatur, Zähler) 60/60, Abfolge (Start, Sammelbeleg) — nur die Verkettung nicht (A). Mit der Korrektur beanstandet es nichts mehr (siehe Befund A).

## Mutationstests (Stryker) — was die Tests nicht festnagelten

Stryker verändert `beleg.ts`, `see.ts`, `dep.ts` und `crypto/*` (427 Mutanten) und prüft, ob die **schnelle Suite** (ohne Python-/XSD-Tests) rot wird.

| | beleg.ts | aes-icm.ts | chain.ts | dep.ts | see.ts | gesamt |
|---|---:|---:|---:|---:|---:|---:|
| erster Lauf (2026-11-02) | 81,1 % | 91,7 % | 83,8 % | 48,8 % | 60,2 % | **66,0 %** |
| nach `code-felder`, `see-zertifikat`, `dep-funktionen` (Stand vor den Startbeleg-/Einheit-Tests in `code-felder`) | 94,3 % | 91,7 % | 83,8 % | 98,8 % | 82,8 % | **89,2 %** |

Gefundene Lücken (jetzt mit Tests mit festen Erwartungswerten geschlossen): das **Format der Beträge im Code** (Dezimalkomma, Vorzeichen bei Stornos — kein Test sah
den Code-Inhalt an), **Selbstsignatur und Gültigkeitsdauer** des Software-Zertifikats, ASN.1-Längen und Seriennummer-Kodierung, `mergeDEP7Exports`/`validiereDEP7`/`dep7AusJson`/DEP131-Export
(nur in Integrationstests ausgeführt), `erstelleNullbeleg`, die Alt-Prüfung für DER-Signaturen, `erstelleStartbeleg` mit externer Einheit.

Die verbleibenden Überlebenden sind **äquivalent oder unerreichbar**: Kodierungsnamen (`'utf8'` → `""`, gleiches Ergebnis), Schutzabfragen für `noUncheckedIndexedAccess`,
nicht minimale DER-Längen/Vorzeichen-Bytes, die OpenSSL toleriert, Langform-Längen, die ECDSA-Signaturen nie erreichen, Fehlerzweige der OID-Kodierung.

**Was Mutationstests nicht können:** `aes-icm.ts` (92 %) und `chain.ts` (84 %) sind nach Mutation fest — die Überlebenden sind äquivalent/unerreichbar —, und trotzdem war die Verkettung
gegenüber der Spezifikation falsch (Befund A, behoben). Die Tests nageln die *Implementierung* fest, nicht die *Spezifikation*. Einen Lesefehler der Spezifikation findet nur ein externer Maßstab
(BMF-Daten, BMF-Prüftool, Zweitprüfer) — genau dafür ist diese Strecke da.

Aufruf: `pnpm --filter @kassa/rksv test:mutation` (3–4 Minuten, Bericht `packages/rksv/reports/mutation/mutation.html`); Überlebende als Liste:
`node scripts/rksv/mutation-bericht.mjs packages/rksv/reports/mutation/mutation.json`. Wöchentlich in `rksv-mutation.yml` (nur Auswertung, wird nicht rot).

## Lokal ausführen

```bash
pnpm --filter @kassa/rksv test                          # inkl. XSD, BMF-Referenz, Zweitprüfer (braucht Python 3)
pnpm --filter @kassa/backend test:integration            # inkl. rksv-externe-pruefer (PostgreSQL)
cd packages/backend && BURNIN_BELEGE=200 pnpm test:burnin   # Burn-in + Python-Zweitprüfer, Bericht in test-results/
RKSV_ZEITMATRIX=1 pnpm --filter @kassa/rksv exec vitest run tests/zeit-matrix.test.ts
pnpm --filter @kassa/rksv test:mutation                  # Stryker, Bericht in packages/rksv/reports/mutation
node scripts/rksv/fon-xsd-drift.mjs                      # Schemas noch wie die mitgeführten?
python scripts/rksv/dep7_pruefer.py --dep7 dep-export.json --crypto cryptographicMaterialContainer.json
node scripts/rksv/bmf-pruefer.mjs --dep dep-export.json --crypto cryptographicMaterialContainer.json --out bericht   # Java nötig
```

Burn-in-Schalter: `BURNIN_BELEGE`, `BURNIN_MINUTEN`, `BURNIN_SEED`, `BURNIN_PARALLEL`, `BURNIN_ZWEITPRUEFER=0`,
`BURNIN_BEKANNTE_REGELN` (bekannte Befunde nur als Hinweis; für Befund D, das AT0-Format: `zweitpruefer-zksn-format,bmf-FORMAT_CLOSED_SYSTEM_SERIAL,bmf-DEP_STATE,bmf-VERIFICATION_FROM_APP,bmf-DEP_RECEIPT_LIST`),
`BMF_PRUEFTOOL_DIR`.

## Der Nacht-Workflow (`rksv-nacht`)

* **burnin:** BMF-Prüftool laden (festgelegte Version, SHA-256 geprüft), **Kontrolllauf** mit den 16 Beispiel-Szenarien des BMF (muss bestehen,
  sonst sagt ein Ergebnis zu unseren Daten nichts), dann Burn-in mit Export an Python-Zweitprüfer und BMF-Prüftool. Als Artefakt (14 Tage) kommen Berichte, Zusammenfassungen
  (`bmf-zusammenfassung.json` mit den ersten 200 beanstandeten Prüfungen), Konsolenausgabe und die Export-Dateien mit — nicht die Einzelergebnisse des Prüftools je Beleg
  (`NNNN_*.json`, `*_full.json`, `DEP-full.json`: 147 MB schon für den Kontrolllauf und zwei Kassa-Läufe); dafür das Skript lokal laufen lassen.
* **zeit-matrix**, **schemas** (Drift der FinanzOnline-Schemas, neueres Prüftool?).
* Manuell startbar (`workflow_dispatch`) mit Belegzahl, Minuten und bekannten Regeln.
* **Rot ist gewollt, solange bekannte Befunde offen sind** (A und B sind behoben; offen ist D, das AT0-Seriennummernformat) — das ist der Zweck. Zum Beruhigen für einen manuellen Lauf `bekannte_regeln` mit den Regeln zu D setzen (Liste oben bei den Burn-in-Schaltern).
* Das BMF-Prüftool ist laut BMF „primär auf korrekte Implementierung ausgerichtet" und nicht verbindlich; ein Fehler dort ist ein Anlass zum Nachsehen,
  ein Bestehen ersetzt weder die Belegprüfung in FinanzOnline noch die BMF-Belegcheck-App.
* Auswertung der Prüftool-Ausgabe (`scripts/rksv/lib/bmf-ergebnis.mjs`): Urteil sind nur die Wurzeln von `N_app/N_cashbox/N_dep.json` und `DEP-global.json`
  (`verificationState` PASS/FAIL). Die `*_full.json`/`DEP-full.json` enthalten ALLE Prüfungen inklusive der verworfenen Typ-Hypothesen (`TYPE_OF_RECEIPT_*` als FAIL unter einer
  PASS-Wurzel) und zählen nicht. Ein Lauf ohne erkanntes PASS gilt als **nicht** bestanden. (Die erste Fassung wertete alle Dateien aus und hielt deshalb auch die BMF-Beispiele
  für durchgefallen — der Probelauf hat das gezeigt; seitdem prüft der Kontrolllauf 16 von 16 BMF-Szenarien als bestanden.)
* **Wie das Tool bisher gelaufen ist:** Lokal wurde das heruntergeladene JAR bei der Entwicklung NICHT gestartet (die Berechtigungsprüfung hat es verhindert; nicht umgangen). Es lief
  ausschließlich in GitHub Actions (Probelauf auf dem Wegwerf-Branch `trial/rksv-nacht`, Java 8) — dort mit den hier beschriebenen Ergebnissen.

## Mit Zugang (noch nicht gebaut — braucht Zugänge des Users)

**FinanzOnline-Testübermittlung** (`art_uebermittlung=T`, verbucht nichts): FinanzOnline-Webservice-Benutzer (TID/BENID/PIN) und Hersteller-ID
(`herstellerid`, 10–24 alphanumerische Zeichen laut Schema — Bedeutung mit der FinanzOnline-Dokumentation klären; das Feld ist heute nur im rksv-Paket
mit ungültigem Platzhalter-Default setzbar, nicht aus Backend/UI). **Voraussetzung: erst den Client auf die Schemas bringen (Befund C).** Danach `scripts/fon-testlauf.ts`:
Login → `status_kasse` → `registrierung_se`/`registrierung_kasse` (T) → Status → `ausfall_se` + `wiederinbetriebnahme_se` → `belegpruefung` für Startbeleg und je einen Beleg
jeder Art (amtliches Urteil) → `ausfall_kasse`/`ausserbetriebnahme` → Logout; jede Anfrage/Antwort (ohne PIN) als Fixture unter `tests/fixtures/fon-live/`,
die dann die Mocks in `finanz-online.test.ts` ersetzen. Für Software-SEE (AT0) zusätzlich `registrierung_ggs` ausprobieren.

**A-Trust-Last-/Latenztest:** persönlicher Testzugang für die Abnahme-Umgebung (`ATRUST_ABNAHME=1`, `ATRUST_BENUTZER`, `ATRUST_PASSWORT`; der öffentliche
Doku-Benutzer darf nicht signieren, POST /Sign → 403). Skript: 500–1000 Signaturen mit Parallelität 1/4/16, Latenzverteilung (p50/p95/p99/max), Fehlerquote,
Auswirkung auf den SEE-Ausfallmodus (Timeout 2,5 s), jede Signatur lokal verifiziert, der entstehende DEP7 (ZDA `AT1`, echte Zertifikatskette) zusätzlich durch Python-Zweitprüfer
und BMF-Prüftool — das wäre der erste Test des offenen Systems mit echtem Zertifikat.

Außerdem mit Zugang: Jahres-/Startbeleg per BMF-Belegcheck-App prüfen (Authentifizierungscode aus FinanzOnline), das ist der einzige amtliche Echtbeleg-Test.
