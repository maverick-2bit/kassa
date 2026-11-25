/**
 * Hilfsfunktionen für Mandant-Scoping.
 * Stellt sicher, dass ein User nur auf Kassen/Belege seines eigenen Mandanten zugreifen kann.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { belege, kassen, userKassen } from '../db/schema.js'
import type { JwtPayload } from './jwt.js'

export async function pruefeKasseGehoertZuMandant(
  db:        Db,
  kasseId:   string,
  mandantId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: kassen.id })
    .from(kassen)
    .where(and(eq(kassen.id, kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  return !!row
}

/**
 * Darf der Benutzer in den Belegen dieser Kasse arbeiten (ansehen, stornieren, Spezialbelege)?
 * Dieselbe Regel wie der Kassen-Umschalter (frontend lib/kassenWechsel.ts):
 *  - Admin und Einstellungs-Recht: alle Kassen des Betriebs
 *  - sonst nur die zugeordneten Kassen (Benutzerverwaltung → Kassen-Zuordnung), frisch aus der Datenbank
 *  - ganz OHNE Zuordnung: nicht eingeschränkt. Solche Benutzer arbeiten auf der Kasse des Geräts, die der
 *    Server nicht kennt; die Oberfläche zeigt ihnen nur diese.
 * Ersetzt NICHT die Mandantenprüfung (pruefeKasseGehoertZuMandant).
 */
export async function pruefeKasseErlaubt(
  db:      Db,
  kasseId: string,
  user:    Pick<JwtPayload, 'sub' | 'mandantId' | 'rolle' | 'berechtigungen'>,
): Promise<boolean> {
  if (user.rolle === 'admin' || user.berechtigungen?.includes('einstellungen')) return true
  const zugeordnet = await db
    .select({ kasseId: userKassen.kasseId })
    .from(userKassen)
    // Nur Kassen des eigenen Mandanten (Altbestand, siehe auth.service ladeKassenFuerUser)
    .innerJoin(kassen, eq(kassen.id, userKassen.kasseId))
    .where(and(eq(userKassen.userId, user.sub), eq(kassen.mandantId, user.mandantId)))
  return zugeordnet.length === 0 || zugeordnet.some(z => z.kasseId === kasseId)
}

export async function pruefeBelegGehoertZuMandant(
  db:        Db,
  belegId:   string,
  mandantId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: belege.id })
    .from(belege)
    .where(and(eq(belege.id, belegId), eq(belege.mandantId, mandantId)))
    .limit(1)
  return !!row
}
