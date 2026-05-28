-- Migration 0003: Mandant-Stammdaten – Belegfußtext
-- Fügt eine optionale Freitext-Fußzeile für Belege / PDFs hinzu.

ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "beleg_fusstext" text;
