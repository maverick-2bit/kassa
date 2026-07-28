-- Aktionen (früher „Happy Hour"): fixe Aktionspreise je Artikel zusätzlich zum
-- Prozent-Rabatt. Format: [{"artikelId": "...", "preisCent": 750}, …]
ALTER TABLE "preisregeln" ADD COLUMN IF NOT EXISTS "artikel_preise" jsonb NOT NULL DEFAULT '[]'::jsonb;
