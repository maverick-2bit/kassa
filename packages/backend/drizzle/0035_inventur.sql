-- Migration 0035: Inventur — dokumentierte, datierte Bestandsaufnahme.
--
-- Eine Inventur ist ein Kopf-Dokument (Status offen/abgeschlossen) mit je einer Position
-- pro lagergeführtem Artikel: sollMenge (Snapshot bei Anlage) + istMenge (gezählt). Beim
-- Abschließen wird die gezählte Ist-Menge absolut auf artikel.lagerstand_menge gebucht.
-- Alles idempotent.

CREATE TABLE IF NOT EXISTS "inventuren" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id"       uuid NOT NULL REFERENCES "mandanten"("id"),
  "bezeichnung"      varchar(120) NOT NULL,
  "status"           varchar(20) NOT NULL DEFAULT 'offen',
  "erstellt_von"     varchar(120) NOT NULL DEFAULT '',
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "abgeschlossen_am" timestamptz
);
CREATE INDEX IF NOT EXISTS "inventuren_mandant_status_idx" ON "inventuren" ("mandant_id", "status");

CREATE TABLE IF NOT EXISTS "inventur_positionen" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "inventur_id" uuid NOT NULL REFERENCES "inventuren"("id") ON DELETE CASCADE,
  "artikel_id"  uuid NOT NULL REFERENCES "artikel"("id"),
  "bezeichnung" varchar(200) NOT NULL,
  "soll_menge"  integer NOT NULL,
  "ist_menge"   integer,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "inventur_positionen_inventur_artikel_idx" ON "inventur_positionen" ("inventur_id", "artikel_id");
