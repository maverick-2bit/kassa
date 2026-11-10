-- Einkaufsbestellungen: Bestellung beim Lieferanten (Kopf + Positionen)
CREATE TABLE IF NOT EXISTS "einkauf_bestellungen" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id" uuid NOT NULL,
  "nummer" varchar(20) NOT NULL,
  "lieferant_id" uuid NOT NULL,
  "status" varchar(20) DEFAULT 'entwurf' NOT NULL,
  "bemerkung" text,
  "liefertermin" date,
  "gesendet_am" timestamp with time zone,
  "gesendet_an" varchar(200),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "einkauf_bestellpositionen" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bestellung_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "artikel_id" uuid,
  "bezeichnung" text NOT NULL,
  "lieferanten_artikelnummer" varchar(60),
  "menge" integer NOT NULL,
  "einkaufspreis_cent" integer,
  "geliefert_menge" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "einkauf_bestellungen" ADD CONSTRAINT "einkauf_bestellungen_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "mandanten"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "einkauf_bestellungen" ADD CONSTRAINT "einkauf_bestellungen_lieferant_id_lieferanten_id_fk" FOREIGN KEY ("lieferant_id") REFERENCES "lieferanten"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "einkauf_bestellpositionen" ADD CONSTRAINT "einkauf_bestellpositionen_bestellung_id_fk" FOREIGN KEY ("bestellung_id") REFERENCES "einkauf_bestellungen"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "einkauf_bestellpositionen" ADD CONSTRAINT "einkauf_bestellpositionen_artikel_id_fk" FOREIGN KEY ("artikel_id") REFERENCES "artikel"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "einkauf_bestellungen_nummer_idx" ON "einkauf_bestellungen" USING btree ("mandant_id","nummer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "einkauf_bestellungen_lieferant_idx" ON "einkauf_bestellungen" USING btree ("lieferant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "einkauf_bestellungen_status_idx" ON "einkauf_bestellungen" USING btree ("mandant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "einkauf_bestellpositionen_bestellung_idx" ON "einkauf_bestellpositionen" USING btree ("bestellung_id");
