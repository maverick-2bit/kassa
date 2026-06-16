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

## CI

`.github/workflows/ci.yml` (push/PR auf `master`):
Build + Unit-Tests, Migrations-Integrität, Integrationstests (Postgres-Service),
E2E (Playwright), Security-Audit (Build rot bei high/critical), Docker-Builds.
