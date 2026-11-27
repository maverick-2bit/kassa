-- Migration 0088: Lagerabzug einer Bonierung an der Kasse merken, damit der Beleg ihn verrechnet.
--
-- Jede verkaufte Ware wird genau einmal vom Lager abgebucht. Der Beleg bucht alles ab — außer, was eine Bonierung
-- desselben Warenkorbs („Bonieren", dann kassieren) schon abgezogen hat. Die Kasse schickt dafür die Bestell-IDs
-- ihrer Bonierungen mit dem Beleg mit; jede Bonierung wird höchstens einmal verrechnet (verrechnet_am).
--
-- bestell_id     = Bestell-ID der Bonierung (wie bonier_bestellungen)
-- positionen     = [{ artikelId, menge }] — was die Bonierung je Verkaufsartikel abgezogen hat (samt Rezeptur)
-- verrechnet_am  = gesetzt, sobald ein Beleg die Bonierung verrechnet hat
-- Idempotent.

CREATE TABLE IF NOT EXISTS "bonier_lagerabzuege" (
  "bestell_id"    uuid PRIMARY KEY,
  "mandant_id"    uuid NOT NULL REFERENCES "mandanten"("id") ON DELETE CASCADE,
  "kasse_id"      uuid NOT NULL REFERENCES "kassen"("id") ON DELETE CASCADE,
  "positionen"    jsonb NOT NULL,
  "verrechnet_am" timestamp with time zone,
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bonier_lagerabzuege_created_idx" ON "bonier_lagerabzuege" ("created_at");
