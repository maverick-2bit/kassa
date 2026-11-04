-- Wartungsrechnungen: Zahlungsangaben des Betriebs (Rechnungs-A4), Kunden-Schalter "Rechnung per E-Mail" und
-- Versand-/Buchhaltungs-Stand der Sammelrechnung (automatischer Versand, Sammelliste zum A4-Druck).
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "rechnung_iban" varchar(34);--> statement-breakpoint
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "rechnung_bic" varchar(11);--> statement-breakpoint
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "rechnung_zahlungsziel_tage" integer NOT NULL DEFAULT 14;--> statement-breakpoint
ALTER TABLE "kunden" ADD COLUMN IF NOT EXISTS "rechnung_per_mail" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "wartungsvertrag_id" uuid;--> statement-breakpoint
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "email_empfaenger" varchar(200);--> statement-breakpoint
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "email_versandt_am" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "email_fehler" text;--> statement-breakpoint
ALTER TABLE "sammelrechnungen" ADD COLUMN IF NOT EXISTS "buchhaltung_gedruckt_am" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sammelrechnungen" ADD CONSTRAINT "sammelrechnungen_wartungsvertrag_id_wartungsvertraege_id_fk"
   FOREIGN KEY ("wartungsvertrag_id") REFERENCES "public"."wartungsvertraege"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sammelrechnungen_versand_idx" ON "sammelrechnungen" USING btree ("mandant_id","email_versandt_am","buchhaltung_gedruckt_am");
