-- Ticketing Release 3: Ticketshop — Online-Bestellungen mit Stripe, Kontingent-
-- Reservierung während der Zahlung, RKSV-Beleg auf einer Verkaufskasse.

-- Einstellungen des Online-Verkaufs je Mandant
-- Kasse, auf der die RKSV-Belege der Online-Verkäufe entstehen (null = Verkauf aus)
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "ticket_verkauf_kasse_id" uuid REFERENCES "kassen"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "ticket_agb_url" varchar(300);--> statement-breakpoint
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "ticket_datenschutz_url" varchar(300);--> statement-breakpoint
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "ticket_impressum_url" varchar(300);--> statement-breakpoint
-- Hinweis im Kaufformular, z. B. zum Rücktrittsrecht bei Veranstaltungen mit fixem Termin
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "ticket_kaufhinweis" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ticket_bestellungen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL REFERENCES "mandanten"("id"),
	"event_id" uuid NOT NULL REFERENCES "ticket_events"("id") ON DELETE CASCADE,
	-- zahlung | finalisiere | bezahlt | abgelaufen | abgebrochen
	"status" varchar(20) DEFAULT 'zahlung' NOT NULL,
	-- Käufer (die Gäste stehen je Ticket in "tickets")
	"name" varchar(200) NOT NULL,
	"email" varchar(254) NOT NULL,
	-- Rechnung auf Firma: { firma, strasse, plz, ort, land, uid } — null = Privatkauf
	"rechnung" jsonb,
	-- Snapshot je Ticketart: [{ ticketArtId, bezeichnung, menge, preisCent, mwstSatz }]
	"positionen" jsonb NOT NULL,
	"summe_cent" integer NOT NULL,
	-- Bis dahin hält die Bestellung ihre Tickets im Kontingent fest
	"reserviert_bis" timestamp with time zone NOT NULL,
	"stripe_session_id" varchar(255),
	-- Adresse der Ticket-App, über die bestellt wurde — Rückfall für Links in der
	-- E-Mail, solange keine Ticket-Adresse eingerichtet ist
	"basis_url" varchar(300),
	"beleg_id" uuid REFERENCES "belege"("id") ON DELETE SET NULL,
	-- Zeitpunkt der Zustimmung zu AGB/Datenschutz (Nachweis)
	"agb_akzeptiert_at" timestamp with time zone NOT NULL,
	"bezahlt_at" timestamp with time zone,
	"email_gesendet_at" timestamp with time zone,
	"email_fehler" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_bestellungen_event_idx" ON "ticket_bestellungen" ("event_id", "created_at");--> statement-breakpoint
-- Aufräum-Job: offene Zahlungen mit abgelaufener Reservierung
CREATE INDEX IF NOT EXISTS "ticket_bestellungen_offen_idx" ON "ticket_bestellungen" ("status", "reserviert_bis");--> statement-breakpoint

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "bestellung_id" uuid REFERENCES "ticket_bestellungen"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tickets_bestellung_idx" ON "tickets" ("bestellung_id");
