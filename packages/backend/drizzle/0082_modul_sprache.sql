-- Migration 0082: Sprachbestellung (Kellner-App, Headset) als aktivierbares Modul.
--
-- modul_sprache_aktiv schaltet das Modul je Mandant frei (AUS = heutiges Verhalten, nichts
-- wird geladen). Weitere Tabellen (Synonyme) folgen mit dem Matching-Schritt.
-- Idempotent.

ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "modul_sprache_aktiv" boolean NOT NULL DEFAULT false;
