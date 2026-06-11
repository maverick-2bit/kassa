CREATE TABLE "lieferbestellungen" (
	"id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id"          uuid NOT NULL REFERENCES "mandanten"("id"),
	"kasse_id"            uuid NOT NULL REFERENCES "kassen"("id") ON DELETE CASCADE,
	"externe_id"          text NOT NULL,
	"provider"            varchar(40) NOT NULL,
	"status"              varchar(20) NOT NULL DEFAULT 'neu',
	"positionen"          jsonb NOT NULL,
	"gesamtbetrag_cent"   integer NOT NULL,
	"liefer_name"         text,
	"liefer_telefon"      text,
	"liefer_adresse"      text,
	"notiz"               text,
	"roh_daten"           jsonb NOT NULL DEFAULT '{}',
	"created_at"          timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at"          timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "lieferbestellungen_kasse_idx"  ON "lieferbestellungen" ("kasse_id");
CREATE INDEX "lieferbestellungen_status_idx" ON "lieferbestellungen" ("mandant_id", "status");
CREATE UNIQUE INDEX "lieferbestellungen_externe_idx" ON "lieferbestellungen" ("provider", "externe_id");
