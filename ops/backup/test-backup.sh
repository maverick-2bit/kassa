#!/usr/bin/env bash
# =============================================================================
# Verifikations-Skript für das Off-Site-Backup — auf der DOCKER-BOX ausführen.
#
# Voraussetzung: der Stack läuft (docker compose up -d) und RESTIC_* ist in der
# .env gesetzt. Prüft Schritt für Schritt, dass das Backup wirklich funktioniert
# und ein Restore möglich ist. Bricht beim ersten Fehler mit Exit 1 ab.
#
# Aufruf (aus dem Repo-Wurzelverzeichnis):
#   ./ops/backup/test-backup.sh
#   COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml" ./ops/backup/test-backup.sh
# =============================================================================
set -euo pipefail

COMPOSE="${COMPOSE:-docker compose}"
SVC="${BACKUP_SERVICE:-backup}"

ok()   { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; exit 1; }

echo "[1/6] Läuft der Backup-Service?"
$COMPOSE ps "$SVC" 2>/dev/null | grep -Eiq 'up|running|healthy' \
  || fail "Service '$SVC' läuft nicht — zuerst 'docker compose up -d'"
ok "Service läuft"

echo "[2/6] Ist RESTIC konfiguriert (sonst ist das Backup absichtlich aus)?"
$COMPOSE exec -T "$SVC" sh -c '[ -n "${RESTIC_REPOSITORY:-}" ] && [ -n "${RESTIC_PASSWORD:-}" ]' \
  || fail "RESTIC_REPOSITORY/RESTIC_PASSWORD nicht gesetzt — Off-Site-Backup deaktiviert"
ok "RESTIC konfiguriert"

echo "[3/6] Repository erreichbar (restic snapshots)?"
$COMPOSE exec -T "$SVC" restic snapshots >/dev/null 2>&1 \
  || fail "Repository nicht erreichbar/initialisiert (Zugangsdaten/Endpoint prüfen)"
ok "Repository erreichbar"

echo "[4/6] Backup-Lauf auslösen..."
$COMPOSE exec -T "$SVC" restic backup /data/db-backups /data/dep-backups --tag test --host kassa \
  || fail "restic backup fehlgeschlagen"
ok "Backup erstellt"

echo "[5/6] Restore-Probe (latest -> /tmp/restore-probe)..."
$COMPOSE exec -T "$SVC" sh -c 'rm -rf /tmp/restore-probe && restic restore latest --target /tmp/restore-probe && ls /tmp/restore-probe/data >/dev/null' \
  || fail "Restore fehlgeschlagen"
ok "Restore erfolgreich"

echo "[6/6] Healthcheck-Status des Backup-Containers?"
CID="$($COMPOSE ps -q "$SVC")"
HEALTH="$(docker inspect -f '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}kein-healthcheck{{ end }}' "$CID" 2>/dev/null || echo unbekannt)"
echo "  → Health: ${HEALTH}"
case "$HEALTH" in
  healthy|starting) ok "Healthcheck ok ($HEALTH)" ;;
  *) echo "  ! Healthcheck: $HEALTH (nach dem ersten erfolgreichen Lauf sollte er 'healthy' werden)";;
esac

echo
echo "ALLE PFLICHT-PRÜFUNGEN BESTANDEN ✓"
echo "Optional: externen Monitoring-Endpoint prüfen:"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' \"http://localhost:3000/api/monitoring/status?token=\$MONITORING_TOKEN\""
