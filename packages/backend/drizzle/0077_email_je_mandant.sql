-- Dieselbe E-Mail-Adresse in mehreren Mandanten: die Eindeutigkeit gilt nur noch je Betrieb. Die Anmeldung
-- prueft das Passwort gegen alle Konten mit der Adresse und fragt bei mehreren Treffern nach dem Betrieb.
DROP INDEX IF EXISTS "users_email_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_mandant_email_idx" ON "users" USING btree ("mandant_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_suche_idx" ON "users" USING btree ("email");
