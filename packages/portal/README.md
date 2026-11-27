# Kassa Serviceportal (Backend)

Zentrale Stelle für den Betreiber: sieht auf einen Blick, ob die Kassa-Boxen der Kunden laufen, und sammelt ihre
Fehlerberichte. Die Boxen melden **von sich aus** nach außen (HTTPS POST) — es ist kein Port beim Kunden offen.

Das Portal bekommt **nur technischen Zustand** (Erreichbarkeit, Version, Sicherungen, Speicher, Drucker, Fehler), nie
Umsätze, Belege, Kunden-, Artikel- oder Mitarbeiterdaten. Die Grenze ist das Schema `PortalMeldungSchema`
(`packages/shared/src/schemas/portal.ts`): Die Box prüft ihre Meldung vor dem Senden dagegen, das Portal beim Empfang —
Zusatzfelder werden verworfen.

## Einrichten

1. PostgreSQL bereitstellen (eigene Datenbank, **nicht** die einer Kassa-Box).
2. `.env` aus `.env.example` anlegen. Pflicht: `DATABASE_URL`, `PORTAL_JWT_SECRET`, `PORTAL_MASTER_KEY` (je mindestens
   32 zufällige Zeichen, z. B. `openssl rand -base64 48`). Geht `PORTAL_MASTER_KEY` verloren, müssen alle Benutzer ihre
   Authenticator-App neu einrichten (`totp-zuruecksetzen`).
3. Starten: `pnpm --filter @kassa/portal start` (spielt die Migrationen selbst ein). Hinter Caddy/nginx
   `TRUST_PROXY=true` setzen, damit die Begrenzung die echte Client-Adresse sieht.

## Benutzer

Es gibt keine Selbstregistrierung. Benutzer legt man auf der Kommandozeile an:

```
pnpm --filter @kassa/portal benutzer anlegen --email chef@firma.at
pnpm --filter @kassa/portal benutzer passwort-setzen --email chef@firma.at
pnpm --filter @kassa/portal benutzer totp-zuruecksetzen --email chef@firma.at
```

Ohne `--passwort` wird ein zufälliges erzeugt und **einmal** ausgegeben. Die Anmeldung braucht Passwort **und** den Code
einer Authenticator-App (TOTP). Beim ersten Anmelden wird die App eingerichtet (Geheimnis/QR-Code, Bestätigung mit
einem Code). Nach 5 Fehlversuchen ist das Konto 15 Minuten gesperrt. Ein Code gilt nur einmal.

## Eine Box anbinden

1. Im Portal einen **Betrieb** und darin eine **Box** anlegen. Das Token (`kpt_…`) wird **nur einmal** angezeigt; das
   Portal speichert nur dessen SHA-256.
2. In der `.env` der Box eintragen: `PORTAL_URL=https://<portal-adresse>` und `PORTAL_TOKEN=<token>`
   (optional `PORTAL_INTERVALL_SEKUNDEN`). Ohne diese beiden Werte meldet die Box nichts.
3. Nach der ersten Meldung wechselt die Box in der Übersicht von „Noch keine Meldung" auf ihren Zustand.
   Ein neues Token (`POST /api/boxen/:id/token-erneuern`) macht das alte sofort ungültig.

## Status einer Box

`ok` · `warnung` (Sicherung veraltet, Drucker nicht erreichbar, Speicher knapp, Bons nicht zugestellt, Zertifikat läuft
in < 30 Tagen ab …) · `kritisch` (Datenbank, Signatureinheit, Zertifikat abgelaufen, Speicher fast voll) · `offline`
(länger als `PORTAL_OFFLINE_NACH_SEKUNDEN` keine Meldung) · `neu`. Die Regeln stehen in `src/services/bewertung.ts`
(rein, mit Tests).

## API (alles unter `/api`)

| Route | Schutz |
|---|---|
| `GET /health` | offen (ohne Daten) |
| `POST /auth/anmelden`, `/auth/totp/einrichten`, `/auth/totp/bestaetigen`, `GET /ich` | Anmeldung bzw. Einrichtungs-Token |
| `POST /box/meldung` | Box-Token (Bearer) |
| `GET /uebersicht`, `/boxen/:id`; `POST /betriebe`, `PATCH /betriebe/:id`, `POST /betriebe/:id/boxen`, `PATCH /boxen/:id`, `POST /boxen/:id/token-erneuern` | Sitzung |

`tests/route-schutz.test.ts` hält jede Route samt Schutz fest — eine neue Route oder ein verlorener Wächter lässt den Test
anschlagen.

## Tests

```
pnpm --filter @kassa/portal test               # schnell, ohne Datenbank
pnpm --filter @kassa/portal test:integration   # echtes PostgreSQL (TEST_DATABASE_URL, Rolle mit CREATEDB)
```
