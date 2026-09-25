-- Gast-Modus je Kasse (aus | tab | online) statt des Schalters gast_bestellung_aktiv.
--
-- gast_bestellung_aktiv bedeutete nur „mit Online-Zahlung"; ohne ihn nahm JEDE
-- Kasse Gast-Bestellungen ohne Zahlung an (offener Tab + Toast an der Kasse) —
-- einen Aus-Zustand gab es nicht, und die kasseId steht in jedem Tisch-QR.
-- Jetzt entscheidet gast_modus:
--   aus    → keine Gast-Bestellung (Standard neuer Kassen)
--   tab    → Bestellung ohne Zahlung → offener Tisch (Kellner „Gast")
--   online → Bestellung mit Online-Zahlung (Stripe)
-- Bestand: Online-Zahlung aktiv → online; sonst tab, wenn die Kasse schon eine
-- Gast-Bestellung ohne Zahlung bekommen hat (Tab mit Kellner „Gast"); sonst aus.
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "gast_modus" varchar(10) DEFAULT 'aus' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (
   SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'kassen' AND column_name = 'gast_bestellung_aktiv'
 ) THEN
   UPDATE "kassen" SET "gast_modus" = 'online' WHERE "gast_bestellung_aktiv";
   UPDATE "kassen" k SET "gast_modus" = 'tab'
    WHERE NOT k."gast_bestellung_aktiv"
      AND EXISTS (SELECT 1 FROM "tisch_tabs" t WHERE t."kasse_id" = k."id" AND t."kellner" = 'Gast');
   ALTER TABLE "kassen" DROP COLUMN "gast_bestellung_aktiv";
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kassen" ADD CONSTRAINT "kassen_gast_modus_check" CHECK ("gast_modus" IN ('aus', 'tab', 'online'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
