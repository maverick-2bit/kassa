# Kassa – Produktiv-Deployment (Mini-PC im Laden)

Diese Anleitung bringt die komplette Kassa auf einer kleinen Box (Mini-PC / NUC /
Server) in Betrieb: Backend + Datenbank + alle Web-Apps als Docker-Container,
mit Autostart, verschlüsseltem Off-Site-Backup und optionalem HTTPS-Zugang.

> **RKSV-Hinweis:** Mit der mitgelieferten **Software-SEE** ist dies ein
> **Testbetrieb** — funktional vollständig, aber nicht rechtsgültig. Für den
> Legalbetrieb in Österreich sind ein **A-Trust-Abo** (Einstellungen → RKSV →
> Signatureinheit) und die **FinanzOnline-Registrierung** nötig
> (siehe `packages/rksv/FINANZONLINE-ABGLEICH.md`).

---

## 1. Voraussetzungen

- Eine Box mit Linux (Debian 12 / Ubuntu 22.04+ empfohlen), 2+ GB RAM, x86-64.
- Docker + Compose-Plugin:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # danach neu einloggen
docker compose version          # prüfen: v2.x
```

## 2. Repo holen + konfigurieren

```bash
git clone https://github.com/maverick-2bit/kassa.git
cd kassa
cp .env.example .env
```

`.env` öffnen und die drei **Pflicht-Secrets** setzen (jeweils generieren mit
`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`,
oder `openssl rand -hex 24`):

| Variable | Zweck | Regel |
|----------|-------|-------|
| `POSTGRES_PASSWORD` | DB-Benutzer | ≥ 20 Zeichen |
| `MASTER_PASSPHRASE` | Verschlüsselt RKSV-Schlüssel at rest | ≥ 16 Zeichen — **NIE ändern**, solange Kassendaten existieren |
| `JWT_SECRET` | Signiert Login-Tokens | ≥ 32 Zeichen |

`CORS_ORIGIN` auf die URL setzen, unter der das Kassen-Frontend erreichbar ist
(LAN-Modus z. B. `http://192.168.1.50`, Proxy-Modus `https://kasse.<domain>`).

## 3. Starten

```bash
docker compose up -d --build
```

Baut alle Images und startet Postgres, Backend (migriert die DB beim Start
automatisch) und die sieben Web-Apps. `restart: unless-stopped` sorgt für
Autostart nach Stromausfall/Reboot. Status prüfen:

```bash
docker compose ps          # alle „healthy" / „running"
docker compose logs -f backend
```

## 4. Erst-Einrichtung

Das Kassen-Frontend im Browser öffnen (siehe Geräte-Tabelle unten) → der
**Setup-Assistent** legt Mandant, Kasse und Signatureinheit an. Danach Admin-PIN
notieren und sich anmelden. Für den Testbetrieb genügt die Software-SEE; für echt
in **Einstellungen → RKSV → Signaturerstellungseinheit** auf A-Trust umstellen.

## 5. Geräte-URLs

**LAN-Modus (Standard, Port pro App)** — `<box>` = IP der Box:

| App | URL | Zweck |
|-----|-----|-------|
| Kasse | `http://<box>` (Port 80) | Haupt-Kassenoberfläche |
| KDS | `http://<box>:8080?station=kueche&token=<jwt>` | Küchen-Display |
| Kundendisplay | `http://<box>:8081?kasseId=<uuid>` | Kundenanzeige |
| Gast | `http://<box>:8082?kasseId=<uuid>&tisch=<nr>` | Gast-Bestellung (QR) |
| Kellner | `http://<box>:8083` | Kellner-App (mobil) |
| SB-Terminal | `http://<box>:8084?kasseId=<uuid>` | Selbstbedienungs-Kiosk |
| Abholmonitor | `http://<box>:8085?kasseId=<uuid>` | Bestellt / Zur Abholung bereit |

Die `kasseId` und die Geräte-Links stehen fertig in **Einstellungen → SB-Terminal**
(Terminal + Monitor) bzw. den jeweiligen Einstellungsbereichen zum Kopieren.

Tablets/Displays am besten im **Kiosk-/Vollbildmodus** des Browsers betreiben.

**Proxy-Modus (optional, HTTPS unter einer Domain)** — siehe Abschnitt 7.

## 6. Backup + Monitoring (dringend empfohlen)

**Off-Site-Backup (restic → S3-kompatibel):** Backblaze B2 / Wasabi / Hetzner /
MinIO. In `.env` `RESTIC_REPOSITORY`, `RESTIC_PASSWORD` (separat sicher
aufbewahren!) und die S3-Keys setzen → `docker compose up -d`. Der `backup`-
Container schiebt DB- und DEP-Sicherungen verschlüsselt raus (Aufbewahrung
Default 7 Jahre, RKSV). Ohne diese Werte ist Backup deaktiviert.

**Monitoring:** `MONITORING_TOKEN` setzen und einen externen Uptime-Monitor
(Healthchecks.io, Uptime Kuma) auf
`http://<box>/api/monitoring/status?token=<TOKEN>` zeigen lassen
(200 = gesund, 503 = DB weg oder Sicherung veraltet).

## 7. Optional: HTTPS unter einer Domain (Caddy-Proxy)

Für eine aus dem Internet erreichbare Box. In `.env`:

```
KASSA_DOMAIN=example.com
ACME_EMAIL=admin@example.com
```

DNS-Records `kasse.`, `kds.`, `kundendisplay.`, `gast.`, `kellner.`,
`terminal.`, `abholmonitor.` (oder ein Wildcard `*.example.com`) auf die Box
zeigen lassen, dann:

```bash
docker compose --profile proxy up -d
```

Caddy holt automatisch Let's-Encrypt-Zertifikate und routet jede App auf ihre
Subdomain (`https://kasse.example.com`, `https://terminal.example.com`, …).
`CORS_ORIGIN=https://kasse.example.com` setzen.

## 8. Aktualisieren

```bash
git pull
docker compose up -d --build     # ggf. mit --profile proxy
```

Migrationen laufen beim Backend-Start automatisch. Ein kurzer Neustart der
Container, die Daten (Postgres-Volume) bleiben erhalten.

## 9. Troubleshooting

- **Backend „unhealthy":** `docker compose logs backend` — meist DB-URL/Secret
  falsch oder `MASTER_PASSPHRASE` nachträglich geändert.
- **App lädt, aber keine Daten:** prüfen, dass die App den Backend-Proxy erreicht
  (`docker compose logs <app>`), und `CORS_ORIGIN` zur aufgerufenen URL passt.
- **DB-Backup/Restore:** die Sicherungen liegen im Volume `db_backups`; Restore
  per `pg_restore` in einen frischen Postgres-Container (Runbook auf Anfrage).
