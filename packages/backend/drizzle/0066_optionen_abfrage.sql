-- Optionen-/Varianten-Abfrage im Direktverkauf abschaltbar (Kasse, Warengruppe, Artikel).
--
-- An einer Bar-Kasse, an der dieselbe Person verkauft und herrichtet, braucht es die Abfrage „pur oder
-- gespritzt" nicht. Die Küche dagegen braucht Optionen/Varianten weiter, weil dort nicht an der Kasse
-- produziert wird. Betrifft NUR den Direktverkauf (Kasse, Kellner-App im Theken-Modus) — Tisch-Bestellungen
-- fragen immer.
--
-- Rangfolge: Artikel -> Warengruppe -> Kasse. NULL = „wie die nächste Ebene".
--  - kassen.optionen_abfrage:     true (Standard, bisheriges Verhalten) = fragen, false = im Direktverkauf nicht fragen
--  - kategorien/artikel:          NULL = wie Kasse (bzw. Warengruppe), true = immer fragen, false = nie fragen
-- Keine bestehende Zeile ändert ihr Verhalten.
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "optionen_abfrage" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "kategorien" ADD COLUMN IF NOT EXISTS "optionen_abfrage" boolean;--> statement-breakpoint
ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "optionen_abfrage" boolean;
