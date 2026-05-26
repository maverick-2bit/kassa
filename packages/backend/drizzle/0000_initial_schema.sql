CREATE TABLE IF NOT EXISTS "angebote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	"nummer" integer NOT NULL,
	"datum" timestamp with time zone DEFAULT now() NOT NULL,
	"gueltig_bis" varchar(10),
	"status" varchar(20) DEFAULT 'offen' NOT NULL,
	"notiz" text,
	"positionen" jsonb NOT NULL,
	"gesamtbetrag_cent" integer NOT NULL,
	"kunde_id" uuid,
	"kunde_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artikel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"bezeichnung" text NOT NULL,
	"preis_brutto_cent" integer NOT NULL,
	"mwst_satz" varchar(20) NOT NULL,
	"artikelnummer" varchar(40),
	"station" varchar(20),
	"kategorie_id" uuid,
	"aktiv" boolean DEFAULT true NOT NULL,
	"lagerstand_aktiv" boolean DEFAULT false NOT NULL,
	"lagerstand_menge" integer,
	"mindestbestand" integer,
	"ist_favorit" boolean DEFAULT false NOT NULL,
	"reihenfolge" integer DEFAULT 0 NOT NULL,
	"favoriten_reihenfolge" integer DEFAULT 0 NOT NULL,
	"bonierdrucker_id" uuid,
	"bild" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artikel_modifikator_gruppen" (
	"artikel_id" uuid NOT NULL,
	"gruppe_id" uuid NOT NULL,
	"reihenfolge" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "artikel_modifikator_gruppen_artikel_id_gruppe_id_pk" PRIMARY KEY("artikel_id","gruppe_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "belege" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	"beleg_nummer" integer NOT NULL,
	"beleg_datum" timestamp with time zone NOT NULL,
	"beleg_typ" varchar(30) NOT NULL,
	"betrag_normal_cent" integer DEFAULT 0 NOT NULL,
	"betrag_ermaessigt1_cent" integer DEFAULT 0 NOT NULL,
	"betrag_ermaessigt2_cent" integer DEFAULT 0 NOT NULL,
	"betrag_null_cent" integer DEFAULT 0 NOT NULL,
	"betrag_besonders_cent" integer DEFAULT 0 NOT NULL,
	"summe_bar_cent" integer DEFAULT 0 NOT NULL,
	"summe_karte_cent" integer DEFAULT 0 NOT NULL,
	"summe_sonstige_cent" integer DEFAULT 0 NOT NULL,
	"umsatzzaehler_verschluesselt" text NOT NULL,
	"zertifikat_sn" text NOT NULL,
	"sig_vorbeleg" text NOT NULL,
	"signaturwert" text NOT NULL,
	"maschinenlesbare_code" text NOT NULL,
	"positionen" jsonb NOT NULL,
	"verweis_beleg_id" uuid,
	"kunde_id" uuid,
	"kunde_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bonierdrucker" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ip" varchar(64) NOT NULL,
	"port" integer DEFAULT 9100 NOT NULL,
	"ist_backup" boolean DEFAULT false NOT NULL,
	"aktiv" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gutschein_buchungen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gutschein_id" uuid NOT NULL,
	"mandant_id" uuid NOT NULL,
	"typ" varchar(20) NOT NULL,
	"betrag_cent" integer NOT NULL,
	"rest_cent_nach" integer NOT NULL,
	"beleg_id" uuid,
	"verknuepfter_gutschein_id" uuid,
	"notiz" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gutscheine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"nummer" integer NOT NULL,
	"datum" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(20) DEFAULT 'aktiv' NOT NULL,
	"betrag_cent" integer NOT NULL,
	"bezahlt_cent" integer DEFAULT 0 NOT NULL,
	"gueltig_bis" varchar(10),
	"kunde_id" uuid,
	"kunde_snapshot" jsonb,
	"notiz" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kasse_kategorie_sichtbarkeit" (
	"kasse_id" uuid NOT NULL,
	"kategorie_id" uuid NOT NULL,
	CONSTRAINT "kasse_kategorie_sichtbarkeit_kasse_id_kategorie_id_pk" PRIMARY KEY("kasse_id","kategorie_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kassen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kassen_id" varchar(40) NOT NULL,
	"bezeichnung" text,
	"status" varchar(20) DEFAULT 'aktiv' NOT NULL,
	"umgebung" varchar(20) DEFAULT 'produktion' NOT NULL,
	"see_zertifikat_der" text NOT NULL,
	"see_private_key_enc" text NOT NULL,
	"see_zertifikat_sn" text NOT NULL,
	"see_gueltig_bis" timestamp with time zone NOT NULL,
	"umsatzzaehler_cent" bigint DEFAULT 0 NOT NULL,
	"letzte_beleg_nummer" integer DEFAULT 0 NOT NULL,
	"letzter_signaturwert" text,
	"bei_fo_registriert" boolean DEFAULT false NOT NULL,
	"fo_pruefwert" text,
	"registriert_am" timestamp with time zone,
	"drucker_ip" varchar(64),
	"drucker_port" integer DEFAULT 9100 NOT NULL,
	"drucker_aktiv" boolean DEFAULT false NOT NULL,
	"drucker_breite_zeichen" integer DEFAULT 42 NOT NULL,
	"kds_stationen" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kds_port" integer DEFAULT 9100 NOT NULL,
	"kds_aktiv" boolean DEFAULT false NOT NULL,
	"erlaubte_zahlungsarten" jsonb DEFAULT '["bar","karte","sonstige"]'::jsonb NOT NULL,
	"artikel_bilder_aktiv" boolean DEFAULT true NOT NULL,
	"zvt_ip" varchar(64),
	"zvt_port" integer DEFAULT 20007 NOT NULL,
	"zvt_passwort" varchar(16),
	"zvt_aktiv" boolean DEFAULT false NOT NULL,
	"webhook_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kategorien" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"farbe" varchar(20) DEFAULT 'grau' NOT NULL,
	"reihenfolge" integer DEFAULT 0 NOT NULL,
	"aktiv" boolean DEFAULT true NOT NULL,
	"bonierdrucker_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kunden" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"nummer" integer NOT NULL,
	"firma" varchar(200),
	"vorname" varchar(100),
	"nachname" varchar(100),
	"email" varchar(200),
	"telefon" varchar(50),
	"strasse" varchar(200),
	"plz" varchar(20),
	"ort" varchar(100),
	"land" varchar(2) DEFAULT 'AT' NOT NULL,
	"uid" varchar(30),
	"aktiv" boolean DEFAULT true NOT NULL,
	"kredit_aktiv" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lieferbestellungen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	"externe_id" text NOT NULL,
	"provider" varchar(40) NOT NULL,
	"status" varchar(20) DEFAULT 'neu' NOT NULL,
	"positionen" jsonb NOT NULL,
	"gesamtbetrag_cent" integer NOT NULL,
	"liefer_name" text,
	"liefer_telefon" text,
	"liefer_adresse" text,
	"notiz" text,
	"roh_daten" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lieferscheine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	"angebot_id" uuid NOT NULL,
	"nummer" integer NOT NULL,
	"datum" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(20) DEFAULT 'offen' NOT NULL,
	"notiz" text,
	"positionen" jsonb NOT NULL,
	"kunde_id" uuid,
	"kunde_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mandanten" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firmenname" text NOT NULL,
	"uid" varchar(11) NOT NULL,
	"vorgaenger_id" uuid,
	"status" varchar(20) DEFAULT 'aktiv' NOT NULL,
	"modul_gastro_aktiv" boolean DEFAULT true NOT NULL,
	"modul_angebote_aktiv" boolean DEFAULT false NOT NULL,
	"modul_mergeport_aktiv" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "modifikator_gruppen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"typ" varchar(20) DEFAULT 'optional' NOT NULL,
	"max_auswahl" integer,
	"reihenfolge" integer DEFAULT 0 NOT NULL,
	"aktiv" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "modifikatoren" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"gruppe_id" uuid NOT NULL,
	"name" text NOT NULL,
	"aufschlag_cent" integer DEFAULT 0 NOT NULL,
	"reihenfolge" integer DEFAULT 0 NOT NULL,
	"aktiv" boolean DEFAULT true NOT NULL,
	"lagerstand_menge" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offene_posten" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"nummer" integer NOT NULL,
	"datum" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(20) DEFAULT 'offen' NOT NULL,
	"kunde_id" uuid,
	"kunde_snapshot" jsonb,
	"beleg_id" uuid,
	"betrag_cent" integer NOT NULL,
	"bezahlt_cent" integer DEFAULT 0 NOT NULL,
	"notiz" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sammelrechnungen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"nummer" integer NOT NULL,
	"datum" timestamp with time zone DEFAULT now() NOT NULL,
	"lieferschein_ids" jsonb NOT NULL,
	"gesamtbetrag_cent" integer NOT NULL,
	"kunde_id" uuid,
	"kunde_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tab_ereignisse" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"tab_id" uuid NOT NULL,
	"typ" varchar(40) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tisch_tabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	"tisch_nummer" varchar(40) NOT NULL,
	"kellner" varchar(100) DEFAULT 'Service' NOT NULL,
	"positionen" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'offen' NOT NULL,
	"geoffnet_am" timestamp with time zone DEFAULT now() NOT NULL,
	"geschlossen_am" timestamp with time zone,
	"beleg_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tischplan_bereiche" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	"name" text NOT NULL,
	"reihenfolge" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tischplan_elemente" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	"bereich_id" uuid NOT NULL,
	"bezeichnung" text NOT NULL,
	"form" varchar(20) DEFAULT 'rechteck' NOT NULL,
	"farbe" varchar(20) DEFAULT 'grau' NOT NULL,
	"x" real DEFAULT 10 NOT NULL,
	"y" real DEFAULT 10 NOT NULL,
	"breite" real DEFAULT 10 NOT NULL,
	"hoehe" real DEFAULT 8 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_kassen" (
	"user_id" uuid NOT NULL,
	"kasse_id" uuid NOT NULL,
	CONSTRAINT "user_kassen_user_id_kasse_id_pk" PRIMARY KEY("user_id","kasse_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL,
	"email" varchar(200) NOT NULL,
	"password_hash" text NOT NULL,
	"pin_hash" text,
	"name" text NOT NULL,
	"rolle" varchar(20) DEFAULT 'kellner' NOT NULL,
	"berechtigungen" jsonb NOT NULL,
	"aktiv" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "angebote" ADD CONSTRAINT "angebote_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "angebote" ADD CONSTRAINT "angebote_kasse_id_kassen_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "angebote" ADD CONSTRAINT "angebote_kunde_id_kunden_id_fk" FOREIGN KEY ("kunde_id") REFERENCES "public"."kunden"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artikel" ADD CONSTRAINT "artikel_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artikel" ADD CONSTRAINT "artikel_kategorie_id_kategorien_id_fk" FOREIGN KEY ("kategorie_id") REFERENCES "public"."kategorien"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artikel" ADD CONSTRAINT "artikel_bonierdrucker_id_bonierdrucker_id_fk" FOREIGN KEY ("bonierdrucker_id") REFERENCES "public"."bonierdrucker"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artikel_modifikator_gruppen" ADD CONSTRAINT "artikel_modifikator_gruppen_artikel_id_artikel_id_fk" FOREIGN KEY ("artikel_id") REFERENCES "public"."artikel"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artikel_modifikator_gruppen" ADD CONSTRAINT "artikel_modifikator_gruppen_gruppe_id_modifikator_gruppen_id_fk" FOREIGN KEY ("gruppe_id") REFERENCES "public"."modifikator_gruppen"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "belege" ADD CONSTRAINT "belege_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "belege" ADD CONSTRAINT "belege_kasse_id_kassen_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "belege" ADD CONSTRAINT "belege_verweis_beleg_id_belege_id_fk" FOREIGN KEY ("verweis_beleg_id") REFERENCES "public"."belege"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "belege" ADD CONSTRAINT "belege_kunde_id_kunden_id_fk" FOREIGN KEY ("kunde_id") REFERENCES "public"."kunden"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bonierdrucker" ADD CONSTRAINT "bonierdrucker_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gutschein_buchungen" ADD CONSTRAINT "gutschein_buchungen_gutschein_id_gutscheine_id_fk" FOREIGN KEY ("gutschein_id") REFERENCES "public"."gutscheine"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gutschein_buchungen" ADD CONSTRAINT "gutschein_buchungen_beleg_id_belege_id_fk" FOREIGN KEY ("beleg_id") REFERENCES "public"."belege"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gutscheine" ADD CONSTRAINT "gutscheine_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gutscheine" ADD CONSTRAINT "gutscheine_kunde_id_kunden_id_fk" FOREIGN KEY ("kunde_id") REFERENCES "public"."kunden"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_kategorie_sichtbarkeit" ADD CONSTRAINT "kasse_kategorie_sichtbarkeit_kasse_id_kassen_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kasse_kategorie_sichtbarkeit" ADD CONSTRAINT "kasse_kategorie_sichtbarkeit_kategorie_id_kategorien_id_fk" FOREIGN KEY ("kategorie_id") REFERENCES "public"."kategorien"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kassen" ADD CONSTRAINT "kassen_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kategorien" ADD CONSTRAINT "kategorien_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kategorien" ADD CONSTRAINT "kategorien_bonierdrucker_id_bonierdrucker_id_fk" FOREIGN KEY ("bonierdrucker_id") REFERENCES "public"."bonierdrucker"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kunden" ADD CONSTRAINT "kunden_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lieferbestellungen" ADD CONSTRAINT "lieferbestellungen_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lieferbestellungen" ADD CONSTRAINT "lieferbestellungen_kasse_id_kassen_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lieferscheine" ADD CONSTRAINT "lieferscheine_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lieferscheine" ADD CONSTRAINT "lieferscheine_kasse_id_kassen_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lieferscheine" ADD CONSTRAINT "lieferscheine_angebot_id_angebote_id_fk" FOREIGN KEY ("angebot_id") REFERENCES "public"."angebote"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lieferscheine" ADD CONSTRAINT "lieferscheine_kunde_id_kunden_id_fk" FOREIGN KEY ("kunde_id") REFERENCES "public"."kunden"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modifikator_gruppen" ADD CONSTRAINT "modifikator_gruppen_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modifikatoren" ADD CONSTRAINT "modifikatoren_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modifikatoren" ADD CONSTRAINT "modifikatoren_gruppe_id_modifikator_gruppen_id_fk" FOREIGN KEY ("gruppe_id") REFERENCES "public"."modifikator_gruppen"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "offene_posten" ADD CONSTRAINT "offene_posten_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "offene_posten" ADD CONSTRAINT "offene_posten_kunde_id_kunden_id_fk" FOREIGN KEY ("kunde_id") REFERENCES "public"."kunden"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "offene_posten" ADD CONSTRAINT "offene_posten_beleg_id_belege_id_fk" FOREIGN KEY ("beleg_id") REFERENCES "public"."belege"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sammelrechnungen" ADD CONSTRAINT "sammelrechnungen_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sammelrechnungen" ADD CONSTRAINT "sammelrechnungen_kunde_id_kunden_id_fk" FOREIGN KEY ("kunde_id") REFERENCES "public"."kunden"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tab_ereignisse" ADD CONSTRAINT "tab_ereignisse_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tab_ereignisse" ADD CONSTRAINT "tab_ereignisse_tab_id_tisch_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."tisch_tabs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tisch_tabs" ADD CONSTRAINT "tisch_tabs_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tisch_tabs" ADD CONSTRAINT "tisch_tabs_kasse_id_kassen_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tischplan_bereiche" ADD CONSTRAINT "tischplan_bereiche_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tischplan_bereiche" ADD CONSTRAINT "tischplan_bereiche_kasse_id_kassen_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tischplan_elemente" ADD CONSTRAINT "tischplan_elemente_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tischplan_elemente" ADD CONSTRAINT "tischplan_elemente_kasse_id_kassen_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tischplan_elemente" ADD CONSTRAINT "tischplan_elemente_bereich_id_tischplan_bereiche_id_fk" FOREIGN KEY ("bereich_id") REFERENCES "public"."tischplan_bereiche"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_kassen" ADD CONSTRAINT "user_kassen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_kassen" ADD CONSTRAINT "user_kassen_kasse_id_kassen_id_fk" FOREIGN KEY ("kasse_id") REFERENCES "public"."kassen"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "public"."mandanten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "angebote_mandant_nummer_idx" ON "angebote" USING btree ("mandant_id","nummer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "angebote_status_idx" ON "angebote" USING btree ("mandant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artikel_mandant_nummer_idx" ON "artikel" USING btree ("mandant_id","artikelnummer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artikel_kategorie_idx" ON "artikel" USING btree ("kategorie_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "amg_artikel_idx" ON "artikel_modifikator_gruppen" USING btree ("artikel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "belege_kasse_belegnr_idx" ON "belege" USING btree ("kasse_id","beleg_nummer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "belege_datum_idx" ON "belege" USING btree ("beleg_datum");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "belege_verweis_idx" ON "belege" USING btree ("verweis_beleg_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bonierdrucker_mandant_idx" ON "bonierdrucker" USING btree ("mandant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gutschein_buchungen_gutschein_idx" ON "gutschein_buchungen" USING btree ("gutschein_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gutschein_buchungen_mandant_idx" ON "gutschein_buchungen" USING btree ("mandant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gutscheine_mandant_code_idx" ON "gutscheine" USING btree ("mandant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gutscheine_mandant_nummer_idx" ON "gutscheine" USING btree ("mandant_id","nummer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gutscheine_status_idx" ON "gutscheine" USING btree ("mandant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kks_kasse_idx" ON "kasse_kategorie_sichtbarkeit" USING btree ("kasse_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kassen_mandant_kassenid_idx" ON "kassen" USING btree ("mandant_id","kassen_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kategorien_mandant_idx" ON "kategorien" USING btree ("mandant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kunden_mandant_nummer_idx" ON "kunden" USING btree ("mandant_id","nummer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kunden_suche_idx" ON "kunden" USING btree ("mandant_id","aktiv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lieferbestellungen_kasse_idx" ON "lieferbestellungen" USING btree ("kasse_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lieferbestellungen_status_idx" ON "lieferbestellungen" USING btree ("mandant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lieferbestellungen_externe_idx" ON "lieferbestellungen" USING btree ("provider","externe_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lieferscheine_mandant_nummer_idx" ON "lieferscheine" USING btree ("mandant_id","nummer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lieferscheine_kunde_idx" ON "lieferscheine" USING btree ("mandant_id","kunde_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lieferscheine_status_idx" ON "lieferscheine" USING btree ("mandant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mandanten_uid_idx" ON "mandanten" USING btree ("uid") WHERE status = 'aktiv';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "modifikator_gruppen_mandant_idx" ON "modifikator_gruppen" USING btree ("mandant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "modifikatoren_gruppe_idx" ON "modifikatoren" USING btree ("gruppe_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "offene_posten_mandant_nummer_idx" ON "offene_posten" USING btree ("mandant_id","nummer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offene_posten_kunde_idx" ON "offene_posten" USING btree ("mandant_id","kunde_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offene_posten_status_idx" ON "offene_posten" USING btree ("mandant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sammelrechnungen_mandant_nummer_idx" ON "sammelrechnungen" USING btree ("mandant_id","nummer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sammelrechnungen_kunde_idx" ON "sammelrechnungen" USING btree ("mandant_id","kunde_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tab_ereignisse_tab_idx" ON "tab_ereignisse" USING btree ("tab_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tisch_tabs_kasse_status_idx" ON "tisch_tabs" USING btree ("kasse_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tischplan_bereiche_kasse_idx" ON "tischplan_bereiche" USING btree ("kasse_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tischplan_elemente_bereich_idx" ON "tischplan_elemente" USING btree ("bereich_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");