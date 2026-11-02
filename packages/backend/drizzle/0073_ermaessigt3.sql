-- Steuersatz 4,9 % (ausgewaehlte Nahrungsmittel, Lieferungen, seit 1.7.2026): eigene Betragsspalte je Beleg.
-- Die RKSV (Anlage 1 Z 4, BGBl. II Nr. 134/2026) fuehrt 4,9 % im Feld "Betrag-Satz-Besonders (19 %, 4,9 %)" -- der
-- QR-Code/DEP traegt betrag_besonders_cent + betrag_ermaessigt3_cent in EINEM Feld. In der Datenbank bleiben beide
-- Saetze getrennt, damit Berichte, Tagesabschluss und BMD/DATEV-Export 4,9 % und 19 % unterscheiden koennen.
-- Bestandsbelege: 0 (der Satz galt vorher nicht).
ALTER TABLE "belege" ADD COLUMN IF NOT EXISTS "betrag_ermaessigt3_cent" integer DEFAULT 0 NOT NULL;
