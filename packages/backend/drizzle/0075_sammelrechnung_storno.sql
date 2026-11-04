-- Sammelrechnung stornieren: die Rechnung bleibt (lueckenlose Nummer), gilt aber als storniert; ihre Lieferscheine
-- werden wieder offen und sind erneut verrechenbar. "manuell_verrechnen" haelt sie aus der Auto-Rechnung heraus,
-- damit die Kassa eine stornierte Rechnung nicht von selbst neu erstellt und verschickt.
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "storniert_am" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "storno_grund" text;--> statement-breakpoint
ALTER TABLE "lieferscheine" ADD COLUMN IF NOT EXISTS "manuell_verrechnen" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "offene_posten" ADD COLUMN IF NOT EXISTS "sammelrechnung_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "offene_posten" ADD CONSTRAINT "offene_posten_sammelrechnung_id_sammelrechnungen_id_fk"
   FOREIGN KEY ("sammelrechnung_id") REFERENCES "public"."sammelrechnungen"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offene_posten_sammelrechnung_idx" ON "offene_posten" USING btree ("sammelrechnung_id");
