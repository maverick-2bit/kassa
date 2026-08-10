-- Storno-Freigabe: ab diesem Belegbetrag muss ein Berechtigter per PIN
-- freigeben. 0 = aus (bisheriges Verhalten, jeder darf jeden Beleg stornieren).
ALTER TABLE "mandanten"
  ADD COLUMN IF NOT EXISTS "storno_freigabe_ab_cent" integer NOT NULL DEFAULT 0;
