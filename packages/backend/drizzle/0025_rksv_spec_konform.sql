-- Migration 0025: RKSV-Kern auf BMF-Detailspezifikation (sauberer Schnitt)
--
-- Die Verkettung laeuft jetzt ueber den KOMPLETTEN maschinenlesbaren Code des
-- Vorbelegs (statt ueber den Signaturwert), der Umsatzzaehler wird mit einem
-- EIGENSTAENDIGEN AES-256-Schluessel verschluesselt (wird bei der FON-
-- Kassenregistrierung gemeldet; bisher faelschlich aus dem Zertifikat
-- abgeleitet). Bestehende Dev-Ketten sind mit dem neuen Format nicht
-- kompatibel (bewusster Schnitt vor dem Echtbetrieb) — Dev-Kassen sind neu
-- aufzusetzen. Statements sind idempotent.

ALTER TABLE "kassen" DROP COLUMN IF EXISTS "letzter_signaturwert";
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "letzter_beleg_code" text;
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "aes_schluessel_enc" text;
