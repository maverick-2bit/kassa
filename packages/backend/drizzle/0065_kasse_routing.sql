-- Kassen-Ausnahmen beim Bon-Routing (Einstellungen → Kassen: Warengruppen/Artikel je Kasse auf andere
-- Drucker bzw. KDS-Stationen legen).
--
-- Allgemein gilt weiter die Vorgabe der Warengruppe (kategorien.bonierdrucker_id / station) bzw. des
-- Artikels (artikel.bonierdrucker_id / station). Eine Zeile hier gilt NUR an der genannten Kasse und geht
-- vor. Rangfolge: Artikel an der Kasse → Artikel allgemein → Warengruppe an der Kasse → Warengruppe allgemein.
--  - Keine Zeile = die allgemeine Vorgabe gilt (abwaertskompatibel).
--  - kein_drucker / keine_station = ausdruecklich kein Drucker / keine Station an dieser Kasse.
--  - Genau eines von kategorie_id / artikel_id ist gesetzt.
-- Kasse, Warengruppe und Artikel haengen per ON DELETE CASCADE an den Zeilen; wird ein Bonierdrucker
-- geloescht, faellt die Zeile fuer den Drucker auf "keine Angabe" zurueck (SET NULL).
CREATE TABLE IF NOT EXISTS "kasse_routing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	"kategorie_id" uuid,
	"artikel_id" uuid,
	"bonierdrucker_id" uuid,
	"kein_drucker" boolean DEFAULT false NOT NULL,
	"station" varchar(20),
	"keine_station" boolean DEFAULT false NOT NULL,
	CONSTRAINT "kasse_routing_ziel_check" CHECK (("kategorie_id" IS NULL) <> ("artikel_id" IS NULL)),
	CONSTRAINT "kasse_routing_drucker_check" CHECK (NOT ("kein_drucker" AND "bonierdrucker_id" IS NOT NULL)),
	CONSTRAINT "kasse_routing_station_check" CHECK (NOT ("keine_station" AND "station" IS NOT NULL))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_routing" ADD CONSTRAINT "kasse_routing_mandant_id_mandanten_id_fk"
   FOREIGN KEY ("mandant_id") REFERENCES "mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_routing" ADD CONSTRAINT "kasse_routing_kasse_id_kassen_id_fk"
   FOREIGN KEY ("kasse_id") REFERENCES "kassen"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_routing" ADD CONSTRAINT "kasse_routing_kategorie_id_kategorien_id_fk"
   FOREIGN KEY ("kategorie_id") REFERENCES "kategorien"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_routing" ADD CONSTRAINT "kasse_routing_artikel_id_artikel_id_fk"
   FOREIGN KEY ("artikel_id") REFERENCES "artikel"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_routing" ADD CONSTRAINT "kasse_routing_bonierdrucker_id_bonierdrucker_id_fk"
   FOREIGN KEY ("bonierdrucker_id") REFERENCES "bonierdrucker"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kasse_routing_kategorie_idx" ON "kasse_routing" ("kasse_id","kategorie_id") WHERE "kategorie_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kasse_routing_artikel_idx" ON "kasse_routing" ("kasse_id","artikel_id") WHERE "artikel_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kasse_routing_kategorie_fk_idx" ON "kasse_routing" ("kategorie_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kasse_routing_artikel_fk_idx" ON "kasse_routing" ("artikel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kasse_routing_drucker_fk_idx" ON "kasse_routing" ("bonierdrucker_id");
