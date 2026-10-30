-- Wartungsvertraege: Haeufigkeit (Anzahl Abrechnungen im Rechnungsintervall, z. B. monatlich x 12 = 1 Jahr)
-- und Positionsintervall optional (null = wie das Rechnungsintervall des Vertrags).
ALTER TABLE "wartungsvertraege" ADD COLUMN IF NOT EXISTS "anzahl_abrechnungen" integer;--> statement-breakpoint
ALTER TABLE "wartungsvertrag_positionen" ALTER COLUMN "intervall" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wartungsvertrag_positionen" ALTER COLUMN "intervall" DROP DEFAULT;
