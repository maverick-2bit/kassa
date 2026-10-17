-- Offene Meldungen zu Bons, die der SERVER selbst ausgeloest hat (Direktverkauf-Beleg mit Kuechenartikeln,
-- Gast-Bestellung, SB-Terminal): dort wartet an der Kasse niemand auf die Antwort der Bonierung. Kam ein Bon nicht
-- an (toter Kuechendrucker) oder liegt er am Backup-Drucker, steht hier eine Zeile je Bestellung, bis das Personal
-- "Verstanden" druckt oder "Nochmal senden" alles zugestellt hat. Die Kasse fragt die Liste ab (Banner) und bekommt
-- ueber SSE einen Anstoss zum Neuladen. eingabe/sb = die Bonierung fuer "Nochmal senden" (mit derselben Bestell-ID).
CREATE TABLE IF NOT EXISTS "bon_probleme" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id"  uuid NOT NULL,
  "kasse_id"    uuid NOT NULL,
  "quelle"      varchar(20) NOT NULL,
  "tisch"       varchar(60) NOT NULL,
  "bestell_id"  uuid NOT NULL,
  "eingabe"     jsonb NOT NULL,
  "sb"          jsonb,
  "fehler"      jsonb NOT NULL DEFAULT '[]'::jsonb,
  "umleitungen" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "erledigt_at" timestamp with time zone,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"  timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bon_probleme" ADD CONSTRAINT "bon_probleme_mandant_id_mandanten_id_fk"
   FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bon_probleme" ADD CONSTRAINT "bon_probleme_kasse_id_kassen_id_fk"
   FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bon_probleme_bestell_idx" ON "bon_probleme" USING btree ("bestell_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bon_probleme_kasse_idx" ON "bon_probleme" USING btree ("kasse_id","erledigt_at");
