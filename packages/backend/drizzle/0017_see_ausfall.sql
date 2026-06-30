-- Migration 0017: SEE-Ausfall-Zeitstempel
--
-- RKSV verlangt, dass bei Ausfall der Signaturerstellungseinheit (SEE) Belege
-- weiter ausgegeben werden — mit dem Marker „Sicherheitseinrichtung
-- ausgefallen" statt einer gueltigen Signatur — und bei Wiederinbetriebnahme
-- ein signierter (Sammel-)Beleg erstellt wird.
--
-- Diese Spalte haelt fest, seit wann die SEE einer Kasse ausgefallen ist:
--   NULL          = SEE in Betrieb (Normalfall, Belege werden signiert)
--   Zeitstempel   = Ausfall aktiv seit; Belege tragen den Ausfallmarker
--
-- Die Wiederherstellung setzt die Spalte zurueck auf NULL und erzeugt einen
-- signierten Nullbeleg (Sammelbeleg) als Nachweis. Statement ist idempotent.

ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "see_ausgefallen_seit" timestamptz;
