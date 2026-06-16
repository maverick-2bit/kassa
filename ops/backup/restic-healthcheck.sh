#!/bin/sh
# =============================================================================
# Healthcheck für den Backup-Service (docker-compose Service "backup").
#
# Gesund, wenn:
#   - das Backup bewusst deaktiviert ist (kein Repo konfiguriert), ODER
#   - der letzte erfolgreiche Lauf nicht älter als BACKUP_MAX_AGE_STUNDEN (26h) ist.
# Sonst ungesund -> in `docker ps`/Monitoring sichtbar.
# =============================================================================
set -eu

STATUS_DIR=/status
MAX_AGE_STUNDEN="${BACKUP_MAX_AGE_STUNDEN:-26}"

# Bewusst deaktiviert -> gesund
[ -f "$STATUS_DIR/disabled" ] && exit 0

# Noch kein erfolgreicher Lauf -> ungesund
if [ ! -f "$STATUS_DIR/last-success" ]; then
  echo "noch kein erfolgreiches Backup"
  exit 1
fi

letzte=$(cat "$STATUS_DIR/last-success" 2>/dev/null || echo 0)
jetzt=$(date +%s)
alter=$(( jetzt - letzte ))
max=$(( MAX_AGE_STUNDEN * 3600 ))

if [ "$alter" -le "$max" ]; then
  exit 0
fi

echo "letztes erfolgreiches Backup vor ${alter}s (Grenze ${max}s)"
exit 1
