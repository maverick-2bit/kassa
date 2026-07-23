-- Migration 0032: Gast-Bestellungen (Handy-Bestellung am Tisch, sofort online bezahlt).
--
-- Der Gast bestellt über den Tisch-QR, zahlt via Stripe Checkout; auf Zahlungserfolg
-- signiert der Server den RKSV-Beleg (belegId) und boniert an KDS/Warengruppen-Drucker.
-- Gate je Kasse via kassen.gast_bestellung_aktiv. Alles idempotent.

CREATE TABLE IF NOT EXISTS "gast_bestellungen" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id"                uuid NOT NULL REFERENCES "mandanten"("id"),
  "kasse_id"                  uuid NOT NULL REFERENCES "kassen"("id"),
  "tisch_nummer"              varchar(40) NOT NULL,
  "positionen"                jsonb NOT NULL,
  "summe_cent"                integer NOT NULL,
  "status"                    varchar(20) NOT NULL DEFAULT 'zahlung',
  "stripe_session_id"         varchar(255),
  "stripe_payment_intent_id"  varchar(255),
  "beleg_id"                  uuid REFERENCES "belege"("id"),
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "gast_bestellungen_mandant_status_idx" ON "gast_bestellungen" ("mandant_id", "status");
CREATE INDEX IF NOT EXISTS "gast_bestellungen_stripe_session_idx" ON "gast_bestellungen" ("stripe_session_id");

ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "gast_bestellung_aktiv" boolean NOT NULL DEFAULT false;
