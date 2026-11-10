-- Migration 0083: Sprachbestellung (optionales Modul) — Synonyme je Artikel.
--
-- Umgangsnamen, die Kellner sagen ("Seidl", "Krügerl"). text_norm = normalisierte Schreibweise
-- (eindeutig je Artikel), position = Reihenfolge der Eingabe. Eigene Tabelle: Mandanten ohne Modul haben schlicht keine Zeilen.
-- Idempotent.

CREATE TABLE IF NOT EXISTS "artikel_synonyme" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id" uuid NOT NULL,
  "artikel_id" uuid NOT NULL,
  "text" varchar(80) NOT NULL,
  "text_norm" varchar(80) NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "artikel_synonyme" ADD CONSTRAINT "artikel_synonyme_mandant_id_mandanten_id_fk" FOREIGN KEY ("mandant_id") REFERENCES "mandanten"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "artikel_synonyme" ADD CONSTRAINT "artikel_synonyme_artikel_id_artikel_id_fk" FOREIGN KEY ("artikel_id") REFERENCES "artikel"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artikel_synonyme_artikel_text_idx" ON "artikel_synonyme" ("artikel_id", "text_norm");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artikel_synonyme_mandant_idx" ON "artikel_synonyme" ("mandant_id");
