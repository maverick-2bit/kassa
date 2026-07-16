#!/bin/sh
#
# Kassa POS — Updater-Dienst (läuft als eigener Container mit Docker-Zugriff).
#
# Sicherheits-Modell: Dieser Dienst führt AUSSCHLIESSLICH den festen Rebuild aus.
# Er nimmt KEINE Befehle/Parameter vom Backend entgegen — das Backend kann nur eine
# leere „request"-Datei anlegen (Startsignal). Branch/Repo sind hier fest verdrahtet.
# Selbst ein kompromittiertes Backend könnte also nur „Rebuild vom offiziellen Repo"
# auslösen, keine beliebigen Container/Befehle.
#
# Ablauf: pollt $CONTROL/request; bei Vorhandensein → neuen Quellcode laden, ins
# gemountete Workspace (= Host-Install-Verzeichnis) spiegeln (.env bleibt) und
# `docker compose up -d --build` der APP-Services ausführen (NIE sich selbst).
# Fortschritt/Status landen in $CONTROL/status.json, das das Backend ausliest.
#
set -u

CONTROL="${UPDATE_CONTROL_DIR:-/control}"
WORKSPACE="${KASSA_WORKSPACE:-/workspace}"
BRANCH="${KASSA_BRANCH:-master}"
REPO="maverick-2bit/kassa"
TARURL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
# Alle App-Services — bewusst OHNE 'updater' (der Dienst darf sich nicht selbst neu
# bauen/neustarten, sonst reißt er sich mitten im Update weg) und ohne 'caddy' (Profil).
APP_SERVICES="postgres backend frontend kundendisplay kds gast kellner terminal abholmonitor backup"

mkdir -p "$CONTROL"

# Werkzeuge sicherstellen (Basis-Image docker:cli = Alpine)
ensure() { command -v "$1" >/dev/null 2>&1 || apk add --no-cache "$2" >/dev/null 2>&1 || true; }
ensure curl curl
ensure rsync rsync
docker compose version >/dev/null 2>&1 || apk add --no-cache docker-cli-compose >/dev/null 2>&1 || true

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# status <status> <schritt> [fehler-json] [version-json]
# Schreibt zusätzlich den Heartbeat (belegt: Updater lebt).
status() {
  st="$1"; schritt="$2"; fehler="${3:-null}"; version="${4:-null}"
  now > "$CONTROL/heartbeat"
  cat > "$CONTROL/status.json" <<EOF
{"status":"$st","schritt":"$schritt","fehler":$fehler,"version":$version,"zeit":"$(now)"}
EOF
}

[ -f "$CONTROL/status.json" ] || status idle "" null null

run_update() {
  status laeuft "Quellcode wird geladen" null null
  tmp="$(mktemp -d)"
  if ! curl -fsSL "$TARURL" 2>/dev/null | tar -xz -C "$tmp" 2>/dev/null; then
    status fehler "Download fehlgeschlagen" '"Download/Netzwerk fehlgeschlagen"' null
    rm -rf "$tmp"; return
  fi
  src="$tmp/kassa-${BRANCH}"
  if [ ! -d "$src" ]; then
    status fehler "Entpacken fehlgeschlagen" '"Archiv nicht lesbar"' null
    rm -rf "$tmp"; return
  fi

  # Quellcode ins Workspace spiegeln — .env bleibt erhalten (Secrets/DB unangetastet)
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude='/.env' "$src"/ "$WORKSPACE"/
  else
    ( cd "$src" && find . -mindepth 1 -maxdepth 1 ! -name .env -exec cp -R {} "$WORKSPACE"/ \; )
  fi
  rm -rf "$tmp"

  status laeuft "Container werden gebaut (das dauert ein paar Minuten)" null null
  # shellcheck disable=SC2086 — Wortauftrennung der Service-Liste ist gewollt
  if docker compose -p kassa --project-directory "$WORKSPACE" -f "$WORKSPACE/docker-compose.yml" \
       up -d --build $APP_SERVICES; then
    v="$(grep -m1 '"version"' "$WORKSPACE/package.json" 2>/dev/null | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
    [ -n "$v" ] && vjson="\"$v\"" || vjson=null
    status fertig "Update abgeschlossen" null "$vjson"
  else
    status fehler "Build fehlgeschlagen — Logs prüfen (docker compose logs)" '"docker compose up --build"' null
  fi
}

# Hauptschleife: Heartbeat schreiben + auf Update-Anforderung warten
while true; do
  now > "$CONTROL/heartbeat"
  if [ -f "$CONTROL/request" ]; then
    rm -f "$CONTROL/request"
    run_update
  fi
  sleep 5
done
