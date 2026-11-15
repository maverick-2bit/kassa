#!/bin/sh
#
# Kassa POS — Updater-Dienst (läuft als eigener Container mit Docker-Zugriff).
#
# SICHERHEITS-MODELL
#   Dieser Dienst führt AUSSCHLIESSLICH den festen Update-Ablauf aus. Er nimmt KEINE Befehle/Parameter
#   vom Backend entgegen — das Backend kann nur eine leere „request"-Datei anlegen (Startsignal).
#
#   Herkunft: Installiert wird nur ein Release, dessen Git-Tag (vX.Y.Z) mit einem der Schlüssel aus
#   ops/updater/allowed_signers signiert ist (SSH-Signatur, `git tag -s`). Maßgeblich ist die Datei des
#   bereits INSTALLIERTEN Stands, nie die des frisch geladenen — ein neuer Schlüssel gilt erst nach einem
#   Release, das noch mit einem alten Schlüssel signiert wurde. Wer GitHub kontrolliert (Konto, master,
#   Tags), den Signaturschlüssel aber nicht, kann hier nichts einschleusen. Ein Release, das ältere
#   Software bringt als die installierte, wird nie eingespielt (kein Wiedereinspielen alter Stände).
#
#   Rückweg: Vor jeder Änderung sichert der Dienst den Installationsordner (ohne .env) und merkt sich die
#   laufenden Images. Scheitert Build, Start oder Gesundheitscheck des Backends, stellt er beides wieder
#   her. Die Sicherung liegt im Dateisystem DIESES Containers — bewusst nicht im Volume /control, auf das
#   auch das Backend schreiben darf (sonst könnte ein kompromittiertes Backend dem Rückweg Code unterschieben).
#   Die Datenbank wird nicht zurückgerollt (Migrationen laufen nur vorwärts).
#
# Ablauf: pollt $CONTROL/request; bei Vorhandensein → neuestes gültig signiertes Release laden und prüfen,
# ins gemountete Workspace (= Host-Install-Verzeichnis) spiegeln (.env bleibt) und `docker compose up -d
# --build` der App-Dienste ausführen (nie sich selbst im selben Lauf — danach startet er sich neu, damit
# seine neue Fassung greift). Fortschritt/Status landen in $CONTROL/status.json, das das Backend ausliest.
#
# Aufbau: nur Funktionen + ein Hauptblock GANZ AM ENDE. Die Shell liest das Skript, während es läuft; die
# neue Fassung wird mitten im Lauf in den Workspace gespiegelt — der Hauptblock ist ein einziger Befehl
# und damit vor dem Start komplett gelesen. Die Tests laden nur die Funktionen (KASSA_UPDATER_NUR_FUNKTIONEN=1).
# Zeilen mit „# M:…" sind Anker der Mutationstests (ops/updater/test-updater.sh) — nicht umformulieren.
#
set -u

CONTROL="${UPDATE_CONTROL_DIR:-/control}"
WORKSPACE="${KASSA_WORKSPACE:-/workspace}"
# Die URL ist kein Vertrauensanker: Gültig ist nur, was mit einem Schlüssel aus allowed_signers signiert ist.
REPO_URL="${KASSA_REPO_URL:-https://github.com/maverick-2bit/kassa.git}"
# Vertrauensdatei = der INSTALLIERTE Stand (nie die frisch geladene Datei)
ALLOWED_SIGNERS="${KASSA_ALLOWED_SIGNERS:-$WORKSPACE/ops/updater/allowed_signers}"
RUECKWEG="${KASSA_RUECKWEG_DIR:-/var/lib/kassa-rueckweg}"
GESUNDHEIT_SEKUNDEN="${KASSA_GESUNDHEIT_SEKUNDEN:-300}"
GESUNDHEIT_TAKT="${KASSA_GESUNDHEIT_TAKT:-3}"
MAX_KANDIDATEN="${KASSA_MAX_KANDIDATEN:-20}"
# Rückfall-Liste, falls die Compose-Datei nicht auswertbar ist. Normalerweise kommt
# die Liste aus der NEUEN docker-compose.yml (app_dienste) — so starten neu
# hinzugekommene Apps (z. B. „tickets" ab v0.7.173) ohne Updater-Anpassung mit.
APP_SERVICES_RUECKFALL="postgres backend frontend kundendisplay kds gast kellner terminal abholmonitor tickets einlass backup"

# git: nie nach Zugangsdaten fragen, hängende Verbindungen nach 60 s ohne Datenfluss abbrechen
export GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=60

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s [updater] %s\n' "$(now)" "$*"; }

compose() {
  docker compose -p kassa --project-directory "$WORKSPACE" -f "$WORKSPACE/docker-compose.yml" "$@"
}

# Alle App-Dienste der Compose-Datei — bewusst OHNE 'updater' (der Dienst darf sich
# nicht mitten im Lauf neu bauen, sonst reißt er sich weg). Dienste hinter einem
# Profil (caddy) listet `config --services` ohnehin nicht.
app_dienste() {
  liste="$(compose config --services 2>/dev/null | grep -v '^updater$' | tr '\n' ' ')"
  if [ -n "$(echo "$liste" | tr -d ' ')" ]; then echo "$liste"; else echo "$APP_SERVICES_RUECKFALL"; fi
}

# JSON-Textinhalt: Steuerzeichen raus, \ und " maskieren
json_text() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# status <status> <schritt> [fehlertext] [version]
# Schreibt zusätzlich den Heartbeat (belegt: Updater lebt). Atomar (Datei + mv), damit das Backend nie eine halbe Datei liest.
status() {
  _st="$1"; _schritt="$(json_text "$2")"; _fehler="null"; _version="null"
  if [ -n "${3:-}" ]; then _fehler="\"$(json_text "$3")\""; fi
  if [ -n "${4:-}" ]; then _version="\"$(json_text "$4")\""; fi
  now > "$CONTROL/heartbeat"
  log "$_st: $2${3:+ — $3}"   # `docker compose logs updater` zeigt den Verlauf
  printf '{"status":"%s","schritt":"%s","fehler":%s,"version":%s,"zeit":"%s"}\n' \
    "$_st" "$_schritt" "$_fehler" "$_version" "$(now)" > "$CONTROL/.status.neu" \
    && mv -f "$CONTROL/.status.neu" "$CONTROL/status.json"
}

# rm -rf nur auf klar benannte Pfade (nie leer, nie Wurzel, nie mit ..)
loesche() {
  for _p in "$@"; do
    case "$_p" in
      ''|/|.|..|*/..|*/../*) log "Löschen verweigert: '$_p'"; return 1 ;;
    esac
    rm -rf "$_p"
  done
  return 0
}

# ── Versionen ────────────────────────────────────────────────────────────────

version_gueltig() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }

# version_vergleich A B → -1 (A älter), 0 (gleich), 1 (A neuer); beide im Format X.Y.Z
version_vergleich() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) {
      if (x[i] + 0 < y[i] + 0) { print -1; exit }
      if (x[i] + 0 > y[i] + 0) { print 1; exit }
    }
    print 0
  }'
}

# "version" aus einer package.json (erste Fundstelle) — leer, wenn es die Datei nicht gibt
lies_version() {
  [ -f "$1" ] || return 0
  grep -m1 '"version"' "$1" 2>/dev/null | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

# ── Herkunft: Release finden, laden, prüfen ───────────────────────────────────

# Release-Tags aus der Ausgabe von `git ls-remote` (Datei), neueste zuerst. Nur das Format vX.Y.Z zählt;
# verglichen wird zahlenweise (v0.8.100 ist neuer als v0.8.99).
liste_release_tags() {
  awk '{ print $2 }' "$1" | sed 's|^refs/tags/||' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | awk -F'[v.]' '{ printf "%09d%09d%09d %s\n", $2, $3, $4, $0 }' | sort -r | awk '{ print $2 }'
}

# pruefe_kandidat <tag> <arbeitsordner>
# 0 = das Tag ist gültig, der Quellcode liegt dann in <arbeitsordner>/quelle. Sonst 1; der Grund steht in ABLEHNUNG.
pruefe_kandidat() {
  _tag="$1"; _ao="$2"; ABLEHNUNG=""
  loesche "$_ao/repo" "$_ao/quelle" "$_ao/quelle.tar" || { ABLEHNUNG="Arbeitsordner nicht benutzbar"; return 1; }
  mkdir -p "$_ao/repo" "$_ao/quelle" && git -C "$_ao/repo" init -q 2>/dev/null \
    || { ABLEHNUNG="Arbeitsordner nicht benutzbar"; return 1; }
  if ! git -C "$_ao/repo" fetch -q --depth 1 --no-tags "$REPO_URL" "+refs/tags/$_tag:refs/tags/$_tag" 2>"$_ao/git.err"; then
    log "git fetch $_tag: $(head -n 1 "$_ao/git.err" 2>/dev/null)"
    ABLEHNUNG="$_tag konnte nicht geladen werden"; return 1
  fi

  # 1. Signatur mit einem Schlüssel aus der INSTALLIERTEN allowed_signers
  if ! git -C "$_ao/repo" -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$ALLOWED_SIGNERS" verify-tag "$_tag" >/dev/null 2>&1; then # M:signatur
    ABLEHNUNG="$_tag ist nicht gültig signiert"; return 1
  fi

  # 2. Das Tag-Objekt muss selbst "$_tag" heißen und auf ein Commit zeigen. Sonst ließe sich ein altes, gültig
  #    signiertes Tag unter einem neuen Namen (v9.9.9) auf GitHub veröffentlichen.
  _tagobj="$(git -C "$_ao/repo" cat-file tag "refs/tags/$_tag" 2>/dev/null)"
  _innen="$(printf '%s\n' "$_tagobj" | sed -n 's/^tag //p' | head -n 1)"
  _typ="$(printf '%s\n' "$_tagobj" | sed -n 's/^type //p' | head -n 1)"
  if [ "$_innen" != "$_tag" ] || [ "$_typ" != "commit" ]; then # M:tagname
    ABLEHNUNG="$_tag ist ein umbenanntes oder fremdes Tag"; return 1
  fi

  # 3. Quellcode des signierten Commits (aus demselben Repo, das geprüft wurde — kein zweiter Download)
  if ! git -C "$_ao/repo" archive --format=tar -o "$_ao/quelle.tar" "refs/tags/$_tag^{commit}" 2>/dev/null \
     || ! tar -x -f - -C "$_ao/quelle" < "$_ao/quelle.tar" 2>/dev/null; then
    ABLEHNUNG="$_tag: Quellcode nicht entpackbar"; return 1
  fi

  # 4. Version im Quellcode == Tag (verhindert ein „v1.2.0" mit 1.1.0 darin)
  _v="$(lies_version "$_ao/quelle/package.json")"
  if [ "$_v" != "${_tag#v}" ]; then # M:version
    ABLEHNUNG="$_tag: package.json meldet Version ${_v:-?}"; return 1
  fi

  # 5. Das Release muss den Update-Weg selbst enthalten und darf seinen eigenen Signierer nicht aussperren
  #    (sonst wäre jedes Folge-Update auf dieser Kasse tot).
  if [ ! -f "$_ao/quelle/docker-compose.yml" ] || [ ! -f "$_ao/quelle/ops/updater/updater.sh" ] \
     || [ ! -f "$_ao/quelle/ops/updater/allowed_signers" ]; then
    ABLEHNUNG="$_tag ist unvollständig (docker-compose.yml, Updater oder allowed_signers fehlt)"; return 1
  fi
  if ! git -C "$_ao/repo" -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$_ao/quelle/ops/updater/allowed_signers" verify-tag "$_tag" >/dev/null 2>&1; then # M:aussperren
    ABLEHNUNG="$_tag würde den Update-Dienst aussperren (der Signierer fehlt in der neuen allowed_signers)"; return 1
  fi
  return 0
}

# hole_release <arbeitsordner> <installierte Version>
# Geht die Release-Tags von neu nach alt durch (höchstens MAX_KANDIDATEN, nie ältere als die installierte Version)
# und nimmt das erste gültige. 0 = gefunden: ZIEL_TAG, ZIEL_VERSION, QUELLE, ABGELEHNT. 1 = nichts: HOL_FEHLER.
hole_release() {
  _ao="$1"; _inst="$2"; ZIEL_TAG=""; ZIEL_VERSION=""; QUELLE=""; ABGELEHNT=""; HOL_FEHLER=""
  if ! git ls-remote --tags --refs "$REPO_URL" 'refs/tags/v*' > "$_ao/refs.txt" 2>"$_ao/git.err"; then
    HOL_FEHLER="Die Release-Liste auf GitHub ist nicht erreichbar (Internetverbindung prüfen)"; return 1
  fi
  _tags="$(liste_release_tags "$_ao/refs.txt")"
  if [ -z "$_tags" ]; then HOL_FEHLER="Auf GitHub gibt es kein Release (Tag vX.Y.Z)"; return 1; fi
  _n=0
  for _t in $_tags; do
    if [ "$(version_vergleich "${_t#v}" "$_inst")" -lt 0 ]; then break; fi # M:aelter
    _n=$((_n + 1))
    if [ "$_n" -gt "$MAX_KANDIDATEN" ]; then break; fi
    if pruefe_kandidat "$_t" "$_ao"; then
      ZIEL_TAG="$_t"; ZIEL_VERSION="${_t#v}"; QUELLE="$_ao/quelle"
      return 0
    fi
    log "Release $_t abgelehnt: $ABLEHNUNG"
    ABGELEHNT="${ABGELEHNT:+$ABGELEHNT; }$ABLEHNUNG"
  done
  if [ -n "$ABGELEHNT" ]; then
    HOL_FEHLER="Kein gültig signiertes Release gefunden — $ABGELEHNT"
  else
    HOL_FEHLER="Kein Release gefunden, das so neu ist wie die installierte Version v$_inst"
  fi
  return 1
}

# ── Rückweg ──────────────────────────────────────────────────────────────────

# Installationsordner spiegeln; .env bleibt unangetastet (Secrets/DB)
spiegeln() { rsync -a --delete --exclude='/.env' "$1"/ "$2"/; } # M:env

# sichere_vorher <version> <dienste>: Code (ohne .env) und die laufenden Images (je Dienst: Name + ID) festhalten
sichere_vorher() {
  loesche "$RUECKWEG" || return 1
  mkdir -p "$RUECKWEG/quelle" || return 1
  rsync -a --exclude='/.env' "$WORKSPACE"/ "$RUECKWEG/quelle"/ || return 1 # M:sicherung
  printf '%s\n' "$1" > "$RUECKWEG/version" || return 1
  : > "$RUECKWEG/images.txt" || return 1
  for _dienst in $2; do
    _cid="$(compose ps -q "$_dienst" 2>/dev/null | head -n 1)"
    [ -n "$_cid" ] || continue
    _info="$(docker inspect --format '{{.Config.Image}}|{{.Image}}' "$_cid" 2>/dev/null)"
    _bild="${_info%%|*}"; _bildid="${_info##*|}"
    case "$_bildid" in sha256:*) ;; *) continue ;; esac
    case "$_bild" in ''|sha256:*) continue ;; esac
    # Eigener Tag, damit ein „docker image prune" das alte Image nicht wegräumt, bevor der Rückweg es braucht
    docker tag "$_bildid" "kassa-rueckweg/$_dienst:vorher" >/dev/null 2>&1 || return 1
    printf '%s|%s|%s\n' "$_dienst" "$_bild" "$_bildid" >> "$RUECKWEG/images.txt"
  done
  return 0
}

# Sicherung wegräumen (nach Erfolg): eigene Tags weg, damit die alten Images nicht ewig Platz belegen
rueckweg_aufraeumen() {
  if [ -f "$RUECKWEG/images.txt" ]; then
    while IFS='|' read -r _dienst _bild _bildid; do
      [ -n "$_dienst" ] || continue
      docker rmi "kassa-rueckweg/$_dienst:vorher" >/dev/null 2>&1 || true
    done < "$RUECKWEG/images.txt"
  fi
  loesche "$RUECKWEG"
}

# warte_auf_backend <erwartete Version>
# 0 = Backend gesund und meldet die Version; 2 = gesund, aber eine andere Version (GELADEN); 1 = nicht gesund/erreichbar.
# Ein langsamer Start (Migrationen!) wird abgewartet, nie vorzeitig abgebrochen.
warte_auf_backend() {
  _erwartet="$1"; GELADEN=""
  _ende=$(( $(date +%s) + GESUNDHEIT_SEKUNDEN ))
  while :; do
    now > "$CONTROL/heartbeat"
    _cid="$(compose ps -q backend 2>/dev/null | head -n 1)"
    if [ -n "$_cid" ]; then
      _gesund="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}ohne{{end}}' "$_cid" 2>/dev/null)"
      if [ "$_gesund" = "healthy" ] || [ "$_gesund" = "ohne" ]; then # M:gesund
        _v="$(compose exec -T backend node -p "require('/app/package.json').version" 2>/dev/null | tr -d '\r\n')"
        if [ -n "$_v" ]; then
          GELADEN="$_v"
          if [ "$_v" = "$_erwartet" ]; then return 0; fi
          return 2
        fi
      fi
    fi
    if [ "$(date +%s)" -ge "$_ende" ]; then break; fi
    sleep "$GESUNDHEIT_TAKT"
  done
  return 1
}

# rueckweg_ausfuehren <grund> <zielversion>: Code und Images auf den gesicherten Stand zurück, dann prüfen.
# Setzt in JEDEM Fall den Status (fehler) und löscht die Unterbrechungs-Marke (kein Endlos-Rückweg beim Neustart).
rueckweg_ausfuehren() {
  _grund="$1"; _ziel="$2"
  _vorher="$(cat "$RUECKWEG/version" 2>/dev/null)"
  rm -f "$RUECKWEG/offen" # M:marke-weg
  if [ -z "$_vorher" ] || [ ! -d "$RUECKWEG/quelle" ]; then
    status fehler "Update auf v$_ziel fehlgeschlagen — und keine Sicherung für den Rückweg vorhanden. Kassa-Setup erneut ausführen." "$_grund"
    return 1
  fi
  log "Rückweg auf v$_vorher: $_grund"
  status laeuft "Update fehlgeschlagen — der vorherige Stand v$_vorher wird wiederhergestellt" "" ""
  if ! spiegeln "$RUECKWEG/quelle" "$WORKSPACE"; then # M:rueckweg-code
    status fehler "Update auf v$_ziel fehlgeschlagen — der Rückweg konnte den Code nicht wiederherstellen (Sicherung: $RUECKWEG/quelle)" "$_grund"
    return 1
  fi
  if [ -f "$RUECKWEG/images.txt" ]; then
    while IFS='|' read -r _dienst _bild _bildid; do
      [ -n "$_bildid" ] || continue
      docker tag "$_bildid" "$_bild" >/dev/null 2>&1 || log "Image $_bild konnte nicht zurückgesetzt werden" # M:rueckweg-images
    done < "$RUECKWEG/images.txt"
  fi
  _dienste="$(app_dienste)"
  # shellcheck disable=SC2086 — Wortauftrennung der Service-Liste ist gewollt
  if ! compose up -d --no-build $_dienste; then
    log "Rückweg ohne Neubau scheiterte — versuche mit Neubau"
    # shellcheck disable=SC2086
    if ! compose up -d --build $_dienste; then
      status fehler "Update auf v$_ziel fehlgeschlagen — der Rückweg konnte die Dienste nicht starten (docker compose logs prüfen)" "$_grund"
      return 1
    fi
  fi
  status laeuft "Der vorherige Stand wird gestartet" "" ""
  warte_auf_backend "$_vorher"; _rc=$?
  if [ "$_rc" -eq 0 ]; then
    status fehler "Update auf v$_ziel fehlgeschlagen — automatisch auf v$_vorher zurückgesetzt" "$_grund" "$_vorher"
    rueckweg_aufraeumen
    return 0
  fi
  status fehler "Update auf v$_ziel fehlgeschlagen — nach dem Rückweg meldet sich das Backend nicht gesund (docker compose logs backend prüfen)" "$_grund"
  return 1
}

# ── Update ───────────────────────────────────────────────────────────────────

run_update() {
  status laeuft "Update wird vorbereitet" "" ""
  for _werkzeug in git ssh-keygen rsync; do
    if ! command -v "$_werkzeug" >/dev/null 2>&1; then
      status fehler "Update abgebrochen: $_werkzeug fehlt im Update-Dienst" "Werkzeug $_werkzeug nicht installierbar (Internetverbindung des Update-Dienstes prüfen, Kassa-Setup erneut ausführen)"
      return
    fi
  done
  if [ ! -f "$ALLOWED_SIGNERS" ]; then
    status fehler "Update abgebrochen: die Vertrauensdatei ops/updater/allowed_signers fehlt" "Kassa-Setup einmal erneut ausführen (siehe ops/DEPLOYMENT.md, Abschnitt 11)"
    return
  fi
  _installiert="$(lies_version "$WORKSPACE/package.json")"
  if ! version_gueltig "$_installiert"; then _installiert="0.0.0"; fi

  _tmp="$(mktemp -d)" || { status fehler "Update abgebrochen: kein Arbeitsordner" "mktemp"; return; }
  status laeuft "Das neueste Release wird geladen und seine Signatur geprüft" "" ""
  if ! hole_release "$_tmp" "$_installiert"; then
    status fehler "Update abgelehnt: $HOL_FEHLER" "$HOL_FEHLER"
    loesche "$_tmp"; return
  fi
  # Gültiges Release ist nur die installierte Version, ein NEUERES wurde aber abgelehnt → nichts Neues einspielen, laut melden
  if [ "$ZIEL_VERSION" = "$_installiert" ] && [ -n "$ABGELEHNT" ]; then
    status fehler "Update abgelehnt: $ABGELEHNT — es bleibt bei v$_installiert" "$ABGELEHNT"
    loesche "$_tmp"; return
  fi
  log "Ziel: $ZIEL_TAG (installiert: v$_installiert)"

  _dienste_vorher="$(app_dienste)"
  status laeuft "Der aktuelle Stand wird für den Rückweg gesichert" "" ""
  if ! sichere_vorher "$_installiert" "$_dienste_vorher"; then
    status fehler "Update abgebrochen: der aktuelle Stand konnte nicht gesichert werden (es wurde nichts verändert)" "Rückweg-Sicherung fehlgeschlagen ($RUECKWEG)"
    loesche "$_tmp"; return
  fi
  # Marke „Update läuft": überlebt einen Neustart des Containers (Stromausfall mitten im Update → wiederaufnehmen)
  printf '%s\n' "$ZIEL_VERSION" > "$RUECKWEG/offen" # M:marke

  status laeuft "Der neue Stand wird installiert" "" ""
  if ! spiegeln "$QUELLE" "$WORKSPACE"; then
    loesche "$_tmp"
    rueckweg_ausfuehren "Der neue Code konnte nicht in den Installationsordner kopiert werden" "$ZIEL_VERSION"
    return
  fi
  loesche "$_tmp"

  status laeuft "Container werden gebaut (das dauert ein paar Minuten)" "" ""
  _dienste="$(app_dienste)"
  # shellcheck disable=SC2086 — Wortauftrennung der Service-Liste ist gewollt
  if ! compose up -d --build $_dienste; then
    rueckweg_ausfuehren "docker compose up --build ist fehlgeschlagen" "$ZIEL_VERSION"
    return
  fi

  # Nicht die Quell-Version als Erfolg melden, sondern die, die danach WIRKLICH läuft. Sonst meldet die
  # Kassa „fertig — v0.7.139", obwohl der Container gar nicht ersetzt wurde, und der Benutzer lädt endlos
  # neu ohne Wirkung.
  status laeuft "Neustart wird abgewartet" "" ""
  warte_auf_backend "$ZIEL_VERSION"; _rc=$? # M:warten
  if [ "$_rc" -eq 0 ]; then
    status fertig "Update abgeschlossen" "" "$GELADEN"
    rueckweg_aufraeumen
  elif [ "$_rc" -eq 2 ]; then
    rueckweg_ausfuehren "Der neue Stand wurde nicht übernommen (das Backend läuft weiter auf v$GELADEN)" "$ZIEL_VERSION"
  else
    rueckweg_ausfuehren "Das Backend meldet sich nach dem Neustart nicht gesund" "$ZIEL_VERSION"
  fi
}

# Nach einem Neustart des Containers: ein unterbrochenes Update (Stromausfall, Docker-Neustart mitten im Lauf)
# beenden — ist das Backend mit der Zielversion gesund, gilt es als fertig, sonst geht es zurück.
wiederaufnehmen() {
  [ -f "$RUECKWEG/offen" ] || return 0
  _ziel="$(cat "$RUECKWEG/offen" 2>/dev/null)"
  log "Unterbrochenes Update (Ziel v$_ziel) gefunden — der Stand wird geprüft"
  status laeuft "Ein unterbrochenes Update wird geprüft" "" ""
  warte_auf_backend "$_ziel"; _rc=$?
  if [ "$_rc" -eq 0 ]; then
    status fertig "Update abgeschlossen (nach einer Unterbrechung geprüft)" "" "$GELADEN"
    rueckweg_aufraeumen
  else
    rueckweg_ausfuehren "Das Update wurde unterbrochen" "$_ziel"
  fi
}

# ── Start ────────────────────────────────────────────────────────────────────

# Werkzeuge sicherstellen (Basis-Image docker:cli = Alpine, bringt git + ssh-keygen meist schon mit)
ensure() { command -v "$1" >/dev/null 2>&1 || apk add --no-cache "$2" >/dev/null 2>&1 || true; }

initialisiere() {
  mkdir -p "$CONTROL"
  # Das Backend (USER node, UID 1000) muss hier die request-Datei anlegen können.
  # Der Mountpoint eines frischen Named Volumes gehört sonst root → EACCES beim
  # „Jetzt aktualisieren". Der Updater läuft als root und heilt die Rechte bei
  # jedem Start — auch für bestehende Installationen.
  chown 1000:1000 "$CONTROL" 2>/dev/null || true
  chmod 775 "$CONTROL" 2>/dev/null || true
  ensure git git
  ensure ssh-keygen openssh-keygen
  ensure rsync rsync
  docker compose version >/dev/null 2>&1 || apk add --no-cache docker-cli-compose >/dev/null 2>&1 || true
  [ -f "$CONTROL/status.json" ] || status idle "" "" ""
  wiederaufnehmen
}

# Hauptblock: Heartbeat schreiben + auf Update-Anforderung warten
haupt() {
  initialisiere
  while true; do
    now > "$CONTROL/heartbeat"
    if [ -f "$CONTROL/request" ]; then
      rm -f "$CONTROL/request"
      run_update
      rm -f "$CONTROL/request"   # eine während des Laufs angeklickte Anforderung nicht nach dem Neustart noch einmal abarbeiten # M:request-weg
      # Nach jedem Lauf beenden: ein laufender sh hält dieses Skript im Speicher,
      # die eben geladene NEUE Fassung griffe sonst erst nach einem PC-Neustart.
      # Die restart-Policy (unless-stopped) startet den Container sofort neu und
      # bindet die Datei dabei frisch ein. Bewusst KEIN „docker restart" auf sich
      # selbst — bräche der Aufruf nach dem Stopp ab, bliebe der Updater gestoppt.
      exit 0
    fi
    sleep 5
  done
}

if [ -z "${KASSA_UPDATER_NUR_FUNKTIONEN:-}" ]; then haupt; fi
