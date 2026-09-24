/**
 * Datenschutz im Ticketing (DSGVO): Namen, Geburtsdaten und E-Mail-Adressen
 * von Gästen und Käufern werden `datenLoeschenNachTagen` Tage nach Eventende
 * gelöscht (Einstellung je Event, Standard 30).
 *
 * Was bleibt: die Tickets selbst (Code, Art, Status, Einlasszeiten — für
 * Besucherzahlen und Protokoll) und die Bestellungen mit Beträgen und
 * Beleg-Verweis. Die Belege sind RKSV-Aufzeichnungen und bleiben unberührt,
 * ebenso Kunden einer Firmenrechnung (Aufbewahrung nach UStG/BAO).
 */

import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { ticketBestellungen, ticketEvents, tickets } from '../db/schema.js'
import { TicketError, ladeEvent } from './ticket.service.js'

export interface LoeschErgebnis {
  tickets:      number
  bestellungen: number
}

/** Personendaten eines Events löschen — idempotent, ein zweiter Lauf ändert nichts mehr. */
export async function loeschePersonendaten(db: Db, eventId: string, jetzt = new Date()): Promise<LoeschErgebnis> {
  return db.transaction(async (tx) => {
    const t = await tx.update(tickets)
      .set({ name: null, geburtsdatum: null, email: null, updatedAt: jetzt })
      .where(and(
        eq(tickets.eventId, eventId),
        or(isNotNull(tickets.name), isNotNull(tickets.geburtsdatum), isNotNull(tickets.email)),
      ))
      .returning({ id: tickets.id })
    const b = await tx.update(ticketBestellungen)
      .set({ name: 'gelöscht', email: '', rechnung: null, updatedAt: jetzt })
      .where(and(eq(ticketBestellungen.eventId, eventId), sql`${ticketBestellungen.email} <> ''`))
      .returning({ id: ticketBestellungen.id })
    await tx.update(ticketEvents).set({ datenGeloeschtAt: jetzt, updatedAt: jetzt }).where(eq(ticketEvents.id, eventId))
    return { tickets: t.length, bestellungen: b.length }
  })
}

/** Stündlicher Job: alle Events, deren Aufbewahrungsfrist abgelaufen ist. */
export async function loescheFaelligePersonendaten(
  db: Db, jetzt = new Date(),
): Promise<LoeschErgebnis & { events: number }> {
  const faellig = await db.select({ id: ticketEvents.id }).from(ticketEvents).where(and(
    isNull(ticketEvents.datenGeloeschtAt),
    sql`coalesce(${ticketEvents.ende}, ${ticketEvents.beginn}) + ${ticketEvents.datenLoeschenNachTagen} * interval '1 day' < ${jetzt.toISOString()}::timestamptz`,
  ))
  const summe = { events: faellig.length, tickets: 0, bestellungen: 0 }
  for (const e of faellig) {
    const r = await loeschePersonendaten(db, e.id, jetzt)
    summe.tickets      += r.tickets
    summe.bestellungen += r.bestellungen
  }
  return summe
}

/**
 * Backoffice „Jetzt löschen": erst nach dem Event — vorher braucht der Einlass
 * die Geburtsdaten (Band) und das Personal die Namen.
 */
export async function loeschePersonendatenJetzt(
  db: Db, mandantId: string, eventId: string, jetzt = new Date(),
): Promise<LoeschErgebnis> {
  const event = await ladeEvent(db, mandantId, eventId)
  if (jetzt < (event.ende ?? event.beginn)) {
    throw new TicketError(409, 'Personendaten lassen sich erst nach dem Event löschen')
  }
  return loeschePersonendaten(db, event.id, jetzt)
}
