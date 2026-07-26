-- Automatischer Tagesabschluss: pro Kasse konfigurierbare Uhrzeit (Wiener Zeit)
-- + Idempotenz-Stempel des zuletzt automatisch abgeschlossenen Tages.
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "auto_abschluss_uhrzeit" text;
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "letzter_auto_abschluss_tag" text;
