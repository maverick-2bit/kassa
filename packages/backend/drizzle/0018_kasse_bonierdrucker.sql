-- Migration 0018: Bonierdrucker-Sichtbarkeit pro Kasse
--
-- Bonierdrucker sind mandantweite Geraete. Bei mehreren Kassen soll pro Kasse
-- waehlbar sein, welche Bonierdrucker aktiv sind. Dieser Join haelt die Auswahl.
-- Existiert fuer eine Kasse KEIN Eintrag, gelten (abwaertskompatibel) ALLE
-- Bonierdrucker des Mandanten. Alle Statements sind idempotent.

CREATE TABLE IF NOT EXISTS "kasse_bonierdrucker_sichtbarkeit" (
	"kasse_id" uuid NOT NULL,
	"bonierdrucker_id" uuid NOT NULL,
	CONSTRAINT "kasse_bonierdrucker_sichtbarkeit_kasse_id_bonierdrucker_id_pk" PRIMARY KEY("kasse_id","bonierdrucker_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_bonierdrucker_sichtbarkeit" ADD CONSTRAINT "kbs_kasse_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_bonierdrucker_sichtbarkeit" ADD CONSTRAINT "kbs_bonierdrucker_id_fk" FOREIGN KEY ("bonierdrucker_id") REFERENCES "public"."bonierdrucker"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kbs_kasse_idx" ON "kasse_bonierdrucker_sichtbarkeit" USING btree ("kasse_id");
