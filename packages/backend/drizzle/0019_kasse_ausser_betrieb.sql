-- Migration 0019: Zeitpunkt der Kassen-Ausserbetriebnahme
--
-- RKSV-konforme Stilllegung einer Registrierkasse: Schlussbeleg (Betrag 0,
-- letzter Beleg der Kasse) wird signiert, status wechselt auf
-- 'ausser_betrieb' (bestehende Sperre in beleg.service verhindert danach
-- jede weitere Belegerstellung), optional FinanzOnline-Abmeldung.
--
--   NULL          = Kasse in Betrieb
--   Zeitstempel   = ausser Betrieb genommen am (Schlussbeleg-Zeitpunkt)
--
-- Die Kasse wird NICHT geloescht — DEP/Belege bleiben aufbewahrungspflichtig.
-- Statement ist idempotent.

ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "ausser_betrieb_am" timestamptz;
