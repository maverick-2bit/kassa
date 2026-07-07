# FinanzOnline-Webservice — Umsetzungsstand

**Stand:** 2026-07-08 · **Ergebnis:** ✅ Der Client (`src/finanz-online.ts` +
`src/fon/`) ist gegen die **echte** BMF-Schnittstelle neu implementiert
(Session-Login → `rkdb` → Logout). Verifiziert gegen die offiziellen Schemas
`session.xsd`, `regKasseWs.xsd` und `regKasse.xsd`.

**Offen (blockiert durch fehlenden Zugang, nicht durch Code):** eine echte
**Test-Übermittlung** (`art_uebermittlung=T`) gegen `finanzonline.bmf.gv.at`
mit einem FinanzOnline-**Webservice-Benutzer**. Erst damit lassen sich
Return-Codes und die Feldnamen der Ausfall-/Außerbetriebnahme-Datensätze
final bestätigen. Registrierung + Status sind schema-verifiziert.

## Die echte Schnittstelle (umgesetzt)

Zwei getrennte Webservices, **Session-basiert**:

| | Endpoint | Namespace | Operationen | SOAPAction |
|---|---|---|---|---|
| **Session** | `https://finanzonline.bmf.gv.at/fonws/ws/session` | `https://finanzonline.bmf.gv.at/fon/ws/session` | `login`, `logout` | `login` / `logout` |
| **Registrierkasse** | `https://finanzonline.bmf.gv.at/fonws/ws/rkdb` | `https://finanzonline.bmf.gv.at/rkdb` | **nur** `rkdb` | `rkdb` |

**Ablauf** (`src/fon/session.ts` + `src/fon/rkdb.ts`, orchestriert in
`FinanzOnlineClient.imSession`):
1. `login(tid, benid, pin, herstellerid)` → `{ id (Session-ID), rc, msg }`.
   Erfolg = `rc === '0'` und `id` gesetzt.
2. `rkdb`: `tid`, `benid`, `id`, `art_uebermittlung` (`T`/`P` aus der
   Kassen-`umgebung`), dann **ein** Aktions-Element:
   - `rkdb` → `registrierung_se` (`satznr`, `art_se`, `vda_id`,
     `zertifikatsseriennummer`) + `registrierung_kasse` (`satznr`,
     `kassenidentifikationsnummer`, `benutzerschluessel`)
   - `status_kasse` / `status_se`
3. `logout(tid, benid, id)` (Fehler nicht fatal).

**Response:** `result` → `rkdbMessage.rc` + `msg`; Status-Abfragen liefern
`abfrage_ergebnis` (`AKTIVIERT` / `REGISTRIERT` / `IN_BETRIEB` / `AUSFALL`).
Erfolg wird über `rc === '0'` erkannt.

## Wichtige Umsetzungsdetails

- **`benutzerschluessel`** = der Umsatzzähler-AES-Schlüssel (32 Byte) base64 —
  seit dem spec-konformen Kern (Etappe A) ein eigenständiger Schlüssel je Kasse,
  der genau hier gemeldet wird.
- **`zertifikatsseriennummer` DEZIMAL**: FON erwartet die Seriennummer dezimal,
  `X509Certificate.serialNumber` liefert hex → `zertSeriennummerDezimal()`.
- **`art_se` / `vda_id`** aus der SEE-Konfiguration der Kasse (Etappe B):
  A-Trust → `HSM_DIENSTLEISTER` / `AT1`; Software-SEE (Dev) → `EIGENES_HSM` / `AT0`.
- **`herstellerid`**: bei BMF zu registrierende Software-Hersteller-ID; Default
  überschreibbar über `credentials.herstellerId`.
- **Startbeleg-Prüfung** läuft NICHT über den WebService, sondern über die
  BMF-**BelegCheck-App**. `startbelegPruefen()` fragt daher `status_kasse` ab
  (REGISTRIERT/IN_BETRIEB = ok); die UI verweist für den Startbeleg auf die App.

## Noch final zu verifizieren (mit Test-Zugang)

Die Datensätze für **Außerbetriebnahme** (`ausserbetriebnahme_kasse`) und
**SEE-Ausfall/-Wiederinbetriebnahme** (`ausfall_se` / `wiederinbetriebnahme_se`,
mit `beginn`/`ende`-Zeitstempel) sind analog zur Registrierung gebaut, ihre
exakten Feldnamen aber noch gegen die vollständige `regKasse.xsd` + eine
Test-Übermittlung zu bestätigen (`src/fon/rkdb.ts` → `rkdbAktion`, klar markiert).

## Test-Zugang einrichten (nächster Schritt)

1. In FinanzOnline unter **Admin → Benutzer** einen **Webservice-Benutzer**
   anlegen (eigene TID/BenID/PIN).
2. Software-Hersteller-ID beim BMF registrieren (bzw. Test-ID verwenden).
3. Kasse mit `umgebung: 'test'` einrichten → alle `rkdb`-Aufrufe laufen mit
   `art_uebermittlung=T` (verbucht nichts) gegen die echte Schnittstelle.
4. Return-Codes prüfen; ggf. Ausfall-/Außerbetriebnahme-Feldnamen nachziehen.

## Quellen
- WSDL Session: https://finanzonline.bmf.gv.at/fonws/ws/sessionService.wsdl
- WSDL Registrierkasse: https://finanzonline.bmf.gv.at/fonws/ws/regKasseService.wsdl
- Schemas: `session.xsd`, `regKasseWs.xsd`, `regKasse.xsd` (BMF)
- BMF RKSV-Mustercode: https://github.com/BMF-RKSV-Technik/at-registrierkassen-mustercode
