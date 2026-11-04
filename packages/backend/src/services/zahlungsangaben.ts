import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { mandanten } from '../db/schema.js'

export interface Zahlungsangaben {
  iban?:            string
  bic?:             string
  zahlungszielTage: number
  /** ISO-Zeitpunkt: Rechnungsdatum + Zahlungsziel */
  faelligAm:        string
}

/** Zahlungsangaben des Betriebs für eine Rechnung vom `rechnungsDatum` (ISO). */
export async function ladeZahlungsangaben(db: Db, mandantId: string, rechnungsDatum: string): Promise<Zahlungsangaben> {
  const [m] = await db
    .select({ iban: mandanten.rechnungIban, bic: mandanten.rechnungBic, tage: mandanten.rechnungZahlungszielTage })
    .from(mandanten).where(eq(mandanten.id, mandantId)).limit(1)
  const tage = m?.tage ?? 14
  return {
    ...(m?.iban ? { iban: m.iban } : {}),
    ...(m?.bic  ? { bic:  m.bic }  : {}),
    zahlungszielTage: tage,
    faelligAm:        new Date(Date.parse(rechnungsDatum) + tage * 86_400_000).toISOString(),
  }
}
