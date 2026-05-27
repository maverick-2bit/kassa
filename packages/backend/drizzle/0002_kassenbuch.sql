-- Kassenbuch: Bar-Einlagen und -Entnahmen
CREATE TABLE IF NOT EXISTS "kassenbuch_buchungen" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kasse_id"    uuid NOT NULL REFERENCES "kassen"("id"),
  "typ"         varchar(20) NOT NULL,
  "betrag_cent" integer NOT NULL,
  "grund"       text,
  "user_id"     uuid,
  "datum"       varchar(10) NOT NULL,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "kassenbuch_kasse_idx"
  ON "kassenbuch_buchungen" USING btree ("kasse_id", "datum");
