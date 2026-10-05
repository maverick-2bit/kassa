-- Bonierung je Bestell-ID (Idempotenz fuer "Nochmal senden"): pro Bestell-ID wird gemerkt, was schon
-- zugestellt wurde. Ein erneuter Aufruf legt keinen zweiten KDS-Bon an, bucht den Lagerstand nicht
-- doppelt ab und sendet nur an die Ziele, die vorher gescheitert sind. ergebnis NULL = laeuft noch.
CREATE TABLE IF NOT EXISTS "bonier_bestellungen" (
  "bestell_id" uuid PRIMARY KEY NOT NULL,
  "mandant_id" uuid NOT NULL,
  "kasse_id"   uuid NOT NULL,
  "bon_nummer" varchar(20) NOT NULL,
  "ergebnis"   jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bonier_bestellungen" ADD CONSTRAINT "bonier_bestellungen_mandant_id_mandanten_id_fk"
   FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bonier_bestellungen" ADD CONSTRAINT "bonier_bestellungen_kasse_id_kassen_id_fk"
   FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bonier_bestellungen_created_idx" ON "bonier_bestellungen" USING btree ("created_at");