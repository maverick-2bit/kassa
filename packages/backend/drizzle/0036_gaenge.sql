-- Migration 0036: Gänge-Steuerung (Coursing) als aktivierbares Modul.
--
-- modul_gaenge_aktiv schaltet das Modul je Mandant frei (AUS = heutiges Verhalten, alles
-- sofort). gaenge_anzahl = Anzahl wählbarer Gänge (Gang-Wähler „1. Gang"…„N. Gang"). Die
-- Gang-Zuordnung je Tab-Position liegt im positionen-JSONB (gang/gesendetAm) — kein Schema.
-- Idempotent.

ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "modul_gaenge_aktiv" boolean NOT NULL DEFAULT false;
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "gaenge_anzahl" integer NOT NULL DEFAULT 3;
