-- Ticketing Release 4: Offline-Einlass + Steuersatz der Ticketarten.

-- Offline-Scans kommen gesammelt nach. scan_id (vom Gerät vergeben) macht das
-- Nachreichen wiederholbar: derselbe Scan wird nie zweimal eingelöst.
ALTER TABLE "ticket_einlass_log" ADD COLUMN IF NOT EXISTS "scan_id" uuid;--> statement-breakpoint
-- Was das Gerät ohne Verbindung entschieden hat (null = online geprüft)
ALTER TABLE "ticket_einlass_log" ADD COLUMN IF NOT EXISTS "lokales_ergebnis" varchar(30);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_einlass_log_scan_idx" ON "ticket_einlass_log" ("scan_id") WHERE "scan_id" IS NOT NULL;--> statement-breakpoint

-- Abgleich der Offline-Liste: nur die seit dem letzten Stand geänderten Tickets
CREATE INDEX IF NOT EXISTS "tickets_event_updated_idx" ON "tickets" ("event_id", "updated_at");--> statement-breakpoint

-- Eintritt kostet 13 % USt (Kultur, Musik, Sport — vom Betreiber bestätigt).
-- Die frühere Vorgabe 10 % war für Eintrittskarten falsch; bereits verkaufte
-- Tickets und Belege behalten ihren Satz (Snapshot bzw. signierter Beleg).
UPDATE "ticket_arten" SET "mwst_satz" = 'ermaessigt2' WHERE "mwst_satz" = 'ermaessigt1';--> statement-breakpoint
ALTER TABLE "ticket_arten" ALTER COLUMN "mwst_satz" SET DEFAULT 'ermaessigt2';--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "mwst_satz" SET DEFAULT 'ermaessigt2';
