-- Migration 0022: Preisregeln — flexiblerer Zeitplan
--
-- Erweitert die Preisregeln (Happy Hour):
--   * mehrere Zeitfenster pro Regel  -> zeitfenster jsonb [{von,bis}]
--   * konkrete Kalendertage          -> datum_tage jsonb [YYYY-MM-DD]
--   * Aktionszeitraum                -> gueltig_von / gueltig_bis (YYYY-MM-DD)
-- Bestehende Regeln mit einem einzelnen von_zeit/bis_zeit werden in ein
-- Zeitfenster ueberfuehrt; danach entfallen die Einzelspalten.
-- Statements sind idempotent.

ALTER TABLE "preisregeln" ADD COLUMN IF NOT EXISTS "zeitfenster" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "preisregeln" ADD COLUMN IF NOT EXISTS "datum_tage"  jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "preisregeln" ADD COLUMN IF NOT EXISTS "gueltig_von" varchar(10);
ALTER TABLE "preisregeln" ADD COLUMN IF NOT EXISTS "gueltig_bis" varchar(10);

-- Bestehende Einzelfenster in das Zeitfenster-Array uebernehmen
UPDATE "preisregeln"
SET "zeitfenster" = jsonb_build_array(jsonb_build_object('von', "von_zeit", 'bis', "bis_zeit"))
WHERE jsonb_array_length("zeitfenster") = 0
  AND "von_zeit" IS NOT NULL
  AND "bis_zeit" IS NOT NULL;

ALTER TABLE "preisregeln" DROP COLUMN IF EXISTS "von_zeit";
ALTER TABLE "preisregeln" DROP COLUMN IF EXISTS "bis_zeit";
