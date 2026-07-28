-- Reservierungen: echte Tischbindung statt Freitext.
-- tischLabel bleibt als Fallback/Anzeige für Altbestand erhalten.
ALTER TABLE "reservierungen"
  ADD COLUMN IF NOT EXISTS "tisch_id" uuid REFERENCES "tischplan_elemente"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "reservierungen_tisch_datum_idx"
  ON "reservierungen" ("tisch_id", "datum");

-- Je Tisch festlegen, ob Gäste ihn online reservieren dürfen
ALTER TABLE "tischplan_elemente"
  ADD COLUMN IF NOT EXISTS "online_reservierbar" boolean NOT NULL DEFAULT false;

-- Sitzplätze je Tisch (0 = unbekannt) — Grundlage für passende Online-Vorschläge
ALTER TABLE "tischplan_elemente"
  ADD COLUMN IF NOT EXISTS "plaetze" integer NOT NULL DEFAULT 0;
