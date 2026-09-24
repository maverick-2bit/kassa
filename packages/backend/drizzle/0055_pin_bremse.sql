-- PIN-Länge je Mandant (4 oder 6 Ziffern) und Länge der gesetzten PIN je Benutzer.
--
-- Wechselt ein Betrieb auf 6 Ziffern, gelten die alten 4-stelligen PINs nicht
-- mehr (sonst bliebe der schwache Bestand ratbar) — die Benutzerverwaltung zeigt
-- anhand users.pin_laenge, wer eine neue PIN braucht. Alle bisherigen PINs sind
-- 4-stellig (das Eingabeschema ließ nie etwas anderes zu), der Standardwert 4
-- beschreibt den Bestand also korrekt.
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "pin_laenge" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pin_laenge" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mandanten" ADD CONSTRAINT "mandanten_pin_laenge_check" CHECK ("pin_laenge" IN (4, 6));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_pin_laenge_check" CHECK ("pin_laenge" IN (4, 6));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
