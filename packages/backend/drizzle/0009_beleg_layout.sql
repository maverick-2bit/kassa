-- Rechnungslayout-Einstellungen pro Mandant
ALTER TABLE "mandanten"
  ADD COLUMN IF NOT EXISTS "beleg_kopftext"              text,
  ADD COLUMN IF NOT EXISTS "beleg_zeige_steuertabelle"   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "beleg_zeige_qr"              boolean NOT NULL DEFAULT false;
