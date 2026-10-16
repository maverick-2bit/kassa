-- Optionsgruppe: „Jede Auswahl = eigener Artikel".
--
-- Ein Spritzer mit „süß", „Sommer" und „weiß" sind drei Getränke, nicht ein Artikel mit drei Optionen.
-- Ist der Schalter an, macht die Kasse aus jeder gewählten Option (und ihrer Anzahl) eine eigene Position
-- (z. B. 1× Spritzer süß, 2× Spritzer weiß); sonst bleibt es wie bisher EINE Position mit allen Optionen.
-- Standard aus — nichts ändert sich ungefragt.
ALTER TABLE "modifikator_gruppen" ADD COLUMN IF NOT EXISTS "je_auswahl_artikel" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Die vom Layout-Import angelegten Variante-Gruppen („Variante (pur / gespritzt …)", Pflicht, beliebig viele
-- Optionen) sind genau solche Getränke-Varianten: einmalig einschalten. Andere Gruppen bleiben unberührt.
UPDATE "modifikator_gruppen" SET "je_auswahl_artikel" = true
  WHERE "name" LIKE 'Variante (%' AND "typ" = 'pflicht' AND "max_auswahl" IS NULL AND "je_auswahl_artikel" = false;
