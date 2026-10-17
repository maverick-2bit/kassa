-- Bepreiste Varianten: welche Option eines Artikels schon aufgelöst ist.
--
-- Artikel aus dem Altsystem haben ihren Preis in der Option („Bier" 0,00 mit „0,33l" +4,00 / „0,5l" +5,00).
-- Ist die Optionen-Abfrage abgeschaltet (0066), fällt die Preisauswahl weg und es wird 0,00 boniert. In der
-- Verwaltung entscheidet der Benutzer je Variante: eigener Artikel („angelegt") oder keiner („verworfen").
--
-- Gemerkt wird je PAAR Artikel + Option, weil Optionsgruppen geteilt sind: dieselbe Gruppe
-- „Variante (0,33l / 0,5l)" hängt oft an allen Bieren. Erst wenn alle bepreisten Optionen einer Gruppe für
-- einen Artikel erledigt sind, wird die Gruppe von DIESEM Artikel gelöst — für die anderen bleibt sie.
CREATE TABLE IF NOT EXISTS "artikel_variante_erledigt" (
  "artikel_id"     uuid NOT NULL REFERENCES "artikel"("id")        ON DELETE CASCADE,
  "modifikator_id" uuid NOT NULL REFERENCES "modifikatoren"("id")  ON DELETE CASCADE,
  -- 'angelegt' = es gibt jetzt einen eigenen Artikel | 'verworfen' = diese Variante wird nicht übernommen
  "art"           varchar(20) NOT NULL,
  -- Der daraus entstandene Artikel (nur bei 'angelegt'); wird er gelöscht, bleibt die Entscheidung bestehen
  "artikel_neu_id" uuid REFERENCES "artikel"("id") ON DELETE SET NULL,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("artikel_id", "modifikator_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ave_artikel_idx" ON "artikel_variante_erledigt" ("artikel_id");
