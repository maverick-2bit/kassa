-- Artikel-Anordnung je Kasse + Warengruppe (eigenes Kachel-Raster).
--
-- Jede Kasse kann je Warengruppe ihre Artikel selbst anordnen (z. B. weil sie 4 statt
-- der 3 Spalten des Import-Layouts hat). Semantik:
--  - Existiert für (Kasse, Warengruppe) mindestens eine Zeile, gilt diese Anordnung:
--    platzierte Artikel stehen an ihrem Slot (position = 1-basierter Slot im Raster der
--    Warengruppe NACH den Untergruppen-Kacheln), fehlende Slotnummern sind leere Felder,
--    ausgeblendete Artikel erscheinen an dieser Kasse dort nicht, Artikel ohne Zeile
--    werden hinten angehängt.
--  - Keine Zeile = Standard-Layout (artikel.raster_position).
--  - Zeilen, deren Artikel inzwischen in einer anderen Warengruppe liegt, werden
--    ignoriert (Lesepfad filtert auf artikel.kategorie_id).
-- Kasse, Warengruppe und Artikel hängen per ON DELETE CASCADE an den Zeilen.
CREATE TABLE IF NOT EXISTS "kasse_artikel_layout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	"kategorie_id" uuid NOT NULL,
	"artikel_id" uuid NOT NULL,
	"position" integer,
	"ausgeblendet" boolean DEFAULT false NOT NULL,
	CONSTRAINT "kasse_artikel_layout_position_check" CHECK (
		("ausgeblendet" AND "position" IS NULL)
		OR (NOT "ausgeblendet" AND "position" IS NOT NULL AND "position" >= 1)
	)
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_artikel_layout" ADD CONSTRAINT "kasse_artikel_layout_mandant_id_mandanten_id_fk"
   FOREIGN KEY ("mandant_id") REFERENCES "mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_artikel_layout" ADD CONSTRAINT "kasse_artikel_layout_kasse_id_kassen_id_fk"
   FOREIGN KEY ("kasse_id") REFERENCES "kassen"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_artikel_layout" ADD CONSTRAINT "kasse_artikel_layout_kategorie_id_kategorien_id_fk"
   FOREIGN KEY ("kategorie_id") REFERENCES "kategorien"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_artikel_layout" ADD CONSTRAINT "kasse_artikel_layout_artikel_id_artikel_id_fk"
   FOREIGN KEY ("artikel_id") REFERENCES "artikel"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kasse_artikel_layout_artikel_idx" ON "kasse_artikel_layout" ("kasse_id","kategorie_id","artikel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kasse_artikel_layout_position_idx" ON "kasse_artikel_layout" ("kasse_id","kategorie_id","position") WHERE "position" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kasse_artikel_layout_kategorie_idx" ON "kasse_artikel_layout" ("kategorie_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kasse_artikel_layout_artikel_fk_idx" ON "kasse_artikel_layout" ("artikel_id");
