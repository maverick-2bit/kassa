-- Betreiber der Installation: nur wer so markiert ist, darf die GANZE Datenbank sichern/herunterladen,
-- die Kassa aktualisieren, die Systemwerte sehen und weitere Mandanten anlegen. Bisher durfte das jeder
-- Admin jedes Mandanten.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ist_betreiber" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Bestehende Installationen: die aktiven Admins des ZUERST angelegten Mandanten sind der Betreiber
-- (auf dem Kassen-PC ist das der Mandant, der bei der Einrichtung entstand).
UPDATE "users" SET "ist_betreiber" = true
WHERE "aktiv" = true AND "rolle" = 'admin'
  AND "mandant_id" = (SELECT "id" FROM "mandanten" ORDER BY "created_at" ASC, "id" ASC LIMIT 1);--> statement-breakpoint
-- Auffangnetz: hat der älteste Mandant keinen aktiven Admin (und gibt es sonst keinen Betreiber),
-- wird der älteste aktive Admin überhaupt Betreiber — sonst könnte niemand mehr aktualisieren.
UPDATE "users" SET "ist_betreiber" = true
WHERE "id" = (SELECT "id" FROM "users" WHERE "aktiv" = true AND "rolle" = 'admin' ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM "users" WHERE "ist_betreiber" = true);
