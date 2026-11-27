-- Migration 0087: Storno bucht den Lagerstand zurück — je Artikel einstellbar.
--
-- storno_lager_rueck  Vorgabe, ob ein stornierter Artikel zurück ins Lager geht:
--                     NULL  = automatisch: ohne Rezeptur ja (Flasche, Dose), mit Rezeptur nein (zubereitet)
--                     true  = immer zurück
--                     false = nie zurück
--                     Beim Storno lässt sich das je Position noch ändern (Häkchen im Storno-Dialog).
-- Idempotent.

ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "storno_lager_rueck" boolean;
