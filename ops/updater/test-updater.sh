#!/bin/sh
#
# Kassa POS — Tests für den Updater (ops/updater/updater.sh): Herkunftsprüfung und Rückweg.
#
# Läuft OHNE Docker und ohne Netz. Echt geprüft werden: git, ssh-keygen (echte SSH-Signaturen), das Dateisystem
# und das Skript selbst. Ersetzt durch Attrappen: docker (mit Zustand: Images, Container, Gesundheit) und rsync
# (Attrappe mit Fehler-Einspritzung; ein Test ruft zusätzlich das ECHTE rsync auf, wenn es installiert ist).
# „GitHub" ist ein lokales Git-Repo (file://). Der Updater wird in einer frischen Shell geladen
# (KASSA_UPDATER_NUR_FUNKTIONEN=1) und seine Funktionen werden direkt aufgerufen.
#
# Aufruf:
#   sh ops/updater/test-updater.sh                 alle Szenarien (Exit-Code 0 = alles bestanden)
#   sh ops/updater/test-updater.sh mutationen      Gegenprobe: Der Updater wird gezielt kaputtgemacht (Mutationen);
#                                                  jede Mutation MUSS mindestens ein Szenario röten
#   TEST_SH=dash sh ...                            Updater unter einer bestimmten Shell laufen lassen (CI: Standard-sh = dash)
#   TEST_NUR="gluecklich unhealthy" sh ...         nur diese Szenarien
#   UPDATER_SKRIPT=<Datei> sh ...                  anderes Skript prüfen (so arbeitet die Mutationsprobe)
#
set -u
export LC_ALL=C

HIER="$(cd "$(dirname "$0")" && pwd)"
UPDATER="${UPDATER_SKRIPT:-$HIER/updater.sh}"
PRUEFE_RELEASE="${PRUEFE_SKRIPT:-$HIER/../release/pruefe-release.sh}"
SH="${TEST_SH:-sh}"
TEST_NUR="${TEST_NUR:-}"
ECHTES_RSYNC="$(command -v rsync 2>/dev/null || true)"

# Pfad in der Form, die auch native Windows-Programme (git, ssh-keygen unter Git for Windows) verstehen
pfad_nativ() { ( cd "$1" && { pwd -W 2>/dev/null || pwd; } ); }
datei_url() {
  case "$1" in
    /*) printf 'file://%s' "$1" ;;
    *)  printf 'file:///%s' "$1" ;;
  esac
}

ANZAHL=0; FEHL=0
pruefe() { # $1 = Beschreibung, Rest = Befehl (Exit 0 = bestanden)
  _text="$1"; shift
  ANZAHL=$((ANZAHL + 1))
  if "$@"; then printf '  [ok]   %s\n' "$_text"
  else printf '  [FAIL] %s\n' "$_text"; FEHL=$((FEHL + 1)); fi
}
gruppe() { printf '\n%s\n' "$1"; }

# ── Arbeitsumgebung ───────────────────────────────────────────────────────────
T="$(pfad_nativ "$(mktemp -d)")"
aufraeumen() { if [ -n "${TEST_BEHALTEN:-}" ]; then echo "Arbeitsordner bleibt: $T"; return; fi; if [ -n "${T:-}" ] && [ -d "$T" ]; then rm -rf "$T"; fi; }
trap aufraeumen EXIT
BIN="$T/bin"; mkdir -p "$BIN" "$T/schl"
# In PATH darf kein „C:/…" stehen (der Doppelpunkt trennt dort) — unter Windows die POSIX-Schreibweise nehmen
BIN_PFAD="$(cygpath -u "$BIN" 2>/dev/null || printf '%s' "$BIN")"

# Schlüssel: „arbeit" = der Signaturschlüssel dieses Tests (steht in der installierten allowed_signers),
# „fremd" = ein Fremder, „neu" = ein Schlüssel, der erst mit einem Release dazukommt
for k in arbeit fremd neu; do
  ssh-keygen -q -t ed25519 -N "" -C "test-$k" -f "$T/schl/$k" >/dev/null 2>&1 || { echo "ssh-keygen fehlt oder scheitert"; exit 2; }
done
signers_datei() { # <Ziel> <Schlüsselname>...
  _z="$1"; shift; : > "$_z"
  for _k in "$@"; do printf 'kassa-test namespaces="git" %s\n' "$(cut -d' ' -f1,2 "$T/schl/$_k.pub")" >> "$_z"; done
}
signers_datei "$T/signers-arbeit" arbeit
signers_datei "$T/signers-fremd" fremd
signers_datei "$T/signers-arbeit-neu" arbeit neu

# ── Attrappen ─────────────────────────────────────────────────────────────────
# rsync: nur die Aufrufform des Updaters (-a [--delete] [--exclude=/.env] QUELLE/ ZIEL/). Mit RSYNC_FEHLER_AUFRUF=<n>
# bricht der n-te Aufruf NACH dem Löschen ab (halb kopierter Zustand).
cat > "$BIN/rsync" <<'EOF'
#!/bin/sh
n=0; [ -f "$RSYNC_ZAEHLER" ] && n="$(cat "$RSYNC_ZAEHLER")"; n=$((n + 1)); echo "$n" > "$RSYNC_ZAEHLER"
loesch=0; ohne_env=0
while [ $# -gt 2 ]; do
  case "$1" in --delete) loesch=1 ;; --exclude=/.env) ohne_env=1 ;; esac
  shift
done
von="$1"; nach="$2"
mkdir -p "$nach" || exit 11
if [ "$loesch" = 1 ]; then
  if [ "$ohne_env" = 1 ]; then ( cd "$nach" && find . -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} + ) || exit 12
  else ( cd "$nach" && find . -mindepth 1 -maxdepth 1 -exec rm -rf {} + ) || exit 12; fi
fi
if [ -n "${RSYNC_FEHLER_AUFRUF:-}" ] && [ "$n" = "$RSYNC_FEHLER_AUFRUF" ]; then exit 23; fi
if [ "$ohne_env" = 1 ]; then ( cd "$von" && find . -mindepth 1 -maxdepth 1 ! -name .env -exec cp -R {} "$nach" \; ) || exit 13
else ( cd "$von" && find . -mindepth 1 -maxdepth 1 -exec cp -R {} "$nach" \; ) || exit 13; fi
exit 0
EOF

# docker: Zustand in $DOCKER_ZUSTAND. Images heißen sha256:img-<Version>; „kassa-<dienst>" ist der Name, den compose benutzt.
cat > "$BIN/docker" <<'EOF'
#!/bin/sh
Z="$DOCKER_ZUSTAND"
echo "docker $*" >> "$Z/log"
enc() { printf '%s' "$1" | sed -e 's#:latest$##' -e 's#[/:]#_#g'; }
ws_version() { grep -m1 '"version"' "$1/package.json" 2>/dev/null | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/'; }
if [ "${1:-}" = "compose" ]; then
  shift; WSD=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -p|-f) shift 2 ;;
      --project-directory) WSD="$2"; shift 2 ;;
      *) break ;;
    esac
  done
  cmd="${1:-}"; [ $# -gt 0 ] && shift
  case "$cmd" in
    version) echo "Docker Compose version attrappe"; exit 0 ;;
    config) printf 'postgres\nbackend\nfrontend\nupdater\n'; exit 0 ;;
    ps) if [ "${1:-}" = "-q" ] && [ -f "$Z/cont/${2:-}" ]; then echo "cid-$2"; fi; exit 0 ;;
    exec)
      [ -f "$Z/cont/backend" ] || exit 1
      id="$(cat "$Z/cont/backend")"; printf '%s\r\n' "${id#sha256:img-}"; exit 0 ;;
    up)
      modus=standard; dienste=""
      for a in "$@"; do case "$a" in -d) ;; --build) modus=build ;; --no-build) modus=nobuild ;; *) dienste="$dienste $a" ;; esac; done
      echo "up-$modus" >> "$Z/ups"
      # Ist zum Zeitpunkt des Bauens die Unterbrechungs-Marke gesetzt? (Stromausfall mitten im Bauen → Wiederaufnahme)
      if [ "$modus" = build ] && [ -n "${KASSA_TEST_MARKE:-}" ] && [ -f "$KASSA_TEST_MARKE" ]; then echo "marke-da-beim-bauen" >> "$Z/ups"; fi
      if [ "$modus" = build ]; then
        [ -f "$Z/fail_build" ] && exit 1
        if [ ! -f "$Z/kein_austausch" ]; then
          v="$(ws_version "$WSD")"
          for d in $dienste; do case "$d" in postgres) ;; *) printf 'sha256:img-%s\n' "$v" > "$Z/tag/$(enc "kassa-$d")" ;; esac; done
        fi
      fi
      if [ "$modus" = nobuild ]; then
        [ -f "$Z/fail_nobuild" ] && exit 1
        for d in $dienste; do case "$d" in postgres) ;; *) [ -f "$Z/tag/$(enc "kassa-$d")" ] || exit 1 ;; esac; done
      fi
      for d in $dienste; do
        case "$d" in postgres) continue ;; esac
        want="$(cat "$Z/tag/$(enc "kassa-$d")" 2>/dev/null)"
        have="$(cat "$Z/cont/$d" 2>/dev/null)"
        if [ -n "$want" ] && [ "$want" != "$have" ]; then printf '%s\n' "$want" > "$Z/cont/$d"; echo "neu-erstellt $d" >> "$Z/ups"; fi
      done
      exit 0 ;;
  esac
  exit 0
fi
case "${1:-}" in
  inspect)  # inspect --format <F> <cid>
    d="${4#cid-}"; id="$(cat "$Z/cont/$d" 2>/dev/null)"; [ -n "$id" ] || exit 1
    case "$3" in
      *Health*) v="${id#sha256:img-}"; if [ -f "$Z/unhealthy_$v" ]; then echo unhealthy; else echo healthy; fi ;;
      *Config.Image*) case "$d" in postgres) printf 'postgres:17-alpine|%s\n' "$id" ;; *) printf 'kassa-%s|%s\n' "$d" "$id" ;; esac ;;
    esac
    exit 0 ;;
  tag)
    [ -f "$Z/fail_tag" ] && exit 1
    case "$2" in sha256:*) id="$2" ;; *) id="$(cat "$Z/tag/$(enc "$2")" 2>/dev/null)" ;; esac
    [ -n "$id" ] || exit 1
    printf '%s\n' "$id" > "$Z/tag/$(enc "$3")"; exit 0 ;;
  rmi) rm -f "$Z/tag/$(enc "$2")"; exit 0 ;;
esac
exit 0
EOF
chmod +x "$BIN/rsync" "$BIN/docker"

# ── Szenario-Bausteine ────────────────────────────────────────────────────────
git_r() { git -C "$REMOTE" "$@"; }

inhalt() { # <Version> <signers-Datei> <alt|neu>
  printf '{ "name": "kassa", "version": "%s" }\n' "$1" > "$REMOTE/package.json"
  printf 'services: {}\n' > "$REMOTE/docker-compose.yml"
  mkdir -p "$REMOTE/ops/updater"
  printf '# Updater %s\n' "$1" > "$REMOTE/ops/updater/updater.sh"
  cp "$2" "$REMOTE/ops/updater/allowed_signers"
  printf 'Stand %s\n' "$1" > "$REMOTE/datei-a.txt"
  case "$3" in
    alt) printf 'verschwindet mit 1.1.0\n' > "$REMOTE/weg.txt" ;;
    neu) rm -f "$REMOTE/weg.txt"; printf 'neu in 1.1.0\n' > "$REMOTE/datei-b.txt" ;;
  esac
}
commit_version() { # <Version> <signers-Datei> [alt|neu]
  inhalt "$1" "$2" "${3:-neu}"
  git_r add -A >/dev/null 2>&1; git_r commit -q -m "Version $1"
}
tag_signiert() { # <Tag> <Schlüssel>
  git_r -c gpg.format=ssh -c "user.signingkey=$T/schl/$2" tag -s -m "Release $1" "$1" >/dev/null 2>&1
}

# Das Basis-„GitHub" (Versionen 1.0.0 und 1.1.0, beide gültig signiert) wird einmal gebaut und je Szenario kopiert
BASIS=""
basis_bauen() {
  BASIS="$T/basis-remote"; REMOTE="$BASIS"
  mkdir -p "$REMOTE"
  git -C "$REMOTE" init -q >/dev/null 2>&1
  git_r config user.name Test; git_r config user.email test@example.invalid
  git_r config commit.gpgsign false; git_r config tag.gpgsign false; git_r config core.autocrlf false
  commit_version 1.0.0 "$T/signers-arbeit" alt
  git_r branch -M master >/dev/null 2>&1
  tag_signiert v1.0.0 arbeit
  commit_version 1.1.0 "$T/signers-arbeit" neu
  tag_signiert v1.1.0 arbeit
}

baum_hash() { ( cd "$1" && find . -type f ! -name .env | sort | xargs cksum | cksum ); }

docker_zustand_setzen() { # <Version der laufenden Container>
  rm -rf "$DS"; mkdir -p "$DS/cont" "$DS/tag"
  printf 'sha256:img-pg\n' > "$DS/cont/postgres"
  for d in backend frontend; do
    printf 'sha256:img-%s\n' "$1" > "$DS/cont/$d"
    printf 'sha256:img-%s\n' "$1" > "$DS/tag/kassa-$d"
  done
  : > "$DS/log"; : > "$DS/ups"
}

neues_szenario() { # <Name>
  if [ -z "$BASIS" ]; then basis_bauen; fi
  SZ="$1"; S="$T/sz-$1"
  mkdir -p "$S/control" "$S/ws"
  REMOTE="$S/remote"; WS="$S/ws"; CTRL="$S/control"; RW="$S/rueckweg"; DS="$S/docker"
  URL="$(datei_url "$REMOTE")"
  RSYNC_FEHLER_AUFRUF=""; GESUNDHEIT=2
  cp -R "$BASIS" "$REMOTE"
  git_r archive v1.0.0 | tar -x -C "$WS"          # installierter Stand: 1.0.0
  printf 'GEHEIMNIS=nicht-anfassen\n' > "$WS/.env"
  docker_zustand_setzen 1.0.0
  VORHER_HASH="$(baum_hash "$WS")"
}
installiert_ist() { # <Version>: Workspace + Docker auf diese Version setzen
  rm -rf "$WS"; mkdir -p "$WS"
  git_r archive "v$1" | tar -x -C "$WS"
  printf 'GEHEIMNIS=nicht-anfassen\n' > "$WS/.env"
  docker_zustand_setzen "$1"
  VORHER_HASH="$(baum_hash "$WS")"
}

# Eine Funktion des Updaters in frischer Shell ausführen; Ausgabe landet in $S/ausgabe.txt
upd() {
  env KASSA_UPDATER_NUR_FUNKTIONEN=1 UPDATE_CONTROL_DIR="$CTRL" KASSA_WORKSPACE="$WS" KASSA_REPO_URL="$URL" \
      KASSA_RUECKWEG_DIR="$RW" KASSA_GESUNDHEIT_SEKUNDEN="$GESUNDHEIT" KASSA_GESUNDHEIT_TAKT=1 \
      DOCKER_ZUSTAND="$DS" RSYNC_ZAEHLER="$S/rsync-zaehler" RSYNC_FEHLER_AUFRUF="$RSYNC_FEHLER_AUFRUF" \
      KASSA_TEST_MARKE="$RW/offen" PATH="$BIN_PFAD:$PATH" $SH -c '. "$1"; shift; "$@"' sh "$UPDATER" "$@" > "$S/ausgabe.txt" 2>&1
}

# Statusdatei (vom Updater geschrieben)
status_feld() { sed -n 's/.*"'"$1"'":"\([^"]*\)".*/\1/p' "$CTRL/status.json" 2>/dev/null; }
status_ist() { [ "$(status_feld status)" = "$1" ]; }
status_text_hat() { case "$(status_feld schritt) $(status_feld fehler)" in *"$1"*) return 0 ;; esac; return 1; }
ausgabe_hat() { grep -q -- "$1" "$S/ausgabe.txt"; }
ws_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$WS/package.json" 2>/dev/null | head -n 1; }
laeuft_version() { sed 's/^sha256:img-//' "$DS/cont/backend" 2>/dev/null; }
ws_unveraendert() { [ "$(baum_hash "$WS")" = "$VORHER_HASH" ]; }
env_heil() { [ "$(cat "$WS/.env" 2>/dev/null)" = "GEHEIMNIS=nicht-anfassen" ]; }
anzahl_ups() { grep -c "^up-$1\$" "$DS/ups" 2>/dev/null || true; }
keine_ups() { ! grep -q '^up-' "$DS/ups"; }
gleich() { [ "$1" = "$2" ]; }
datei_da() { [ -f "$1" ]; }
datei_weg() { [ ! -e "$1" ]; }
log_hat() { grep -q -- "$1" "$DS/log"; }
log_hat_nicht() { ! grep -q -- "$1" "$DS/log"; }
status_json_hat() { grep -q -- "$1" "$CTRL/status.json"; }
kontrollordner_sauber() { [ -z "$(ls "$CTRL" | grep -v -e '^status.json$' -e '^heartbeat$')" ]; }
tag_weg() { [ ! -e "$DS/tag/$1" ]; }

solo() {
  if [ -z "$TEST_NUR" ]; then return 0; fi
  case " $TEST_NUR " in *" $1 "*) return 0 ;; esac
  return 1
}

# ═════════════════════════════════════════════════════════════════════════════
# Szenarien
# ═════════════════════════════════════════════════════════════════════════════

sz_gluecklich() {
  gruppe "1. Gültig signiertes Release wird installiert"
  neues_szenario gluecklich
  upd run_update
  pruefe "Status fertig, gemeldete Version 1.1.0" gleich "$(status_feld status) $(status_feld version)" "fertig 1.1.0"
  pruefe "Statusdatei: status, schritt, fehler, version, zeit" sh -c "grep -q '\"status\":' '$CTRL/status.json' && grep -q '\"schritt\":' '$CTRL/status.json' && grep -q '\"fehler\":null' '$CTRL/status.json' && grep -q '\"version\":' '$CTRL/status.json' && grep -q '\"zeit\":' '$CTRL/status.json'"
  pruefe "Workspace trägt die neue Version" gleich "$(ws_version)" 1.1.0
  pruefe "Neue Datei ist da, die entfallene ist weg (Spiegel mit Löschen)" sh -c "[ -f '$WS/datei-b.txt' ] && [ ! -e '$WS/weg.txt' ]"
  pruefe "Die .env bleibt unangetastet" env_heil
  pruefe "Container wurden neu gebaut (docker compose up -d --build)" gleich "$(anzahl_ups build)" 1
  pruefe "Dienst 'updater' wird beim Bauen NICHT mitgenommen" log_hat_nicht 'up -d --build.* updater'
  pruefe "Im Container läuft die neue Version" gleich "$(laeuft_version)" 1.1.0
  pruefe "Während des Bauens war die Unterbrechungs-Marke gesetzt" grep -q '^marke-da-beim-bauen$' "$DS/ups"
  pruefe "Rückweg-Sicherung und eigene Image-Tags sind danach weggeräumt" sh -c "[ ! -e '$RW' ] && [ ! -e '$DS/tag/kassa-rueckweg_backend_vorher' ]"
  pruefe "Im geteilten Kontroll-Volume liegt nur Status + Heartbeat (keine Sicherung)" kontrollordner_sauber
}

sz_unsigniert() {
  gruppe "2. Das neueste Tag ist nicht signiert → es wird übersprungen, das gültige davor installiert"
  neues_szenario unsigniert
  commit_version 1.2.0 "$T/signers-arbeit"; git_r tag -a -m "ohne Signatur" v1.2.0
  upd run_update
  pruefe "Es wird v1.1.0 installiert, nie das unsignierte v1.2.0" gleich "$(ws_version)" 1.1.0
  pruefe "Status fertig" status_ist fertig
  pruefe "Die Ablehnung steht im Log" ausgabe_hat "v1.2.0 abgelehnt"
}

sz_nur_ungueltig() {
  gruppe "3. Neueres Release ungültig, gültig ist nur der installierte Stand → Ablehnung, nichts wird verändert"
  neues_szenario nur_ungueltig
  git_r tag -d v1.1.0 >/dev/null; git_r tag -a -m "ohne Signatur" v1.1.0
  upd run_update
  pruefe "Status fehler" status_ist fehler
  pruefe "Text nennt v1.1.0 und dass es bei v1.0.0 bleibt" sh -c "grep -q 'v1.1.0 ist nicht gültig signiert' '$CTRL/status.json' && grep -q 'bleibt bei v1.0.0' '$CTRL/status.json'"
  pruefe "Workspace unverändert" ws_unveraendert
  pruefe "Kein Build, keine Sicherung" sh -c "! grep -q '^up-' '$DS/ups' && [ ! -e '$RW' ]"
}

sz_fremder_schluessel() {
  gruppe "4. Tag von einem Fremden signiert (auch wenn sein Schlüssel im neuen Release steht)"
  neues_szenario fremder_schluessel
  git_r tag -d v1.1.0 >/dev/null
  commit_version 1.1.0 "$T/signers-fremd"
  tag_signiert v1.1.0 fremd
  upd run_update
  pruefe "Abgelehnt: nicht gültig signiert" status_json_hat 'nicht gültig signiert'
  pruefe "Workspace unverändert" ws_unveraendert
  pruefe "Kein Build gestartet" keine_ups
}

sz_leichtgewichtig() {
  gruppe "5. Leichtgewichtiges Tag (ohne Tag-Objekt) wird abgelehnt"
  neues_szenario leichtgewichtig
  git_r tag -d v1.1.0 >/dev/null; git_r tag v1.1.0
  upd run_update
  pruefe "Status fehler" status_ist fehler
  pruefe "Workspace unverändert, kein Build" ws_unveraendert
  pruefe "…kein Build gestartet" keine_ups
}

sz_umbenannt() {
  gruppe "6. Altes, gültig signiertes Tag unter neuem Namen (v1.9.9) veröffentlicht"
  neues_szenario umbenannt
  git_r update-ref refs/tags/v1.9.9 "$(git_r rev-parse refs/tags/v1.1.0)"
  upd run_update
  pruefe "v1.9.9 wird abgelehnt (Name im Tag-Objekt ist v1.1.0)" ausgabe_hat "v1.9.9 abgelehnt: v1.9.9 ist ein umbenanntes oder fremdes Tag"
  pruefe "Installiert wird das echte v1.1.0" gleich "$(ws_version)" 1.1.0
}

sz_manipuliert() {
  gruppe "7. Manipuliertes Tag-Objekt (Signatur übernommen, Commit ausgetauscht)"
  neues_szenario manipuliert
  git_r cat-file tag v1.1.0 > "$S/tag.txt"
  git_r checkout -q -b boese v1.0.0 >/dev/null 2>&1
  inhalt 1.5.0 "$T/signers-arbeit" neu; printf 'boese\n' > "$REMOTE/boese.txt"
  git_r add -A >/dev/null 2>&1; git_r commit -q -m boese
  BOESE="$(git_r rev-parse HEAD)"
  sed -e "s/^object .*/object $BOESE/" -e 's/^tag v1.1.0/tag v1.5.0/' "$S/tag.txt" > "$S/tag2.txt"
  NEU_OBJ="$(git_r hash-object --no-filters -t tag -w "$S/tag2.txt")"
  git_r update-ref refs/tags/v1.5.0 "$NEU_OBJ"
  upd run_update
  pruefe "Das manipulierte v1.5.0 wird abgelehnt (Signatur passt nicht mehr)" ausgabe_hat "v1.5.0 abgelehnt: v1.5.0 ist nicht gültig signiert"
  pruefe "Die böse Datei landet nie im Workspace" datei_weg "$WS/boese.txt"
  pruefe "Installiert wird das echte v1.1.0" gleich "$(ws_version)" 1.1.0
}

sz_version_passt_nicht() {
  gruppe "8. Tag und package.json widersprechen sich"
  neues_szenario version_passt_nicht
  commit_version 1.3.0 "$T/signers-arbeit"; tag_signiert v1.4.0 arbeit
  upd run_update
  pruefe "v1.4.0 mit Version 1.3.0 wird abgelehnt" ausgabe_hat "v1.4.0 abgelehnt: v1.4.0: package.json meldet Version 1.3.0"
  pruefe "Installiert wird v1.1.0" gleich "$(ws_version)" 1.1.0
}

sz_aussperren() {
  gruppe "9. Release, das seinen eigenen Signierer aus allowed_signers streicht"
  neues_szenario aussperren
  commit_version 1.4.0 "$T/signers-fremd"; tag_signiert v1.4.0 arbeit
  upd run_update
  pruefe "v1.4.0 wird abgelehnt (würde jedes Folge-Update unmöglich machen)" ausgabe_hat "v1.4.0 abgelehnt: v1.4.0 würde den Update-Dienst aussperren"
  pruefe "Installiert wird v1.1.0" gleich "$(ws_version)" 1.1.0
}

sz_aelter() {
  gruppe "10. Nur ältere Releases verfügbar → kein Zurückspielen"
  neues_szenario aelter
  installiert_ist 1.1.0
  git_r tag -d v1.1.0 >/dev/null
  upd run_update
  pruefe "Status fehler: kein Release, das nicht älter ist" status_json_hat 'so neu ist wie die installierte Version v1.1.0'
  pruefe "Workspace bleibt auf 1.1.0" gleich "$(ws_version)" 1.1.0
  pruefe "Kein Build gestartet" keine_ups
}

sz_neuer_schluessel() {
  gruppe "11. Ein neuer Schlüssel gilt erst nach einem Release, das noch mit einem alten signiert war"
  neues_szenario neuer_schluessel
  commit_version 1.2.0 "$T/signers-arbeit-neu"; tag_signiert v1.2.0 neu
  upd run_update
  pruefe "v1.2.0 (mit dem neuen Schlüssel signiert, der nur im neuen Release steht) wird abgelehnt" ausgabe_hat "v1.2.0 abgelehnt: v1.2.0 ist nicht gültig signiert"
  pruefe "Installiert wird v1.1.0" gleich "$(ws_version)" 1.1.0
}

sz_schluesselwechsel() {
  gruppe "12. Geplanter Schlüsselwechsel: erst mit altem Schlüssel einführen, dann mit dem neuen signieren"
  neues_szenario schluesselwechsel
  commit_version 1.2.0 "$T/signers-arbeit-neu"; tag_signiert v1.2.0 arbeit
  upd run_update
  pruefe "Schritt 1: v1.2.0 (alter Schlüssel, bringt den neuen mit) wird installiert" gleich "$(ws_version) $(status_feld status)" "1.2.0 fertig"
  commit_version 1.3.0 "$T/signers-arbeit-neu"; tag_signiert v1.3.0 neu
  upd run_update
  pruefe "Schritt 2: v1.3.0 (mit dem neuen Schlüssel signiert) wird nun akzeptiert" gleich "$(ws_version) $(status_feld status)" "1.3.0 fertig"
}

sz_keine_liste() {
  gruppe "13. GitHub nicht erreichbar"
  neues_szenario keine_liste
  URL="$(datei_url "$S/gibt-es-nicht")"
  upd run_update
  pruefe "Status fehler: Release-Liste nicht erreichbar" status_json_hat 'nicht erreichbar'
  pruefe "Nichts verändert" ws_unveraendert
}

sz_vertrauensdatei_fehlt() {
  gruppe "14. Vertrauensdatei fehlt im installierten Stand → es wird NICHTS installiert (nicht still ungeprüft)"
  neues_szenario vertrauensdatei_fehlt
  rm -f "$WS/ops/updater/allowed_signers"; VORHER_HASH="$(baum_hash "$WS")"
  upd run_update
  pruefe "Status fehler mit Hinweis auf die Vertrauensdatei" status_json_hat 'allowed_signers fehlt'
  pruefe "Nichts verändert" ws_unveraendert
  pruefe "Kein Build gestartet" keine_ups
}

sz_erzwingen() {
  gruppe "15. „Update erzwingen“ auf dem neuesten Stand: dasselbe Release wird erneut gebaut"
  neues_szenario erzwingen
  installiert_ist 1.1.0
  upd run_update
  pruefe "Status fertig, Version 1.1.0, ein Build" gleich "$(status_feld status) $(status_feld version) $(anzahl_ups build)" "fertig 1.1.0 1"
}

sz_build_scheitert() {
  gruppe "16. Rückweg: der Build scheitert"
  neues_szenario build_scheitert
  : > "$DS/fail_build"
  upd run_update
  pruefe "Status fehler: automatisch auf v1.0.0 zurückgesetzt" status_text_hat "automatisch auf v1.0.0 zurückgesetzt"
  pruefe "Workspace ist wieder genau der alte Stand (inkl. der wiederhergestellten Datei weg.txt)" ws_unveraendert
  pruefe "Die .env bleibt unangetastet" env_heil
  pruefe "Es läuft weiter v1.0.0" gleich "$(laeuft_version)" 1.0.0
  pruefe "Sicherung ist weggeräumt" datei_weg "$RW"
}

sz_unhealthy() {
  gruppe "17. Rückweg: der neue Stand wird nie gesund"
  neues_szenario unhealthy
  : > "$DS/unhealthy_1.1.0"
  upd run_update
  pruefe "Status fehler: automatisch auf v1.0.0 zurückgesetzt" status_text_hat "automatisch auf v1.0.0 zurückgesetzt"
  pruefe "Grund im Status: Backend meldet sich nicht gesund" status_text_hat "nicht gesund"
  pruefe "Workspace ist wieder der alte Stand" ws_unveraendert
  pruefe "Images wurden zurückgesetzt: Es läuft wieder v1.0.0" gleich "$(laeuft_version)" 1.0.0
  pruefe "Gemeldete Version ist die laufende (1.0.0)" gleich "$(status_feld version)" 1.0.0
  pruefe "Der Rückweg startete ohne Neubau (docker compose up --no-build)" gleich "$(anzahl_ups nobuild)" 1
}

sz_nicht_uebernommen() {
  gruppe "18. Rückweg: die Images wurden nicht ersetzt (Container läuft weiter auf der alten Version)"
  neues_szenario nicht_uebernommen
  : > "$DS/kein_austausch"
  upd run_update
  pruefe "Status fehler: zurückgesetzt" status_text_hat "automatisch auf v1.0.0 zurückgesetzt"
  pruefe "Grund: Backend läuft weiter auf v1.0.0" status_text_hat "läuft weiter auf v1.0.0"
  pruefe "Workspace ist wieder der alte Stand" ws_unveraendert
}

sz_sicherung_scheitert() {
  gruppe "19. Die Sicherung für den Rückweg scheitert → Abbruch VOR jeder Änderung"
  neues_szenario sicherung_scheitert
  printf 'ich bin eine Datei\n' > "$S/blockiert"; RW="$S/blockiert/rueckweg"
  upd run_update
  pruefe "Status fehler: nicht gesichert" status_json_hat 'nicht gesichert werden'
  pruefe "Workspace unverändert" ws_unveraendert
  pruefe "Kein Build gestartet" keine_ups
}

sz_kopieren_scheitert() {
  gruppe "20. Rückweg: Kopieren in den Installationsordner bricht halb ab"
  neues_szenario kopieren_scheitert
  RSYNC_FEHLER_AUFRUF=2
  upd run_update
  pruefe "Status fehler: zurückgesetzt" status_text_hat "automatisch auf v1.0.0 zurückgesetzt"
  pruefe "Workspace ist wieder genau der alte Stand" ws_unveraendert
  pruefe "Kein Build wurde gestartet" gleich "$(anzahl_ups build)" 0
}

sz_rueckweg_scheitert() {
  gruppe "21. Auch der Rückweg scheitert → klare Meldung, keine Endlosschleife beim Neustart"
  neues_szenario rueckweg_scheitert
  : > "$DS/fail_build"; : > "$DS/fail_nobuild"
  upd run_update
  pruefe "Status fehler: der Rückweg konnte die Dienste nicht starten" status_text_hat "der Rückweg konnte die Dienste nicht starten"
  pruefe "Unterbrechungs-Marke ist entfernt (kein erneuter Rückweg bei jedem Neustart)" datei_weg "$RW/offen"
  pruefe "Die Sicherung bleibt für den manuellen Notfall liegen" datei_da "$RW/version"
}

sz_unterbrochen_gesund() {
  gruppe "22. Neustart nach unterbrochenem Update: neuer Stand ist gesund → gilt als fertig"
  neues_szenario unterbrochen_gesund
  upd sichere_vorher 1.0.0 "postgres backend frontend"
  printf '1.1.0\n' > "$RW/offen"
  printf 'sha256:img-1.1.0\n' > "$DS/cont/backend"
  upd wiederaufnehmen
  pruefe "Status fertig mit Version 1.1.0" gleich "$(status_feld status) $(status_feld version)" "fertig 1.1.0"
  pruefe "Marke und Sicherung sind weg" datei_weg "$RW"
}

sz_unterbrochen_defekt() {
  gruppe "23. Neustart nach unterbrochenem Update: neuer Stand ist nicht gesund → Rückweg"
  neues_szenario unterbrochen_defekt
  upd sichere_vorher 1.0.0 "postgres backend frontend"
  printf '1.1.0\n' > "$RW/offen"
  printf 'sha256:img-1.1.0\n' > "$DS/cont/backend"; printf 'sha256:img-1.1.0\n' > "$DS/tag/kassa-backend"
  : > "$DS/unhealthy_1.1.0"
  upd wiederaufnehmen
  pruefe "Status fehler: zurückgesetzt auf v1.0.0" status_text_hat "automatisch auf v1.0.0 zurückgesetzt"
  pruefe "Es läuft wieder v1.0.0" gleich "$(laeuft_version)" 1.0.0
  upd wiederaufnehmen
  pruefe "Ohne Marke tut ein weiterer Start nichts" gleich "$(cat "$S/ausgabe.txt")" ""
}

zeilen_der_vertrauensdatei() { grep -v -e '^#' -e '^ *$' "$1"; }
vertrauensdatei_zeilenform_ok() { ! zeilen_der_vertrauensdatei "$1" | grep -v -E '^[A-Za-z0-9._-]+ namespaces="git" ssh-ed25519 AAAA[A-Za-z0-9+/=]+( .*)?$'; }
vertrauensdatei_mind_zwei() { [ "$(zeilen_der_vertrauensdatei "$1" | wc -l)" -ge 2 ]; }
vertrauensdatei_schluessel_gueltig() { zeilen_der_vertrauensdatei "$1" | awk '{ print $3, $4 }' > "$2"; [ "$(ssh-keygen -l -f "$2" | wc -l)" -ge 2 ]; }
ohne_cr() { ! grep -q "$(printf '\r')" "$1"; }

sz_vertrauensdatei_echt() {
  gruppe "24. Die echte ops/updater/allowed_signers"
  S="$T/sz-echt"; mkdir -p "$S"
  ECHT="$HIER/allowed_signers"
  pruefe "Datei existiert" datei_da "$ECHT"
  pruefe "Mindestens zwei Schlüssel (Arbeit + Reserve)" vertrauensdatei_mind_zwei "$ECHT"
  pruefe "Jede Zeile: Principal, namespaces=\"git\", ssh-ed25519, Schlüssel" vertrauensdatei_zeilenform_ok "$ECHT"
  pruefe "Alle Schlüssel sind gültig (ssh-keygen kann sie lesen)" vertrauensdatei_schluessel_gueltig "$ECHT" "$S/schluessel.pub"
  pruefe "Die Datei hat LF-Zeilenenden (kein CR)" ohne_cr "$ECHT"
}

echtes_rsync_ok() {
  "$ECHTES_RSYNC" -a --delete --exclude='/.env' "$S/von"/ "$S/nach"/ \
    && [ -f "$S/nach/neu.txt" ] && [ ! -e "$S/nach/alt.txt" ] && [ "$(cat "$S/nach/.env")" = GEHEIM ]
}
sz_rsync_echt() {
  gruppe "25. Das ECHTE rsync mit den Flags des Updaters (nur wenn installiert)"
  if [ -z "$ECHTES_RSYNC" ]; then printf '  [--]   rsync ist hier nicht installiert — übersprungen (läuft in der CI)\n'; return; fi
  S="$T/sz-rsync"; mkdir -p "$S/von" "$S/nach"
  printf 'neu\n' > "$S/von/neu.txt"; printf 'alt\n' > "$S/nach/alt.txt"; printf 'GEHEIM\n' > "$S/nach/.env"
  pruefe "Neu kopiert, Altes gelöscht, .env bleibt" echtes_rsync_ok
}

# pruefe-release.sh im Repo des Szenarios ausführen; Ausgabe in $S/release.txt
release_pruefen() { ( cd "$REMOTE" && $SH "$PRUEFE_RELEASE" "$@" ) > "$S/release.txt" 2>&1; }
release_hat() { grep -q -- "$1" "$S/release.txt"; }
release_ok() { release_pruefen "$@"; }
release_abgelehnt() { ! release_pruefen "$@"; }

sz_release_pruefen() {
  gruppe "26. ops/release/pruefe-release.sh (Vorab-Prüfung vor dem Push und im GitHub-Workflow)"
  neues_szenario release_pruefen
  pruefe "Gültig signiertes Release auf master: alles in Ordnung" release_ok v1.1.0 --master
  pruefe "…die Signatur wird auch gegen die allowed_signers des Vorgängers geprüft" release_hat 'Vorgängers v1.0.0'

  git_r tag -d v1.1.0 >/dev/null; git_r tag -a -m "ohne Signatur" v1.1.0
  pruefe "Unsigniertes Tag: abgelehnt" release_abgelehnt v1.1.0
  pruefe "…mit Hinweis, wie es richtig geht" release_hat 'Signatur fehlt oder ungültig'

  git_r tag -d v1.1.0 >/dev/null; git_r tag v1.1.0
  pruefe "Leichtgewichtiges Tag: abgelehnt" release_abgelehnt v1.1.0
  pruefe "…mit Hinweis auf git tag -s" release_hat 'kein annotiertes Tag'

  git_r tag -d v1.1.0 >/dev/null; tag_signiert v1.1.0 fremd
  pruefe "Tag eines Fremden: abgelehnt" release_abgelehnt v1.1.0

  git_r tag -d v1.1.0 >/dev/null; tag_signiert v1.1.0 arbeit
  commit_version 1.2.0 "$T/signers-arbeit-neu"; tag_signiert v1.2.0 neu
  pruefe "Neuer Schlüssel im selben Release eingeführt UND damit signiert: abgelehnt (eine Kasse mit v1.1.0 würde es ablehnen)" release_abgelehnt v1.2.0
  pruefe "…Begründung nennt den Vorgänger" release_hat 'Kasse mit v1.1.0 würde dieses Release ABLEHNEN'

  commit_version 1.3.0 "$T/signers-fremd"; tag_signiert v1.3.0 arbeit
  pruefe "Release, das seinen eigenen Signierer aus allowed_signers streicht: abgelehnt" release_abgelehnt v1.3.0

  commit_version 1.4.0 "$T/signers-arbeit"; mkdir -p "$REMOTE/packages/x"; printf '{ "version": "9.9.9" }\n' > "$REMOTE/packages/x/package.json"
  git_r add -A >/dev/null 2>&1; git_r commit -q -m "falsche Version"; tag_signiert v1.4.0 arbeit
  pruefe "Eine package.json mit anderer Version (Versions-Lockstep gebrochen): abgelehnt" release_abgelehnt v1.4.0
  pruefe "…nennt die Datei" release_hat 'packages/x/package.json hat Version'

  git_r rm -q ops/updater/allowed_signers >/dev/null 2>&1; rm -rf "$REMOTE/packages"; printf '{ "version": "1.5.0" }\n' > "$REMOTE/package.json"; git_r add -A >/dev/null 2>&1
  git_r commit -q -m "ohne allowed_signers"; tag_signiert v1.5.0 arbeit
  pruefe "Release ohne ops/updater/allowed_signers: abgelehnt" release_abgelehnt v1.5.0

  git_r checkout -q -b nebenzweig v1.1.0 >/dev/null 2>&1
  commit_version 1.6.0 "$T/signers-arbeit"; tag_signiert v1.6.0 arbeit
  pruefe "Mit --master: ein Commit außerhalb von master wird abgelehnt" release_abgelehnt v1.6.0 --master
  pruefe "…ohne --master wäre es sonst in Ordnung" release_ok v1.6.0

  pruefe "Kein Release-Tag als Argument: Aufrufhinweis, Fehlercode" release_abgelehnt nichtsgueltiges
}

sz_hauptschleife() {
  gruppe "27. Hauptschleife: eine Anforderung löst genau einen Lauf aus, danach Neustart des Containers"
  neues_szenario hauptschleife
  : > "$CTRL/request"
  # Wrapper: lädt den Updater, ersetzt run_update durch eine Attrappe (zählt den Lauf und „klickt" währenddessen noch einmal) und startet haupt
  cat > "$S/haupt.sh" <<'WRAPPER'
. "$1"
run_update() { echo lauf >> "$UPDATE_CONTROL_DIR/laeufe"; : > "$UPDATE_CONTROL_DIR/request"; }
haupt
echo "NICHT-BEENDET"
WRAPPER
  env KASSA_UPDATER_NUR_FUNKTIONEN=1 UPDATE_CONTROL_DIR="$CTRL" KASSA_WORKSPACE="$WS" KASSA_REPO_URL="$URL" \
      KASSA_RUECKWEG_DIR="$RW" KASSA_GESUNDHEIT_SEKUNDEN=1 KASSA_GESUNDHEIT_TAKT=1 DOCKER_ZUSTAND="$DS" \
      RSYNC_ZAEHLER="$S/rsync-zaehler" PATH="$BIN_PFAD:$PATH" $SH "$S/haupt.sh" "$UPDATER" > "$S/ausgabe.txt" 2>&1
  _rc=$?
  pruefe "Genau ein Lauf, danach Beenden mit Code 0 (die restart-Policy startet den Container neu)" gleich "$(wc -l < "$CTRL/laeufe" | tr -d ' ') $_rc" "1 0"
  pruefe "Die Schleife läuft nach dem Lauf nicht weiter" sh -c "! grep -q NICHT-BEENDET '$S/ausgabe.txt'"
  pruefe "Eine währenddessen angeklickte Anforderung wird NICHT nach dem Neustart noch einmal abgearbeitet" datei_weg "$CTRL/request"
  pruefe "Beim Start ist der Status 'idle' gesetzt und der Heartbeat da" sh -c "grep -q '\"status\":\"idle\"' '$CTRL/status.json' && [ -s '$CTRL/heartbeat' ]"
}

alle_szenarien="gluecklich unsigniert nur_ungueltig fremder_schluessel leichtgewichtig umbenannt manipuliert version_passt_nicht aussperren aelter neuer_schluessel schluesselwechsel keine_liste vertrauensdatei_fehlt erzwingen build_scheitert unhealthy nicht_uebernommen sicherung_scheitert kopieren_scheitert rueckweg_scheitert unterbrochen_gesund unterbrochen_defekt vertrauensdatei_echt rsync_echt release_pruefen hauptschleife"

szenarien_laufen_lassen() {
  for _n in $alle_szenarien; do
    if solo "$_n"; then "sz_$_n"; fi
  done
}

# ═════════════════════════════════════════════════════════════════════════════
# Mutationsprobe: Der Updater wird gezielt kaputtgemacht. Jede Mutation muss mindestens ein Szenario röten —
# sonst prüft der Test an dieser Stelle nichts (vakuum-grün).
# ═════════════════════════════════════════════════════════════════════════════
MUT_FEHLER=0
mutation() { # <Anker> <Ersatzzeile> <Szenarien (Leerzeichen)> <Beschreibung> [updater|release]
  _anker="$1"; _ersatz="$2"; _szen="$3"; _text="$4"; _ziel="${5:-updater}"
  _datei="$T/mut-$_anker.sh"
  if [ "$_ziel" = release ]; then _orig="$PRUEFE_RELEASE"; else _orig="$UPDATER"; fi
  ERSATZ="$_ersatz" awk -v anker="# M:$_anker" '{ if (index($0, anker)) print ENVIRON["ERSATZ"]; else print }' "$_orig" > "$_datei"
  if cmp -s "$_orig" "$_datei"; then
    printf '  [FAIL] %s — die Mutation hat nichts verändert (Anker „# M:%s" fehlt im Updater)\n' "$_text" "$_anker"
    MUT_FEHLER=$((MUT_FEHLER + 1)); return
  fi
  if ! $SH -n "$_datei" 2>/dev/null; then
    printf '  [FAIL] %s — die Mutation ist selbst kein gültiges Shell-Skript\n' "$_text"
    MUT_FEHLER=$((MUT_FEHLER + 1)); return
  fi
  if [ "$_ziel" = release ]; then
    PRUEFE_SKRIPT="$_datei" TEST_NUR="$_szen" TEST_SH="$SH" sh "$0" > "$T/mut-$_anker.log" 2>&1; _ergebnis=$?
  else
    UPDATER_SKRIPT="$_datei" TEST_NUR="$_szen" TEST_SH="$SH" sh "$0" > "$T/mut-$_anker.log" 2>&1; _ergebnis=$?
  fi
  if [ "$_ergebnis" -eq 0 ]; then
    printf '  [FAIL] %s — die Tests merken den Defekt NICHT (Szenarien: %s)\n' "$_text" "$_szen"
    MUT_FEHLER=$((MUT_FEHLER + 1))
  else
    printf '  [ok]   %s — Tests werden rot (%s)\n' "$_text" "$_szen"
  fi
}

mutationsprobe() {
  gruppe "Mutationsprobe (jede Mutation muss die Tests röten)"
  mutation signatur '  if false; then' "unsigniert nur_ungueltig fremder_schluessel leichtgewichtig manipuliert neuer_schluessel" "Signaturprüfung abgeschaltet"
  mutation tagname '  if false; then' "umbenannt" "Namensprüfung des Tag-Objekts abgeschaltet"
  mutation version '  if false; then' "version_passt_nicht" "Prüfung Tag = Version in package.json abgeschaltet"
  mutation aussperren '  if false; then' "aussperren" "Prüfung „Signierer bleibt in der neuen allowed_signers“ abgeschaltet"
  mutation aelter '    if false; then break; fi' "aelter" "Sperre für ältere Versionen abgeschaltet"
  mutation env 'spiegeln() { rsync -a --delete "$1"/ "$2"/; }' "gluecklich build_scheitert" ".env nicht mehr vom Spiegeln ausgenommen"
  mutation sicherung '  true' "build_scheitert unhealthy kopieren_scheitert" "Sicherung des Codes entfällt"
  mutation rueckweg-code '  if ! true; then' "build_scheitert unhealthy nicht_uebernommen kopieren_scheitert" "Rückweg stellt den Code nicht wieder her"
  mutation rueckweg-images '      true' "unhealthy unterbrochen_defekt" "Rückweg setzt die Images nicht zurück"
  mutation gesund '      if true; then' "unhealthy unterbrochen_defekt" "Gesundheitscheck wird ignoriert"
  mutation warten '  GELADEN="$ZIEL_VERSION"; _rc=0' "unhealthy nicht_uebernommen" "Nach dem Build wird nicht auf das Backend gewartet"
  mutation marke '  true' "gluecklich" "Unterbrechungs-Marke wird nicht gesetzt"
  mutation marke-weg '  true' "rueckweg_scheitert" "Unterbrechungs-Marke bleibt nach gescheitertem Rückweg stehen"
  mutation request-weg '  true' "hauptschleife" "Anforderung während des Laufs bleibt liegen (zweiter, unnötiger Lauf nach dem Neustart)"
  mutation vorgaenger '    if true; then' "release_pruefen" "pruefe-release.sh: Signatur gegen die allowed_signers des Vorgängers wird nicht geprüft" release
  mutation lockstep '  :' "release_pruefen" "pruefe-release.sh: Versions-Lockstep wird nicht geprüft" release
  mutation signatur-dieses 'elif true; then' "release_pruefen" "pruefe-release.sh: Signatur gegen die eigene allowed_signers wird nicht geprüft" release
}

# ═════════════════════════════════════════════════════════════════════════════
case "${1:-}" in
  mutationen)
    if [ -n "$TEST_NUR" ]; then echo "TEST_NUR passt nicht zu 'mutationen'"; exit 2; fi
    mutationsprobe
    printf '\n'
    if [ "$MUT_FEHLER" -eq 0 ]; then printf 'ALLE MUTATIONEN WERDEN ERKANNT\n'; exit 0; fi
    printf '%d MUTATION(EN) WERDEN NICHT ERKANNT\n' "$MUT_FEHLER"; exit 1 ;;
  *)
    szenarien_laufen_lassen
    printf '\n'
    if [ "$FEHL" -eq 0 ]; then printf 'ALLE %d TESTS BESTANDEN\n' "$ANZAHL"; exit 0; fi
    printf '%d von %d TESTS FEHLGESCHLAGEN\n' "$FEHL" "$ANZAHL"; exit 1 ;;
esac
