-- Allergen-Kennzeichnung je Artikel: Buchstabencodes A-R, kommagetrennt und sortiert (z. B. 'A,C,G').
-- NULL = keine Angabe. Reine Anzeige (Kasse, Kellner-App, Gast-Karte), kein Einfluss auf Belege.
ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "allergene" varchar(40);
