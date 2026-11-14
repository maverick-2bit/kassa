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

**Zugriffsrechte:** Der Installationsordner (Standard `C:\kassa-pos`) ist nur für SYSTEM, die
Administratoren und das Konto zugänglich, mit dem installiert wurde (Docker Desktop läuft unter diesem
Konto). Ein Ordner direkt unter `C:\` erbt sonst „Authentifizierte Benutzer: Ändern" — jedes andere
Windows-Konto auf dem PC könnte die `.env` (JWT_SECRET, MASTER_PASSPHRASE, Datenbank-Passwort) lesen
oder `ops\updater\updater.sh` ändern, das im Update-Dienst als Root mit Docker-Zugriff läuft. Das Setup
setzt die Rechte bei jedem Lauf (auch beim Update) neu. Sollen weitere Windows-Konten in den Ordner
sehen, braucht jedes einen ausdrücklichen Eintrag (`icacls C:\kassa-pos /grant <Konto>:(OI)(CI)M`).

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
Zeile einfügen (sie holt den Installer des **neuesten Release-Tags**, nicht der master-Spitze):

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force; [Net.ServicePointManager]::SecurityProtocol = 3072; $t = (Invoke-RestMethod 'https://api.github.com/repos/maverick-2bit/kassa/git/matching-refs/tags/v').ref | Where-Object { $_ -match '^refs/tags/v\d+\.\d+\.\d+$' } | ForEach-Object { $_ -replace '^refs/tags/','' } | Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1; iwr "https://raw.githubusercontent.com/maverick-2bit/kassa/$t/ops/install.ps1" -OutFile "$env:TEMP\kassa-install.ps1" -UseBasicParsing; & "$env:TEMP\kassa-install.ps1"
```

Ein bestimmtes Release statt des neuesten: `& "$env:TEMP\kassa-install.ps1" -Version v0.8.91`.
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
T=$(curl -fsSL https://api.github.com/repos/maverick-2bit/kassa/git/matching-refs/tags/v | grep -Eo '"refs/tags/v[0-9]+\.[0-9]+\.[0-9]+"' | tr -d '"' | sed 's|refs/tags/||' | sort -V | tail -n 1); curl -fsSL "https://raw.githubusercontent.com/maverick-2bit/kassa/$T/ops/install.sh" | bash
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
T=$(curl -fsSL https://api.github.com/repos/maverick-2bit/kassa/git/matching-refs/tags/v | grep -Eo '"refs/tags/v[0-9]+\.[0-9]+\.[0-9]+"' | tr -d '"' | sed 's|refs/tags/||' | sort -V | tail -n 1); curl -fsSL "https://raw.githubusercontent.com/maverick-2bit/kassa/$T/ops/install.sh" | bash
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
> Ein bestimmtes Release statt des neuesten: `KASSA_VERSION=v0.8.91` (vor `bash`).
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
(Die A-Trust-Adresse nimmt nur `https://hs.a-trust.at` und `https://hs-abnahme.a-trust.at`;
wer sie ändert, gibt das Passwort neu ein — das gespeicherte geht nie an eine neue Adresse.)

## 4b. Betreiber und weitere Mandanten

Eine Installation kann mehrere Mandanten (Betriebe) beherbergen. Was den **ganzen Rechner** betrifft,
darf nur der **Betreiber** — das Konto, das die Kassa betreibt, nicht jeder Mandanten-Admin:

| Nur der Betreiber | Jeder Mandanten-Admin (für den eigenen Betrieb) |
|-------------------|--------------------------------------------------|
| Datenbank-Sicherung anlegen, ansehen, herunterladen (Dump der **ganzen** Datenbank, alle Mandanten) | Export des eigenen Mandanten („Mandant übertragen"), DEP-Sicherung der eigenen Kassen |
| Kassa aktualisieren (Einstellungen → System → Aktualisierung) | Drucker-Status und Keep-Alive des eigenen Betriebs |
| Systemwerte: Speicher, Platte, Laufzeit, Datenbank, Sicherungsalter | Version und Update-Hinweis ansehen |
| Weitere Mandanten anlegen; eine Übergabedatei als Mandant einspielen | |

**Wer ist Betreiber?** Der erste Admin einer frisch eingerichteten Installation. Auf einer bestehenden
Installation macht das Update die aktiven Admins des **zuerst angelegten** Mandanten zu Betreibern
(Migration 0072). In der Benutzerverwaltung trägt der Betreiber ein gelbes Schild „Betreiber". Sein Konto
ändert oder sperrt nur ein Betreiber, und der letzte aktive Betreiber lässt sich nicht stilllegen. Die
Prüfung geschieht bei jedem Aufruf in der Datenbank — ein deaktivierter Betreiber verliert die Rechte
sofort, auch mit noch gültiger Anmeldung. Keine Oberfläche und kein Mandanten-Import vergibt die
Betreiber-Rolle; weitere Betreiber (oder einen anderen als den automatisch gewählten) setzt man auf dem
Kassen-PC:

```bash
docker compose exec postgres psql -U kassa -d kassa -c "UPDATE users SET ist_betreiber = true WHERE email = 'name@firma.at';"
# entziehen: ... SET ist_betreiber = false ...; Übersicht: SELECT email, ist_betreiber FROM users WHERE ist_betreiber;
```

**Weiteren Mandanten anlegen:** als Betreiber anmelden → **Einstellungen → System → „Weiteren Mandanten
anlegen"**. Die Einrichtungsseite `/setup` ist nur auf einer leeren Installation offen (Ersteinrichtung);
auf einer eingerichteten antwortet sie allen außer dem angemeldeten Betreiber mit 403 und einem Hinweis.
Notweg ohne Anmeldung (Skripte, Notfall): `SETUP_TOKEN` in der `.env` setzen (mind. 24 Zeichen,
`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`), Backend neu starten
(`docker compose up -d`) und den Schlüssel als Header mitschicken:

```bash
curl -X POST https://kasse.example.com/api/setup -H "Content-Type: application/json" \
  -H "x-setup-token: $SETUP_TOKEN" -d @neuer-mandant.json
```

Ohne `SETUP_TOKEN` ist dieser Weg zu (Standard). Versuche ohne Berechtigung stehen im Audit-Log
(`setup.verweigert`), angelegte Mandanten ebenso (`setup.mandant_angelegt`); die Route erlaubt je Client
nur 5 Anfragen pro Minute.

**Demo-Zahlungen** (SB-Terminal ohne Kartenterminal mit dem öffentlichen „Bezahlt"-Knopf, ZVT-„IP" `stub`)
gibt es nur an Kassen im **Testmodus** (RKSV-Umgebung „test" — das setzt die Einrichtung, nachträglich
ändert sie keine Oberfläche). Eine Kasse im Produktivmodus lehnt beides ab; ein SB-Terminal braucht dort
ein eingerichtetes Kartenterminal.

## 4c. Rechte: wer darf was (auch über die Schnittstelle)

Die Rechte eines Benutzers (Benutzerverwaltung) gelten nicht nur für die Menüs, sondern **für jede Route der
Schnittstelle** — wer ein Anmelde-Token hat, kommt mit einem selbst gebauten Aufruf nicht weiter als die
Oberfläche. Admins dürfen immer; ein Kellner-Konto nur, was es als Recht trägt. Eines der genannten Rechte
genügt, wo mehrere Seiten dieselbe Funktion brauchen.

| Recht | schaltet in der Schnittstelle frei |
|-------|-------------------------------------|
| Einstellungen | Drucker, Kassen, KDS-Zuordnung, Sicherungen (DEP), Prüfer-Zugänge, Mandanten-Stammdaten/Module/Stripe, Werbefolien, Zeiterfassung/Dienstplan, Exporte (BMD, DEP), Audit-Log |
| Artikel verwalten | Artikel, Warengruppen, Optionen, Lagerstand, Inventur, Lieferanten, Einkauf, Preislisten, Preisregeln |
| Schnellkasse | Verkauf (Barzahlung), Gutscheine, Angebote, Lieferscheine, Wartungsverträge, Reservierungen, Lieferungen |
| Kreditverkauf | offenen Posten anlegen („Auf Kredit buchen") |
| Belege einsehen | Belegliste, Berichte, Tagesabschluss, Monats-/Jahresbeleg, Kassenbuch lesen |
| Belege stornieren | Storno |
| Kunden (CRM) | Kundenstamm, offene Posten, Kundenbelege |
| Tickets | Ticketing |
| nur Administratoren (Rolle) | Benutzerverwaltung, Tischplan und Layout-Pflege, KDS-Geräte, Mandanten-Übergabe, Monitoring, RKSV-Selbsttest |

Die vollständige Tabelle — jede Route mit ihrem Recht — steht in `packages/backend/src/auth/route-rechte.ts`;
`tests/route-schutz.test.ts` schlägt an, wenn eine Route ohne Entscheidung hinzukommt.

**Bewusst offen für jeden angemeldeten Benutzer** bleiben die Wege der **Kellner-App** (Tische öffnen und
abrechnen, bonieren, Karte und Kassen-Konfiguration lesen), der Küchenbildschirm sowie die Statusleisten. Die
Kellner-App prüft selbst keine Rechte, und ein Kellner-Konto ohne „Tische"-Recht arbeitet damit heute — ein
Recht dort zu verlangen, würde solche Konten ohne Vorwarnung aussperren. Wer das schließen will, prüft zuerst
die Konten (Kellner ohne „Tische" **und** ohne „Schnellkasse"):

```bash
docker compose exec postgres psql -U kassa -d kassa -c "SELECT name, email, berechtigungen FROM users WHERE rolle = 'kellner' AND aktiv AND NOT ('tische' = ANY(berechtigungen) OR 'kasse' = ANY(berechtigungen));"
```

Rechte stecken im Anmelde-Token: Änderungen in der Benutzerverwaltung gelten ab der **nächsten Anmeldung** des
Benutzers (das Token läuft nach 8 Stunden ab, `JWT_EXPIRES_IN`); ein gesperrtes Konto kommt nicht mehr hinein,
ein bereits ausgestelltes Token aber bis zum Ablauf.

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

Die Gast-Bestellung per Tisch-QR ist je Kasse schaltbar: **Einstellungen → Kassen & Drucker →
Details der Kasse → „Gast-Bestellung per Tisch-QR"** — *Aus* (neue Kassen), *Ohne Zahlung* (Bestellung landet
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

## 6b. FinanzOnline: Hersteller-ID

Für Meldungen an FinanzOnline (Registrierung nachtragen, SEE-Ausfall und -Wiederinbetriebnahme, Kasse außer Betrieb
nehmen) meldet sich die Kassa als Webservice-Client an. Der Login braucht außer den Zugangsdaten des
Webservice-Benutzers die **Hersteller-ID**: die UID-Nummer des **Softwareherstellers** (nicht die des Betriebs, der die
Kassa benutzt), 10–24 Buchstaben/Ziffern ohne Leerzeichen, z. B. `ATU12345678`. Sie ist für die ganze Installation
gleich — einmal in `.env` eintragen und das Backend neu starten (`docker compose up -d`):

```
FON_HERSTELLER_ID=ATU12345678
```

Ohne Eintrag verwendet die Kassa einen Platzhalter (der Login ist dann formal gültig, FinanzOnline lehnt ihn aber
voraussichtlich ab; die Fehlermeldung nennt `FON_HERSTELLER_ID`, das Backend warnt beim Start). Ein ungültiger Wert
(Unterstrich, Leerzeichen, zu kurz/lang) verhindert den Start mit einer klaren Meldung — so fällt der Tippfehler sofort auf
und nicht erst beim Login. Der Stand der FinanzOnline-Anbindung steht in `packages/rksv/FINANZONLINE-ABGLEICH.md`.

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
- Pro Kasse freischalten: **Einstellungen → Kassen & Drucker → Details der Kasse → „Gast-Bestellung per Tisch-QR"
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
ein Klick auf **„Jetzt aktualisieren"** (nur der Betreiber, siehe 4b) holt das **neueste signierte
Release** (Git-Tag `vX.Y.Z`, nie die master-Spitze), prüft seine Signatur und baut die
Container neu. Die Kassa ist dabei ~1 Minute offline (nicht während des Kassierens
starten). Nach Abschluss erscheint **„Jetzt neu laden"**. Scheitert das Update, setzt der
Updater die Kassa selbst auf den vorherigen Stand zurück und meldet es dort — siehe Abschnitt 11.

> Dahinter steckt ein eigener `updater`-Container (in `docker-compose.yml` enthalten),
> der als Einziger den Docker-Socket sieht und **ausschließlich** den festen Ablauf
> ausführt — das Backend gibt nur das Startsignal (Datei im `update_control`-Volume),
> kann also keine beliebigen Befehle auslösen. Was er installiert, muss mit einem Schlüssel aus
> `ops/updater/allowed_signers` signiert sein (Abschnitt 11).
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
- **Uhrzeit auf Bons/QR-Code 1–2 Stunden daneben:** Der Backend-Container läuft in
  `Europe/Vienna` (`TZ` in `docker-compose.yml` und im Image). Belege und Bons rechnen
  die Uhrzeit ohnehin fest in Wiener Ortszeit, unabhängig vom Container. Prüfen mit
  `docker compose exec backend date` — bei `UTC` fehlt `TZ` (alte Compose-Datei): neu
  starten mit `docker compose up -d --build backend`. **Belege, die VOR der Umstellung
  signiert wurden, tragen im QR-Code die Zeit in UTC** (signiert, nicht mehr änderbar).
  Einstellungen → RKSV → Signatur-Selbsttest meldet sie als „QR-Zeit in UTC" — sie bleiben
  gültig, das CSV-Protokoll dokumentiert sie.
- **Signatur-Selbsttest meldet „Verkettung im Altformat: Belege 2–m":** Belege aus Programmversionen vor der Korrektur
  tragen ab dem 2. Beleg als Verkettungswert den Hash des QR-Codes ihres Vorgängers statt seiner
  JWS-Form (RKSV Anlage 1 Z 4, Befund A der RKSV-Prüfstrecke). Der Wert steckt im signierten Code
  und lässt sich nicht mehr ändern; schon der erste Beleg nach dem Update ist richtig verkettet.
  Die Kassa erkennt die Altstrecke aus den Daten, hält die Kette für geschlossen und
  dokumentiert den Belegbereich im CSV-Protokoll. Das BMF-Prüftool meldet in dieser Strecke je
  Beleg einen Verkettungsfehler (`DEP_CHAINING_VALUE`) und lehnt DEP-Auszüge ohne Startbeleg ab.
  Erscheint das Altformat NACH dem Umstieg wieder (gelber Hinweis), läuft vermutlich eine ältere
  Programmversion — Update prüfen. „Signaturkette unterbrochen bei Beleg N" dagegen ist ein echter
  Bruch (gelöschter, vertauschter oder veränderter Beleg).
- **Signatureinheit (A-Trust) fällt aus:** Ist sie nicht erreichbar (Netz, Timeout, HTTP 5xx),
  geht die Kassa in den Ausfallmodus (roter Banner, Belege mit Marker statt Signatur) und
  prüft die Verbindung selbst jede Minute; kommt die Einheit wieder, stellt die Kassa die
  Signatur mit einem signierten Sammelbeleg von allein wieder her (Ausfälle unter 48 h). Weist
  A-Trust die Anfrage ab (HTTP 4xx, meist Benutzer/Passwort/Adresse), erstellt die Kassa KEINEN
  Beleg und nennt den Grund — das lässt sich nur in den Einstellungen beheben. Ab 48 Stunden
  Ausfall ist der Ausfall FinanzOnline zu melden (Banner, „Wieder in Betrieb nehmen").
- **„FON-Login fehlgeschlagen … Platzhalter-Hersteller-ID":** in `.env` ist noch keine `FON_HERSTELLER_ID` gesetzt
  (Abschnitt 6b). Eintragen, `docker compose up -d`, erneut versuchen. Dieselbe Meldung ohne den Hinweis auf die
  Hersteller-ID betrifft die Zugangsdaten des Webservice-Benutzers (TID, BenID, PIN).
- **„Die Software-Signatur dieser Kasse (Kennung AT0 …) kann bei FinanzOnline nicht … registriert werden":** FinanzOnline
  nimmt als Signaturerstellungseinheit nur Zertifikate von Vertrauensdiensteanbietern (A-Trust u. a.) an, nicht die
  Software-Signatur. Für die Registrierung die Kasse in den Einstellungen auf A-Trust umstellen (Abschnitt „RKSV-Hinweis" oben).
- **„Die Systemuhr der Kassa geht nach":** Die Uhr des Kassen-PCs liegt mehr als eine Minute VOR
  dem letzten Beleg. Belege dürfen nicht rückdatiert werden; Uhr/Zeitsynchronisation des PCs
  prüfen. Kleine Rücksprünge (bis 1 Minute) gleicht die Kassa selbst an.
- **„Jetzt aktualisieren" / Datenbank-Backups / „Weiteren Mandanten anlegen" fehlen, oder
  „Das darf nur der Betreiber dieser Kassa":** das angemeldete Konto ist nicht als Betreiber
  markiert (Abschnitt 4b). Auf dem Kassen-PC prüfen und setzen:
  `docker compose exec postgres psql -U kassa -d kassa -c "SELECT email, ist_betreiber FROM users WHERE rolle = 'admin'"`
  bzw. `UPDATE users SET ist_betreiber = true WHERE email = '…'`.
- **Die Einrichtungsseite (`/setup`) sagt „bereits eingerichtet":** gewollt — auf einer eingerichteten
  Installation legt nur der angemeldete Betreiber weitere Mandanten an (Abschnitt 4b).
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

## 9b. Kassa übertragen (Büro → Kunden-Hardware)

Eine im Büro eingerichtete Kassa (alle Daten, Layout, Benutzer, Signaturschlüssel) auf den PC
des Kunden übertragen — verschlüsselt, optional über ein **privates** GitHub-Repo
(`maverick-2bit/kassa-uebergaben`, vorher anlegen):

```powershell
# Büro-PC (Skript liegt im Installationsverzeichnis unter ops\):
.\uebergabe.ps1 -Export -Name kunde-mustermann -Hochladen -Stilllegen
# Kunden-PC: erst Kassa-Setup normal ausführen, dann:
.\uebergabe.ps1 -Import -Herunterladen -Name kunde-mustermann     # oder -Datei X.kuep (USB)
```

**Nur einen Mandanten dazu übertragen** (Ziel-Kassa hat schon eigene Daten, soll sie behalten):

```powershell
# Quelle: Auswahlliste der Mandanten, oder -MandantId <id>
.\uebergabe.ps1 -Export -Mandant -Name laptop-test -Hochladen
# Ziel: spielt den Mandanten ZUSÄTZLICH ein; vorhandene Mandanten/Daten bleiben unberührt
.\uebergabe.ps1 -Import -Mandant -Herunterladen -Name laptop-test
```

Danach am Ziel mit dem Login des übertragenen Mandanten anmelden — er erscheint im
Mandanten-Umschalter. Die RKSV-Schlüssel werden mit der `MASTER_PASSPHRASE` des Ziels neu
verschlüsselt. Bricht irgendetwas ab (z. B. Mandant schon vorhanden, Version zu alt), wird
nichts geändert. Beide Kassen müssen auf demselben Stand sein (Ziel zuerst updaten).

- Das **Übergabe-Passwort** wird abgefragt (min. 10 Zeichen) und gehört nie ins Repo.
- Enthalten: komplette Datenbank + `MASTER_PASSPHRASE` (sonst sind die RKSV-Schlüssel unlesbar).
- **RKSV:** immer nur EINE Kassa darf produktiv laufen (`-Stilllegen`); am besten Übergabe vor dem ersten Echt-Beleg.
- Danach beim Kunden Drucker-IPs und Kartenterminal anpassen. Ziel mit vorhandenen Belegen nur mit `-Ueberschreiben`.

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
(Version 15 oder neuer); das Host-Modul („Custom Host") nennt die ältere Doku ab Business, die neuere
Corporate/Tensor. Sehen Sie in der Verwaltungskonsole unter *Admin settings → Device Management* den Punkt
**Rollout set-up**, nehmen Sie Variante A. Fehlt er, geht nur Variante B bzw. die Frage an den
TeamViewer-Support, ob die Lizenz die Rollout-Konfiguration umfasst.

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

## 11. Update-Kette: Herkunft, Signatur, Rückweg

Der In-App-Updater läuft als Root mit Docker-Zugriff. Er installiert deshalb **nur, was nachweislich von
Ihnen stammt**, und nimmt ein fehlgeschlagenes Update selbst zurück. (Prüfbericht 2026-11, Befund 4: bis v0.8.91
zog er die master-Spitze von GitHub ohne jede Prüfung — wer das GitHub-Konto oder master kontrollierte, bestimmte,
was jede Kassa als Root ausführte.)

### 11.1 So funktioniert es

- **Nur signierte Release-Tags.** Ein Release ist ein Git-Tag `vX.Y.Z`, mit `git tag -s` (SSH-Signatur) signiert.
  Der Updater lädt das neueste Tag, prüft die Signatur gegen `ops/updater/allowed_signers` und installiert erst dann.
  Ohne gültige Signatur passiert **nichts** — die Kassa zeigt „Update abgelehnt: …".
- **Der Prüfschlüssel ist der des INSTALLIERTEN Stands**, nie der des frisch geladenen. Ein neuer Schlüssel gilt
  deshalb erst nach einem Release, das noch mit einem alten signiert wurde (Abschnitt 11.3).
- **Weitere Prüfungen:** Das Tag-Objekt muss selbst `vX.Y.Z` heißen (kein altes Tag unter neuem Namen);
  `package.json` im Release muss `X.Y.Z` melden; das Release muss Updater und `allowed_signers` enthalten und darf
  seinen eigenen Signierer nicht aussperren; **ältere Versionen als die installierte werden nie eingespielt**.
  Unsigniert/ungültig übergeht der Updater (bis zu 20 Tags) und nimmt das neueste gültige — meldet aber, was er abgelehnt hat.
- **Rückweg.** Vor jeder Änderung sichert der Updater den Installationsordner (ohne `.env`) und merkt sich die laufenden
  Images (Tag `kassa-rueckweg/<dienst>:vorher`). Scheitert der Build, ein Dienst oder meldet sich das Backend binnen
  5 Minuten nicht **gesund mit der Zielversion**, stellt er Code und Images wieder her, startet ohne Neubau und zeigt
  in der Kassa: „Update auf vX fehlgeschlagen — automatisch auf vY zurückgesetzt". Die Sicherung liegt im Dateisystem des
  Updater-Containers, **nicht** im Volume `update_control` (auf das auch das Backend schreiben darf).
- **Stromausfall / Docker-Neustart mitten im Update:** Beim nächsten Start findet der Updater die Marke „Update läuft"
  und prüft: Backend gesund mit der Zielversion → fertig; sonst Rückweg.
- **Die Datenbank wird nicht zurückgerollt.** Migrationen laufen nur vorwärts; der alte Code muss mit dem neueren Schema
  zurechtkommen (neue Spalten/Tabellen sind unkritisch). Es gibt weiter die nächtliche DB-Sicherung (Abschnitt 6).
- **Fehlerbilder in der Kassa** (Einstellungen → System → rote Box „Letztes Update fehlgeschlagen"):
  - *„Update abgelehnt: … nicht gültig signiert"* — das Release ist nicht (richtig) signiert; Abschnitt 11.2. Die Kassa bleibt unverändert.
  - *„… die Vertrauensdatei ops/updater/allowed_signers fehlt"* — `Kassa-Setup` einmal erneut ausführen.
  - *„… automatisch auf vY zurückgesetzt"* — das neue Release ist nicht angelaufen; alles läuft wieder auf dem alten Stand. Logs:
    `docker compose logs backend`.
  - *„… der Rückweg konnte … nicht starten"* — selten; die Sicherung liegt dann noch im Updater (`docker compose exec updater ls /var/lib/kassa-rueckweg`).
    `Kassa-Setup` erneut ausführen holt das neueste Release und startet alles neu.

### 11.2 Ein Release veröffentlichen (Betreiber/Entwickler)

Wie bisher: Branch → Verify (Build, `pnpm test`, Integration, E2E) → `merge --no-ff` → alle 13 `package.json` auf die neue Version →
`git push origin HEAD:master`. **Neu ist nur der Tag:**

```bash
git tag -s -m "Release vX.Y.Z" vX.Y.Z                  # signiert (statt -a); fragt nichts, wenn der Arbeitsschlüssel eingerichtet ist
sh ops/release/pruefe-release.sh vX.Y.Z --master       # prüft Signatur (auch gegen den Vorgänger), Versionen, Pflichtdateien
git push origin vX.Y.Z
```

`pruefe-release.sh` prüft genau das, worauf sich der Updater verlässt. Nach dem Push prüft derselbe Test der GitHub-Workflow
**„Release-Tag prüfen"** (Actions): Rot + Mail von GitHub heißt, dass die Kassen das Release **ablehnen und still übergehen** —
dann beheben (Tag neu setzen: `git push --delete origin vX.Y.Z`, `git tag -d vX.Y.Z`, erneut signieren; die GitHub-Regel „Tags fest" muss dafür
kurz ausgesetzt werden: Repo → Settings → Rules). Die Kassen zeigen weiter das alte Release, bis ein gültiges da ist.

**Einmalig einrichten** (nur im Kassa-Repo, nicht global; die Pfade des Arbeitsschlüssels anpassen):

```bash
git config gpg.format ssh
git config user.signingkey C:/Users/<Benutzer>/.ssh/kassa-release     # Arbeitsschlüssel (privat, ohne Passphrase)
```

### 11.3 Schlüssel

| Schlüssel | Zweck | Wo der geheime Teil liegt |
|---|---|---|
| **Arbeitsschlüssel** `kassa-release` | signiert jedes Release | auf dem Release-PC, `~/.ssh/kassa-release` (nur dieses Benutzerkonto) |
| **Reserveschlüssel** `kassa-release-reserve` | Notfall: ersetzt einen verlorenen/gestohlenen Arbeitsschlüssel | **offline** (USB-Stick/Tresor/Passwortmanager), nie auf dem Release-PC; empfohlen: mit Passphrase (`ssh-keygen -p -f <Datei>`) |

Die öffentlichen Teile stehen in `ops/updater/allowed_signers` (Fingerprints: Arbeitsschlüssel
`SHA256:3JcXRo5pyc0zWaBK52uIHL/KyNzxcmAIStKkMGI5iWI`, Reserveschlüssel `SHA256:28+xTrvbo0IfeqEl2OjLZV7mBESlcqo5aESJlqFiDs0`;
den Fingerprint einer Schlüsseldatei zeigt `ssh-keygen -l -f <datei>.pub`).

- **Schlüsselwechsel (geplant):** Release N führt den neuen Schlüssel in `allowed_signers` ein und wird noch mit einem **alten**
  Schlüssel signiert. Erst Release N+1 darf mit dem neuen signiert werden. `pruefe-release.sh` meldet es, wenn man beides in
  einem Schritt versucht („eine Kasse mit vX würde dieses Release ABLEHNEN").
- **Arbeitsschlüssel verloren oder gestohlen:** ein Release mit dem **Reserveschlüssel** signieren, das den alten Schlüssel aus
  `allowed_signers` streicht und einen neuen einträgt. Kassen, die dieses Release installieren, vertrauen danach nur noch den neuen.
  Bis dahin kann mit dem gestohlenen Schlüssel signierter Code auf Kassen gelangen — das Release also schnell machen und die Kunden
  zum Update bewegen.
- **Beide Schlüssel verloren:** Kassen, die schon auf dem neuen Updater laufen, nehmen kein Update mehr an. Dann hilft nur ein Neuaufsetzen
  mit `Kassa-Setup` (holt das neueste Release samt neuem `allowed_signers`) — daher den Reserveschlüssel sorgfältig sichern.

### 11.4 Übergang für bestehende Installationen

Kassen mit dem **alten** Updater (bis v0.8.91) ziehen beim nächsten Klick auf „Jetzt aktualisieren" noch die master-Spitze — das ist
die **eine** Lieferung ohne Prüfung. Sie bringt den neuen Updater und `allowed_signers` mit; der Updater-Container startet danach von selbst neu
(die Datei `ops/updater/updater.sh` wird beim Neustart frisch eingebunden). **Jedes weitere Update ist dann geprüft.**

- Bis alle Kassen umgestellt sind, muss **master dem neuesten Release entsprechen** (keine unveröffentlichten Commits) — die alten Updater
  und die alte Versionsanzeige lesen weiter master.
- Wer den Übergang nicht dem alten Updater überlassen will, führt `Kassa-Setup` aus: Es installiert das neueste **Release** (nicht master).
- Neue Kassen: `Kassa-Setup`/Einzeiler holen ebenfalls das neueste Release-Tag. Die **Erstinstallation vertraut GitHub (TLS) und dem Installer**,
  den Sie weitergeben — erst das erste Update ist signaturgeprüft. Dasselbe gilt für Offline-Pakete (`erstelle-offline-paket.ps1`).

### 11.5 Was das NICHT abdeckt

- **Der Release-PC:** Wer den Arbeitsschlüssel von dort stiehlt (oder eine fehlgeleitete Sitzung dort signieren lässt), kann Releases signieren.
  Mit Passphrase bzw. Hardware-Schlüssel (FIDO2) wäre das schwerer — heute bewusst ohne, damit Releases ohne Rückfrage laufen.
- **Abhängigkeiten außerhalb des Repos:** Basis-Images (`docker:27-cli`, `postgres`, `nginx`, `node`), npm-Pakete im Build (`pnpm-lock.yaml`)
  und die Alpine-Pakete des Updaters (`apk`) prüft der Updater nicht.
- **Die Datenbank** (siehe oben) und **Fremdzugriff auf den Installationsordner:** Wer dort schreiben darf, kann `updater.sh` und
  `allowed_signers` ändern — die Windows-Installer beschränken die Rechte darauf (Abschnitt „Zugriffsrechte").
- **Erstinstallation und Offline-Pakete** (siehe 11.4).

### 11.6 GitHub-Regeln

Im Repo `maverick-2bit/kassa` (Settings → Rules): **Tags `v*` sind fest** (nicht löschen, nicht verschieben) und **master** erlaubt
kein Force-Push und kein Löschen. Direkt-Push-Releases bleiben möglich; einen Pull-Request mit CI zu verlangen wäre mit der Signatur
kaum nötig und würde den Direkt-Push-Release brechen. Die Regeln schützen vor Versehen und anderen Konten, **nicht** vor dem Admin-Konto selbst —
das übernimmt die Signatur.

### 11.7 Tests

```bash
sh ops/updater/test-updater.sh                # Updater + pruefe-release.sh: echte SSH-Signaturen, Docker-/rsync-Attrappen, über 90 Prüfungen
sh ops/updater/test-updater.sh mutationen     # Gegenprobe: jede gezielte Zerstörung des Updaters MUSS die Tests röten
bash ops/test-fernwartung.sh                  # Installer install.sh (Release-Wahl) + Fernwartung
pwsh -File ops/test-fernwartung.ps1           # Installer install.ps1 / Offline-Paket / Kassa-Setup.cmd (auch Windows PowerShell 5.1)
```

Die CI führt `test-updater.sh` (mit Mutationsprobe) in jedem Lauf aus (Job „Updater"). **Nicht automatisch getestet** ist der Lauf gegen ein
echtes Docker (kein Docker auf dem Entwicklungs-PC): ein echter Rückweg und ein echter Update-Lauf wurden mit Attrappen geprüft — vor dem ersten
Kunden-Rollout einmal am Test-PC durchspielen (Release einspielen; zum Test des Rückwegs ein Release mit absichtlich kaputtem Backend-Start).
