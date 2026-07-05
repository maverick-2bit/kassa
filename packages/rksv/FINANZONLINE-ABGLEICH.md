# FinanzOnline-Webservice — Abgleich mit der echten BMF-Schnittstelle

**Stand:** 2026-07-02 · **Ergebnis:** ⚠️ Die aktuelle SOAP-Implementierung in
`src/finanz-online.ts` entspricht **NICHT** der echten BMF-Schnittstelle und
würde gegen den realen FinanzOnline-Webservice **nicht funktionieren**. Sie
„funktioniert" bisher nur gegen den eigenen Stub (`FO_STUB`).

Dieser Abgleich wurde anhand der öffentlichen BMF-WSDLs und der offiziellen
RKSV-Muster-Community erstellt (Quellen unten). Zur Umsetzung + Freigabe sind
ein echter FinanzOnline-**Webservice-Benutzer** (Testumgebung) und das
vollständige `regKasseWs.xsd` nötig.

## Die echte Schnittstelle (Ist beim BMF)

Zwei getrennte Webservices, **Session-basiert**:

| | Endpoint | Namespace | Operationen | SOAPAction |
|---|---|---|---|---|
| **Session** | `https://finanzonline.bmf.gv.at/fonws/ws/session` | `https://finanzonline.bmf.gv.at/fon/ws/session` | `login`, `logout` | `login` / `logout` |
| **Registrierkasse** | `https://finanzonline.bmf.gv.at/fonws/ws/rkdb` | `https://finanzonline.bmf.gv.at/rkdb` | **nur** `rkdb` | `rkdb` |

**Ablauf:**
1. `login(tid, benid, pin)` am Session-WS → liefert eine **Session-ID** (`id`).
2. `rkdb(...)` am Registrierkassen-WS mit dieser Session-ID im Feld `id`.
   **Eine einzige** Operation `rkdb` transportiert ALLE Aktionen; der Aktionstyp
   steckt im Payload (nicht als eigene SOAP-Operation):
   - `registrierung_se` (SEE registrieren: `art_se`, `vda_id`, `zertifikatsseriennummer`, …)
   - `registrierung_rk` (Registrierkasse: `kassenidentifikationsnummer`, …)
   - Status-Abfragen `status_kasse` / `status_see` / `status_ggs`
   - (Außerbetriebnahme / Ausfall analog als Datensätze im `rkdb`-Payload)
3. `logout(tid, benid, id)`.

**rkdbRequest** (Auszug): `tid`, `benid`, `id` (=Session-ID), `art_uebermittlung`
(`"T"`/`"P"`), optional `erzwinge_asynchron`, dann genau ein Aktions-Element
(`rkdb` mit Registrierungs-Datensätzen bzw. `status_*`), je mit `paket_nr`,
`ts_erstellung`, `satznr`.

**rkdbResponse**: `result` → `rkdbMessage` mit **`rc`** (Return-Code) + **`msg`**;
Status-Abfragen liefern `abfrage_ergebnis` mit Werten wie `AKTIVIERT`,
`REGISTRIERT`, `IN_BETRIEB`, `AUSFALL`. Erfolg wird über `rc` signalisiert
(nicht über ein `<Code>000</Code>`-Element).

## Was unsere Implementierung falsch macht

| Aspekt | Unser Code (`finanz-online.ts`) | Echt (BMF) |
|---|---|---|
| Endpoint | `…/fon/ws/rksv/` | `…/fonws/ws/rkdb` + `…/fonws/ws/session` |
| Namespace | `…/fon/ws/rksv` | `…/rkdb` bzw. `…/fon/ws/session` |
| Auth | TID/BenID/PIN bei **jedem** Call | `login` → **Session-ID**, dann `id` mitgeben |
| Operationen | `SEERegistrierung`, `KasseRegistrierung`, `StartbelegPruefen`, `KasseAusserBetriebnahme`, `SEEAusfall`, `SEEWiederinbetriebnahme` | existieren nicht — **nur** `rkdb` (+ `login`/`logout`); Aktion steckt im Payload |
| SOAPAction | volle URL je „Operation" | `rkdb` / `login` / `logout` |
| Response | sucht `<Code>000</Code>` / `<Info>` | `rkdbMessage.rc` + `msg`, `abfrage_ergebnis` |
| Startbeleg-Prüfung | eigener Call `StartbelegPruefen` | Beleg-/Startbeleg-Prüfung läuft **nicht** über diesen WS — erfolgt per FinanzOnline-App/Belegcheck bzw. DEP-Upload; hier ist die Annahme grundfalsch |

**Fazit:** Jede Achse (Transport, Auth, Operationsnamen, Payload, Response) weicht
ab. Der reale Produktivbetrieb der FON-Anbindung ist damit **nicht gegeben**;
der Rest des RKSV-Kerns (SEE-Signatur, Umsatzzähler, DEP, Belegkette) ist davon
unberührt und korrekt.

## Empfehlung

1. `finanz-online.ts` gegen die echte Schnittstelle **neu implementieren**:
   Session-Login → `rkdb`-Operation mit typisierten Registrierungs-Datensätzen →
   Logout; Response über `rc`/`msg` auswerten.
2. Zwingend mit einem **FinanzOnline-Webservice-Testbenutzer** gegen
   `finanzonline.bmf.gv.at` (Testumgebung) validieren, inkl. `regKasseWs.xsd`-
   Schema-Validierung (der häufigste reale Fehler ist `cvc-complex-type`).
3. Bis dahin: FON-Registrierung/-Abmeldung nur mit `FO_STUB` (Dev/Test) nutzen;
   provisorische Einrichtung ohne FON ist möglich (siehe `setup.ts`), die
   FON-Registrierung ist dann **manuell** über das FinanzOnline-Portal
   nachzutragen.

## Quellen
- WSDL Session: https://finanzonline.bmf.gv.at/fonws/ws/sessionService.wsdl
- WSDL Registrierkasse: https://finanzonline.bmf.gv.at/fonws/ws/regKasseService.wsdl
- Schema: https://finanzonline.bmf.gv.at/fonws/ws/regKasseWs.xsd
- BMF RKSV-Mustercode (Community/Issues): https://github.com/BMF-RKSV-Technik/at-registrierkassen-mustercode
