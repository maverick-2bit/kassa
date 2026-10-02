-- Geschäftstag: frei verschiebbarer Tagesbeginn je Mandant.
--
-- Ein Lokal mit Betrieb über Mitternacht will eine Schicht von 18:00 bis 02:00
-- auf EINEM Tag sehen. Der „Tag" (Tagesabschluss, Berichte, Zeiterfassung)
-- beginnt dann nicht um 00:00, sondern z. B. um 06:00 und läuft bis 06:00 des
-- Folgetages.
--
-- Eine Änderung gilt AB EINEM STICHTAG (gueltig_ab, Wiener Kalendertag):
-- vergangene Tage bleiben unverändert, der Übergangstag wird länger oder
-- kürzer, es entsteht weder eine Lücke noch eine Überschneidung. Für den
-- Kalendertag D gilt der Eintrag mit dem größten gueltig_ab <= D; ohne Eintrag
-- 00:00 (= bisheriges Verhalten, Bestandsmandanten bleiben also unverändert).
-- Der Geschäftstag D reicht von „D um beginn(D)" bis „D+1 um beginn(D+1)".
--
-- Die RKSV-Begriffe (Monatsbeleg = Kalendermonat, Jahresbeleg = Kalenderjahr,
-- Belegnummern, Signaturkette, DEP) bleiben davon unberührt; Belege behalten
-- ihre exakten Zeitstempel.
CREATE TABLE IF NOT EXISTS "mandant_tagesbeginn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mandant_id" uuid NOT NULL REFERENCES "mandanten"("id") ON DELETE CASCADE,
	"gueltig_ab" date NOT NULL,
	"beginn" varchar(5) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mandant_tagesbeginn_mandant_ab_idx" ON "mandant_tagesbeginn" ("mandant_id", "gueltig_ab");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mandant_tagesbeginn" ADD CONSTRAINT "mandant_tagesbeginn_beginn_check"
   CHECK ("beginn" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
