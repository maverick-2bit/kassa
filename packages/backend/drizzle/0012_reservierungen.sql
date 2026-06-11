ALTER TABLE "mandanten" ADD COLUMN "modul_reservierungen_aktiv" boolean NOT NULL DEFAULT false;
ALTER TABLE "kassen"    ADD COLUMN "online_buchung_aktiv"        boolean NOT NULL DEFAULT false;

CREATE TABLE "reservierungen" (
	"id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id"       uuid NOT NULL REFERENCES "mandanten"("id"),
	"kasse_id"         uuid NOT NULL REFERENCES "kassen"("id") ON DELETE CASCADE,
	"datum"            varchar(10) NOT NULL,
	"zeit_von"         varchar(5)  NOT NULL,
	"dauer"            integer     NOT NULL DEFAULT 90,
	"personen_anzahl"  integer     NOT NULL,
	"name"             text        NOT NULL,
	"telefon"          text,
	"email"            text,
	"notiz"            text,
	"tisch_label"      text,
	"status"           varchar(20) NOT NULL DEFAULT 'bestaetigt',
	"quelle"           varchar(10) NOT NULL DEFAULT 'intern',
	"online_token"     uuid        NOT NULL DEFAULT gen_random_uuid(),
	"created_at"       timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX        "reservierungen_mandant_datum_idx" ON "reservierungen" ("mandant_id", "datum");
CREATE INDEX        "reservierungen_kasse_datum_idx"   ON "reservierungen" ("kasse_id",   "datum");
CREATE UNIQUE INDEX "reservierungen_online_token_idx"  ON "reservierungen" ("online_token");
