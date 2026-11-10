-- Preislisten: Sonderpreise je Kunde (z. B. fuer einen Grosskunden), manuell am Kunden zugewiesen
CREATE TABLE IF NOT EXISTS "preislisten" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id" uuid NOT NULL,
  "name" varchar(80) NOT NULL,
  "aktiv" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "preislisten_preise" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "preisliste_id" uuid NOT NULL,
  "artikel_id" uuid NOT NULL,
  "preis_brutto_cent" integer NOT NULL
);--> statement-breakpoint
ALTER TABLE "kunden" ADD COLUMN IF NOT EXISTS "preisliste_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "preislisten" ADD CONSTRAINT "preislisten_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "mandanten"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "preislisten_preise" ADD CONSTRAINT "preislisten_preise_preisliste_id_fk" FOREIGN KEY ("preisliste_id") REFERENCES "preislisten"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "preislisten_preise" ADD CONSTRAINT "preislisten_preise_artikel_id_fk" FOREIGN KEY ("artikel_id") REFERENCES "artikel"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "kunden" ADD CONSTRAINT "kunden_preisliste_id_fk" FOREIGN KEY ("preisliste_id") REFERENCES "preislisten"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preislisten_mandant_name_idx" ON "preislisten" USING btree ("mandant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preislisten_preise_eindeutig_idx" ON "preislisten_preise" USING btree ("preisliste_id","artikel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preislisten_preise_artikel_idx" ON "preislisten_preise" USING btree ("artikel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kunden_preisliste_idx" ON "kunden" USING btree ("preisliste_id");
