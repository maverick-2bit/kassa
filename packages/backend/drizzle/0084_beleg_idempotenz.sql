-- Migration 0084: Idempotenz-Schlüssel für Verkäufe (Offline-Warteschlange der Kassa).
--
-- Die Kassa schickt je Verkauf einen zufälligen Schlüssel (Header Idempotency-Key) mit. Kommt
-- derselbe Verkauf ein zweites Mal an (Antwort ging im WLAN verloren, Nachsenden aus der
-- Offline-Warteschlange), liefert das Backend den schon gebuchten Beleg statt einen zweiten zu
-- signieren. Eindeutig je Kasse; NULL (alle Belege ohne Schlüssel) zählt nie als Dublette.
-- Idempotent.

ALTER TABLE "belege" ADD COLUMN IF NOT EXISTS "idempotenz_schluessel" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "belege_kasse_idempotenz_idx" ON "belege" ("kasse_id", "idempotenz_schluessel");
