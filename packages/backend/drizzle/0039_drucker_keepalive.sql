-- Drucker-Keep-Alive: Intervall in Sekunden (0 = aus), verhindert dass
-- Bondrucker im LAN in den Energiespar-/Schlafmodus wechseln.
ALTER TABLE "mandanten" ADD COLUMN IF NOT EXISTS "drucker_keep_alive_sekunden" integer NOT NULL DEFAULT 60;
