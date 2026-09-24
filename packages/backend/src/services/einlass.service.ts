/**
 * Einlass — Scan am Eingang, Geräteverwaltung, Protokoll.
 *
 * Kernregel „nur 1× gültig": die Einlösung ist EIN bedingtes UPDATE
 * (`erster_einlass_at IS NULL`). Zwei Scanner, die dieselbe Kopie im selben
 * Augenblick lesen, laufen in dieselbe Zeile — Postgres lässt genau einen
 * gewinnen, der andere bekommt 0 Zeilen und meldet „bereits eingelöst".
 *
 * Mehrfachtickets (Crew …) zählen bei jedem Eintritt hoch, setzen den ersten
 * Einlass aber nur einmal — die Besucherzahl zählt sie damit genau einmal.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  EINLASS_ZUGELASSEN,
  ticketCodeAusScan,
  type EinlassErgebnis,
  type EinlassErgebnisArt,
  type EinlassEvent,
  type EinlassGeraet,
  type EinlassLogEintrag,
  type EinlassTicket,
  type TicketEventStatus,
  type TicketTyp,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  einlassGeraete,
  mandanten,
  ticketEinlassLog,
  ticketEvents,
  tickets,
  type EinlassGeraetRow,
  type TicketBandRow,
  type TicketEventRow,
  type TicketRow,
} from '../db/schema.js'
import { alterUndBand, bandAnzeige, holeEinlassStand, ladeBaender, ladeEvent } from './ticket.service.js'

export class EinlassError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

function zuGeraet(g: EinlassGeraetRow): EinlassGeraet {
  return {
    id:             g.id,
    name:           g.name,
    erstelltAt:     g.erstelltAt.toISOString(),
    zuletztAktivAt: g.zuletztAktivAt?.toISOString() ?? null,
    widerrufenAt:   g.widerrufenAt?.toISOString() ?? null,
  }
}

export async function listeGeraete(db: Db, mandantId: string): Promise<EinlassGeraet[]> {
  const rows = await db.select().from(einlassGeraete)
    .where(eq(einlassGeraete.mandantId, mandantId))
    .orderBy(desc(einlassGeraete.erstelltAt))
  return rows.map(zuGeraet)
}

export async function legeGeraetAn(db: Db, mandantId: string, name: string): Promise<EinlassGeraet> {
  const [g] = await db.insert(einlassGeraete).values({ mandantId, name }).returning()
  return zuGeraet(g!)
}

export async function widerrufeGeraet(db: Db, mandantId: string, geraetId: string): Promise<EinlassGeraet> {
  const [g] = await db.update(einlassGeraete)
    .set({ widerrufenAt: new Date() })
    .where(and(eq(einlassGeraete.id, geraetId), eq(einlassGeraete.mandantId, mandantId), isNull(einlassGeraete.widerrufenAt)))
    .returning()
  if (!g) {
    const [vorhanden] = await db.select({ id: einlassGeraete.id }).from(einlassGeraete)
      .where(and(eq(einlassGeraete.id, geraetId), eq(einlassGeraete.mandantId, mandantId))).limit(1)
    throw new EinlassError(vorhanden ? 409 : 404, vorhanden ? 'Gerät ist bereits gesperrt' : 'Gerät nicht gefunden')
  }
  return zuGeraet(g)
}

/** „Zuletzt aktiv" nur jede Minute schreiben — nicht bei jedem Scan eine Zusatz-Schreiblast. */
const AKTIV_INTERVALL_MS = 60_000

/**
 * Prüft das Einlass-Gerät hinter einem Geräte-Token: existiert, gehört zum
 * Mandanten, ist nicht gesperrt. Gesperrt heißt sofort gesperrt — der Token
 * selbst bleibt zwar gültig signiert, wird aber hier abgewiesen.
 */
export async function pruefeGeraet(db: Db, geraetId: string, mandantId: string): Promise<EinlassGeraetRow> {
  const [g] = await db.select().from(einlassGeraete)
    .where(and(eq(einlassGeraete.id, geraetId), eq(einlassGeraete.mandantId, mandantId))).limit(1)
  if (!g) throw new EinlassError(401, 'Gerät unbekannt — bitte neu einrichten')
  if (g.widerrufenAt) throw new EinlassError(401, 'Gerät wurde gesperrt — bitte neu einrichten')
  const jetzt = new Date()
  if (!g.zuletztAktivAt || jetzt.getTime() - g.zuletztAktivAt.getTime() > AKTIV_INTERVALL_MS) {
    await db.update(einlassGeraete).set({ zuletztAktivAt: jetzt }).where(eq(einlassGeraete.id, g.id))
  }
  return g
}

export async function holeFirmenname(db: Db, mandantId: string): Promise<string> {
  const [m] = await db.select({ firmenname: mandanten.firmenname }).from(mandanten)
    .where(eq(mandanten.id, mandantId)).limit(1)
  return m?.firmenname ?? ''
}

// ---------------------------------------------------------------------------
// Events für die Einlass-App
// ---------------------------------------------------------------------------

/**
 * Events, an denen gerade oder demnächst Einlass sein kann: Test oder
 * veröffentlicht, nicht länger als einen Tag vorbei. Entwürfe und abgesagte
 * Events tauchen nicht auf.
 */
export async function listeEinlassEvents(db: Db, mandantId: string): Promise<EinlassEvent[]> {
  const rows = await db.select({
    id:       ticketEvents.id,
    titel:    ticketEvents.titel,
    beginn:   ticketEvents.beginn,
    ort:      ticketEvents.ort,
    status:   ticketEvents.status,
    tickets:  sql<number>`(SELECT count(*) FROM tickets t WHERE t.event_id = ticket_events.id AND t.status = 'gueltig')`.mapWith(Number),
    besucher: sql<number>`(SELECT count(*) FROM tickets t WHERE t.event_id = ticket_events.id AND t.erster_einlass_at IS NOT NULL)`.mapWith(Number),
  }).from(ticketEvents)
    .where(and(
      eq(ticketEvents.mandantId, mandantId),
      inArray(ticketEvents.status, ['test', 'veroeffentlicht']),
      sql`coalesce(${ticketEvents.ende}, ${ticketEvents.beginn} + interval '12 hours') >= now() - interval '1 day'`,
    ))
    .orderBy(ticketEvents.beginn)
  return rows.map(r => ({ ...r, beginn: r.beginn.toISOString(), status: r.status as TicketEventStatus }))
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function zuEinlassTicket(t: TicketRow, event: TicketEventRow, baender: TicketBandRow[]): EinlassTicket {
  const { alter, band } = alterUndBand(t.geburtsdatum, event, baender)
  return {
    code:                t.code,
    typ:                 t.typ as TicketTyp,
    rolle:               t.rolle,
    bezeichnung:         t.bezeichnung,
    name:                t.name,
    geburtsdatum:        t.geburtsdatum,
    alter,
    band:                band ? bandAnzeige(band) : null,
    einlassAnzahl:       t.einlassAnzahl,
    ersterEinlassAt:     t.ersterEinlassAt?.toISOString() ?? null,
    ersterEinlassGeraet: t.ersterEinlassGeraet,
  }
}

export async function scanne(
  db: Db,
  geraet: Pick<EinlassGeraetRow, 'id' | 'name' | 'mandantId'>,
  input: { eventId: string; inhalt: string },
): Promise<EinlassErgebnis> {
  const mandantId = geraet.mandantId
  const event     = await ladeEvent(db, mandantId, input.eventId)
  const baender   = await ladeBaender(db, event.id)
  const code      = ticketCodeAusScan(input.inhalt)

  const protokolliere = async (ergebnis: EinlassErgebnisArt, ticketId: string | null) => {
    await db.insert(ticketEinlassLog).values({
      mandantId, eventId: event.id, ticketId, geraetId: geraet.id, geraetName: geraet.name,
      code: code ?? input.inhalt.slice(0, 64), ergebnis,
    })
  }
  const antwort = async (
    ergebnis: EinlassErgebnisArt, t: TicketRow | null, extra: Partial<EinlassErgebnis> = {},
  ): Promise<EinlassErgebnis> => {
    await protokolliere(ergebnis, t?.id ?? null)
    return {
      ergebnis,
      zugelassen: EINLASS_ZUGELASSEN.has(ergebnis),
      ticket:     t ? zuEinlassTicket(t, event, baender) : null,
      ...extra,
      stand:      await holeEinlassStand(db, event, baender),
    }
  }

  if (!code) return antwort('unbekannt', null)

  // Das Event selbst muss Einlass zulassen — ein abgesagtes Event löst NICHTS ein.
  if (event.status === 'abgesagt' || event.status === 'entwurf') {
    const [t] = await db.select().from(tickets)
      .where(and(eq(tickets.code, code), eq(tickets.eventId, event.id))).limit(1)
    return antwort(event.status === 'abgesagt' ? 'abgesagt' : 'nicht_freigegeben', t ?? null)
  }

  const jetzt = new Date()
  const dasTicket = and(
    eq(tickets.code, code), eq(tickets.eventId, event.id),
    eq(tickets.mandantId, mandantId), eq(tickets.status, 'gueltig'),
  )

  // 1× gültig: nur einlösen, wenn noch nie eingelöst (atomar, siehe Kopfkommentar)
  const [einzel] = await db.update(tickets).set({
    ersterEinlassAt: jetzt, letzterEinlassAt: jetzt, einlassAnzahl: 1,
    ersterEinlassGeraet: geraet.name, updatedAt: jetzt,
  }).where(and(dasTicket, eq(tickets.typ, 'einzel'), isNull(tickets.ersterEinlassAt))).returning()
  if (einzel) return antwort('zugelassen', einzel)

  // Mehrfachticket: jeder Eintritt zählt hoch, der erste Einlass bleibt stehen
  const [mehrfach] = await db.update(tickets).set({
    ersterEinlassAt:     sql`coalesce(${tickets.ersterEinlassAt}, ${jetzt.toISOString()}::timestamptz)`,
    ersterEinlassGeraet: sql`coalesce(${tickets.ersterEinlassGeraet}, ${geraet.name})`,
    letzterEinlassAt:    jetzt,
    einlassAnzahl:       sql`${tickets.einlassAnzahl} + 1`,
    updatedAt:           jetzt,
  }).where(and(dasTicket, eq(tickets.typ, 'mehrfach'))).returning()
  if (mehrfach) return antwort('mehrfach', mehrfach)

  // Warum nicht? — Ticket unabhängig vom Event nachschlagen
  const [t] = await db.select().from(tickets).where(eq(tickets.code, code)).limit(1)
  if (!t || t.mandantId !== mandantId) return antwort('unbekannt', null)   // fremde Mandanten nie offenlegen
  if (t.eventId !== event.id) {
    const [anderes] = await db.select({ titel: ticketEvents.titel, beginn: ticketEvents.beginn })
      .from(ticketEvents).where(eq(ticketEvents.id, t.eventId)).limit(1)
    // Das Ticket gehört zu einem anderen Event — dessen Bänder gelten hier nicht
    await protokolliere('falsches_event', t.id)
    return {
      ergebnis: 'falsches_event', zugelassen: false,
      ticket: { ...zuEinlassTicket(t, event, []), band: null, alter: null },
      ...(anderes ? { anderesEvent: { titel: anderes.titel, beginn: anderes.beginn.toISOString() } } : {}),
      stand: await holeEinlassStand(db, event, baender),
    }
  }
  if (t.status === 'storniert')  return antwort('storniert', t)
  if (t.status === 'reserviert') return antwort('nicht_bezahlt', t)
  return antwort('bereits_eingeloest', t)
}

// ---------------------------------------------------------------------------
// Protokoll (Backoffice)
// ---------------------------------------------------------------------------

export async function listeEinlassLog(
  db: Db, mandantId: string, eventId: string, limit = 200,
): Promise<EinlassLogEintrag[]> {
  await ladeEvent(db, mandantId, eventId)
  const rows = await db.select({
    log:    ticketEinlassLog,
    ticket: { bezeichnung: tickets.bezeichnung, typ: tickets.typ, name: tickets.name },
  })
    .from(ticketEinlassLog)
    .leftJoin(tickets, eq(tickets.id, ticketEinlassLog.ticketId))
    .where(and(eq(ticketEinlassLog.eventId, eventId), eq(ticketEinlassLog.mandantId, mandantId)))
    .orderBy(desc(ticketEinlassLog.zeitpunkt))
    .limit(limit)
  return rows.map(({ log, ticket }) => ({
    id:         log.id,
    zeitpunkt:  log.zeitpunkt.toISOString(),
    geraetName: log.geraetName,
    ergebnis:   log.ergebnis as EinlassErgebnisArt,
    code:       log.code,
    offline:    log.offline,
    ticket:     ticket?.bezeichnung
      ? { bezeichnung: ticket.bezeichnung, typ: ticket.typ as TicketTyp, name: ticket.name }
      : null,
  }))
}
