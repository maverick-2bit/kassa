-- Aktionen: Mengenaktion "kaufe X, zahle Y" (je Artikel oder ueber die ganze Auswahl) und Ende nach X Aktionstagen
ALTER TABLE "preisregeln" ADD COLUMN IF NOT EXISTS "menge_kauf" integer;--> statement-breakpoint
ALTER TABLE "preisregeln" ADD COLUMN IF NOT EXISTS "menge_zahle" integer;--> statement-breakpoint
ALTER TABLE "preisregeln" ADD COLUMN IF NOT EXISTS "menge_modus" varchar(10);--> statement-breakpoint
ALTER TABLE "preisregeln" ADD COLUMN IF NOT EXISTS "wiederholungen" integer;
