CREATE TABLE "portal_benutzer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(200) NOT NULL,
	"passwort_hash" varchar(100) NOT NULL,
	"totp_geheimnis" varchar(300),
	"totp_aktiv" boolean DEFAULT false NOT NULL,
	"totp_letzter_schritt" bigint,
	"aktiv" boolean DEFAULT true NOT NULL,
	"fehlversuche" integer DEFAULT 0 NOT NULL,
	"gesperrt_bis" timestamp with time zone,
	"letzter_login" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_betriebe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"notiz" varchar(2000),
	"aktiv" boolean DEFAULT true NOT NULL,
	"module" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_boxen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"betrieb_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_hinweis" varchar(8) NOT NULL,
	"aktiv" boolean DEFAULT true NOT NULL,
	"token_erneuert_am" timestamp with time zone,
	"zuletzt_gesehen" timestamp with time zone,
	"version" varchar(40),
	"meldung" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_fehler" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"box_id" uuid NOT NULL,
	"hash" varchar(40) NOT NULL,
	"name" varchar(100) NOT NULL,
	"meldung" varchar(300) NOT NULL,
	"route" varchar(200),
	"anzahl" integer NOT NULL,
	"erster_am" timestamp with time zone NOT NULL,
	"letzter_am" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_boxen" ADD CONSTRAINT "portal_boxen_betrieb_id_portal_betriebe_id_fk" FOREIGN KEY ("betrieb_id") REFERENCES "public"."portal_betriebe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_fehler" ADD CONSTRAINT "portal_fehler_box_id_portal_boxen_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."portal_boxen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_benutzer_email_idx" ON "portal_benutzer" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_betriebe_name_idx" ON "portal_betriebe" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_boxen_token_idx" ON "portal_boxen" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "portal_boxen_betrieb_idx" ON "portal_boxen" USING btree ("betrieb_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_fehler_box_hash_idx" ON "portal_fehler" USING btree ("box_id","hash");--> statement-breakpoint
CREATE INDEX "portal_fehler_letzter_idx" ON "portal_fehler" USING btree ("box_id","letzter_am");