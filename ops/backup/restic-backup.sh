#!/bin/sh
# =============================================================================
# Off-Site-Backup der vom Backend erzeugten DB- und DEP-Sicherungen via restic.
# Läuft als eigener Container (siehe docker-compose.yml, Service "backup").
#
# Opt-in: ohne RESTIC_REPOSITORY/RESTIC_PASSWORD passiert nichts (Warnung + idle).
# Schreibt einen Status-Marker (/status), den der Healthcheck auswertet.
# busybox-ash-kompatibel (keine bash-Builtins).
# =============================================================================
set -eu

STATUS_DIR=/status
mkdir -p "$STATUS_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] restic-backup: $*"; }

if [ -z "${RESTIC_REPOSITORY:-}" ] || [ -z "${RESTIC_PASSWORD:-}" ]; then
  log "RESTIC_REPOSITORY/RESTIC_PASSWORD nicht gesetzt — Off-Site-Backup deaktiviert (opt-in)."
  : > "$STATUS_DIR/disabled"        # Healthcheck wertet das als "gesund (bewusst aus)"
  while true; do sleep 3600; done
fi
rm -f "$STATUS_DIR/disabled"

# Führende Null entfernen (busybox-Arithmetik interpretiert "08" sonst als Oktal)
strip0() { v="${1#0}"; [ -z "$v" ] && v=0; echo "$v"; }

sekunden_bis_stunde() {
  ziel="$1"
  jetzt=$(( $(strip0 "$(date +%H)") * 3600 + $(strip0 "$(date +%M)") * 60 + $(strip0 "$(date +%S)") ))
  diff=$(( ziel * 3600 - jetzt ))
  [ "$diff" -le 0 ] && diff=$(( diff + 86400 ))
  echo "$diff"
}

# Repository sicherstellen: erreichbar → fertig, sonst anlegen (bei S3 legt
# restic init auch das Bucket an). Ein bestehendes Repo überschreibt init nie —
# es bricht an der vorhandenen config ab (z. B. falsches Passwort).
LETZTE_MELDUNG=""
repo_sicherstellen() {
  # --retry-lock: läuft gerade ein Aufräumen (auch von Hand), kurz warten statt
  # „nicht erreichbar" anzunehmen
  restic snapshots --retry-lock 1m >/dev/null 2>&1 && return 0
  if LETZTE_MELDUNG="$(restic init 2>&1)"; then
    log "Repository neu initialisiert: $(echo "$LETZTE_MELDUNG" | head -n 1)"
    return 0
  fi
  return 1
}

backup_lauf() {
  # Holt eine beim Start gescheiterte Initialisierung nach
  repo_sicherstellen || true
  log "Starte Backup von /data/db-backups + /data/dep-backups ..."
  # --retry-lock: eine gerade laufende Prüfung/Wiederherstellung von Hand bremst
  # den Lauf nur, statt ihn scheitern zu lassen
  if restic backup --retry-lock 10m /data/db-backups /data/dep-backups --tag kassa --host kassa; then
    log "Backup ok — wende Retention an ..."
    restic forget --retry-lock 10m \
      --keep-daily   "${RESTIC_KEEP_DAILY:-14}" \
      --keep-weekly  "${RESTIC_KEEP_WEEKLY:-8}" \
      --keep-monthly "${RESTIC_KEEP_MONTHLY:-84}" \
      --prune || log "WARN: restic forget/prune meldete einen Fehler"
    date +%s > "$STATUS_DIR/last-success"   # Zeitstempel für den Healthcheck
  else
    log "FEHLER: restic backup fehlgeschlagen"
  fi
}

# Beim Start kann das Ziel noch fehlen (Router bootet nach einem Stromausfall
# langsamer als der PC, lokales Test-S3 fährt noch hoch) — daher bis zu 5 min
# wiederholen. Vorher gab es genau EINEN Versuch: scheiterte der, blieb ein
# neues Repo ungeöffnet und jeder Tageslauf schlug fehl. Danach holt jeder
# geplante Lauf die Initialisierung nach.
versuch=0
until repo_sicherstellen; do
  versuch=$((versuch + 1))
  if [ "$versuch" -eq 1 ]; then
    log "Repository noch nicht erreichbar/angelegt — versuche es bis zu 5 min lang ..."
  fi
  if [ "$versuch" -ge 60 ]; then
    log "WARN: Repository nach 5 min nicht bereit (Ziel erreichbar? Repo mit anderem Passwort?). Letzte Meldung: ${LETZTE_MELDUNG}"
    break
  fi
  sleep 5
done

log "Off-Site-Backup aktiv. Repo: ${RESTIC_REPOSITORY}. Täglicher Lauf um ~${BACKUP_STUNDE:-4}:00 (Containerzeit)."

# Sofort-Lauf beim Start: sichert direkt nach dem Deploy + setzt den Status-Marker,
# damit der Healthcheck nicht bis zum ersten geplanten Lauf "unhealthy" meldet.
log "Initialer Backup-Lauf beim Start ..."
backup_lauf

while true; do
  warten=$(sekunden_bis_stunde "$(strip0 "${BACKUP_STUNDE:-4}")")
  log "Nächster Lauf in ${warten}s."
  sleep "$warten"
  backup_lauf
  sleep 60   # nicht zweimal in derselben Minute laufen
done
