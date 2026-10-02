-- Asello-Layout: Untergruppen-Baum + freie Raster-Position der Artikel.
--
-- kategorien.parent_id  : übergeordnete Warengruppe (null = Hauptgruppe/Reiter)
-- artikel.raster_position: Slot 1..n im Raster der Warengruppe; fehlende
--   Nummern sind leere Felder, null = hinten nach reihenfolge anhängen.
-- Farben (kategorien.farbe / artikel.farbe, varchar(20)) nehmen zusätzlich
-- Hex-Werte #rrggbb auf — keine Spaltenänderung nötig.
ALTER TABLE "kategorien" ADD COLUMN IF NOT EXISTS "parent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kategorien" ADD CONSTRAINT "kategorien_parent_id_kategorien_id_fk"
   FOREIGN KEY ("parent_id") REFERENCES "kategorien"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kategorien_parent_idx" ON "kategorien" ("parent_id");--> statement-breakpoint
ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "raster_position" integer;
