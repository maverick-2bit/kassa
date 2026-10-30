-- Wartungsvertraege: wiederkehrende Leistungen je Kunde. Zum Monatswechsel entsteht je Vertrag ein
-- Wartungslieferschein (lieferscheine.wartungsvertrag_id + periode), spaeter die Sammelrechnung.
-- Je Position ein eigenes Intervall (z. B. RKSV-Zertifikat nur jaehrlich) mit Faelligkeitsmonat.
CREATE TABLE IF NOT EXISTS "wartungsvertraege" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id"          uuid NOT NULL,
  "kasse_id"            uuid NOT NULL,
  "kunde_id"            uuid NOT NULL,
  "nummer"              integer NOT NULL,
  "bezeichnung"         varchar(200) NOT NULL,
  "beginn"              varchar(10) NOT NULL,
  "ende"                varchar(10),
  "rechnungs_intervall" varchar(12) NOT NULL DEFAULT 'monatlich',
  "status"              varchar(12) NOT NULL DEFAULT 'aktiv',
  "notiz"               text,
  "created_at"          timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"          timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wartungsvertrag_positionen" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vertrag_id"              uuid NOT NULL,
  "reihenfolge"             integer NOT NULL DEFAULT 0,
  "artikel_id"              uuid,
  "bezeichnung"             varchar(200) NOT NULL,
  "menge"                   integer NOT NULL DEFAULT 1,
  "einzelpreis_brutto_cent" integer NOT NULL,
  "mwst_satz"               varchar(20) NOT NULL,
  "intervall"               varchar(12) NOT NULL DEFAULT 'monatlich',
  "anker_monat"             integer
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wartungsvertraege" ADD CONSTRAINT "wartungsvertraege_mandant_id_mandanten_id_fk"
   FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wartungsvertraege" ADD CONSTRAINT "wartungsvertraege_kasse_id_kassen_id_fk"
   FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wartungsvertraege" ADD CONSTRAINT "wartungsvertraege_kunde_id_kunden_id_fk"
   FOREIGN KEY ("kunde_id") REFERENCES "public"."kunden"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wartungsvertrag_positionen" ADD CONSTRAINT "wartungsvertrag_positionen_vertrag_id_wartungsvertraege_id_fk"
   FOREIGN KEY ("vertrag_id") REFERENCES "public"."wartungsvertraege"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wartungsvertraege_mandant_nummer_idx" ON "wartungsvertraege" USING btree ("mandant_id","nummer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wartungsvertraege_kunde_idx" ON "wartungsvertraege" USING btree ("mandant_id","kunde_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wartungsvertraege_status_idx" ON "wartungsvertraege" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wartungsvertrag_positionen_vertrag_idx" ON "wartungsvertrag_positionen" USING btree ("vertrag_id");--> statement-breakpoint
-- Lieferschein: Angebotsbezug optional, dafuer Vertragsbezug + Abrechnungsmonat
ALTER TABLE "lieferscheine" ALTER COLUMN "angebot_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lieferscheine" ADD COLUMN IF NOT EXISTS "wartungsvertrag_id" uuid;--> statement-breakpoint
ALTER TABLE "lieferscheine" ADD COLUMN IF NOT EXISTS "periode" varchar(7);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lieferscheine" ADD CONSTRAINT "lieferscheine_wartungsvertrag_id_wartungsvertraege_id_fk"
   FOREIGN KEY ("wartungsvertrag_id") REFERENCES "public"."wartungsvertraege"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lieferscheine_vertrag_periode_idx" ON "lieferscheine" USING btree ("wartungsvertrag_id","periode") WHERE "wartungsvertrag_id" IS NOT NULL;
