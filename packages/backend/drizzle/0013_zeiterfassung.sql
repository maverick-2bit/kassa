ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "modul_zeiterfassung_aktiv" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "arbeitszeiten" (
	"id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id"     uuid NOT NULL REFERENCES "mandanten"("id"),
	"kasse_id"       uuid NOT NULL REFERENCES "kassen"("id") ON DELETE CASCADE,
	"user_id"        uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"user_name"      text NOT NULL,
	"beginn"         timestamp with time zone NOT NULL,
	"ende"           timestamp with time zone,
	"pause_minuten"  integer NOT NULL DEFAULT 0,
	"notiz"          text,
	"quelle"         varchar(10) NOT NULL DEFAULT 'pin',
	"created_at"     timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at"     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "arbeitszeiten_mandant_user_idx"   ON "arbeitszeiten" ("mandant_id", "user_id");
CREATE INDEX IF NOT EXISTS "arbeitszeiten_mandant_beginn_idx" ON "arbeitszeiten" ("mandant_id", "beginn");
CREATE INDEX IF NOT EXISTS "arbeitszeiten_offenes_idx"        ON "arbeitszeiten" ("mandant_id", "user_id", "ende");
