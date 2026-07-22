-- Migration 0031: Basis-URL der Gast-Bestell-App je Kasse (für den Tisch-QR-Druck).
--
-- Der optionale QR-Code auf dem Tischnummern-Etikett kodiert
-- <gast_basis_url>?kasseId=<uuid>&tisch=<label> → die (bestehende) Gast-App.
-- Leer = kein QR-Druck möglich. Idempotent.

ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "gast_basis_url" varchar(300);
