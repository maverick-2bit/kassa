-- Ticketing Release 2: Einlass-Geräte (einzeln sperrbar) + Einlass-Protokoll.

-- Öffentliche Adresse der Einlass-App (z. B. https://einlass.example.at) — für
-- den Einrichtungs-QR der Scanner-Handys. null = nicht eingerichtet.
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "einlass_basis_url" varchar(300);--> statement-breakpoint

-- Wo und womit ein Ticket zuerst eingelöst wurde — für die Meldung
-- „bereits eingelöst um 19:42 an Einlass 2" ohne Umweg übers Protokoll.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "erster_einlass_geraet" varchar(60);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "einlass_geraete" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL REFERENCES "mandanten"("id"),
	"name" varchar(60) NOT NULL,
	"erstellt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"zuletzt_aktiv_at" timestamp with time zone,
	-- gesetzt = gesperrt (verlorenes Handy): der Geräte-Token gilt ab sofort nicht mehr
	"widerrufen_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "einlass_geraete_mandant_idx" ON "einlass_geraete" ("mandant_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ticket_einlass_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL REFERENCES "mandanten"("id"),
	"event_id" uuid NOT NULL REFERENCES "ticket_events"("id") ON DELETE CASCADE,
	"ticket_id" uuid REFERENCES "tickets"("id") ON DELETE SET NULL,
	"geraet_id" uuid REFERENCES "einlass_geraete"("id") ON DELETE SET NULL,
	"geraet_name" varchar(60),
	-- erkannter Ticket-Code bzw. gekürzter Rohinhalt eines fremden QR-Codes
	"code" varchar(64) NOT NULL,
	"ergebnis" varchar(30) NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"zeitpunkt" timestamp with time zone DEFAULT now() NOT NULL,
	"empfangen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_einlass_log_event_zeit_idx" ON "ticket_einlass_log" ("event_id", "zeitpunkt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_einlass_log_ticket_idx" ON "ticket_einlass_log" ("ticket_id");
