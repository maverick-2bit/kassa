-- Freigabe: Wartungsrechnungen werden erstellt, aber erst nach Freigabe versendet bzw. gedruckt.
-- freigegeben_am = Zeitpunkt der Freigabe (null = wartet auf Freigabe).
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "freigegeben_am" timestamp with time zone;--> statement-breakpoint
-- Bereits verschickte Rechnungen gelten als freigegeben (Bestand aus der Zeit vor der Freigabe)
UPDATE "sammelrechnungen" SET "freigegeben_am" = COALESCE("email_versandt_am", "created_at")
  WHERE "wartungsvertrag_id" IS NOT NULL AND "freigegeben_am" IS NULL AND "email_versandt_am" IS NOT NULL;
--> statement-breakpoint
-- Stornorechnung: eigene Nummer je Storno + Mailversand an den Kunden (nur wenn die Rechnung per Mail rausging)
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "storno_nummer" integer;--> statement-breakpoint
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "storno_email_versandt_am" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "storno_email_fehler" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sammelrechnungen_mandant_storno_nummer_idx" ON "sammelrechnungen" USING btree ("mandant_id","storno_nummer") WHERE "storno_nummer" IS NOT NULL;