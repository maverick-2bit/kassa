-- Migration 0086: Signaturkarte (a.sign RK CHIP) als Signaturerstellungseinheit (see_typ 'atrust_chip').
--
-- karte_pin_enc       Karten-PIN, verschlüsselt wie das A-Trust-Passwort (master-key.ts)
-- karte_pin_gesperrt  true, sobald die Karte die PIN abgelehnt hat: Die Kassa versucht es dann NIE
--                     wieder von selbst (weder beim Verkauf noch über die SEE-Sonde) — nach wenigen
--                     Fehlversuchen wäre die Karte für immer gesperrt. Erst eine neu eingetragene PIN
--                     hebt das auf.
-- karte_pin_hinweis   Wortlaut der letzten Ablehnung („noch 2 Versuche") für die Einstellungen
-- Idempotent.

ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "karte_pin_enc" text;--> statement-breakpoint
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "karte_pin_gesperrt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "karte_pin_hinweis" text;
