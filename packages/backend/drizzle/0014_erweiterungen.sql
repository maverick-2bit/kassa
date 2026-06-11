-- Feature 7: Tagesabschluss-E-Mail pro Kasse
ALTER TABLE "kassen" ADD COLUMN "abschluss_email" text;

-- Feature 5: Self-Checkout via QR
ALTER TABLE "kassen" ADD COLUMN "self_checkout_aktiv" boolean NOT NULL DEFAULT false;

-- Feature 6: Kundendisplay-Werbefolien
CREATE TABLE "werbefolien" (
	"id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id"       uuid NOT NULL REFERENCES "mandanten"("id"),
	"titel"            text NOT NULL DEFAULT '',
	"bild_base64"      text NOT NULL,
	"mime_type"        varchar(50) NOT NULL DEFAULT 'image/jpeg',
	"reihenfolge"      integer NOT NULL DEFAULT 0,
	"aktiv"            boolean NOT NULL DEFAULT true,
	"anzeigedauer_sek" integer NOT NULL DEFAULT 8,
	"created_at"       timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "werbefolien_mandant_idx" ON "werbefolien" ("mandant_id", "reihenfolge");

-- Feature 3: Dienstplan-Schichten
CREATE TABLE "dienstplan_schichten" (
	"id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id"      uuid NOT NULL REFERENCES "mandanten"("id"),
	"kasse_id"        uuid NOT NULL REFERENCES "kassen"("id") ON DELETE CASCADE,
	"user_id"         uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"user_name"       text NOT NULL,
	"datum"           varchar(10) NOT NULL,
	"beginn_geplant"  varchar(5)  NOT NULL,
	"ende_geplant"    varchar(5)  NOT NULL,
	"position"        text,
	"notiz"           text,
	"status"          varchar(20) NOT NULL DEFAULT 'geplant',
	"created_at"      timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "dienstplan_mandant_datum_idx" ON "dienstplan_schichten" ("mandant_id", "datum");
CREATE INDEX "dienstplan_kasse_datum_idx"   ON "dienstplan_schichten" ("kasse_id",   "datum");
