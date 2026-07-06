-- Migration 0023: Seriennummern (striktes Pool-Modell pro Artikel)
--
-- Artikel bekommen ein Flag seriennummern_aktiv. Fuer solche Artikel werden
-- die Seriennummern im Wareneingang erfasst (Status 'verfuegbar') und beim
-- Verkauf (Lieferschein/Rechnung) auf 'verkauft' gesetzt (mit Verweis).
-- Eine Seriennummer ist pro Artikel eindeutig. Statements sind idempotent.

ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "seriennummern_aktiv" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "seriennummern" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mandant_id"      uuid NOT NULL REFERENCES "mandanten"("id"),
  "artikel_id"      uuid NOT NULL REFERENCES "artikel"("id"),
  "seriennummer"    varchar(100) NOT NULL,
  "status"          varchar(20) NOT NULL DEFAULT 'verfuegbar',
  "beleg_id"        uuid,
  "lieferschein_id" uuid,
  "verkauft_am"     timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "seriennummern_artikel_sn_unique" ON "seriennummern" ("artikel_id", "seriennummer");
CREATE INDEX IF NOT EXISTS "seriennummern_artikel_status_idx" ON "seriennummern" ("artikel_id", "status");
