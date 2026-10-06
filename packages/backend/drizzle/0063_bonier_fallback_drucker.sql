-- Fester Fallback-Bonierdrucker je Mandant: scheitert ein Bonierdruck auf dem vorgesehenen Drucker (und auf
-- dessen eigenem Fallback), geht der Bon an diesen Drucker - damit kein Bon verloren geht.
CREATE TABLE IF NOT EXISTS "bonier_fallback_drucker" (
  "mandant_id"       uuid PRIMARY KEY NOT NULL,
  "bonierdrucker_id" uuid NOT NULL,
  "updated_at"       timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bonier_fallback_drucker" ADD CONSTRAINT "bonier_fallback_drucker_mandant_id_mandanten_id_fk"
   FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bonier_fallback_drucker" ADD CONSTRAINT "bonier_fallback_drucker_bonierdrucker_id_bonierdrucker_id_fk"
   FOREIGN KEY ("bonierdrucker_id") REFERENCES "public"."bonierdrucker"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;