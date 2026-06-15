-- Migration 0016: Audit-Log Komposit-Index
--
-- Die Audit-Log-Liste filtert nach mandant_id und sortiert nach created_at DESC
-- (audit.route.ts). Mit getrennten Einzel-Indizes muss Postgres alle Zeilen des
-- Mandanten laden und im Speicher sortieren. Ein Komposit-Index (mandant_id,
-- created_at) liefert die Reihenfolge direkt aus dem Index — kein Sort-Schritt.
--
-- Der vormalige audit_logs_mandant_idx wird durch das Komposit-Präfix redundant;
-- audit_logs_created_idx hatte keinen Reader. Beide werden entfernt, um die
-- Index-Pflege bei jedem Audit-Insert (bei jedem Login/Beleg) zu reduzieren.
-- Alle Statements sind idempotent.

CREATE INDEX IF NOT EXISTS "audit_logs_mandant_created_idx" ON "audit_logs" ("mandant_id", "created_at");
DROP INDEX IF EXISTS "audit_logs_mandant_idx";
DROP INDEX IF EXISTS "audit_logs_created_idx";
