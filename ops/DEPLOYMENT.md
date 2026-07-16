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

## Schnellstart: Windows-PC (Test-/Pilotbetrieb)

**Der einfachste Weg — Doppelklick-Installer:**

1. **Download (direkter Link):**
   <https://github.com/maverick-2bit/kassa/releases/latest/download/Kassa-Setup.cmd>
   — und die Datei auf den Ziel-PC kopieren (USB-Stick, Netzlaufwerk, …).
2. **Doppelklick** → UAC-Abfrage bestätigen. Fertig.

Das Setup erledigt alles selbst: holt sich Administrator-Rechte, lädt Installer +
Code von GitHub, **installiert bei Bedarf Docker Desktop automatisch** (inkl.
Lizenz-Bestätigung), **startet Docker Desktop und richtet den Windows-Autostart
ein** (Docker + Kassa kommen nach jedem PC-Neustart von selbst hoch), erzeugt die
`.env` mit sicheren Zufalls-Secrets, baut und startet alle Container, öffnet die
Windows-Firewall und zeigt am Ende die **Geräte-URL-Tabelle** (Kassa, KDS,
Kundendisplay, Kellner-Handy, …) mit der LAN-IP.

**Einziger möglicher Zwischenstopp:** Fehlt auf dem PC die Windows-Funktion WSL2,
aktiviert das Setup sie und bittet um **einen Neustart** — danach einfach
`Kassa-Setup.cmd` erneut doppelklicken, die Installation läuft automatisch weiter.

**Update später:** dieselbe Datei einfach erneut doppelklicken
(`.env`, Datenbank und alle Belege bleiben erhalten).

### Offline-Installation (Ziel-PC ganz ohne Internet)

Für PCs ohne Internetzugang gibt es ein **Offline-Paket** (USB-Stick, ~2–3 GB):

1. **Paket erstellen** — einmalig auf einem PC **mit** Docker + Internet (z. B. dem
   Test-PC): `ops/erstelle-offline-paket.ps1` ausführen. Ergebnis: Ordner
   `kassa-offline-paket` am Desktop mit allem drin (Docker-Desktop-Installer,
   WSL2-Kernel, alle fertig gebauten Container-Images, Code, Setup, LIES-MICH).
2. **Ordner auf den Ziel-PC kopieren** (USB-Stick) und dort
   **`Kassa-Setup-Offline.cmd` doppelklicken** — installiert alles ohne Internet
   (inkl. Docker Desktop, Autostart, Firewall; bei fehlendem WSL2 einmaliger
   Neustart, danach erneut doppelklicken).

**Update offline:** neues Paket erstellen, rüberkopieren, erneut doppelklicken
(Datenbank/Belege/`.env` bleiben erhalten).

<details>
<summary>Alternative: Installation per PowerShell-Befehl (ohne Setup-Datei)</summary>

PowerShell **als Administrator** öffnen (blaues Fenster, nicht CMD) und diese eine
Zeile einfügen:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force; [Net.ServicePointManager]::SecurityProtocol = 3072; iwr 'https://raw.githubusercontent.com/maverick-2bit/kassa/master/ops/install.ps1' -OutFile "$env:TEMP\kassa-install.ps1" -UseBasicParsing; & "$env:TEMP\kassa-install.ps1"
```
</details>

> Der Windows-Weg ist für **Test/Pilot** gedacht; für die endgültige Laden-Box wird
> das Linux-/Raspberry-Setup unten empfohlen (identische Container, robusterer Unterbau).

---

## Schnellstart: macOS

**Ein Skript, das alles erledigt** — Docker prüfen/installieren, Code laden, `.env`
mit Zufalls-Secrets erzeugen, alle Container bauen + starten, Geräte-URLs anzeigen.

**Variante A — Doppelklick-Installer:**

1. Datei `ops/Kassa-Setup.command` auf den Mac kopieren.
2. **Rechtsklick → „Öffnen" → „Öffnen"** (nur beim ersten Mal; danach reicht Doppelklick).
   macOS blockiert frisch geladene Skripte sonst als „nicht verifiziert".

**Variante B — ein Terminal-Befehl** (Programme → Dienstprogramme → Terminal):

```bash
curl -fsSL https://raw.githubusercontent.com/maverick-2bit/kassa/master/ops/install.sh | bash
```

Fehlt Docker, installiert das Skript **Docker Desktop per Homebrew** (`brew install --cask
docker`). Ist kein Homebrew da, führt es dich zum Docker-Desktop-Download und du startest
danach erneut. Die Container werden **nativ** gebaut (Apple Silicon = arm64, Intel = amd64).

- **Update:** denselben Befehl / dieselbe Datei erneut ausführen (`.env`, DB, Belege bleiben).
- **Autostart:** in Docker Desktop → Settings → **„Start Docker Desktop when you sign in"**
  aktivieren; die Container kommen dank `restart: unless-stopped` dann von selbst mit hoch.

---

## Schnellstart: Raspberry Pi (und andere Linux-Boxen)

Empfohlen: **Raspberry Pi 4 oder 5 mit 64-bit Raspberry Pi OS** (Bookworm) und **≥ 4 GB RAM**.
Ein Terminal öffnen und **einen** Befehl ausführen:

```bash
curl -fsSL https://raw.githubusercontent.com/maverick-2bit/kassa/master/ops/install.sh | bash
```

Das Skript installiert Docker (offizielles `get.docker.com`), lädt den Code und baut die
Container **nativ für arm64** — es sind keine vorgefertigten Images nötig.

- **Erster Build dauert 15–40 Min.** (die 8 Frontends werden auf dem Pi kompiliert). Danach
  laufen Updates schneller.
- **Nur 4 GB RAM?** Swap vergrößern, sonst kann der Build am Speicher scheitern:
  `sudo dphys-swapfile swapoff && sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile && sudo dphys-swapfile setup && sudo dphys-swapfile swapon`
- **docker ohne sudo:** das Skript trägt dich in die `docker`-Gruppe ein — dafür einmal
  ab- und wieder anmelden (oder Pi neu starten).
- **Autostart:** automatisch — der Docker-Dienst wird aktiviert, die Container starten nach
  jedem Neustart von selbst (`restart: unless-stopped`).
- **Update:** denselben Befehl erneut ausführen (`.env`, Datenbank, Belege bleiben erhalten).

> Zielverzeichnis ist standardmäßig `~/kassa`. Anpassbar per `KASSA_DIR=/opt/kassa curl … | bash`.
> Ein Testlauf ohne Docker (nur Code + `.env`): `KASSA_OHNE_DOCKER=1 bash ops/install.sh`.

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

**Am einfachsten — direkt in der Kassa (Ein-Klick):**
**Einstellungen → System → Aktualisierung**. Zeigt installierte vs. neueste Version;
ein Klick auf **„Jetzt aktualisieren"** (nur Admin) holt den neuen Stand und baut die
Container neu. Die Kassa ist dabei ~1 Minute offline (nicht während des Kassierens
starten). Nach Abschluss erscheint **„Jetzt neu laden"**.

> Dahinter steckt ein eigener `updater`-Container (in `docker-compose.yml` enthalten),
> der als Einziger den Docker-Socket sieht und **ausschließlich** den festen Rebuild
> ausführt — das Backend gibt nur das Startsignal (Datei im `update_control`-Volume),
> kann also keine beliebigen Befehle auslösen.
>
> **Erststart des Update-Dienstes:** Auf bereits laufenden Installationen ohne
> `updater`-Container zeigt das Panel „Update-Dienst nicht aktiv". Dann **einmal**
> `Kassa-Setup` (Doppelklick) bzw. den `install.sh`-Einzeiler ausführen — das fügt den
> Dienst hinzu; ab dann läuft jedes weitere Update per Klick.

**Manuell (Terminal), immer möglich:**

```bash
cd ~/kassa   # bzw. das Install-Verzeichnis
git pull 2>/dev/null || true     # oder Kassa-Setup / install.sh erneut ausführen
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
- **Bondrucker: „Testdruck gesendet"/LED online, aber es kommt NICHTS raus** —
  häufigste Ursache bei Epson TM (z. B. TM-T20IV) mit modernem Web-Interface:
  in der Drucker-Weboberfläche (http://\<drucker-ip\>) unter
  **Advanced Settings → Secure Printing** steht **Enable**. Das erzwingt
  verschlüsseltes Drucken (ePOS-Print) und **verwirft den normalen Roh-Druck auf
  Port 9100**, den die Kassa nutzt. **Fix: Secure Printing → Disable** (lässt den
  gesicherten UND den Roh-Druck zu; für einen Bondrucker im Laden-LAN Standard).
  Gegenprobe, ob der Drucker grundsätzlich druckt: Selbsttest (Drucker aus →
  Papiervorschub-Taste halten → einschalten). Und: nach dem Text immer genug
  Vorschub vor dem Schnitt (Kopf-zu-Messer-Abstand ~12–15 mm; erledigt die Kassa
  automatisch).
