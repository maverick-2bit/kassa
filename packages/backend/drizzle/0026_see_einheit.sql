-- Migration 0026: Pluggable Signaturerstellungseinheit (Software / A-Trust HSM)
--
-- Je Kasse waehlbar: 'software' (Dev/Test, lokaler Key, ZDA AT0) oder
-- 'atrust_hsm' (a.sign RK HSM REST; Zertifikat/ZDA kommen von A-Trust,
-- Passwort at rest AES-GCM-verschluesselt). Statements sind idempotent.

ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "see_typ" varchar(20) NOT NULL DEFAULT 'software';
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "see_zda_id" varchar(10) NOT NULL DEFAULT 'AT0';
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "atrust_basis_url" text;
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "atrust_benutzer" text;
ALTER TABLE "kassen" ADD COLUMN IF NOT EXISTS "atrust_passwort_enc" text;
