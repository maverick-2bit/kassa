-- Ticketing (Modul): Events, Bänder (Jugendschutz), Ticketarten, Tickets.
-- Bestellungen/Zahlung und Einlass-Protokoll folgen in eigenen Migrationen.

ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "modul_tickets_aktiv" boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- Öffentliche Adresse der Ticket-App (z. B. https://tickets.example.at) —
-- nötig für Links und QR-Codes in E-Mails. null = noch nicht eingerichtet.
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "ticket_basis_url" varchar(300);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL REFERENCES "mandanten"("id"),
	"titel" varchar(200) NOT NULL,
	"beschreibung" text,
	"beginn" timestamp with time zone NOT NULL,
	"ende" timestamp with time zone,
	"ort" varchar(200) NOT NULL,
	"adresse" varchar(300),
	"hinweis" varchar(200),
	"veranstalter" varchar(200),
	"status" varchar(20) DEFAULT 'entwurf' NOT NULL,
	"mindestalter" integer,
	"name_pflicht" boolean DEFAULT false NOT NULL,
	"daten_loeschen_nach_tagen" integer DEFAULT 30 NOT NULL,
	"daten_geloescht_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_events_mandant_beginn_idx" ON "ticket_events" ("mandant_id", "beginn");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ticket_baender" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL REFERENCES "mandanten"("id"),
	"event_id" uuid NOT NULL REFERENCES "ticket_events"("id") ON DELETE CASCADE,
	"bezeichnung" varchar(60) NOT NULL,
	"farbe" varchar(7) NOT NULL,
	"alter_von" integer,
	"alter_bis" integer,
	"hinweis" varchar(200),
	"reihenfolge" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_baender_event_idx" ON "ticket_baender" ("event_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ticket_arten" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL REFERENCES "mandanten"("id"),
	"event_id" uuid NOT NULL REFERENCES "ticket_events"("id") ON DELETE CASCADE,
	"bezeichnung" varchar(120) NOT NULL,
	"beschreibung" text,
	"preis_cent" integer DEFAULT 0 NOT NULL,
	"mwst_satz" varchar(20) DEFAULT 'ermaessigt1' NOT NULL,
	"kontingent" integer,
	"max_pro_bestellung" integer DEFAULT 10 NOT NULL,
	"verkauf_ab" timestamp with time zone,
	"verkauf_bis" timestamp with time zone,
	"online_verkauf" boolean DEFAULT true NOT NULL,
	"reihenfolge" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_arten_event_idx" ON "ticket_arten" ("event_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL REFERENCES "mandanten"("id"),
	"event_id" uuid NOT NULL REFERENCES "ticket_events"("id"),
	"ticket_art_id" uuid REFERENCES "ticket_arten"("id") ON DELETE SET NULL,
	"code" varchar(32) NOT NULL,
	"typ" varchar(20) DEFAULT 'einzel' NOT NULL,
	"rolle" varchar(60),
	"bezeichnung" varchar(120) NOT NULL,
	"name" varchar(200),
	"geburtsdatum" date,
	"email" varchar(254),
	"status" varchar(20) DEFAULT 'gueltig' NOT NULL,
	"preis_cent" integer DEFAULT 0 NOT NULL,
	"mwst_satz" varchar(20) DEFAULT 'ermaessigt1' NOT NULL,
	"erster_einlass_at" timestamp with time zone,
	"letzter_einlass_at" timestamp with time zone,
	"einlass_anzahl" integer DEFAULT 0 NOT NULL,
	"ausgestellt_von" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Der Code steht im QR und ist systemweit eindeutig: der Einlass findet das
-- Ticket allein über ihn, ohne den Mandanten zu kennen.
CREATE UNIQUE INDEX IF NOT EXISTS "tickets_code_idx" ON "tickets" ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tickets_event_status_idx" ON "tickets" ("event_id", "status");
