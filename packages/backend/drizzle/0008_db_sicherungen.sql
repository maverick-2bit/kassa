-- Migration 0008: DB-Sicherungen-Tabelle
-- Protokolliert automatische und manuelle PostgreSQL-Datenbank-Dumps

CREATE TABLE IF NOT EXISTS "db_sicherungen" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "erstellt_am"      timestamptz NOT NULL DEFAULT now(),
  "dateiname"        text NOT NULL,
  "dateipfad"        text NOT NULL,
  "dateigroesse"     bigint NOT NULL DEFAULT 0,
  "automatisch"      boolean NOT NULL DEFAULT false,
  "erfolgreich"      boolean NOT NULL DEFAULT true,
  "fehler"           text
);

CREATE INDEX IF NOT EXISTS "db_sicherungen_erstellt_idx" ON "db_sicherungen" ("erstellt_am" DESC);
