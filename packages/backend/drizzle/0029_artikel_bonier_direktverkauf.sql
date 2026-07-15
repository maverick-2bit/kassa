-- Migration 0029: Artikel-Option „Bonierbon auch beim Direktverkauf"
--
-- Bisher wird ein Bonierbon (Kuechenzettel) nur beim Bonieren/Parken ueber eine
-- Tischbuchung gedruckt. Neu kann je Artikel eingestellt werden, dass der
-- eingestellte Bonierbon auch beim direkten „Bon erstellen" an der Kasse
-- gedruckt wird. Default false = Verhalten wie bisher (nur Tischbuchung).
-- Idempotent.

ALTER TABLE "artikel" ADD COLUMN IF NOT EXISTS "bonier_bei_direktverkauf" boolean NOT NULL DEFAULT false;
