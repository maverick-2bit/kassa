-- Migration 0024: SB-Terminal + Abholmonitor (Selbstbedienungs-Bestellsystem)
--
-- Neues Modul: Gaeste bestellen am Touch-Kiosk, zahlen mit Karte und erhalten
-- eine 4-stellige Bestellnummer (taeglich ab 1 je Mandant). Die Bestellung
-- laeuft am KDS auf und erscheint am oeffentlichen Abholmonitor.
-- Sichtbarkeit am Terminal: Kategorie-Flag mit Artikel-Override (NULL = erbt).
-- Statements sind idempotent.

ALTER TABLE "mandanten"  ADD COLUMN IF NOT EXISTS "modul_sb_terminal_aktiv" boolean NOT NULL DEFAULT false;
ALTER TABLE "kategorien" ADD COLUMN IF NOT EXISTS "terminal_sichtbar" boolean NOT NULL DEFAULT false;
ALTER TABLE "artikel"    ADD COLUMN IF NOT EXISTS "terminal_sichtbar" boolean;

ALTER TABLE "kds_bons" ADD COLUMN IF NOT EXISTS "sb_bestellung_id" uuid;
ALTER TABLE "kds_bons" ADD COLUMN IF NOT EXISTS "sb_bestell_nummer" varchar(10);
CREATE INDEX IF NOT EXISTS "kds_bons_sb_bestellung_idx" ON "kds_bons" ("sb_bestellung_id");

CREATE TABLE IF NOT EXISTS "sb_bestellungen" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mandant_id"     uuid NOT NULL REFERENCES "mandanten"("id"),
  "kasse_id"       uuid NOT NULL REFERENCES "kassen"("id"),
  "bestell_nummer" integer,
  "datum"          date NOT NULL,
  "positionen"     jsonb NOT NULL,
  "summe_cent"     integer NOT NULL,
  "status"         varchar(20) NOT NULL DEFAULT 'zahlung',
  "zvt_job_id"     uuid,
  "beleg_id"       uuid REFERENCES "belege"("id"),
  "erstellt_at"    timestamptz NOT NULL DEFAULT now(),
  "bereit_at"      timestamptz,
  "abgeholt_at"    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "sb_bestellungen_nummer_tag_unique" ON "sb_bestellungen" ("mandant_id", "datum", "bestell_nummer");
CREATE INDEX IF NOT EXISTS "sb_bestellungen_mandant_status_idx" ON "sb_bestellungen" ("mandant_id", "status");
