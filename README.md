# Kassa

Österreichische RKSV-konforme Registrierkasse (Multi-Tenant POS) als pnpm-Monorepo.

## Pakete

| Paket | Zweck |
|-------|-------|
| `rksv` | RKSV-Kern: SEE-Signierung (ECDSA), Signaturkette, AES-ICM-Umsatzzähler, FinanzOnline, DEP7/DEP131 |
| `shared` | Zod-Schemas + Typen (Single Source of Truth Backend ↔ Frontend) |
| `backend` | Fastify 5 + Drizzle ORM + PostgreSQL |
| `frontend` | React 19 + Vite 5 + Tailwind 4 (Kassen-Oberfläche) |
| `kds` | Küchen-Display-System |
| `kundendisplay` | Kundendisplay |
| `gast` | Gast-Bestellsystem (QR-Code) |
| `kellner` | Kellner-App (mobile-first) |
| `terminal` | SB-Bestellterminal (Selbstbedienungs-Kiosk) |
| `abholmonitor` | Abholmonitor (Bestellt / Zur Abholung bereit) |

## Produktiv-Deployment

Eine Box im Laden aufsetzen (alle Container, Autostart, Backup, optional HTTPS):
siehe **[ops/DEPLOYMENT.md](ops/DEPLOYMENT.md)**.
Für einen **Windows-Test-PC** gibt es den Doppelklick-Installer
**[ops/Kassa-Setup.cmd](ops/Kassa-Setup.cmd)** (auf den Ziel-PC kopieren →
Doppelklick; installiert bei Bedarf auch Docker Desktop — Details im
Deployment-Handbuch).

## Lokale Entwicklung

Voraussetzung: Node 22+, pnpm 9.15, PostgreSQL (lokal oder via Docker).

### Variante A — Docker (Null-Konfiguration, zum Ausprobieren)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Bringt Postgres + alle Services hoch. Dank **`FO_STUB`** lässt sich die Kasse
**ohne echte FinanzOnline-Zugangsdaten** einrichten — Setup, Kassieren und
RKSV-Belegsignierung funktionieren komplett lokal.
⚠️ Nur für Entwicklung — niemals in Produktion (siehe unten).

### Variante B — Manuell (für aktive Entwicklung)

```bash
# Secrets vorbereiten
cp packages/backend/.env.example packages/backend/.env
# in der .env: FO_STUB=true setzen, damit die Einrichtung ohne FinanzOnline geht

cd packages/backend && pnpm db:migrate:run && pnpm dev   # Backend :3000
cd packages/frontend && pnpm dev                          # Frontend :5173
```

Die übrigen Apps: `pnpm --filter @kassa/<paket> dev` (kds :5175, kundendisplay
:5176, gast :5177, kellner :5178).

## Tests

```bash
pnpm test                                   # alle Unit-Tests (Backend, Frontend, RKSV)
pnpm --filter @kassa/backend test:integration   # Integrationstests gegen echtes PostgreSQL
pnpm --filter @kassa/frontend test:e2e          # Playwright-E2E (legt Wegwerf-DB an, FO_STUB)
pnpm --filter @kassa/backend check:migrations   # Migrations-Integrität (Journal ↔ SQL)
```

Die E2E-Tests bauen das Frontend und starten Backend (mit `FO_STUB`) +
Frontend selbst; sie brauchen ein erreichbares PostgreSQL mit `CREATEDB`-Recht
(lokal: `ALTER ROLE kassa CREATEDB`).

## Datenbank-Migrationen

Migrationen sind **handgeschrieben und idempotent** (`IF NOT EXISTS`) mit
manuellem Eintrag in `drizzle/meta/_journal.json`. **Nie `db:push`** für
Schema-Änderungen verwenden (verursacht Drift). `check:migrations` stellt in der
CI sicher, dass Journal und SQL-Dateien 1:1 übereinstimmen.

## Betrieb / Deployment

- **Single-Instance:** Backend ist auf **eine Instanz** ausgelegt. SSE-Events
  (Kasse/KDS/Kundendisplay) laufen über einen In-Process-EventEmitter, und die
  Cron-Jobs (DEP-/DB-Sicherung) über In-Process-Timer. Bei mehreren Instanzen
  würden SSE-Clients Events verpassen und Crons doppelt laufen. Für horizontale
  Skalierung müssten Event-Bus (z. B. Postgres LISTEN/NOTIFY oder Redis) und
  Cron-Leader-Wahl externalisiert werden.
- **`FO_STUB` ist in Produktion verboten:** Eine gestubte FinanzOnline-
  Registrierung ist keine gültige RKSV-Anmeldung. Das Backend bricht bei
  `FO_STUB=true` + `NODE_ENV=production` beim Start ab.
- **`MASTER_PASSPHRASE`** verschlüsselt die privaten SEE-Schlüssel. Bei Verlust
  ist kein Schlüssel mehr entschlüsselbar und jede Kasse muss neu eingerichtet
  werden — sicher und dauerhaft aufbewahren.

### Topologie: eine Box pro Lokal

Empfohlen wird **ein eigener Rechner (Mini-PC/NUC) pro Lokal**, der Backend,
Postgres und die Frontends via Docker Compose betreibt. Das passt zur
Single-Instance-Architektur und dazu, dass Drucker (ESC/POS) und Kartenterminal
(ZVT) per TCP im **lokalen Netz** erreichbar sein müssen.

**Autostart nach Stromausfall:** Docker am Host beim Boot aktivieren
(`systemctl enable docker`); die Services haben `restart: unless-stopped` und
starten dann automatisch wieder.

### Off-Site-Backup (dringend empfohlen)

Postgres-Daten und die lokalen Sicherungen liegen sonst nur auf der Box — bei
Defekt/Diebstahl wären die Fiskaldaten (7 Jahre Aufbewahrungspflicht) verloren.
Der optionale `backup`-Service (siehe `docker-compose.yml`) schiebt die vom
Backend erzeugten DB- und DEP-Sicherungen mit **restic** verschlüsselt an
S3-kompatiblen Object-Storage. Aktivierung über `.env`
(`RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, S3-Zugangsdaten — siehe `.env.example`).
Ohne diese Variablen ist der Service inaktiv.

Der Backup-Service hat einen **Healthcheck**: er wird *unhealthy*, sobald der
letzte erfolgreiche Off-Site-Lauf älter als `BACKUP_MAX_AGE_STUNDEN` (Default 26 h)
ist — sichtbar in `docker ps` und für externes Monitoring abgreifbar. Beim Start
läuft sofort ein erstes Backup, danach täglich. Status prüfen:
`docker compose ps backup` (Spalte STATUS) bzw. `docker compose logs backup`.

**Backup verifizieren (auf der Box):** `./ops/backup/test-backup.sh` löst einen
Backup-Lauf aus, prüft Repository-Erreichbarkeit, macht eine Restore-Probe und
zeigt den Healthcheck-Status — bricht beim ersten Fehler ab.

**Backup lokal testen (ohne Cloud-Account):** `docker-compose.minio.yml` stellt
ein lokales MinIO als S3-Ziel bereit und legt das Bucket automatisch an:
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.minio.yml up -d --build
# Kasse einrichten (http://localhost) + einloggen, dann Sicherungen erzeugen,
# damit das Backup nicht leer ist (als Admin per API mit JWT):
#   curl -X POST http://localhost:3000/api/db-sicherungen  -H "Authorization: Bearer <JWT>"
#   curl -X POST http://localhost:3000/api/dep-sicherungen -H "Authorization: Bearer <JWT>" \
#        -H "Content-Type: application/json" -d '{"kasseId":"<uuid>","format":"dep7"}'
./ops/backup/test-backup.sh
```
Nur für Tests — MinIO läuft hier auf derselben Box und ist kein echtes Off-Site-Ziel.

**Restore-Runbook:**
```bash
# 1. Sicherungen aus dem Off-Site-Repo holen
docker run --rm -e RESTIC_REPOSITORY=... -e RESTIC_PASSWORD=... \
  -e AWS_ACCESS_KEY_ID=... -e AWS_SECRET_ACCESS_KEY=... \
  -v "$PWD/restore:/restore" restic/restic:0.17.3 restore latest --target /restore
# 2. Jüngsten Postgres-Dump aus restore/data/db-backups in die DB einspielen
#    (Format/Befehl siehe db-backup.service); danach Stack starten:
docker compose up -d
```

### Externes Monitoring

Der Endpoint **`GET /api/monitoring/status?token=<MONITORING_TOKEN>`** liefert
maschinenlesbar den DB- und Backup-Frische-Status und antwortet mit **HTTP 200**
(gesund) bzw. **503** (degradiert — DB nicht erreichbar ODER eine Sicherung älter
als `DB_/DEP_BACKUP_MAX_AGE_STUNDEN`). Ohne gesetztes `MONITORING_TOKEN` ist der
Endpoint deaktiviert (404).

Einen Uptime-Monitor (z. B. **Healthchecks.io**, **Uptime Kuma**) auf diese URL
zeigen lassen — er alarmiert dann bei 503 oder Nichterreichbarkeit über den
gewünschten Kanal (E-Mail, Push, Slack …). So fällt auf der unbeaufsichtigten
Box ein gestopptes Backup oder DB-Ausfall sofort auf. `fehlt` (noch keine
Sicherung) gilt bewusst NICHT als degradiert (frische Installation).

Eine detaillierte Live-Übersicht (DB-Latenz, Speicher/CPU, Backup-Block) bietet
zusätzlich `GET /api/admin/monitoring` (Admin-Login erforderlich).

### RKSV-Ausfallprozedur

Steht die Box (Hardware/Strom), kann nicht signiert werden. Gemäß RKSV:
Geschäftsfälle weiter aufzeichnen (Papierbeleg/Notlösung), den Ausfall
dokumentieren und nach Wiederherstellung die Belege nacherfassen. Dauert der
Ausfall länger als 48 h, ist er FinanzOnline zu melden. Der Frontend-Offline-
Modus (Service Worker/IndexedDB) puffert die Bedienung, ersetzt aber **nicht**
die Signierung — die braucht das Backend.

## CI / Deployment

`.github/workflows/ci.yml` (push/PR auf `master`):
Build + Unit-Tests, Migrations-Integrität, Integrationstests (Postgres-Service),
E2E (Playwright), Security-Audit (Build rot bei high/critical).

Auf `master`-Push werden zusätzlich versionierte Docker-Images nach **GHCR**
gepusht (`ghcr.io/<owner>/kassa-<service>:latest` + `:<sha>`). Deployment auf der
Box: gewünschtes `:<sha>`-Tag in der Compose-Datei pinnen und `docker compose pull
&& docker compose up -d`. Rollback = vorheriges `:<sha>`-Tag erneut ausrollen.
Eine Fiskalkasse **nie** automatisch (z. B. Watchtower) aktualisieren — Updates
immer kontrolliert und getestet einspielen.
