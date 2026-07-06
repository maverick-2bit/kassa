-- Migration 0021: Preisregeln pro Einzel-Artikel
--
-- Ergaenzt die Preisregeln (Happy Hour) um artikel_ids: eine Regel kann jetzt
-- nicht nur ganze Warengruppen (kategorie_ids), sondern auch einzelne Artikel
-- betreffen. Sind beide leer, gilt die Regel weiterhin fuer alle Artikel.
-- Statement ist idempotent.

ALTER TABLE "preisregeln" ADD COLUMN IF NOT EXISTS "artikel_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
