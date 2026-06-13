-- Migration 0006: KDS-Bons (Browser-basiertes Küchen-Display)
-- Speichert aktive Bonierbons pro Station für das integrierte KDS.

CREATE TABLE IF NOT EXISTS kds_bons (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mandant_id  UUID        NOT NULL REFERENCES mandanten(id) ON DELETE CASCADE,
  bon_nummer  VARCHAR(20) NOT NULL,
  station     VARCHAR(20) NOT NULL,
  tisch       VARCHAR(40) NOT NULL,
  bereich     VARCHAR(60),
  kellner     VARCHAR(60) NOT NULL,
  -- Positionen: [{id, bezeichnung, menge, details?, erledigt}]
  positionen  JSONB       NOT NULL DEFAULT '[]',
  -- 'offen' | 'erledigt'
  status      VARCHAR(20) NOT NULL DEFAULT 'offen',
  erstellt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kds_bons_mandant_station_status_idx
  ON kds_bons (mandant_id, station, status);

CREATE INDEX IF NOT EXISTS kds_bons_bon_nummer_idx
  ON kds_bons (bon_nummer);
