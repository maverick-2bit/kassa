# Referenzdaten des BMF-Mustercodes (unverändert)

Auszug aus dem Beispiel-Output des BMF-Mustercodes — Belege, die ein unabhängig vom Kassa-Code
geschriebener Generator des BMF (mit A-SIT Plus) erzeugt hat. Sie sind die einzige Gegenprobe der
RKSV-Umsetzung gegen **fremd erzeugte** Daten: Verkettung, Umsatzzähler und Signaturen der Kassa
werden an ihnen gemessen, nicht an Nachrechnungen mit derselben Lesart.

| | |
|---|---|
| Quelle | https://github.com/BMF-RKSV-Technik/at-registrierkassen-mustercode → Release V1.0.0 → `example-output-1.0.0.zip` (Verzeichnisse `closed system/TESTSUITE_TEST_SZENARIO_1` und `open system/TESTSUITE_TEST_SZENARIO_1`) |
| Abgerufen | 2026-11-02, ZIP SHA-256 `b5d50c0c8258595327c431ebcb6613d98cbf584b945676bdc9376d2cf42d5473` |
| Lizenz | Muster-Code und Beispieldaten des Repositorys: Apache License 2.0 (siehe README des Repositorys) |
| Inhalt je Szenario | `dep-export.json` (DEP7, 81 Belege), `qr-code-rep.json` (dieselben Belege als QR-Codes), `cryptographicMaterialContainer.json` (AES-Schlüssel + öffentliche Schlüssel/Zertifikate) |
| `closed-system-1` | geschlossenes Gesamtsystem, ZDA `AT0`, Schlüssel `U:ATU12345678-K0/K1/K2` als öffentliche Schlüssel |
| `open-system-1` | offenes System, ZDA `AT100`, drei Zertifikate |

Was in den Daten steckt (relevant für Eigenheiten der Kassa):

- Verkettung (`Sig-Voriger-Beleg`) = Base64(SHA-256(**JWS-Compact** des Vorbelegs)[0..7]) — alle 1284 Folgebelege der 16 Szenarien.
- Belegnummern sind Text (`CASHBOX-DEMO-1-Receipt-ID-1`), der IV des Umsatzzählers wird aus Kassen-ID + diesem Text gebildet.
- Umsatzzähler: 6 Byte (Spezifikation: mindestens 5). Trainingsbelege tragen `TRA`, Stornobelege `STO` (Base64 von „TRA"/„STO") statt des verschlüsselten Zählers; Trainingsbeträge zählen nicht, Stornobeträge schon.
- Im offenen System weicht die Seriennummer im Beleg vom Zertifikat ab (Zweierkomplement der Seriennummer, Eigenheit des Generators) — der Container ordnet den Schlüssel über diese Kennung zu.
- Ausfallbelege tragen als Signatur den Text „Sicherheitseinrichtung ausgefallen".

Die Dateien nicht bearbeiten (`.gitattributes` schaltet die Zeilenende-Umwandlung aus, Prüfsummen in `SHA256SUMS`).
Weitere Szenarien: das Release-ZIP laden — der nächtliche Workflow `rksv-nacht` lässt das BMF-Prüftool zur Kontrolle über alle 16 laufen.
