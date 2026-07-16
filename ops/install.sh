#!/usr/bin/env bash
#
# Kassa POS — Setup / Update für macOS und Linux (Raspberry Pi / Debian / Ubuntu)
#
# EIN Skript für beide Plattformen (Pendant zu ops/install.ps1 für Windows):
#   1. erkennt das Betriebssystem (macOS / Linux)
#   2. installiert bei Bedarf Docker (Docker Desktop per Homebrew bzw. get.docker.com)
#   3. lädt den aktuellen Quellcode von GitHub (baut die Container nativ für die
#      jeweilige Architektur — Apple Silicon/Intel bzw. Raspberry Pi arm64)
#   4. erzeugt beim ERSTEN Lauf die .env mit sicheren Zufalls-Secrets
#   5. baut + startet alle Container (docker compose up -d --build)
#   6. wartet auf den Gesundheitscheck und zeigt die Geräte-URL-Tabelle
#
# Erneut ausführen = UPDATE (Code neu laden + Container neu bauen; .env, Datenbank
# und alle Belege bleiben erhalten).
#
# Nutzung:
#   curl -fsSL https://raw.githubusercontent.com/maverick-2bit/kassa/master/ops/install.sh | bash
#   # oder aus einem Checkout:  bash ops/install.sh
#
# Optionale Umgebungsvariablen:
#   KASSA_DIR=~/kassa        Zielverzeichnis (Default: $HOME/kassa)
#   KASSA_BRANCH=master      Git-Branch (Default: master)
#   KASSA_OHNE_DOCKER=1      Nur Code + .env vorbereiten (Testlauf, kein Docker)
#
set -euo pipefail

KASSA_DIR="${KASSA_DIR:-$HOME/kassa}"
KASSA_BRANCH="${KASSA_BRANCH:-master}"
REPO="maverick-2bit/kassa"
TARURL="https://github.com/${REPO}/archive/refs/heads/${KASSA_BRANCH}.tar.gz"

# ── Ausgabe-Helfer ───────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_G=$'\033[32m'; C_C=$'\033[36m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_0=$'\033[0m'
else
  C_G=''; C_C=''; C_Y=''; C_R=''; C_0=''
fi
schritt()  { printf '\n%s▶ %s%s\n' "$C_C" "$*" "$C_0"; }
ok()       { printf '%s✓ %s%s\n' "$C_G" "$*" "$C_0"; }
hinweis()  { printf '%s… %s%s\n' "$C_Y" "$*" "$C_0"; }
fehler()   { printf '%s✗ %s%s\n' "$C_R" "$*" "$C_0" 1>&2; }
abbruch()  { fehler "$*"; exit 1; }

# ── Plattform erkennen ───────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) PLATTFORM="macos" ;;
  Linux)  PLATTFORM="linux" ;;
  *)      abbruch "Nicht unterstütztes Betriebssystem: $(uname -s) — nur macOS und Linux/Raspberry Pi." ;;
esac

# sudo nur unter Linux und nur, wenn nicht bereits root
SUDO=""
if [ "$PLATTFORM" = "linux" ] && [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"
  else abbruch "sudo wird benötigt (oder das Skript als root ausführen)."; fi
fi

printf '\n%s══════════════════════════════════════════%s\n' "$C_G" "$C_0"
printf   '%s  Kassa POS — Setup / Update  (%s)%s\n' "$C_G" "$PLATTFORM" "$C_0"
printf   '%s══════════════════════════════════════════%s\n' "$C_G" "$C_0"

# Fehlendes Debian/Ubuntu-Paket nachinstallieren (nur Linux, nur mit apt-get)
linux_paket() { # $1 = Befehl, $2 = Paketname
  command -v "$1" >/dev/null 2>&1 && return 0
  if command -v apt-get >/dev/null 2>&1; then
    hinweis "Installiere fehlendes Paket: $2"
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$2"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. Docker sicherstellen
# ─────────────────────────────────────────────────────────────────────────────
DOCKER="docker"          # ggf. später auf "sudo docker" umgestellt
daemon_ok() { $DOCKER info >/dev/null 2>&1; }

warte_auf_docker() {
  schritt "Warte, bis der Docker-Dienst bereit ist …"
  i=0
  while [ "$i" -lt 90 ]; do
    if daemon_ok; then ok "Docker läuft"; return 0; fi
    sleep 2; i=$((i + 1))
  done
  return 1
}

if [ "${KASSA_OHNE_DOCKER:-0}" != "1" ]; then
  if command -v docker >/dev/null 2>&1 && daemon_ok; then
    ok "Docker ist installiert und läuft"
  elif [ "$PLATTFORM" = "macos" ]; then
    if ! command -v docker >/dev/null 2>&1; then
      schritt "Docker Desktop installieren"
      if command -v brew >/dev/null 2>&1; then
        brew install --cask docker
      else
        abbruch "Weder Docker noch Homebrew gefunden. Bitte Docker Desktop installieren:
    https://www.docker.com/products/docker-desktop/
  (oder erst Homebrew von https://brew.sh) und das Skript erneut ausführen."
      fi
    fi
    schritt "Starte Docker Desktop"
    open -a Docker || true
    warte_auf_docker || abbruch "Docker Desktop wurde nicht bereit. Bitte einmal manuell öffnen (Wal-Symbol in der Menüleiste) und das Skript erneut ausführen."
  else
    # Linux / Raspberry Pi
    schritt "Docker installieren (offizielles get.docker.com-Skript)"
    linux_paket curl curl
    curl -fsSL https://get.docker.com | $SUDO sh
    $SUDO systemctl enable --now docker 2>/dev/null || true
    # Zugriff ohne sudo: Benutzer in die docker-Gruppe (wirkt erst nach Ab-/Anmeldung)
    if [ -n "$SUDO" ] && ! id -nG "$USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
      $SUDO usermod -aG docker "$USER" 2>/dev/null || true
      hinweis "Benutzer '$USER' zur docker-Gruppe hinzugefügt — für 'docker' ohne sudo einmal ab- und wieder anmelden."
    fi
    # In DIESER Sitzung fehlt die Gruppen-Mitgliedschaft noch → ggf. via sudo ansprechen
    if ! daemon_ok && [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
      DOCKER="$SUDO docker"
    fi
    daemon_ok || abbruch "Docker-Dienst ist nicht erreichbar."
    ok "Docker läuft"
  fi

  # Compose v2 (Plugin) prüfen
  if ! $DOCKER compose version >/dev/null 2>&1; then
    if [ "$PLATTFORM" = "linux" ]; then linux_paket docker-compose-plugin docker-compose-plugin; fi
    $DOCKER compose version >/dev/null 2>&1 || abbruch "Docker Compose (v2) fehlt. Linux: '$SUDO apt-get install -y docker-compose-plugin'."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Quellcode laden (nach $KASSA_DIR spiegeln, .env bleibt erhalten)
# ─────────────────────────────────────────────────────────────────────────────
schritt "Lade aktuellen Quellcode (Branch: $KASSA_BRANCH)"
linux_paket curl curl
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$TARURL" | tar -xz -C "$tmp" || abbruch "Download/Entpacken fehlgeschlagen — Internetverbindung prüfen."
quelle="$tmp/kassa-${KASSA_BRANCH}"
[ -d "$quelle" ] || abbruch "Entpacktes Verzeichnis nicht gefunden ($quelle)."

mkdir -p "$KASSA_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude='/.env' "$quelle"/ "$KASSA_DIR"/
else
  # Fallback ohne rsync (spiegelt additiv; .env bleibt unangetastet)
  ( cd "$quelle" && find . -mindepth 1 -maxdepth 1 ! -name .env -exec cp -R {} "$KASSA_DIR"/ \; )
fi
ok "Code liegt in $KASSA_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# 3. .env beim ersten Lauf erzeugen (Secrets generieren)
# ─────────────────────────────────────────────────────────────────────────────
schritt "Konfiguration (.env)"
envf="$KASSA_DIR/.env"
gen_secret() { # $1 = Anzahl Bytes → 2*$1 Hex-Zeichen (RKSV-sicher, nur [0-9a-f])
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else LC_ALL=C od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; fi
}
if [ -f "$envf" ]; then
  ok "Bestehende .env gefunden — bleibt unverändert (Update-Modus)"
else
  [ -f "$KASSA_DIR/.env.example" ] || abbruch ".env.example fehlt im Quellcode."
  [ "$PLATTFORM" = "linux" ] && linux_paket openssl openssl
  PW="$(gen_secret 16)"; MP="$(gen_secret 20)"; JW="$(gen_secret 32)"
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PW}|" \
      -e "s|^MASTER_PASSPHRASE=.*|MASTER_PASSPHRASE=${MP}|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=${JW}|" \
      "$KASSA_DIR/.env.example" > "$envf"
  chmod 600 "$envf" 2>/dev/null || true
  ok ".env mit sicheren Zufalls-Secrets erstellt"
  hinweis "WICHTIG: Sichere eine Kopie der .env an einem sicheren Ort!"
  hinweis "Die MASTER_PASSPHRASE darf NIE geändert werden oder verloren gehen —"
  hinweis "sonst sind die RKSV-Signaturen der bereits erstellten Belege unbrauchbar."
fi

# Ports aus der .env lesen (für die URL-Tabelle)
env_port() { # $1 = Name, $2 = Default
  v="$(grep -E "^$1=" "$envf" 2>/dev/null | head -1 | cut -d= -f2 | tr -dc '0-9')"
  [ -n "$v" ] && echo "$v" || echo "$2"
}

if [ "${KASSA_OHNE_DOCKER:-0}" = "1" ]; then
  schritt "Testlauf (KASSA_OHNE_DOCKER=1): Docker-Build und Start übersprungen"
  ok "Code + .env liegen bereit in $KASSA_DIR"
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Container bauen + starten
# ─────────────────────────────────────────────────────────────────────────────
if [ "$PLATTFORM" = "linux" ]; then
  # Warnung bei knappem RAM (Vite-Builds von 8 Frontends sind speicherhungrig)
  memkb="$(grep -E '^MemTotal:' /proc/meminfo 2>/dev/null | tr -dc '0-9' || echo 0)"
  if [ "${memkb:-0}" -gt 0 ] && [ "$memkb" -lt 3800000 ]; then
    hinweis "Wenig Arbeitsspeicher erkannt (< 4 GB). Der erste Build kann lange dauern oder"
    hinweis "am Speicher scheitern. Empfehlung: Raspberry Pi 4/5 mit ≥ 4 GB + vergrößerter"
    hinweis "Swap (z. B. /etc/dphys-swapfile: CONF_SWAPSIZE=2048, dann 'sudo dphys-swapfile setup && sudo dphys-swapfile swapon')."
  fi
fi

schritt "Baue und starte alle Container — der erste Lauf dauert einige Minuten (auf dem Raspberry Pi ggf. 15–40 Min.) …"
( cd "$KASSA_DIR" && $DOCKER compose up -d --build ) || abbruch "docker compose up fehlgeschlagen — Ausgabe oben prüfen."
ok "Container laufen"

# ─────────────────────────────────────────────────────────────────────────────
# 5. Auf die Kassa warten (Gesundheitscheck)
# ─────────────────────────────────────────────────────────────────────────────
FRONTEND_PORT="$(env_port FRONTEND_PORT 80)"
schritt "Warte auf die Kassa (Gesundheitscheck)"
gesund=0; i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS "http://localhost:${FRONTEND_PORT}/api/health" >/dev/null 2>&1; then gesund=1; break; fi
  sleep 3; i=$((i + 1))
done
if [ "$gesund" = "1" ]; then
  ok "Kassa antwortet"
else
  hinweis "Kassa antwortet noch nicht — der erste Start kann dauern."
  hinweis "Status prüfen:  cd $KASSA_DIR && $DOCKER compose ps   bzw.   $DOCKER compose logs backend"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Geräte-URLs anzeigen
# ─────────────────────────────────────────────────────────────────────────────
if [ "$PLATTFORM" = "macos" ]; then
  lan_ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
else
  lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
[ -n "${lan_ip:-}" ] || lan_ip="<IP-dieses-Geräts>"

# Label|ENV-Variable|Default-Port  (keine assoziativen Arrays → bash 3.2/macOS-tauglich)
DIENSTE="Kassa (Haupt-App)|FRONTEND_PORT|80
KDS Küche/Schank|KDS_PORT|8080
Kundendisplay|KUNDENDISPLAY_PORT|8081
Gast-Bestellung|GAST_PORT|8082
Kellner-App|KELLNER_PORT|8083
SB-Terminal|TERMINAL_PORT|8084
Abholmonitor|ABHOLMONITOR_PORT|8085"

printf '\n%s═════════════════════════════════════════════%s\n' "$C_G" "$C_0"
printf   '%s  Kassa POS ist installiert!%s\n' "$C_G" "$C_0"
printf   '%s═════════════════════════════════════════════%s\n' "$C_G" "$C_0"
printf '\n%s Geräte-URLs (im selben Netzwerk):%s\n' "$C_C" "$C_0"
echo "$DIENSTE" | while IFS='|' read -r label var def; do
  [ -n "$label" ] || continue
  port="$(env_port "$var" "$def")"
  if [ "$port" = "80" ]; then suffix=""; else suffix=":$port"; fi
  printf '   %-20s http://%s%s\n' "${label}:" "$lan_ip" "$suffix"
done

hp="$(env_port FRONTEND_PORT 80)"
if [ "$hp" = "80" ]; then lokal="http://localhost"; else lokal="http://localhost:$hp"; fi
printf '\n%s Erste Schritte:%s\n' "$C_C" "$C_0"
printf '   1. Hier öffnen:  %s\n' "$lokal"
printf '   2. Setup-Assistent ausfüllen (Firma, Kasse, Admin) — RKSV-Testmodus wählen\n'
printf '   3. Bondrucker: Einstellungen → Hardware → IP des LAN-Druckers eintragen + Testdruck\n'
printf '\n%s Update später:%s dieses Skript erneut ausführen (Daten bleiben erhalten).\n' "$C_Y" "$C_0"
if [ "$PLATTFORM" = "macos" ]; then
  printf '%s Autostart:%s in Docker Desktop → Einstellungen → „Start Docker Desktop when you sign in" aktivieren;\n' "$C_Y" "$C_0"
  printf '            die Container starten dank restart-Policy dann automatisch mit.\n'
else
  printf '%s Autostart:%s eingerichtet — Docker-Dienst ist aktiviert, die Container kommen nach\n' "$C_Y" "$C_0"
  printf '            jedem Neustart automatisch hoch (restart: unless-stopped).\n'
fi
printf '\n'
