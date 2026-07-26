-- Küchen-Durchlaufzeiten: Erledigt-Zeitstempel auf KDS-Bons.
-- Bestehende erledigte Bons ohne Stempel fallen aus der Statistik (bewusst).
ALTER TABLE "kds_bons" ADD COLUMN IF NOT EXISTS "erledigt_at" timestamp with time zone;
