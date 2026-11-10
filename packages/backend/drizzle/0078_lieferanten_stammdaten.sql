-- Lieferanten-Stammdaten vollstaendig (Adresse, UID, Kundennummer, Zahlungsbedingung, Lieferzeit) und
-- Einkaufsdaten am Artikel (EAN, Einkaufspreis netto, Lieferanten-/Hersteller-Artikelnummer).
ALTER TABLE "lieferanten" ADD COLUMN IF NOT EXISTS "strasse" varchar(200);--> statement-breakpoint
ALTER TABLE "lieferanten" ADD COLUMN IF NOT EXISTS "plz" varchar(20);--> statement-breakpoint
ALTER TABLE "lieferanten" ADD COLUMN IF NOT EXISTS "ort" varchar(100);--> statement-breakpoint
ALTER TABLE "lieferanten" ADD COLUMN IF NOT EXISTS "land" varchar(2) DEFAULT 'AT' NOT NULL;--> statement-breakpoint
ALTER TABLE "lieferanten" ADD COLUMN IF NOT EXISTS "uid" varchar(30);--> statement-breakpoint
ALTER TABLE "lieferanten" ADD COLUMN IF NOT EXISTS "kundennummer" varchar(60);--> statement-breakpoint
ALTER TABLE "lieferanten" ADD COLUMN IF NOT EXISTS "zahlungsbedingung" varchar(200);--> statement-breakpoint
ALTER TABLE "lieferanten" ADD COLUMN IF NOT EXISTS "lieferzeit_tage" integer;--> statement-breakpoint
ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "ean" varchar(20);--> statement-breakpoint
ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "einkaufspreis_cent" integer;--> statement-breakpoint
ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "lieferanten_artikelnummer" varchar(60);--> statement-breakpoint
ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "hersteller" varchar(100);--> statement-breakpoint
ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "hersteller_artikelnummer" varchar(60);
