-- Migration 0020: Preisregeln (Happy Hour / zeitgesteuerte Preise)
--
-- Eine Preisregel senkt den Preis um rabatt_prozent in einem Zeitfenster
-- (von_zeit..bis_zeit) an bestimmten Wochentagen (JSON-Array 1=Mo..7=So),
-- optional nur fuer bestimmte Warengruppen (kategorie_ids; leer = alle).
-- Die Anwendung erfolgt beim Kassieren/Bonieren (Frontend berechnet den
-- effektiven Preis, Backend uebernimmt ihn wie bisher als einzelpreis).
-- Statements sind idempotent.

CREATE TABLE IF NOT EXISTS "preisregeln" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mandant_id"     uuid NOT NULL REFERENCES "mandanten"("id"),
  "name"           varchar(80) NOT NULL,
  "aktiv"          boolean NOT NULL DEFAULT true,
  "wochentage"     jsonb NOT NULL,
  "von_zeit"       varchar(5) NOT NULL,
  "bis_zeit"       varchar(5) NOT NULL,
  "rabatt_prozent" integer NOT NULL,
  "kategorie_ids"  jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "preisregeln_mandant_idx" ON "preisregeln" ("mandant_id");
