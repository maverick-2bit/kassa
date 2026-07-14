-- Migration 0028: Bondrucker-Bibliothek (mandantenweiter Pool) + Auswahl je Kasse
--
-- Bisher hatte jede Kasse genau EINEN inline konfigurierten Bondrucker. Neu:
-- ein mandantenweiter Pool ("drucker"), aus dem jede Kasse per kassen.drucker_id
-- auswaehlt. Die kassen.drucker*-Inline-Felder bleiben als aufgeloester Snapshot
-- des gewaehlten Druckers erhalten (der Druckpfad liest weiterhin nur diese).
-- Alle Statements idempotent.

-- Pool-Tabelle
CREATE TABLE IF NOT EXISTS "drucker" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id"    uuid NOT NULL REFERENCES "mandanten"("id"),
  "name"          text NOT NULL,
  "ip"            varchar(64) NOT NULL,
  "port"          integer NOT NULL DEFAULT 9100,
  "breite_zeichen" integer NOT NULL DEFAULT 42,
  "timeout_sek"   integer NOT NULL DEFAULT 5,
  "aktiv"         boolean NOT NULL DEFAULT true,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "drucker_mandant_idx" ON "drucker" ("mandant_id");

-- Auswahl-Spalte an der Kasse (FK auf den Pool; beim Loeschen des Druckers -> NULL)
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "drucker_id" uuid;
DO $$ BEGIN
  ALTER TABLE "kassen" ADD CONSTRAINT "kassen_drucker_id_fk"
    FOREIGN KEY ("drucker_id") REFERENCES "drucker"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Datenuebernahme: je Kasse mit vorhandener Inline-IP einen Pool-Eintrag anlegen
-- und verknuepfen. Nur einmalig (Kassen ohne drucker_id, mit gesetzter IP).
DO $$
DECLARE k RECORD;
        neue_id uuid;
BEGIN
  FOR k IN
    SELECT "id", "kassen_id", "drucker_ip", "drucker_port",
           "drucker_breite_zeichen", "drucker_timeout_sek", "drucker_aktiv", "mandant_id"
    FROM "kassen"
    WHERE "drucker_ip" IS NOT NULL AND "drucker_id" IS NULL
  LOOP
    INSERT INTO "drucker" ("mandant_id", "name", "ip", "port", "breite_zeichen", "timeout_sek", "aktiv")
    VALUES (k."mandant_id", 'Bondrucker ' || k."kassen_id", k."drucker_ip", k."drucker_port",
            k."drucker_breite_zeichen", k."drucker_timeout_sek", k."drucker_aktiv")
    RETURNING "id" INTO neue_id;
    UPDATE "kassen" SET "drucker_id" = neue_id WHERE "id" = k."id";
  END LOOP;
END $$;
