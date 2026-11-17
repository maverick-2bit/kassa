-- Migration 0085: EAN als Artikelkennzeichnung — eindeutig je Mandant.
--
-- Vergleich über den GTIN-14-Schlüssel (links mit Nullen auf 14 Stellen aufgefüllt): dieselbe UPC-A
-- kommt vom Scanner 12- oder 13-stellig, das ist derselbe Artikel. Längere Altwerte (bis 20 Zeichen,
-- vor der Prüfziffer-Validierung erfasst) bleiben dabei unverkürzt, daher greatest(length, 14).
-- Die Anwendung nutzt exakt diesen Ausdruck (artikel.service.ts: eanSchluesselSql).
--
-- Altbestand: leere/Leerzeichen-Werte werden NULL; bei doppelter EAN behält sie EIN Artikel
-- (aktive vor inaktiven, dann der älteste), bei den übrigen wird sie geleert — sonst ließe sich der
-- eindeutige Index nicht anlegen. Ungültige Altwerte (falsche Prüfziffer) bleiben stehen; das
-- Formular verlangt beim nächsten Speichern eine gültige EAN.
-- Idempotent.

UPDATE "artikel" SET "ean" = NULLIF(btrim("ean"), '') WHERE "ean" IS NOT NULL AND "ean" IS DISTINCT FROM NULLIF(btrim("ean"), '');--> statement-breakpoint
WITH rang AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "mandant_id", lpad("ean", greatest(length("ean"), 14), '0')
    ORDER BY "aktiv" DESC, "created_at" ASC, "id" ASC
  ) AS nr
  FROM "artikel"
  WHERE "ean" IS NOT NULL
)
UPDATE "artikel" SET "ean" = NULL FROM rang WHERE "artikel"."id" = rang."id" AND rang.nr > 1;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artikel_mandant_ean_idx" ON "artikel" ("mandant_id", lpad("ean", greatest(length("ean"), 14), '0')) WHERE "ean" IS NOT NULL;
