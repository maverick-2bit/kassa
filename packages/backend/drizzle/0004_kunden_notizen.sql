-- Migration 0004: Kunden – Notizen
-- Fügt ein internes Freitext-Notizfeld pro Kunde hinzu.

ALTER TABLE "kunden" ADD COLUMN IF NOT EXISTS "notizen" text;
