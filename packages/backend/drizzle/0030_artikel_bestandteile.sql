-- Migration 0030: Artikel-Stückliste / Rezept (Rohstoffe/Bestandteile)
--
-- Ein Verkaufsartikel kann aus Bestandteilen (Rohstoff-Artikeln) mit Menge
-- zusammengesetzt sein. Beim Verkauf/Bonieren wird der Lagerstand der
-- Bestandteile abgebucht; bei Bestandteil-Lagerstand 0 gilt der Verkaufsartikel
-- als ausverkauft (abgeleitete Verfügbarkeit). Rohstoff-Artikel (ist_bestandteil)
-- werden aus der Bonieroberfläche ausgeblendet.
-- Alle Statements idempotent.

ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "ist_bestandteil" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "artikel_bestandteile" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id"             uuid NOT NULL REFERENCES "mandanten"("id"),
  "verkaufsartikel_id"     uuid NOT NULL REFERENCES "artikel"("id") ON DELETE CASCADE,
  "bestandteil_artikel_id" uuid NOT NULL REFERENCES "artikel"("id") ON DELETE CASCADE,
  "menge"                  integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "artikel_bestandteil_uniq_idx"        ON "artikel_bestandteile" ("verkaufsartikel_id", "bestandteil_artikel_id");
CREATE INDEX        IF NOT EXISTS "artikel_bestandteil_verkaufs_idx"    ON "artikel_bestandteile" ("verkaufsartikel_id");
CREATE INDEX        IF NOT EXISTS "artikel_bestandteil_bestandteil_idx" ON "artikel_bestandteile" ("bestandteil_artikel_id");
