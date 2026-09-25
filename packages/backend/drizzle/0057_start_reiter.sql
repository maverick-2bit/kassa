-- Start-Reiter der Artikelwahl je Kasse (Kasse direkt, Tisch, Kellner-App).
--
-- Der Reiter „Alle" zeigte an der Kasse jeden Artikel — auch aus Warengruppen,
-- die der Kasse gar nicht zugeordnet sind. Er entfällt; stattdessen öffnet die
-- Artikelwahl mit den Favoriten (Standard) oder einer gewählten Warengruppe
-- (null = erste sichtbare Warengruppe).
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "start_favoriten" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "start_kategorie_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kassen" ADD CONSTRAINT "kassen_start_kategorie_id_kategorien_id_fk"
   FOREIGN KEY ("start_kategorie_id") REFERENCES "kategorien"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
