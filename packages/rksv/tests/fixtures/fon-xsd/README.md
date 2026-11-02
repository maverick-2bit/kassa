# Amtliche FinanzOnline-Schemas (unverändert)

Diese Dateien sind **unveränderte Kopien** der Schnittstellenbeschreibung des BMF für den
Registrierkassen-Webservice. Sie dienen als externe Gegenprobe für den FinanzOnline-Client
(`src/finanz-online.ts`, `src/fon/*`): Die Tests erzeugen die Requests des Clients und prüfen
sie mit libxml2 (`xmllint-wasm`) gegen diese Schemas — siehe `tests/fon-xsd.test.ts`.

| Datei | Quelle (abgerufen am 2026-11-02) |
|---|---|
| `regKasseService.wsdl` | https://finanzonline.bmf.gv.at/fonws/ws/regKasseService.wsdl |
| `regKasseWs.xsd` | https://finanzonline.bmf.gv.at/fonws/ws/regKasseWs.xsd (Request/Response, bindet `regKasse.xsd` und `verification.xsd` ein) |
| `regKasse.xsd` | https://finanzonline.bmf.gv.at/fonws/ws/regKasse.xsd (Datensätze: Registrierung, Ausfall, Belegprüfung) |
| `verification.xsd` | https://finanzonline.bmf.gv.at/fonws/ws/verification.xsd (Prüfergebnisse der Belegprüfung) |
| `sessionService.wsdl` | https://finanzonline.bmf.gv.at/fonws/ws/sessionService.wsdl |
| `session.xsd` | https://finanzonline.bmf.gv.at/fonws/ws/session.xsd (Login/Logout) |

Die SHA-256-Prüfsummen stehen in `SHA256SUMS`. **Nicht bearbeiten, nicht neu formatieren**
(`.gitattributes` schaltet die Zeilenende-Umwandlung für diesen Ordner aus). Ändert das BMF die
Schemas, meldet das der nächtliche Vergleich (`scripts/rksv/fon-xsd-drift.mjs`, Workflow
`rksv-nacht`); dann die neuen Dateien laden, `SHA256SUMS` aktualisieren und die Tests prüfen:

```bash
node scripts/rksv/fon-xsd-drift.mjs --aktualisieren   # lädt neu und schreibt SHA256SUMS
```

Die Schemas sind öffentlich abrufbar (kein Login nötig) und werden hier nur zu Testzwecken
mitgeführt. Rechte am Inhalt: Bundesministerium für Finanzen.
