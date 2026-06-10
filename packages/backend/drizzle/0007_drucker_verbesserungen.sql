-- Migration 0007: Drucker-Verbesserungen
-- 1. Konfigurierbarer Timeout pro Kasse
-- 2. Druckhistorie-Tabelle
-- 3. Fallback-Bonierdrucker

-- Konfigurierbarer Timeout (Standard: 5 Sekunden)
ALTER TABLE kassen ADD COLUMN IF NOT EXISTS drucker_timeout_sek INTEGER NOT NULL DEFAULT 5;

-- Fallback-Bonierdrucker: wenn Primärdrucker ausfällt, wird dieser verwendet
ALTER TABLE bonierdrucker ADD COLUMN IF NOT EXISTS fallback_id UUID REFERENCES bonierdrucker(id) ON DELETE SET NULL;

-- Druckhistorie: jeder Druckversuch wird protokolliert
CREATE TABLE IF NOT EXISTS druck_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mandant_id   UUID        NOT NULL REFERENCES mandanten(id) ON DELETE CASCADE,
  kasse_id     UUID        REFERENCES kassen(id) ON DELETE SET NULL,
  drucker_ip   VARCHAR(64) NOT NULL,
  drucker_typ  VARCHAR(20) NOT NULL, -- 'bon' | 'bonierbon' | 'test'
  beleg_id     UUID,
  erfolg       BOOLEAN     NOT NULL,
  fehler_text  TEXT,
  erstellt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX druck_log_mandant_idx ON druck_log (mandant_id, erstellt_at DESC);
CREATE INDEX druck_log_kasse_idx   ON druck_log (kasse_id,   erstellt_at DESC);
