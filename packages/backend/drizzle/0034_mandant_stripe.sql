-- Migration 0034: Pro-Mandant-Stripe-Konten.
--
-- Jeder Mandant kann sein eigenes Stripe-Konto hinterlegen (Secret- + Webhook-Key),
-- verschlüsselt mit dem Master-Passwort (Muster crypto/master-key.ts, wie atrust_passwort_enc).
-- Sind sie leer, greifen die globalen Env-Keys (Fallback). Idempotent.

ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "stripe_secret_key_enc" text;
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "stripe_webhook_secret_enc" text;
