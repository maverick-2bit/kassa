-- Migration 0015: Schema-Synchronisation
--
-- Diese Objekte existierten nur in src/db/schema.ts (auf Dev-Systemen via
-- drizzle-kit push angelegt), aber in keiner Migration. Frische Installationen
-- hatten sie deshalb nicht. Alle Statements sind idempotent, damit bestehende
-- Datenbanken die Wiederanwendung schadlos überstehen.

-- Lieferanten — Stammdaten für Einkauf + Bestellliste
CREATE TABLE IF NOT EXISTS "lieferanten" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id"  uuid NOT NULL REFERENCES "mandanten"("id"),
  "name"        text NOT NULL,
  "kontakt"     text,
  "email"       varchar(200),
  "telefon"     varchar(50),
  "notiz"       text,
  "aktiv"       boolean NOT NULL DEFAULT true,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "lieferanten_mandant_idx" ON "lieferanten" ("mandant_id");

-- Artikel → Lieferant (nullable, SET NULL beim Löschen des Lieferanten)
ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "lieferant_id" uuid REFERENCES "lieferanten"("id") ON DELETE SET NULL;

-- DEP-Sicherungen — Protokoll automatischer/manueller DEP-Exporte
CREATE TABLE IF NOT EXISTS "dep_sicherungen" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id"     uuid NOT NULL REFERENCES "mandanten"("id"),
  "kasse_id"       uuid NOT NULL REFERENCES "kassen"("id"),
  "erstellt_am"    timestamp with time zone NOT NULL DEFAULT now(),
  "format"         varchar(10) NOT NULL,
  "anzahl_belege"  integer NOT NULL,
  "dateipfad"      text NOT NULL,
  "dateiname"      text NOT NULL,
  "automatisch"    boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS "dep_sicherungen_kasse_idx" ON "dep_sicherungen" ("kasse_id", "erstellt_am");

-- Prüfungs-Tokens — zeitlich begrenzte Read-only-Links für Finanzprüfer
CREATE TABLE IF NOT EXISTS "pruefungs_tokens" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mandant_id"            uuid NOT NULL REFERENCES "mandanten"("id"),
  "kasse_id"              uuid NOT NULL REFERENCES "kassen"("id"),
  "token"                 varchar(64) NOT NULL,
  "erstellt_am"           timestamp with time zone NOT NULL DEFAULT now(),
  "gueltig_bis"           timestamp with time zone NOT NULL,
  "erstellt_von_user_id"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "beschreibung"          text,
  "widerrufen"            boolean NOT NULL DEFAULT false,
  "letzte_verwendung"     timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "pruefungs_tokens_token_idx" ON "pruefungs_tokens" ("token");
CREATE INDEX IF NOT EXISTS "pruefungs_tokens_kasse_idx" ON "pruefungs_tokens" ("kasse_id");
