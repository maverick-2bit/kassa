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

**Fernwartung (optional):** Liegt neben `Kassa-Setup.cmd` eine `fernwartung.json`, richtet das Setup
zusätzlich **TeamViewer Host** ein und ordnet die Box Ihrem TeamViewer-Konto zu — so warten Sie
Mietkassen aus der Ferne. Anleitung, Konfigurationsdatei und Sicherheitshinweise:
**Abschnitt 10** („Fernwartung (TeamViewer Host)").

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

Die Gast-Bestellung per Tisch-QR ist je Kasse schaltbar: **Einstellungen → Hardware →
„Gast-Bestellung per Tisch-QR"** — *Aus* (neue Kassen), *Ohne Zahlung* (Bestellung landet
als offener Tisch mit Kellner „Gast") oder *Mit Online-Zahlung* (Abschnitt 7b). Solange
„Aus" gewählt ist, nimmt die Kasse über den QR-Code nichts an.

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

### Client-IP und Rate-Limit

Das Backend bremst jeden Client auf 300 Anfragen/Minute (Login 10/Minute).
Angemeldete Geräte — Kasse, Kellner-Handy, KDS, Einlass-Scanner — zählen je
Anmeldung, alle anderen (Gast-App, SB-Terminal, Ticketseite, Login) je
Client-IP. Die Client-IP bestimmt der nginx jeder App je **Eingang**; mitgeschickte
`X-Forwarded-For`-/`X-Real-IP`-Header zählen nie:

| Weg | Ziel-Port der App | Client-IP stammt aus |
|---|---|---|
| direkt im LAN (`http://<box>:8083` …) | 80 | Absender der Verbindung |
| Caddy (Profil `proxy`) | 8090 — steht so im `ops/caddy/Caddyfile` | `X-Forwarded-For` (von Caddy gesetzt) |
| Cloudflare-Tunnel (Profil `tunnel`) | **8091** — in Cloudflare als `http://tickets:8091` usw. eintragen | `CF-Connecting-IP` |

- **Docker Desktop (Windows/macOS)** reicht die IP von LAN-Geräten nicht in die
  Container durch — alle erscheinen als Gateway-Adresse (z. B. `172.18.0.1`,
  am Test-PC nachgemessen), direkt wie über Caddy. Angemeldete Geräte trennt das
  Backend trotzdem sauber (je Anmeldung); anonyme LAN-Clients teilen sich je App
  einen Zähler. Echte Besucher-IPs gibt es dort nur über den Cloudflare-Tunnel,
  auf Linux-Hosts (Docker Engine) auch im LAN.
- Wer ins Limit läuft, steht im Backend-Log: `Rate-Limit überschritten` mit
  Schlüssel und Pfad (höchstens einmal je Minute und Schlüssel).
- Nach einem Update, das die `Caddyfile` ändert, Caddy einmal neu starten
  (`docker compose --profile proxy up -d --force-recreate caddy`) — Caddy liest
  die Datei nur beim Start.
- Prüfen lässt sich die ganze Kette auf jedem Rechner mit Docker:
  `sh ops/nginx/client-ip-test/test.sh` (läuft auch in CI).

## 7b. Optional: Gast-Onlinebestellung mit Stripe

Gast scannt den Tisch-QR → bestellt am Handy → zahlt online (Stripe Checkout) →
RKSV-Beleg + Bonierung an KDS/Warengruppen-Drucker, ohne Zahlkellner. **Voraussetzung:
die Box ist öffentlich erreichbar (Abschnitt 7), denn Stripe ruft den Webhook direkt an.**

Es gibt **zwei Wege**, das Stripe-Konto zu hinterlegen. Pro-Mandant-Keys haben Vorrang;
sind für einen Mandanten keine gesetzt, greifen die globalen Env-Keys als Fallback.

**Variante A — pro Betrieb/Mandant (empfohlen, Geld fließt direkt an den Betrieb):**
1. Jeder Betrieb legt ein **eigenes Stripe-Konto** an und kopiert den **Secret-Key**
   (Test `sk_test_…` / Live `sk_live_…`).
2. In der Kassa: **Einstellungen → Gast → „Online-Zahlung (Stripe)"**. Dort wird die
   **mandant-spezifische Webhook-URL** angezeigt
   (`https://kasse.example.com/api/stripe/webhook/<mandantId>`). Diese im Stripe-Dashboard
   als Webhook-Endpoint für **`checkout.session.completed`** eintragen und das erzeugte
   **Signing-Secret** (`whsec_…`) kopieren.
3. Secret-Key + Webhook-Secret in dieselbe Maske eintragen und speichern. Die Keys werden
   **verschlüsselt** gespeichert (AES-256-GCM, Master-Passwort) und nie im Klartext
   zurückgegeben.

**Variante B — ein globales Konto für alle (Env-Fallback):**
1. Ein Stripe-Konto; Secret-Key + einen Webhook auf `…/api/stripe/webhook` (ohne mandantId)
   mit Event `checkout.session.completed` anlegen.
2. In `.env`:
   ```
   STRIPE_SECRET_KEY=sk_live_…
   STRIPE_WEBHOOK_SECRET=whsec_…
   ```

Fehlen für einen Mandanten sowohl eigene als auch globale Keys, ist die Online-Zahlung aus
(in Dev/Test läuft dann der Demo-Pfad, der ohne echte Zahlung sofort finalisiert —
**nie in Produktion ohne Keys**).

**Zusätzlich, unabhängig von Variante A/B:**
- Pro Kasse freischalten: **Einstellungen → Hardware → „Gast-Bestellung per Tisch-QR"
  = „Mit Online-Zahlung (Stripe)"**, und die **Gast-Bestell-Basis-URL** auf die öffentliche Gast-App
  setzen (z. B. `https://gast.example.com`) — daraus wird der Tisch-QR gebaut und der
  Rücksprung nach der Zahlung.
- Tisch-QRs drucken: **Tische → „Tischnummern drucken"** mit QR (Abschnitt Phase 1).

**Lokaler Test ohne öffentliche Box:** Stripe-CLI —
`stripe listen --forward-to localhost:3000/api/stripe/webhook` (globaler Fallback) bzw.
`… --forward-to localhost:3000/api/stripe/webhook/<mandantId>` (pro-Mandant) — leitet
Test-Events an die lokale Kassa weiter.

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

## 10. Fernwartung (TeamViewer Host)

Mietkassen aus der Ferne warten und bei Problemen eingreifen: Der Installer richtet auf der Box
**TeamViewer Host** ein (dauerhaft verbunden, unbeaufsichtigter Zugriff) und ordnet sie **Ihrem
TeamViewer-Konto** zu. In der Geräteliste erscheint jede Kasse mit Namen (Kunde/Kasse) in der
Gruppe z. B. „Mietkassen" — ein Klick, und Sie sind drauf. In der Kassa selbst steht unter
**Einstellungen → System → Fernwartung** die TeamViewer-ID (zum Vorlesen am Telefon).

Der Schritt ist **optional**: Ohne `fernwartung.json` passiert nichts — alles andere am Installer bleibt
wie beschrieben. Ein Fehler in diesem Schritt bricht die Kassa-Installation **nie** ab (Warnung +
Hinweis, wie man es nachholt). Er ist als erste von mehreren Wartungs-Schichten gedacht
(später z. B. Leitstand mit Heartbeat aller Kassen, VPN).

### 10.1 Welche Variante passt zu Ihrer Lizenz?

| | **A — Rollout-Konfiguration** (empfohlen) | **B — API-Token** (älterer Weg) |
|---|---|---|
| TeamViewer-Befehl | `TeamViewer.exe assignment --id <Assignment-ID>` | `TeamViewer.exe assign --api-token <Token> …` |
| Geheimnis | die **Assignment-ID** der Rollout-Konfiguration | der **API-/Skript-Token** |
| Gerätegruppe, Manager, Richtlinie | kommen aus der Rollout-Konfiguration | `gruppe` / `gruppeId` in der Datei |
| Ohne Internet | wird vorgemerkt (`--offline`) und später ausgeführt | nicht möglich |
| Linux | ja | nein |
| In der TeamViewer-Doku | aktuell („TeamViewer deployment — User guide") | als „Legacy" geführt |

TeamViewer führt die Massenverteilung per MSI laut Doku für **Corporate- und Tensor-Lizenzen**
(Version 15 oder neuer); das Host-Modul („Custom Host") nennt die ältere Doku schon ab Business (die neuere ebenfalls Corporate/Tensor). Sehen Sie in der
Verwaltungskonsole unter *Admin settings → Device Management* den Punkt **Rollout set-up**, nehmen Sie
Variante A. Fehlt er, geht nur Variante B bzw. die Frage an den TeamViewer-Support, ob die Lizenz die
Rollout-Konfiguration umfasst.

> **Hinweis:** In der Community berichten Nutzer seit 2024, dass der alte Einschritt-Aufruf
> `msiexec … APITOKEN=… ASSIGNMENTOPTIONS=…` nicht mehr wie früher funktioniert; TeamViewer zeigt dort
> den Weg über Rollout-Konfiguration + `TeamViewer.exe assignment --id`. Der Installer nutzt deshalb
> auch bei Variante B die Zweischritt-Fassung (erst MSI, dann `assign`) — das gibt ein prüfbares
> Ergebnis und hält das Token aus der MSI-Kommandozeile heraus.

### 10.2 Einmalig in der TeamViewer-Verwaltungskonsole (Variante A)

Anmelden unter <https://login.teamviewer.com> (bzw. im neuen Web-Client). Die Menünamen unten stehen
so in der englischen Oberfläche; die deutsche heißt sinngemäß gleich.

1. **Konto absichern — zuerst.** Profil (oben rechts) → *Edit profile* → *Security* → *Activate
   two-factor authentication* (neuer Web-Client: *Settings* → Profil → *Authentication* → *Two-factor
   authentication for sign-in*); QR-Code mit einer Authenticator-App scannen, den **Recovery-Code** ausdrucken
   und getrennt aufbewahren (TeamViewer kann die Zwei-Faktor-Anmeldung **nicht** zurücksetzen — ohne Code
   sind Konto und alle Kassen weg). Danach ein langes, einmaliges Passwort. Wer dieses Konto hat, hat
   Zugriff auf **alle** Mietkassen.
2. **Gerätegruppe anlegen:** *Device list* → bei *Groups* auf **+** → Name `Mietkassen` → Rechte der
   Manager: **Easy access (unattended)** einschalten → *Create*. (Pro Kunde eine eigene Gruppe ist auch
   möglich — dann je Kunde eine eigene Rollout-Konfiguration, Schritt 4.)
3. **Richtlinie (Policy) für die Kassen anlegen:** *Admin settings* → *Policies* → *Create new policy*.
   Empfohlene Einstellungen, jeweils mit **erzwingen** („Enforce" — dann kann sie der Kunde am PC nicht
   abschalten):
   - *Random password (for spontaneous access)*: **Disabled** (kein Zufallspasswort)
   - kein persönliches/statisches Passwort setzen — der Zugriff läuft nur über Ihr Konto
     (Easy access, Public-Key-Verfahren statt Passwort)
   - bei Corporate/Tensor: Verbindungen zum Gerät protokollieren („report connections to this device")
4. **Rollout-Konfiguration anlegen:** *Admin settings* → *Device Management* → **Rollout set-up** →
   **+ Create Configuration** → Name (z. B. `Mietkassen`) → Gerätegruppe `Mietkassen` → Manager (Ihr Konto)
   → Richtlinie aus Schritt 3 → *Save*. Dann in der Liste die Konfiguration wählen → Menü **⋮** →
   **Copy ID**. Das ist die **Assignment-ID** — in `fernwartung.json` als `assignmentId`.
   **Die ID ist ein Geheimnis** (wer sie hat, kann Geräte in Ihr Konto hängen): nicht in den Chat, nicht
   ins Repo, nicht in E-Mails.
5. **Host-Modul anlegen:** *Admin settings* → *Device Management* → **Custom modules** → *Create custom
   module* → **Host** → Name, Aussehen nach Wunsch. **Rollout-Konfiguration: „None"** lassen — wählen Sie
   dort eine aus, erscheint laut Doku am Gerät nach der Installation ein Pop-up „Zuordnung bestätigen".
   *Save* → die **Configuration-ID** des Moduls steht in der Modulübersicht bzw. im erzeugten
   Download-Link (die Doku zeigt die Stelle in der neuen Oberfläche nicht eindeutig; in der älteren
   Konsole *Design & Deploy* wird sie nach dem Speichern als **CUSTOMCONFIGID** angezeigt). Eintragen als
   `customConfigId` — **optional**; ohne sie läuft der Standard-Host.
6. **Installer holen:** *Admin settings* → *Rollout set-up* → **Download Installer** → Windows → das ZIP
   enthält `TeamViewer_Host.msi` (und `TeamViewer_Full.msi`). Die MSI liegt nur hinter der Anmeldung,
   es gibt keine öffentliche Adresse dafür. Legen Sie `TeamViewer_Host.msi` **neben** `fernwartung.json`.
   *Alternative ohne MSI* (z. B. Lizenz ohne MSI-Verteilung): die öffentliche EXE
   `https://download.teamviewer.com/download/TeamViewer_Host_Setup_x64.exe` als `hostInstallerUrl` — dann
   fehlt das Host-Modul (kein `customConfigId`), die Zuordnung läuft trotzdem.
7. **Protokollierung einschalten:** *Admin settings* → **Connection reports** zeigt, wer sich wann auf
   welches Gerät verbunden hat (Premium/Corporate/Tensor; für eingehende Verbindungen an Geräten muss die
   Richtlinien-Einstellung aus Schritt 3 aktiv sein; Export als CSV, Zeiten in UTC). Mit Tensor zusätzlich
   *Admin settings* → *General* → **Event logging** einschalten (Aufbewahrung ein Jahr, nicht änderbar).

### 10.3 `fernwartung.json` ausfüllen

Vorlage: **`ops/fernwartung.example.json`** — kopieren, ausfüllen, **neben den Installer** legen
(neben `Kassa-Setup.cmd` bzw. `install.ps1`, im Offline-Paket in den Paketordner) oder mit
`-FernwartungKonfig <Pfad>` angeben. **Niemals einchecken** (`.gitignore` schützt `ops/fernwartung.json`
und `ops/fernwartung*.local.json`) und **nie auf die Box legen**: Der Installer kopiert die Datei nicht ins
Installationsverzeichnis — die Box braucht nach der Zuordnung weder Token noch Assignment-ID.

```json
{
  "anbieter": "teamviewer",
  "msiPfad": "TeamViewer_Host.msi",
  "customConfigId": "ihre-customconfigid",
  "assignmentId": "ihre-assignment-id-aus-der-rollout-konfiguration",
  "gruppe": "Mietkassen",
  "aliasVorlage": "Kassa {Name}"
}
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `anbieter` | nein | `"teamviewer"` (Standard; später weitere) |
| `msiPfad` | nein | Installer-Datei (MSI oder EXE; Linux: `.deb`/`.rpm`), relativ zu **dieser Datei** oder absolut |
| `hostInstallerUrl` | nein | Alternative zu `msiPfad`: `https://`-Adresse (ein `?…`-Teil gilt als Geheimnis und wird nie angezeigt). Fehlen beide, sucht der Installer `TeamViewer_Host*.msi/.exe` neben der Datei; unter Linux lädt er das offizielle Host-Paket |
| `signaturPruefen` | nein | Standard `true`: der Installer läuft nur, wenn er gültig **von TeamViewer signiert** ist (Windows). `false` nur für bewusst umgepackte Installer |
| `exeArgumente` | nein | nur EXE; Standard `["/S"]` |
| `customConfigId` | nein | `CUSTOMCONFIGID` des Host-Moduls (nur MSI) |
| `einstellungsDatei` | nein | `SETTINGSFILE` (exportierte `.tvopt`); besser per Richtlinie (Schritt 3) |
| **`assignmentId`** | Variante A | ID der Rollout-Konfiguration — **Geheimnis** |
| **`apiToken`** | Variante B | API-/Skript-Token — **Geheimnis** (nur Windows) |
| `zuordnungsweg` | nein | `"cli"` (Standard, empfohlen) oder `"msi"` = Einschritt über MSI-Eigenschaften; dann lässt sich der Erfolg der Zuordnung **nicht prüfen** (und bei `assignmentId` entfällt der Gerätename) |
| `gruppe` / `gruppeId` | nein | Variante B: Zielgruppe (`--group` bzw. `--group-id g12345678`); Variante A: nur Anzeige in der Kassa (die Gruppe bestimmt die Rollout-Konfiguration) |
| `aliasVorlage` | nein | Gerätename in der Liste; `{Name}` = `-FernwartungName` (sonst Computername), `{Computername}` = Windows-PC-Name. Standard `"{Name}"` |
| `assignmentRetries` / `assignmentTimeout` | nein | Wiederholungen (Standard 20) und Gesamtzeit in Sekunden (Standard 120) der Zuordnung |

Felder mit `_` am Anfang sind Kommentare. Tippfehler in Feldnamen und nicht ersetzte Platzhalter
(`ERSETZEN`) meldet der Installer; Fehlermeldungen nennen nie den Wert eines Feldes.

### 10.4 Installer aufrufen

**Windows:** `fernwartung.json` neben `Kassa-Setup.cmd` legen und doppelklicken — fertig. Der Installer
fragt einmalig nach dem **Gerätenamen** (Enter = Computername); bei späteren Läufen bleibt der Name.
Mit Parametern (`install.ps1` direkt):

```powershell
# erst ansehen, was passieren würde (ändert nichts; Token/ID maskiert):
powershell -ExecutionPolicy Bypass -File ops\install.ps1 -Trockenlauf -FernwartungKonfig D:\fernwartung.json -FernwartungName "Gasthof Mayr"

# echter Lauf (als Administrator):
powershell -ExecutionPolicy Bypass -File ops\install.ps1 -FernwartungKonfig D:\fernwartung.json -FernwartungName "Gasthof Mayr"
```

| Parameter | Wirkung |
|---|---|
| `-FernwartungKonfig <Pfad>` | Pfad zur `fernwartung.json` (sonst: neben dem Installer / neben `Kassa-Setup.cmd` / aktueller Ordner) |
| `-FernwartungName <Name>` | Gerätename (`{Name}` der Vorlage); Standard: Rückfrage bzw. Computername |
| `-Fernwartung` | Schritt erzwingen (auch mit `-OhneDocker`) und fehlende Konfiguration melden |
| `-OhneFernwartung` | Schritt überspringen |
| `-FernwartungNeuZuordnen` | bereits zugeordnetes Gerät **erneut** zuordnen (`--reassign`: ersetzt Zuordnung, Manager und Richtlinien) |
| `-Trockenlauf` | nur die geplanten Schritte anzeigen, **nichts** verändern |

(Beim PowerShell-Einzeiler aus dem Schnellstart die Parameter einfach hinter `& "$env:TEMP\kassa-install.ps1"`
anhängen.)

Was der Schritt tut (Windows): prüft, ob TeamViewer schon installiert ist (sonst **still installieren**,
Signatur geprüft) → Dienst „TeamViewer" läuft und startet mit Windows → **Zuordnung** zum Konto → liest die
**TeamViewer-ID** (Registry-Wert `ClientID`: `HKLM\SOFTWARE\TeamViewer` beim 64-Bit-Client, `…\WOW6432Node\…`
beim 32-Bit-Client) → schreibt `C:\ProgramData\KassaPOS\fernwartung-status.json` (**ohne Geheimnis**) → nach dem
Start der Container legt der Installer sie in das Kontroll-Volume der Kassa (`/control` — dasselbe, über das
Updater und Backend schon sprechen; das Backend hängt es zusätzlich **schreibgeschützt** als `/control-ro`
ein und liest nur dort). Der Status „folgt der Box": Ist ein PC schon eingerichtet, übergibt auch ein späteres
Update **ohne** `fernwartung.json` die gespeicherte Statusdatei erneut (z. B. nach neu aufgesetzten Containern).
Der Schritt läuft **vor** dem
Container-Build: hakt Docker, ist die Box trotzdem schon erreichbar.

### 10.5 Kontrolle

1. In der **TeamViewer-Geräteliste** erscheint die Kasse unter dem Gerätenamen in der Gruppe `Mietkassen`
   (das kann einen Moment dauern).
2. Verbinden Sie sich **von Ihrem Rechner aus**: Easy access — ohne Passwortabfrage. Fragt es nach einem
   Passwort, fehlt das Recht *Easy access (unattended)* (Schritt 2) oder die Zuordnung ist nicht angekommen.
3. In der Kassa: **Einstellungen → System → Fernwartung** zeigt *Eingerichtet* mit der ID (nur Administratoren
   sehen die Karte). *Nicht eingerichtet* heißt: Statusdatei fehlt — Installer erneut ausführen.

### 10.6 Bestandskassen nachrüsten

Den Installer (`Kassa-Setup.cmd` mit `fernwartung.json` daneben) **einfach erneut ausführen** — er
aktualisiert die Kassa wie gewohnt (Daten und `.env` bleiben) und rüstet die Fernwartung nach. Idempotent:
Ist TeamViewer schon da, wird nicht neu installiert; ist das Gerät laut Statusdatei schon zugeordnet, wird
nicht erneut zugeordnet. Anderen Namen oder andere Gruppe setzen: mit `-FernwartungNeuZuordnen`.

### 10.7 Variante B — API-Token

Nur nötig, wenn die Rollout-Konfiguration fehlt. Das Token entweder

- **modulgebunden** (Legacy-Konsole *Design & Deploy*): Host-Modul anlegen, Option **Allow account
  assignment** einschalten — nach dem *Save* zeigt TeamViewer **CUSTOMCONFIGID** und **APITOKEN**; oder
- als **Skript-Token**: Profil → *Edit profile* → *Apps* (neuer Web-Client: *Apps & Tokens*) → **Create script token**, **nur** diese Rechte
  anhaken (laut Community-Antwort die Mindestrechte für die Zuordnung): *Group management → View, create,
  delete, edit and share groups* und *Computers & Contacts → View, add, edit and delete entries*. Ein Token
  lässt sich nach dem Erstellen nicht mehr ändern, nur löschen — zum Austauschen ein neues anlegen, das alte
  löschen.

Die Gruppen-ID für `gruppeId` steht in der Konsole in der Adresszeile, wenn Sie die Gruppe anklicken
(`…/g/12345678` → `g12345678`). In `fernwartung.json` dann statt `assignmentId`:

```json
{ "msiPfad": "TeamViewer_Host.msi", "customConfigId": "ihre-customconfigid",
  "apiToken": "ihr-api-token", "gruppeId": "g12345678", "aliasVorlage": "Kassa {Name}" }
```

Der Installer ruft dann `TeamViewer.exe assign --api-token … --alias … --group-id … --grant-easy-access`
auf. **Das Token nie in einen Chat, ein Ticket oder das Repo schreiben** — es steht nur in dieser Datei.

### 10.8 Offline-Paket

`ops/erstelle-offline-paket.ps1 -FernwartungKonfig D:\fernwartung.json` legt den in der Konfiguration
genannten TeamViewer-Installer (Datei oder Download, Signatur geprüft) sowie `fernwartung.ps1` und die
Vorlage ins Paket — die **`fernwartung.json` selbst wird nicht kopiert** (sie enthält das Token). Soll die
Zuordnung schon beim Installieren am Ziel-PC laufen, legen Sie die Datei von Hand in den Paketordner und
verwahren den Stick sicher. Ohne Internet am Ziel merkt TeamViewer die Zuordnung vor (`--offline`) und führt
sie aus, sobald die Kasse online ist; dann `Kassa-Setup-Offline.cmd` noch einmal doppelklicken, damit die
Kassa die Fernwartung anzeigt.

### 10.9 Linux / Raspberry Pi (best effort)

```bash
# Trockenlauf, dann echter Lauf — fernwartung.json im aktuellen Ordner:
KASSA_TROCKENLAUF=1 KASSA_FERNWARTUNG_NAME="Gasthof Mayr" bash ops/install.sh
KASSA_FERNWARTUNG_NAME="Gasthof Mayr" bash ops/install.sh
```

Umgebungsvariablen: `KASSA_FERNWARTUNG_KONFIG` (Pfad), `KASSA_FERNWARTUNG_NAME`, `KASSA_FERNWARTUNG=1`
(erzwingen), `KASSA_OHNE_FERNWARTUNG=1`, `KASSA_FERNWARTUNG_NEU=1` (`--reassign`), `KASSA_TROCKENLAUF=1`.
Es gilt nur **Variante A** (`assignmentId`): installiert das Host-Paket (`.deb` per `apt`, `.rpm` per
`dnf`/`zypper`; ohne Angabe das offizielle von `download.teamviewer.com`), aktiviert `teamviewerd`, ordnet
mit `sudo teamviewer assignment --id …` zu, liest die ID mit `teamviewer info`. Für die Konfiguration wird
`python3` oder `jq` gebraucht. Das TeamViewer-Paket kann für Updates ein eigenes apt-Repository einrichten.
Laut TeamViewer-Doku braucht die Fernsteuerung einer Linux-Konsole einen Framebuffer (`/dev/fb0`); läuft
ein X-Server, landet die Verbindung auf der aktiven Sitzung. macOS: nicht unterstützt.

### 10.10 Sicherheit und Verträge — bitte lesen

- **Auf der Box liegen die privaten Signaturschlüssel** (RKSV-Schlüssel, verschlüsselt mit der
  `MASTER_PASSPHRASE` aus der `.env` — beides liegt auf demselben PC), dazu Belege und Kassendaten.
  Fernzugriff als Administrator des PCs ist damit Zugriff auf alles. Behandeln Sie das TeamViewer-Konto wie
  den Tresorschlüssel: Zwei-Faktor-Anmeldung, einmaliges langes Passwort, so wenige Manager wie möglich,
  keine geteilten Zugänge, ausgeschiedene Mitarbeiter sofort entfernen.
- **Nur Ihr Konto soll hinein:** Zufallspasswort aus, kein statisches Passwort (Schritt 3); zusätzlich eine
  **Allowlist** der erlaubten Konten (TeamViewer: *Block and Allowlist* — alles, was nicht auf der Liste
  steht, wird abgewiesen).
- **Verbindungsprotokoll** auswerten (Schritt 7) und stichprobenweise prüfen, ob jede Verbindung einen
  Anlass hatte.
- **Geheimnisse:** `fernwartung.json` gehört nicht ins Repo, nicht auf die Box, nicht in Chats/E-Mails/Tickets;
  Ablage nur auf Ihren eigenen Datenträgern (verschlüsselt). Vermutet jemand, die Assignment-ID oder das Token
  sei offen: Rollout-Konfiguration bzw. Token **löschen und neu anlegen**. Das Token steht beim Lauf kurz
  auf der Kommandozeile von `TeamViewer.exe assign` (für lokale Administratoren sichtbar) — der Installer
  gibt es nirgends aus, schreibt es in keine Logdatei, keine Statusdatei, keine `.env`, nicht in Compose.
- **Vertrag mit dem Kunden:** Dauerhafter, unbeaufsichtigter Zugriff auf ein System mit Geschäftsdaten
  braucht eine Grundlage — **Wartungs-/Mietvertrag** mit Fernwartungsklausel (Umfang, Zeiten,
  Benachrichtigung) und, soweit Sie dabei personenbezogene Daten (Kunden, Mitarbeiter, Belege) einsehen
  können, eine **Auftragsverarbeitungs-Vereinbarung** (Art. 28 DSGVO). Auch TeamViewer ist dabei ein
  Dienstleister (Verbindungsdaten laufen über dessen Server). Lassen Sie die Texte juristisch prüfen — das
  hier ist keine Rechtsberatung.
- Zur Transparenz zeigt die Kassa dem Administrator unter *Einstellungen → System → Fernwartung*, dass und
  unter welcher ID die Fernwartung eingerichtet ist.

### 10.11 Wenn etwas hakt

| Meldung des Installers | Bedeutung / Abhilfe |
|---|---|
| „Konfiguration fehlerhaft" / „Platzhalter … nicht ersetzt" | `fernwartung.json` prüfen (Komma, Anführungszeichen; Beispieltexte `ERSETZEN` ersetzen) |
| „Installer wird NICHT ausgeführt … Signatur" | die Datei ist nicht von TeamViewer signiert/verändert — neu herunterladen |
| „Installation fehlgeschlagen (Exit-Code 1603)" | Protokoll: `%TEMP%\kassa-teamviewer-msi.log`; oft läuft schon eine Installation / Neustart ausstehend |
| Zuordnung: *ungültiges Argument* (40/400) | Assignment-ID falsch kopiert oder Rollout-Konfiguration gelöscht |
| Zuordnung: *keine Verbindung* (43/403), *Zeitüberschreitung* (45/405) | Internet/Firewall der Box: TeamViewer braucht ausgehend TCP/UDP **5938** (sonst TCP 443, zuletzt TCP 80) zu `*.teamviewer.com`, eingehend nichts; der Installer merkt die Zuordnung dann vor |
| Zuordnung: *durch Richtlinie verhindert* (48/408) | eine aktive Richtlinie verbietet das Entfernen der bisherigen Zuordnung — `-FernwartungNeuZuordnen` bzw. Richtlinie prüfen |
| Zuordnung: *bereits zugeordnet* (49/409) | gilt als Erfolg |
| Gerät schon einem **anderen** Konto zugeordnet | `-FernwartungNeuZuordnen` (Achtung: ersetzt bisherige Zuordnung, Manager, Richtlinien) |
| „TeamViewer-ID konnte nicht ausgelesen werden" | die Box ist nicht online; ID erscheint erst nach der ersten Verbindung — Installer später erneut ausführen |
| Am Gerät erscheint ein Pop-up „Zuordnung bestätigen" | Host-Modul wurde mit einer Rollout-Konfiguration gespeichert (Schritt 5: „None") — das Bestätigen oder Ablehnen ändert an der Verwaltung laut Doku nichts |
| Karte zeigt „Nicht eingerichtet", obwohl TeamViewer läuft | Statusdatei fehlt: Installer erneut ausführen (er ordnet nicht doppelt zu, schreibt aber die Datei neu) |

### 10.12 Grenzen (ehrlich)

- Die **Einschritt-Variante** (`zuordnungsweg: "msi"`) lässt sich nicht auf Erfolg prüfen.
- Die Stelle der **CUSTOMCONFIGID** in der neuen Konsole ist in der TeamViewer-Doku nicht eindeutig
  beschrieben — das Feld ist deshalb optional.
- Das stille Installieren der **EXE** (`/S`) steht nicht in der offiziellen TeamViewer-Wissensdatenbank,
  nur in Community-Beiträgen; der MSI-Weg ist der dokumentierte.
- Der Gerätename-Parameter heißt in der Doku unter Windows `--device-alias=`, unter Linux `--device_alias`;
  der Linux-Schritt probiert bei „ungültigen Argumenten" die zweite Schreibweise.
- Die Kassa-Karte zeigt nur, was der Installer geschrieben hat; sie prüft nicht live, ob TeamViewer gerade
  verbunden ist (das zeigt Ihre Geräteliste).

### 10.13 Quellen (TeamViewer-Dokumentation)

- Massenverteilung, Schritt „Deploy TeamViewer (Host or full client)": <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/deployment/mass-deployment-user-guide/deploy-teamviewer-host-or-full-client-9-10/> — `msiexec … /qn CUSTOMCONFIGID=… ASSIGNMENTID=…`, `SETTINGSFILE`, `--retries`, `--timeout`, Fehlercodes
- Zuordnung per Kommandozeile (Windows/macOS/Linux): <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/deployment/mass-deployment-user-guide/assign-a-device-via-command-line-8-10/> — `assignment --id`, `--offline`, `--device-alias`, `--reassign`
- Rollout-Konfiguration anlegen / ID kopieren: <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/deployment/mass-deployment-user-guide/create-a-rollout-configuration-6-10/>
- Host-Modul (Custom module): <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/deployment/mass-deployment-user-guide/create-your-module-3-10/> und <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-classic/modules/custom-host/>
- Richtlinie: <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/deployment/mass-deployment-user-guide/create-your-policy-4-10/> · Gerätegruppe: <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/deployment/mass-deployment-user-guide/create-a-device-group-5-10/> · Easy access: <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/deployment/mass-deployment-user-guide/grant-easy-access-to-your-devices-and-device-groups-10-10/>
- MSI-Installer herunterladen: <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/deployment/mass-deployment-user-guide/download-the-msi-installer-7-10/> · Download-Portal (EXE, Linux-Pakete): <https://www.teamviewer.com/en/download/portal/windows/> und <https://www.teamviewer.com/en/download/portal/linux/>
- Älterer Weg (Legacy): <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-classic/deployment/mass-deployment-on-windows-user-guide-legacy/recommended-scripts-3-6-legacy> (`APITOKEN`, `ASSIGNMENTOPTIONS`, `assign --api-token`), <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-classic/deployment/mass-deployment-on-windows-user-guide-legacy/assignment-options-5-6-legacy/> (`--alias`, `--group`, `--group-id`, `--grant-easy-access`, `--reassign`), <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-classic/deployment/mass-deployment-on-windows-user-guide-legacy/create-your-custom-teamviewer-module-2-6-legacy/> („Allow account assignment")
- Skript-Token erstellen: <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-remote/for-developers/use-the-teamviewer-api/> · Mindestrechte der Zuordnung (Community-Antwort): <https://community.teamviewer.com/English/discussion/119996/assign-reasssign-via-script-to-specifc-group>
- Ports und Adressen (ausgehend 5938/443/80, eingehend nichts): <https://www.teamviewer.com/en-us/global/support/knowledge-base/teamviewer-remote/troubleshooting/ports-used-by-teamviewer/>
- Linux ohne grafische Oberfläche (`teamviewer info`, `setup`, `passwd`): <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-classic/installation/linux/install-teamviewer-classic-on-linux-without-graphical-user-interface>
- TeamViewer-ID in der Registry (Antwort eines TeamViewer-Mitarbeiters): <https://community.teamviewer.com/English/discussion/7503/teamviewer-id>
- Sicherheit: <https://community.teamviewer.com/English/kb/articles/108689-set-up-unattended-access> (Zufallspasswort aus), <https://community.teamviewer.com/English/kb/articles/108694-golden-security-rules>, <https://community.teamviewer.com/English/kb/articles/108687-restrict-access> (Allowlist), Zwei-Faktor: <https://www.teamviewer.com/en-us/global/support/knowledge-base/teamviewer-remote/account/two-factor-authentication-for-your-account/>, Protokolle: <https://www.teamviewer.com/en-us/global/support/knowledge-base/teamviewer-remote/security/connection-reports/> und <https://www.teamviewer.com/en/global/support/knowledge-base/teamviewer-tensor/security/auditability-event-log/>
