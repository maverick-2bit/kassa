-- Umrüstzeit: Minuten fürs Neueindecken, die ein Tisch nach dem Ende einer
-- Reservierung zusätzlich blockiert bleibt. 0 = aus (bisheriges Verhalten).
ALTER TABLE "mandanten"
  ADD COLUMN IF NOT EXISTS "umruest_minuten" integer NOT NULL DEFAULT 0;
