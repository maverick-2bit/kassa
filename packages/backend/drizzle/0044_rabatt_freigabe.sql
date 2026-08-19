-- Rabatt-Freigabe: ab diesem Nachlass (prozentual ODER absolut) muss ein
-- Berechtigter per PIN freigeben. 0 = aus. Schließt die Umgehung der
-- Storno-Freigabe per 100-%-Rabatt.
ALTER TABLE "mandanten"
  ADD COLUMN IF NOT EXISTS "rabatt_freigabe_ab_prozent" integer NOT NULL DEFAULT 0;
ALTER TABLE "mandanten"
  ADD COLUMN IF NOT EXISTS "rabatt_freigabe_ab_cent" integer NOT NULL DEFAULT 0;
