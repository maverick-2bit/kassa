-- Papierdruck der KDS-Bons (Erledigt-Bon, Teilbon, Nachdrucken) je Station: dieser Bonierdrucker druckt
-- fuer diese Station. Ohne Eintrag gilt wie frueher "alle aktiven Nicht-Backup-Bonierdrucker".
CREATE TABLE IF NOT EXISTS "kds_station_drucker" (
  "mandant_id"       uuid NOT NULL,
  "station"          varchar(20) NOT NULL,
  "bonierdrucker_id" uuid NOT NULL,
  "updated_at"       timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kds_station_drucker_mandant_id_station_pk" PRIMARY KEY ("mandant_id", "station")
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kds_station_drucker" ADD CONSTRAINT "kds_station_drucker_mandant_id_mandanten_id_fk"
   FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kds_station_drucker" ADD CONSTRAINT "kds_station_drucker_bonierdrucker_id_bonierdrucker_id_fk"
   FOREIGN KEY ("bonierdrucker_id") REFERENCES "public"."bonierdrucker"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;