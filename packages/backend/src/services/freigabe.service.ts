/**
 * Freigaben (Vier-Augen-Prinzip).
 *
 * Storno- und Rabatt-Missbrauch ist im Gastro-Betrieb der klassische
 * Schwundkanal: Ware wird kassiert, danach storniert, das Bargeld bleibt in der
 * Tasche. Rollen und Audit-Protokoll allein helfen nicht — das Protokoll liest
 * im Betrieb niemand.
 *
 * Deshalb: ab einer einstellbaren Schwelle muss jemand mit der Berechtigung
 * „freigabe" (oder ein Admin) seinen PIN eingeben. Geprüft wird IMMER im
 * Backend — eine Oberfläche, die den Dialog überspringt, kommt trotzdem nicht
 * vorbei.
 */

import bcrypt from 'bcryptjs'
import { and, eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { mandanten, users } from '../db/schema.js'

/** Maschinenlesbarer Code, damit die Oberfläche den PIN-Dialog öffnen kann. */
export const FREIGABE_CODE = 'freigabe_erforderlich'

export class FreigabeError extends Error {
  readonly httpStatus = 403
  readonly code = FREIGABE_CODE
  constructor(
    message: string,
    /** Schwelle in Cent — die Oberfläche kann sie im Dialog nennen. */
    public readonly abCent: number,
  ) {
    super(message)
    this.name = 'FreigabeError'
  }
}

export interface Freigeber {
  userId: string
  name:   string
}

/** Cent → „12,34 €" (deutsches Format; die Meldung landet direkt in der Kassa). */
function euro(cent: number): string {
  return `${(cent / 100).toFixed(2).replace('.', ',')} €`
}

/**
 * Prüft, ob ein Storno über der Schwelle liegt, und verlangt in dem Fall einen
 * gültigen Freigabe-PIN.
 *
 * @returns den Freigeber, wenn eine Freigabe nötig WAR und erteilt wurde;
 *          null, wenn keine nötig war (Schwelle 0 oder Betrag darunter).
 * @throws  FreigabeError wenn eine Freigabe nötig ist und PIN fehlt/falsch ist.
 */
export async function pruefeStornoFreigabe(
  db:         Db,
  mandantId:  string,
  betragCent: number,
  pin?:       string,
): Promise<Freigeber | null> {
  const [m] = await db
    .select({ abCent: mandanten.stornoFreigabeAbCent })
    .from(mandanten)
    .where(eq(mandanten.id, mandantId))
    .limit(1)

  const abCent = m?.abCent ?? 0
  // 0 = Freigabe abgeschaltet. Vergleich mit >=, damit „ab 50 €" auch bei
  // genau 50 € greift — sonst wäre die Schwelle für den Bediener überraschend.
  if (abCent === 0 || Math.abs(betragCent) < abCent) return null

  if (!pin) {
    throw new FreigabeError(
      `Storno ab ${euro(abCent)} muss freigegeben werden.`,
      abCent,
    )
  }

  const freigeber = await findeFreigeber(db, mandantId, pin)
  if (!freigeber) {
    throw new FreigabeError('Freigabe-PIN ist nicht gültig.', abCent)
  }
  return freigeber
}

/**
 * Prüft, ob ein Rabatt über der Schwelle liegt (prozentual ODER absolut — was
 * zuerst greift), und verlangt in dem Fall einen gültigen Freigabe-PIN.
 *
 * Ohne diese Prüfung wäre die Storno-Freigabe wertlos: statt 80 € zu
 * stornieren gibt der Kellner einfach 100 % Rabatt — gleicher Effekt, kein PIN.
 *
 * @param nachlassCent Gesamtnachlass des Belegs (Belegrabatt + Positionsrabatte)
 * @param basisCent    Belegsumme VOR dem Nachlass (Bezugsgröße fürs Prozent)
 */
export async function pruefeRabattFreigabe(
  db:           Db,
  mandantId:    string,
  nachlassCent: number,
  basisCent:    number,
  pin?:         string,
): Promise<Freigeber | null> {
  if (nachlassCent <= 0) return null

  const [m] = await db
    .select({
      abProzent: mandanten.rabattFreigabeAbProzent,
      abCent:    mandanten.rabattFreigabeAbCent,
    })
    .from(mandanten)
    .where(eq(mandanten.id, mandantId))
    .limit(1)

  const abProzent = m?.abProzent ?? 0
  const abCent    = m?.abCent ?? 0

  const prozent        = basisCent > 0 ? (nachlassCent / basisCent) * 100 : 100
  const prozentGreift  = abProzent > 0 && prozent >= abProzent
  const centGreift     = abCent > 0 && nachlassCent >= abCent
  if (!prozentGreift && !centGreift) return null

  if (!pin) {
    const grenze = prozentGreift ? `${abProzent} % Nachlass` : euro(abCent)
    throw new FreigabeError(`Rabatt ab ${grenze} muss freigegeben werden.`, abCent)
  }

  const freigeber = await findeFreigeber(db, mandantId, pin)
  if (!freigeber) {
    throw new FreigabeError('Freigabe-PIN ist nicht gültig.', abCent)
  }
  return freigeber
}

/**
 * Sucht den Benutzer zum PIN — nur Admins und Träger der Berechtigung
 * „freigabe" kommen infrage.
 *
 * Wie beim PIN-Login wird über alle Kandidaten gehasht statt den PIN
 * nachzuschlagen: bcrypt-Hashes sind nicht rückwärts durchsuchbar.
 */
async function findeFreigeber(db: Db, mandantId: string, pin: string): Promise<Freigeber | null> {
  const kandidaten = await db
    .select({
      id:             users.id,
      name:           users.name,
      rolle:          users.rolle,
      berechtigungen: users.berechtigungen,
      pinHash:        users.pinHash,
    })
    .from(users)
    .where(and(
      eq(users.mandantId, mandantId),
      eq(users.aktiv, true),
      isNotNull(users.pinHash),
    ))

  for (const k of kandidaten) {
    const darfFreigeben = k.rolle === 'admin'
      || (Array.isArray(k.berechtigungen) && (k.berechtigungen as string[]).includes('freigabe'))
    if (!darfFreigeben) continue
    if (await bcrypt.compare(pin, k.pinHash!)) {
      return { userId: k.id, name: k.name }
    }
  }
  return null
}
