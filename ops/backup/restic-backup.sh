#!/bin/sh
# =============================================================================
# Off-Site-Backup der vom Backend erzeugten DB- und DEP-Sicherungen via restic.
# Läuft als eigener Container (siehe docker-compose.yml, Service "backup").
#
# Opt-in: ohne RESTIC_REPOSITORY/RESTIC_PASSWORD passiert nichts (Warnung + idle).
# busybox-ash-kompatibel (keine bash-Builtins).
# =============================================================================
set -eu

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] restic-backup: $*"; }

if [ -z "${RESTIC_REPOSITORY:-}" ] || [ -z "${RESTIC_PASSWORD:-}" ]; then
  log "RESTIC_REPOSITORY/RESTIC_PASSWORD nicht gesetzt — Off-Site-Backup deaktiviert (opt-in)."
  while true; do sleep 3600; done
fi

# Führende Null entfernen (busybox-Arithmetik interpretiert "08" sonst als Oktal)
strip0() { v="${1#0}"; [ -z "$v" ] && v=0; echo "$v"; }

sekunden_bis_stunde() {
  ziel="$1"
  jetzt=$(( $(strip0 "$(date +%H)") * 3600 + $(strip0 "$(date +%M)") * 60 + $(strip0 "$(date +%S)") ))
  diff=$(( ziel * 3600 - jetzt ))
  [ "$diff" -le 0 ] && diff=$(( diff + 86400 ))
  echo "$diff"
}

backup_lauf() {
  log "Starte Backup von /data/db-backups + /data/dep-backups ..."
  if restic backup /data/db-backups /data/dep-backups --tag kassa --host kassa; then
    log "Backup ok — wende Retention an ..."
    restic forget \
      --keep-daily   "${RESTIC_KEEP_DAILY:-14}" \
      --keep-weekly  "${RESTIC_KEEP_WEEKLY:-8}" \
      --keep-monthly "${RESTIC_KEEP_MONTHLY:-84}" \
      --prune || log "WARN: restic forget/prune meldete einen Fehler"
  else
    log "FEHLER: restic backup fehlgeschlagen"
  fi
}

# Repository initialisieren, falls leer/neu
if ! restic snapshots >/dev/null 2>&1; then
  log "Repository nicht gefunden — initialisiere ..."
  restic init || log "WARN: restic init fehlgeschlagen (existiert das Repo schon mit anderem Passwort?)"
fi

log "Off-Site-Backup aktiv. Repo: ${RESTIC_REPOSITORY}. Täglicher Lauf um ~${BACKUP_STUNDE:-4}:00 (Containerzeit)."
while true; do
  warten=$(sekunden_bis_stunde "$(strip0 "${BACKUP_STUNDE:-4}")")
  log "Nächster Lauf in ${warten}s."
  sleep "$warten"
  backup_lauf
  sleep 60   # nicht zweimal in derselben Minute laufen
done
