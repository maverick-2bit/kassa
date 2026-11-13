# FinanzOnline-Webservice — Umsetzungsstand

**Stand:** 2026-11-13 · **Ergebnis:** Der Client (`src/finanz-online.ts` + `src/fon/`) erzeugt **schema-gültige** Nachrichten und
wertet die Antworten so aus, wie das Schema sie aufbaut. Geprüft wird das mit libxml2 gegen die **unveränderten** amtlichen Schemas
(`tests/fon-xsd.test.ts`, Schemas samt Prüfsummen in `tests/fixtures/fon-xsd`); jede Nachricht, die der Client in den Testläufen
sendet, muss gültig sein. **Noch nicht erprobt:** eine echte Test-Übermittlung (`art_uebermittlung=T`) gegen
`finanzonline.bmf.gv.at` — dafür fehlen ein FinanzOnline-**Webservice-Benutzer** und die **Hersteller-ID** (siehe unten). Erst damit
zeigt sich, wie FinanzOnline die Nachrichten tatsächlich beantwortet.

> **Verlauf.** Bis 2026-11-02 stand hier, der Client sei „verifiziert gegen die offiziellen Schemas". Das stimmte nicht: die
> RKSV-Prüfstrecke (v0.8.77, `PRUEFSTRECKE.md` Befund C) fand, dass **kein** Request des Clients schema-gültig war (F-1 … F-11).
> Behoben am 2026-11-13 (Branch `fix/fon-schema`, noch nicht released); die Mocks der Unit-Tests sind jetzt selbst schema-gültig.

| Befund | Was war falsch | Jetzt |
|---|---|---|
| F-1 / F-2 | Wurzelelement `login`/`logout` statt `loginRequest`/`logoutRequest` | behoben |
| F-3 | Datensätze und Felder des rkdb ohne Namespace `https://finanzonline.bmf.gv.at/rkdb` | behoben (alles mit Präfix `rk:`) |
| F-4 | Pflichtfelder `paket_nr`, `ts_erstellung`, `satznr` fehlten | behoben |
| F-5 | `status_se` statt `status_see` | behoben |
| F-6 | SE und Kasse in einem `rkdb` (je Aufruf nur EINE Datensatzart) | behoben: zwei Aufrufe |
| F-7 | Ausfall/Wiederinbetriebnahme/Außerbetriebnahme mit falschen Feldnamen | behoben (`ausfall`/`begruendung`/`beginn_ausfall`, `ende_ausfall`, `ausfall_kasse`/`ausserbetriebnahme`) |
| F-8 | `abfrage_ergebnis` als Text gelesen (es hat Kinder `ts_registrierung`, `status`, `ts_status`) | behoben |
| F-9 | nur der erste `rc` wurde ausgewertet | behoben: jede Meldung jedes Ergebnisblocks zählt |
| F-10 | Standard-Hersteller-ID `ATU_KASSA_RKSV_0001` (Unterstriche) verletzt das Muster | behoben (gültiger Platzhalter, einstellbar, siehe unten) |
| F-11 | `vda_id` `AT0` (Software-Signatur) ist für `registrierung_se` nicht zulässig | **offene Entscheidung** — der Client weist AT0 ab, statt Ungültiges zu senden (siehe „Software-Signatur") |

## Die Schnittstelle (umgesetzt)

Zwei getrennte Webservices, **Session-basiert**, document/literal (die SOAP-Nachricht ist genau ein Element im Body):

| | Endpoint | Namespace | Operationen | SOAPAction |
|---|---|---|---|---|
| **Session** | `https://finanzonline.bmf.gv.at/fonws/ws/session` | `https://finanzonline.bmf.gv.at/fon/ws/session` | `login`, `logout` | `login` / `logout` |
| **Registrierkasse** | `https://finanzonline.bmf.gv.at/fonws/ws/rkdb` | `https://finanzonline.bmf.gv.at/rkdb` | **nur** `rkdb` | `rkdb` |

**Ablauf** (`src/fon/session.ts` + `src/fon/rkdb.ts`, orchestriert in `FinanzOnlineClient.imSession`):

1. `loginRequest(tid, benid, pin, herstellerid)` → `loginResponse { id (Session-ID), rc, msg }`. Erfolg = `rc` 0 und `id` gesetzt
   (laut BMF: −1 Session ungültig/abgelaufen, −2 Wartungsarbeiten, −3 technischer Fehler, −4 Zugangsdaten ungültig).
2. `rkdbRequest(tid, benid, id, art_uebermittlung)` mit **genau einem** Aktions-Element (`T`/`P` aus der Kassen-`umgebung`).
3. `logoutRequest(tid, benid, id)` (Fehler nicht fatal).

Netz- und SOAP-Fehler (HTTP 500 mit `faultstring`, Zeitüberschreitung) kommen als Ergebnis mit Fehlermeldung zurück, nicht als Ausnahme;
das Logout läuft in jedem Fall.

## Was der Client sendet

| Methode | Nachrichten | Anmerkung |
|---|---|---|
| `kasseInBetriebNehmen` | `status_see` → `rkdb`/`registrierung_se` → `rkdb`/`registrierung_kasse` | zwei Aufrufe. Kennt FinanzOnline die SE schon (Statusabfrage mit rc 0 und `status`), entfällt `registrierung_se`: nach einem Abbruch zwischen den Schritten käme sonst bei jedem Wiederholen „bereits gespeichert". Eine bereits registrierte **Kasse** wird nie stillschweigend übernommen (anderer Benutzerschlüssel möglich) — die Ablehnung bleibt sichtbar. |
| `startbelegPruefen` | `status_kasse` | `REGISTRIERT`/`IN_BETRIEB` = ok, `AUSFALL` = nicht ok. Prüft **nicht** den Beleg selbst (siehe „belegpruefung"). |
| `statusSe` | `status_see` | liefert den Status (`AKTIVIERT`, `AUSFALL`, …) als `pruefwert` |
| `seeAusfallMelden` | `rkdb`/`ausfall_se` mit `ausfall { begruendung, beginn_ausfall }` | Begründung 2 (Standard), `beginn_ausfall` = tatsächlicher Beginn (das Backend übergibt `seeAusgefallenSeit`), nie später als jetzt |
| `seeWiederinbetriebnahmeMelden` | `rkdb`/`wiederinbetriebnahme_se` mit `ende_ausfall` | Standard: jetzt |
| `kasseAusserBetriebNehmen` | `rkdb`/`ausfall_kasse` mit `ausserbetriebnahme { begruendung }` | Begründung 6 (Standard); einen Zeitpunkt gibt es dafür nicht (FinanzOnline nimmt den der Übermittlung) |

**Antworten** (`parseRkdbAntwort`): je Datensatz ein `result` (`satznr`, eine oder mehrere `rkdbMessage` mit `rc` und `msg`, bei Statusabfragen
`abfrage_ergebnis`). **Erfolg nur, wenn es mindestens ein Ergebnis gibt, jedes Ergebnis mindestens eine Meldung hat und jede Meldung `rc` = `0`
trägt.** `rc` ist ein **Text** (laut BMF u. a. `0`, `-1` bis `-4`, `4`, `B14`, `V6` …) und wird nicht als Zahl gelesen; jeder Wert außer `0` ist ein
Fehler. Eine unlesbare Antwort (Wartungsseite, abgeschnittenes XML) ist kein Erfolg. Fehlermeldungen nennen alle fehlgeschlagenen Meldungen
(`(rc B20): Text`); Zeichenverweise im Text (`&amp;`, `&#223;`) werden gelesen.

## Wichtige Umsetzungsdetails

- **`benutzerschluessel`** = der Umsatzzähler-AES-Schlüssel (32 Byte) als Base64 (44 Zeichen) — ein eigenständiger Schlüssel je Kasse.
- **`zertifikatsseriennummer`:** laut BMF entweder in der Original-Kodierung (Dezimalzahl) oder hexadezimal **mit Attribut `hex="true"`**, ohne Präfix
  `0x`. Bei der Registrierung kommt die Dezimalzahl aus dem Zertifikat (`zertSeriennummerDezimal`). Die Seriennummer, die Datenbank und Beleg
  halten, ist **hexadezimal** — Ausfall, Wiederinbetriebnahme und Statusabfrage schicken sie deshalb mit `hex="true"`. (Vorher ging sie
  unmarkiert hinaus, FinanzOnline hätte sie als Dezimalzahl gelesen: ein Fehler, den die Schema-Prüfung nicht sieht, weil das Muster beides erlaubt.)
- **Hersteller-ID** (`herstellerid` im Login): laut BMF-Beschreibung des Session-Webservice die **UID-Nummer des Softwareherstellers** (nicht des Betriebs),
  Muster `[0-9A-Za-z]{10,24}`, z. B. `ATU12345678`. Einstellung im Backend: **`FON_HERSTELLER_ID`** (`.env`, siehe `ops/DEPLOYMENT.md` 6b); ein ungültiger Wert
  verhindert den Start. Vorrang: `credentials.herstellerId` > Einstellung > Platzhalter `KASSANICHTGESETZT` (gültig nach Schema, aber erkennbar kein echter Wert;
  bei fehlgeschlagenem Login weist die Meldung darauf hin). Ob FinanzOnline die ID nur auf Form oder auch auf Existenz prüft, zeigt erst der Testzugang.
- **Begründungscodes** (BMF „Registrierkassen-Webservice", Stand 12.05.2017, Punkt 4): Ausfall SE — 1 Diebstahl/Verlust, **2 Signatur- bzw. Siegelerstellung unmöglich
  oder fehlerhaft**, 99 sonstiger Grund; Ausfall Kasse — 1, 5, 99; Außerbetriebnahme SE und Kasse — **6 planmäßig**, 7 wegen irreparablen Ausfalls. Das Schema lässt 1–99 zu;
  die Codes stammen aus der Beschreibung (dort ist 2016 eine Änderung der Codes 2 und 5 vermerkt — vor dem Echtbetrieb die aktuelle Liste prüfen).
- **Zeitangaben** (`ts_erstellung`, `beginn_ausfall`, `ende_ausfall`, `xs:dateTime`): Wiener Ortszeit **mit** Zeitzonenabstand (`2026-11-13T10:30:00+01:00`), unabhängig von `TZ`
  (`src/fon/datum.ts`). Die BMF-Beschreibung nennt keine Zeitzone; mit Abstand ist die Angabe in jeder Lesart richtig. Ein Ausfallbeginn in der Zukunft ist laut BMF
  unzulässig (Fehler `V1`) — der Client begrenzt ihn auf jetzt.
- **`paket_nr` / `satznr`:** laut BMF beliebige Nummern bis 9 Stellen, vom Übermittler vergeben. `paket_nr` kommt aus der Uhr (1 … 999 999 999), `satznr` ist 1: der Client schickt je
  Aufruf genau einen Datensatz — denn mehrere Datensätze verarbeitet FinanzOnline **asynchron** (Ergebnis in die Databox), einen einzelnen und jede Statusabfrage synchron.
- **Prüfung vor dem Senden:** Ein Request, der das Schema verletzen würde, geht gar nicht erst hinaus — ungültige Hersteller-ID, Seriennummer ohne Hexadezimalziffern, unzulässige
  `vda_id`, unlesbares Zertifikat werden als Fehlermeldung zurückgegeben.

## Software-Signatur (AT0) — OFFENE ENTSCHEIDUNG

**Lage.** Die Kassa signiert ohne A-Trust-Konfiguration mit einem selbst erzeugten Zertifikat (Kennung `AT0`). Für `registrierung_se` lässt das Schema `vda_id`
nur `[A-Z]{2}[1-9][0-9]?` zu, die BMF-Beschreibung nennt AT1 (A-Trust), AT2 (GlobalTrust), AT3 (PrimeSign): **AT0 ist nicht meldbar** (F-11). Das Schema kennt für Software-Signaturen
einen anderen Weg: **`registrierung_ggs`** („Validierungsdaten in einem geschlossenen Gesamtsystem") mit `art_ob` (UID/GLN/FASTNR) + `ob` (der Ordnungsbegriff, z. B. die UID),
optional `zusatz_ob`, `art_se_ggs` = `SW_GGS` (oder `EIGENES_HSM`) und `public_key` (Base64 des öffentlichen Schlüssels, SubjectPublicKeyInfo/DER) **oder** `zertifikat`; dazu
`ausfall_ggs`, `wiederinbetriebnahme_ggs`, `status_ggs`. Das hängt mit Befund D zusammen: Das BMF-Prüftool erwartet bei geschlossenen Systemen statt der Zertifikats-Seriennummer
den Ordnungsbegriff im Beleg (`U:ATU12345678-K1`) und beanstandet jeden AT0-Beleg (`PRUEFSTRECKE.md`, Abschnitt D).

**Stand im Code.** Der Client sendet für AT0 nichts und sagt klar, warum (Test „F-11"). Wer bei der Einrichtung FinanzOnline-Zugangsdaten **und** die Software-Signatur hat, bekommt
diese Meldung — vorher scheiterte es an FinanzOnline an der ungültigen Nachricht. Der funktionierende Weg ist: provisorisch einrichten (ohne FinanzOnline-Zugang), die Kasse auf A-Trust (AT1)
umstellen, dann die Registrierung nachtragen.

**Optionen** (der Anwender entscheidet):
- **A — AT0 als geschlossenes Gesamtsystem melden** (`registrierung_ggs` + Kasse): Client-Seite überschaubar; die Beleg-Seriennummer müsste dann der Ordnungsbegriff sein (Befund D, ändert
  signierte RKSV-Belegdaten) — und ob die Kassa-Betreiber überhaupt als „geschlossenes Gesamtsystem" auftreten dürfen, ist eine fachlich-rechtliche Frage, die sich aus den Schemas nicht beantworten lässt.
- **B — AT0 bleibt Test-/Demo-Signatur, FinanzOnline nur mit A-Trust:** heutiger Stand dieses Branches, kein weiterer Aufwand.
- **C — erst mit Testzugang ausprobieren,** ob FinanzOnline `registrierung_ggs` für diesen Teilnehmer überhaupt annimmt, und danach A oder B.

## `belegpruefung` — vom Client (noch) nicht genutzt

Das Schema kennt `belegpruefung` (amtliche Prüfung eines Belegs, Antwort mit `verificationResultList`). Der Client ruft sie **bewusst nicht** auf; `startbelegPruefen` fragt weiter nur den Kassen-Status ab.
Gründe laut BMF-Beschreibung und Prüfstrecke: je Aufruf **ein** Beleg, Antwort synchron; ein **wiederholt fehlerhaft geprüfter Beleg wird bis zu 24 Stunden nicht mehr geprüft** — ein
automatischer Aufruf könnte die spätere Prüfung des Startbelegs (Belegcheck-App) sperren, und AT0-Belege fallen laut BMF-Prüftool ohnehin durch (Befund D); ob eine erfolgreiche Belegprüfung die Kasse
auf `IN_BETRIEB` setzt, steht nirgends. **Folgekarte** (nach Testzugang): Methode `belegPruefen(code, credentials)` mit `belegpruefung { satznr, beleg }` (Muster: 13 Gruppen, 100–1000 Zeichen),
Auswertung der verschachtelten `verificationResultList` (braucht einen echten XML-Baum statt der bisherigen Textsuche), zuerst von Hand mit einem A-Trust-Startbeleg.

## Noch final zu verifizieren (mit Test-Zugang)

- Nehmen die Nachrichten den Dienst an, und stimmen die Return-Codes mit der Beschreibung (Fehlercodes `B…`, `V…`, `C1`, Zahlen)? Insbesondere: antwortet `status_see` auf eine unbekannte SE mit rc ≠ 0 (die Vorabfrage der Registrierung setzt das voraus)?
- **Test-Modus (`T`) und die zwei Registrierungsschritte:** verbucht `T` nichts, könnte `registrierung_kasse` nach `registrierung_se` mit „keine in Betrieb befindliche Signaturerstellungseinheit" scheitern — dann
  beide Schritte getrennt prüfen.
- Akzeptiert FinanzOnline den Platzhalter als Hersteller-ID, oder prüft es die UID? Wird `ts_erstellung`/`beginn_ausfall` mit Abstand wie erwartet gelesen?
- Statuswerte: welche gelten für SE (`AKTIVIERT`, `AUSFALL`) und welche für Kassen (`REGISTRIERT`, `IN_BETRIEB`, `AUSFALL`); wann wird eine Kasse `IN_BETRIEB`?
- Verhalten bei Wiederholung („Status bereits gesetzt", „Kasse bereits registriert") — idempotent behandeln oder nicht?

## Test-Zugang einrichten (nächster Schritt)

1. In FinanzOnline unter **Admin → Benutzer** einen **Webservice-Benutzer** anlegen (eigene TID/BenID/PIN).
2. Die **UID-Nummer des Softwareherstellers** als `FON_HERSTELLER_ID` eintragen (Hersteller-ID = UID laut BMF-Beschreibung des Session-Webservice).
3. Kasse mit `umgebung: 'test'` einrichten → alle `rkdb`-Aufrufe laufen mit `art_uebermittlung=T` (verbucht nichts) gegen die echte Schnittstelle.
4. Return-Codes und Antworten prüfen, Mocks durch aufgezeichnete Antworten (ohne PIN) ersetzen (`PRUEFSTRECKE.md`, „Mit Zugang").

## Quellen

- WSDL Session: https://finanzonline.bmf.gv.at/fonws/ws/sessionService.wsdl · WSDL Registrierkasse: https://finanzonline.bmf.gv.at/fonws/ws/regKasseService.wsdl
- Schemas: `session.xsd`, `regKasseWs.xsd`, `regKasse.xsd`, `verification.xsd` (BMF; unverändert in `tests/fixtures/fon-xsd`)
- BMF „Registrierkassen Webservice" (Stand 12.05.2017): https://www.bmf.gv.at/dam/jcr%3A19c193f4-99cd-42ff-9b23-655f2ab5734e/BMF_Registrierkassen_Webservice.pdf
- BMF „Session Webservice" (Stand 06.11.2019; `herstellerid` = „UID-Nummer des Softwareherstellers", Return-Codes 0, −1 bis −4): https://www.bmf.gv.at:443/dam/jcr:570753b2-d511-4194-a03e-33f0ac7371ec/BMF_Session_Webservice_2.pdf
- BMF RKSV-Mustercode: https://github.com/BMF-RKSV-Technik/at-registrierkassen-mustercode
