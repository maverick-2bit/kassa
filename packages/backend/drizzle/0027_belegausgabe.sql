-- Migration 0027: Belegausgabe-Modus je Kasse (digitaler Beleg via QR)
--
-- Je Kasse waehlbar: 'drucken' (Papier-Bon), 'digital' (nur QR -> oeffentliche
-- Web-Ansicht, KEIN Druck) oder 'beides'. Optionale oeffentliche Basis-URL fuer
-- den Beleg-QR (leer = Origin der Kassa-App). Statements sind idempotent.

ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "beleg_modus" varchar(16) NOT NULL DEFAULT 'drucken';
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "beleg_basis_url" varchar(255);
