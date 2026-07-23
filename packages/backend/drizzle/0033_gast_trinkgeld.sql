-- Migration 0033: Trinkgeld für die Gast-Onlinebestellung.
--
-- Der Gast gibt beim Bezahlen optional ein Trinkgeld; es wird mit der Stripe-Zahlung
-- eingezogen und als 0%-USt-Position auf dem RKSV-Beleg ausgewiesen (Beleg = gezahlter
-- Betrag). trinkgeld_cent hält den Betrag der Bestellung fest. Idempotent.

ALTER TABLE "gast_bestellungen" ADD COLUMN IF NOT EXISTS "trinkgeld_cent" integer NOT NULL DEFAULT 0;
