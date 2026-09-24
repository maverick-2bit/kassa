/**
 * Ticketing — Events, Bänder, Ticketarten, Tickets (Backoffice + öffentliche Ansicht).
 *
 * Grundsätze:
 *  - Das Band ergibt sich LIVE aus Geburtsdatum + Eventtag + Bandregeln des
 *    Events; es wird nicht am Ticket gespeichert. Wer die Regeln vor dem Event
 *    korrigiert, korrigiert damit alle Tickets.
 *  - Die öffentliche Ansicht zeigt nie Geburtsdatum oder E-Mail — sie ist zum
 *    Weiterleiten gedacht.
 *  - „Besucher" = Tickets mit erstem Einlass. Mehrfachtickets zählen dadurch
 *    genau einmal, egal wie oft die Crew rein und raus geht.
 */

import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm'
import {
  STANDARD_BAENDER,
  TICKET_CODE_ALPHABET,
  TICKET_CODE_LAENGE,
  alterAm,
  bandAltersText,
  bandFuerAlter,
  ticketUrl,
  wienerTag,
  type MwStSatz,
  type TicketAdmin,
  type TicketAnzeigeStatus,
  type TicketArt,
  type TicketArtInput,
  type TicketArtUpdate,
  type TicketAusstellenInput,
  type TicketBaenderSetzen,
  type TicketBand,
  type TicketBandAnzeige,
  type TicketEinlassStand,
  type TicketEventDetail,
  type TicketEventInput,
  type TicketEventStatus,
  type TicketEventUebersicht,
  type TicketEventUpdate,
  type TicketOeffentlich,
  type TicketStatus,
  type TicketTyp,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  mandanten,
  ticketArten,
  ticketBaender,
  ticketEvents,
  tickets,
  type TicketBandRow,
  type TicketEventRow,
  type TicketRow,
} from '../db/schema.js'
import type { TicketPdfDaten } from './ticket-pdf.service.js'

export class TicketError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

/**
 * Zufalls-Code aus dem Ticket-Alphabet. Rejection Sampling statt `% 31`:
 * 256 ist nicht durch 31 teilbar, ein schlichtes Modulo würde die ersten
 * Zeichen minimal bevorzugen.
 */
export function erzeugeTicketCode(): string {
  const n = TICKET_CODE_ALPHABET.length
  const grenze = 256 - (256 % n)
  let code = ''
  while (code.length < TICKET_CODE_LAENGE) {
    for (const byte of randomBytes(TICKET_CODE_LAENGE * 2)) {
      if (byte < grenze) code += TICKET_CODE_ALPHABET[byte % n]
      if (code.length === TICKET_CODE_LAENGE) break
    }
  }
  return code
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

function bandAnzeige(b: TicketBandRow): TicketBandAnzeige {
  return { bezeichnung: b.bezeichnung, farbe: b.farbe, altersText: bandAltersText(b), hinweis: b.hinweis }
}

function zuBand(b: TicketBandRow): TicketBand {
  return {
    id: b.id, bezeichnung: b.bezeichnung, farbe: b.farbe, alterVon: b.alterVon,
    alterBis: b.alterBis, hinweis: b.hinweis, reihenfolge: b.reihenfolge,
  }
}

/** Alter am Eventtag + passendes Band (null ohne Geburtsdatum). */
export function alterUndBand(
  geburtsdatum: string | null, event: Pick<TicketEventRow, 'beginn'>, baender: TicketBandRow[],
): { alter: number | null; band: TicketBandRow | null } {
  if (!geburtsdatum) return { alter: null, band: null }
  const alter = alterAm(geburtsdatum, wienerTag(event.beginn))
  return { alter, band: bandFuerAlter(baender, alter) }
}

export function anzeigeStatus(
  t: Pick<TicketRow, 'status' | 'typ' | 'ersterEinlassAt'>, eventStatus: string,
): TicketAnzeigeStatus {
  if (eventStatus === 'abgesagt') return 'abgesagt'
  if (t.status === 'storniert')   return 'storniert'
  if (t.typ === 'einzel' && t.ersterEinlassAt) return 'eingeloest'
  return 'gueltig'
}

function zuTicketAdmin(
  t: TicketRow, event: TicketEventRow, baender: TicketBandRow[], basisUrl: string | null,
): TicketAdmin {
  const { alter, band } = alterUndBand(t.geburtsdatum, event, baender)
  return {
    id:              t.id,
    code:            t.code,
    typ:             t.typ as TicketTyp,
    rolle:           t.rolle,
    bezeichnung:     t.bezeichnung,
    ticketArtId:     t.ticketArtId,
    name:            t.name,
    geburtsdatum:    t.geburtsdatum,
    alter,
    band:            band ? bandAnzeige(band) : null,
    email:           t.email,
    status:          t.status as TicketStatus,
    anzeigeStatus:   anzeigeStatus(t, event.status),
    preisCent:       t.preisCent,
    ersterEinlassAt: t.ersterEinlassAt?.toISOString() ?? null,
    einlassAnzahl:   t.einlassAnzahl,
    createdAt:       t.createdAt.toISOString(),
    url:             basisUrl ? ticketUrl(basisUrl, t.code) : null,
  }
}

async function ladeEvent(db: Db, mandantId: string, eventId: string): Promise<TicketEventRow> {
  const [event] = await db.select().from(ticketEvents)
    .where(and(eq(ticketEvents.id, eventId), eq(ticketEvents.mandantId, mandantId))).limit(1)
  if (!event) throw new TicketError(404, 'Event nicht gefunden')
  return event
}

async function ladeBaender(db: Db, eventId: string): Promise<TicketBandRow[]> {
  return db.select().from(ticketBaender)
    .where(eq(ticketBaender.eventId, eventId)).orderBy(asc(ticketBaender.reihenfolge))
}

async function ladeMandant(db: Db, mandantId: string): Promise<{ firmenname: string; ticketBasisUrl: string | null }> {
  const [m] = await db.select({ firmenname: mandanten.firmenname, ticketBasisUrl: mandanten.ticketBasisUrl })
    .from(mandanten).where(eq(mandanten.id, mandantId)).limit(1)
  if (!m) throw new TicketError(404, 'Mandant nicht gefunden')
  return m
}

const leerZuNull = (s: string | null | undefined): string | null | undefined =>
  s === undefined ? undefined : (s === null || s.trim() === '' ? null : s.trim())

// ---------------------------------------------------------------------------
// Einlass-Stand
// ---------------------------------------------------------------------------

export async function holeEinlassStand(
  db: Db, event: TicketEventRow, baender: TicketBandRow[],
): Promise<TicketEinlassStand> {
  const [zaehler] = await db.select({
    tickets:          sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'gueltig')`.mapWith(Number),
    mehrfach:         sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'gueltig' AND ${tickets.typ} = 'mehrfach')`.mapWith(Number),
    besucher:         sql<number>`count(*) FILTER (WHERE ${tickets.ersterEinlassAt} IS NOT NULL)`.mapWith(Number),
    besucherMehrfach: sql<number>`count(*) FILTER (WHERE ${tickets.ersterEinlassAt} IS NOT NULL AND ${tickets.typ} = 'mehrfach')`.mapWith(Number),
  }).from(tickets).where(eq(tickets.eventId, event.id))

  // Bänder je Farbe: nur eingelassene Gäste — das ist der tatsächliche Verbrauch.
  const eingelassen = await db.select({ geburtsdatum: tickets.geburtsdatum })
    .from(tickets).where(and(eq(tickets.eventId, event.id), isNotNull(tickets.ersterEinlassAt)))
  const proBand = new Map<string, { bandId: string | null; bezeichnung: string; farbe: string | null; anzahl: number }>()
  for (const b of baender) proBand.set(b.id, { bandId: b.id, bezeichnung: b.bezeichnung, farbe: b.farbe, anzahl: 0 })
  for (const e of eingelassen) {
    const { band } = alterUndBand(e.geburtsdatum, event, baender)
    const schluessel = band?.id ?? 'ohne'
    const eintrag = proBand.get(schluessel)
      ?? { bandId: null, bezeichnung: 'ohne Band', farbe: null, anzahl: 0 }
    eintrag.anzahl++
    proBand.set(schluessel, eintrag)
  }

  return {
    tickets:          zaehler?.tickets ?? 0,
    mehrfach:         zaehler?.mehrfach ?? 0,
    besucher:         zaehler?.besucher ?? 0,
    besucherMehrfach: zaehler?.besucherMehrfach ?? 0,
    proBand:          [...proBand.values()],
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function listeEvents(db: Db, mandantId: string): Promise<TicketEventUebersicht[]> {
  const rows = await db.select({
    id:       ticketEvents.id,
    titel:    ticketEvents.titel,
    beginn:   ticketEvents.beginn,
    ende:     ticketEvents.ende,
    ort:      ticketEvents.ort,
    status:   ticketEvents.status,
    tickets:  sql<number>`(SELECT count(*) FROM tickets t WHERE t.event_id = ${ticketEvents.id} AND t.status = 'gueltig')`.mapWith(Number),
    besucher: sql<number>`(SELECT count(*) FROM tickets t WHERE t.event_id = ${ticketEvents.id} AND t.erster_einlass_at IS NOT NULL)`.mapWith(Number),
  }).from(ticketEvents)
    .where(eq(ticketEvents.mandantId, mandantId))
    .orderBy(desc(ticketEvents.beginn))

  return rows.map(r => ({
    ...r,
    beginn: r.beginn.toISOString(),
    ende:   r.ende?.toISOString() ?? null,
    status: r.status as TicketEventStatus,
  }))
}

export async function holeEventDetail(db: Db, mandantId: string, eventId: string): Promise<TicketEventDetail> {
  const event   = await ladeEvent(db, mandantId, eventId)
  const baender = await ladeBaender(db, eventId)
  const arten   = await db.select({
    art:        ticketArten,
    ausgegeben: sql<number>`(SELECT count(*) FROM tickets t WHERE t.ticket_art_id = ${ticketArten.id} AND t.status <> 'storniert')`.mapWith(Number),
  }).from(ticketArten)
    .where(eq(ticketArten.eventId, eventId))
    .orderBy(asc(ticketArten.reihenfolge), asc(ticketArten.createdAt))

  return {
    id:           event.id,
    titel:        event.titel,
    beschreibung: event.beschreibung,
    beginn:       event.beginn.toISOString(),
    ende:         event.ende?.toISOString() ?? null,
    ort:          event.ort,
    adresse:      event.adresse,
    hinweis:      event.hinweis,
    veranstalter: event.veranstalter,
    status:       event.status as TicketEventStatus,
    mindestalter: event.mindestalter,
    namePflicht:  event.namePflicht,
    datenLoeschenNachTagen: event.datenLoeschenNachTagen,
    datenGeloeschtAt:       event.datenGeloeschtAt?.toISOString() ?? null,
    baender:      baender.map(zuBand),
    arten:        arten.map(({ art, ausgegeben }) => zuTicketArt(art, ausgegeben)),
    stand:        await holeEinlassStand(db, event, baender),
  }
}

function zuTicketArt(a: typeof ticketArten.$inferSelect, ausgegeben: number): TicketArt {
  return {
    id:               a.id,
    eventId:          a.eventId,
    bezeichnung:      a.bezeichnung,
    beschreibung:     a.beschreibung,
    preisCent:        a.preisCent,
    mwstSatz:         a.mwstSatz as MwStSatz,
    kontingent:       a.kontingent,
    maxProBestellung: a.maxProBestellung,
    verkaufAb:        a.verkaufAb?.toISOString() ?? null,
    verkaufBis:       a.verkaufBis?.toISOString() ?? null,
    onlineVerkauf:    a.onlineVerkauf,
    reihenfolge:      a.reihenfolge,
    ausgegeben,
  }
}

/** Neues Event — bekommt die Standardbänder (Jugendschutz) gleich mit. */
export async function erstelleEvent(db: Db, mandantId: string, input: TicketEventInput): Promise<TicketEventDetail> {
  const id = await db.transaction(async (tx) => {
    const [event] = await tx.insert(ticketEvents).values({
      mandantId,
      titel:        input.titel,
      beschreibung: leerZuNull(input.beschreibung) ?? null,
      beginn:       new Date(input.beginn),
      ende:         input.ende ? new Date(input.ende) : null,
      ort:          input.ort,
      adresse:      leerZuNull(input.adresse) ?? null,
      hinweis:      leerZuNull(input.hinweis) ?? null,
      veranstalter: leerZuNull(input.veranstalter) ?? null,
      status:       input.status ?? 'entwurf',
      mindestalter: input.mindestalter ?? null,
      namePflicht:  input.namePflicht ?? false,
      ...(input.datenLoeschenNachTagen !== undefined ? { datenLoeschenNachTagen: input.datenLoeschenNachTagen } : {}),
    }).returning({ id: ticketEvents.id })
    await tx.insert(ticketBaender).values(STANDARD_BAENDER.map((b, i) => ({
      mandantId, eventId: event!.id, bezeichnung: b.bezeichnung, farbe: b.farbe,
      alterVon: b.alterVon, alterBis: b.alterBis, hinweis: b.hinweis ?? null, reihenfolge: b.reihenfolge ?? i,
    })))
    return event!.id
  })
  return holeEventDetail(db, mandantId, id)
}

export async function aktualisiereEvent(
  db: Db, mandantId: string, eventId: string, input: TicketEventUpdate,
): Promise<TicketEventDetail> {
  const vorher = await ladeEvent(db, mandantId, eventId)
  // Ende gegen den (ggf. unveränderten) Beginn prüfen — das Schema sieht nur die Änderung.
  const beginn = input.beginn ? new Date(input.beginn) : vorher.beginn
  const ende   = input.ende === undefined ? vorher.ende : (input.ende ? new Date(input.ende) : null)
  if (ende && ende <= beginn) throw new TicketError(400, 'Das Ende muss nach dem Beginn liegen')

  await db.update(ticketEvents).set({
    ...(input.titel        !== undefined ? { titel: input.titel } : {}),
    ...(input.beschreibung !== undefined ? { beschreibung: leerZuNull(input.beschreibung) ?? null } : {}),
    ...(input.beginn       !== undefined ? { beginn } : {}),
    ...(input.ende         !== undefined ? { ende } : {}),
    ...(input.ort          !== undefined ? { ort: input.ort } : {}),
    ...(input.adresse      !== undefined ? { adresse: leerZuNull(input.adresse) ?? null } : {}),
    ...(input.hinweis      !== undefined ? { hinweis: leerZuNull(input.hinweis) ?? null } : {}),
    ...(input.veranstalter !== undefined ? { veranstalter: leerZuNull(input.veranstalter) ?? null } : {}),
    ...(input.status       !== undefined ? { status: input.status } : {}),
    ...(input.mindestalter !== undefined ? { mindestalter: input.mindestalter } : {}),
    ...(input.namePflicht  !== undefined ? { namePflicht: input.namePflicht } : {}),
    ...(input.datenLoeschenNachTagen !== undefined ? { datenLoeschenNachTagen: input.datenLoeschenNachTagen } : {}),
    updatedAt: new Date(),
  }).where(and(eq(ticketEvents.id, eventId), eq(ticketEvents.mandantId, mandantId)))
  return holeEventDetail(db, mandantId, eventId)
}

/** Löschen nur ohne Tickets — sonst wären ausgegebene Tickets verwaist. Dann „abgesagt" setzen. */
export async function loescheEvent(db: Db, mandantId: string, eventId: string): Promise<void> {
  await ladeEvent(db, mandantId, eventId)
  const [{ anzahl } = { anzahl: 0 }] = await db.select({ anzahl: sql<number>`count(*)`.mapWith(Number) })
    .from(tickets).where(eq(tickets.eventId, eventId))
  if (anzahl > 0) {
    throw new TicketError(409, `Für dieses Event gibt es ${anzahl} Ticket(s) — statt zu löschen den Status auf „Abgesagt" setzen.`)
  }
  await db.delete(ticketEvents).where(and(eq(ticketEvents.id, eventId), eq(ticketEvents.mandantId, mandantId)))
}

// ---------------------------------------------------------------------------
// Bänder
// ---------------------------------------------------------------------------

export async function setzeBaender(
  db: Db, mandantId: string, eventId: string, input: TicketBaenderSetzen,
): Promise<TicketBand[]> {
  await ladeEvent(db, mandantId, eventId)
  await db.transaction(async (tx) => {
    await tx.delete(ticketBaender).where(eq(ticketBaender.eventId, eventId))
    if (input.baender.length > 0) {
      await tx.insert(ticketBaender).values(input.baender.map((b, i) => ({
        mandantId, eventId, bezeichnung: b.bezeichnung, farbe: b.farbe.toLowerCase(),
        alterVon: b.alterVon, alterBis: b.alterBis,
        hinweis: leerZuNull(b.hinweis) ?? null, reihenfolge: b.reihenfolge ?? i,
      })))
    }
  })
  return (await ladeBaender(db, eventId)).map(zuBand)
}

// ---------------------------------------------------------------------------
// Ticketarten
// ---------------------------------------------------------------------------

async function ladeTicketArt(db: Db, mandantId: string, artId: string) {
  const [art] = await db.select().from(ticketArten)
    .where(and(eq(ticketArten.id, artId), eq(ticketArten.mandantId, mandantId))).limit(1)
  if (!art) throw new TicketError(404, 'Ticketart nicht gefunden')
  return art
}

async function ausgegebeneTickets(db: Db, artId: string): Promise<number> {
  const [{ anzahl } = { anzahl: 0 }] = await db.select({ anzahl: sql<number>`count(*)`.mapWith(Number) })
    .from(tickets).where(and(eq(tickets.ticketArtId, artId), sql`${tickets.status} <> 'storniert'`))
  return anzahl
}

export async function erstelleTicketArt(
  db: Db, mandantId: string, eventId: string, input: TicketArtInput,
): Promise<TicketArt> {
  await ladeEvent(db, mandantId, eventId)
  const [art] = await db.insert(ticketArten).values({
    mandantId, eventId,
    bezeichnung:  input.bezeichnung,
    beschreibung: leerZuNull(input.beschreibung) ?? null,
    preisCent:    input.preisCent,
    mwstSatz:     input.mwstSatz,
    kontingent:   input.kontingent ?? null,
    verkaufAb:    input.verkaufAb ? new Date(input.verkaufAb) : null,
    verkaufBis:   input.verkaufBis ? new Date(input.verkaufBis) : null,
    ...(input.maxProBestellung !== undefined ? { maxProBestellung: input.maxProBestellung } : {}),
    ...(input.onlineVerkauf    !== undefined ? { onlineVerkauf: input.onlineVerkauf } : {}),
    ...(input.reihenfolge      !== undefined ? { reihenfolge: input.reihenfolge } : {}),
  }).returning()
  return zuTicketArt(art!, 0)
}

export async function aktualisiereTicketArt(
  db: Db, mandantId: string, artId: string, input: TicketArtUpdate,
): Promise<TicketArt> {
  await ladeTicketArt(db, mandantId, artId)
  const ausgegeben = await ausgegebeneTickets(db, artId)
  if (input.kontingent !== undefined && input.kontingent !== null && input.kontingent < ausgegeben) {
    throw new TicketError(409, `Kontingent kann nicht unter die ${ausgegeben} bereits ausgegebenen Tickets sinken`)
  }
  const [art] = await db.update(ticketArten).set({
    ...(input.bezeichnung      !== undefined ? { bezeichnung: input.bezeichnung } : {}),
    ...(input.beschreibung     !== undefined ? { beschreibung: leerZuNull(input.beschreibung) ?? null } : {}),
    ...(input.preisCent        !== undefined ? { preisCent: input.preisCent } : {}),
    ...(input.mwstSatz         !== undefined ? { mwstSatz: input.mwstSatz } : {}),
    ...(input.kontingent       !== undefined ? { kontingent: input.kontingent } : {}),
    ...(input.maxProBestellung !== undefined ? { maxProBestellung: input.maxProBestellung } : {}),
    ...(input.verkaufAb        !== undefined ? { verkaufAb: input.verkaufAb ? new Date(input.verkaufAb) : null } : {}),
    ...(input.verkaufBis       !== undefined ? { verkaufBis: input.verkaufBis ? new Date(input.verkaufBis) : null } : {}),
    ...(input.onlineVerkauf    !== undefined ? { onlineVerkauf: input.onlineVerkauf } : {}),
    ...(input.reihenfolge      !== undefined ? { reihenfolge: input.reihenfolge } : {}),
  }).where(and(eq(ticketArten.id, artId), eq(ticketArten.mandantId, mandantId))).returning()
  return zuTicketArt(art!, ausgegeben)
}

export async function loescheTicketArt(db: Db, mandantId: string, artId: string): Promise<void> {
  await ladeTicketArt(db, mandantId, artId)
  const [{ anzahl } = { anzahl: 0 }] = await db.select({ anzahl: sql<number>`count(*)`.mapWith(Number) })
    .from(tickets).where(eq(tickets.ticketArtId, artId))
  if (anzahl > 0) {
    throw new TicketError(409, `Von dieser Ticketart gibt es ${anzahl} Ticket(s) — stattdessen den Online-Verkauf abschalten.`)
  }
  await db.delete(ticketArten).where(and(eq(ticketArten.id, artId), eq(ticketArten.mandantId, mandantId)))
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export async function listeTickets(
  db: Db, mandantId: string, eventId: string, filter: { suche?: string | undefined },
): Promise<TicketAdmin[]> {
  const event   = await ladeEvent(db, mandantId, eventId)
  const baender = await ladeBaender(db, eventId)
  const { ticketBasisUrl } = await ladeMandant(db, mandantId)

  const bedingungen = [eq(tickets.eventId, eventId), eq(tickets.mandantId, mandantId)]
  const suche = filter.suche?.trim()
  if (suche) {
    const muster = `%${suche.replace(/[%_\\]/g, m => `\\${m}`)}%`
    bedingungen.push(or(
      ilike(tickets.code, muster), ilike(tickets.name, muster),
      ilike(tickets.email, muster), ilike(tickets.rolle, muster),
    )!)
  }
  const rows = await db.select().from(tickets)
    .where(and(...bedingungen)).orderBy(desc(tickets.createdAt)).limit(1000)
  return rows.map(t => zuTicketAdmin(t, event, baender, ticketBasisUrl))
}

/** Intern ausstellen: Freikarten (Einzel) oder Mehrfachtickets (Crew …). */
export async function stelleTicketsAus(
  db: Db, mandantId: string, userId: string, eventId: string, input: TicketAusstellenInput,
): Promise<TicketAdmin[]> {
  const event   = await ladeEvent(db, mandantId, eventId)
  const baender = await ladeBaender(db, eventId)
  if (event.status === 'abgesagt') throw new TicketError(409, 'Das Event ist abgesagt')

  let bezeichnung: string
  let ticketArtId: string | null = null
  let mwstSatz = 'ermaessigt1'
  if (input.typ === 'einzel' || input.ticketArtId) {
    const art = await ladeTicketArt(db, mandantId, input.ticketArtId!)
    if (art.eventId !== eventId) throw new TicketError(400, 'Die Ticketart gehört zu einem anderen Event')
    ticketArtId = art.id
    mwstSatz = art.mwstSatz
    bezeichnung = art.bezeichnung
    if (art.kontingent !== null) {
      const ausgegeben = await ausgegebeneTickets(db, art.id)
      if (ausgegeben + input.anzahl > art.kontingent) {
        throw new TicketError(409, `Kontingent erschöpft: noch ${Math.max(0, art.kontingent - ausgegeben)} von ${art.kontingent} frei`)
      }
    }
  } else {
    bezeichnung = input.rolle!
  }
  if (input.typ === 'mehrfach') bezeichnung = input.rolle!

  if (input.geburtsdatum && event.mindestalter !== null) {
    const alter = alterAm(input.geburtsdatum, wienerTag(event.beginn))
    if (alter < event.mindestalter) {
      throw new TicketError(422, `Mindestalter ${event.mindestalter} — am Eventtag erst ${alter} Jahre`)
    }
  }
  if (event.namePflicht && input.typ === 'einzel' && input.anzahl === 1 && !input.name) {
    throw new TicketError(422, 'Für dieses Event ist ein Name je Ticket Pflicht')
  }

  const neu = Array.from({ length: input.anzahl }, () => ({
    mandantId, eventId, ticketArtId,
    code:          erzeugeTicketCode(),
    typ:           input.typ,
    rolle:         input.typ === 'mehrfach' ? input.rolle! : null,
    bezeichnung,
    name:          input.name ?? null,
    geburtsdatum:  input.geburtsdatum ?? null,
    email:         input.email ?? null,
    status:        'gueltig',
    // Intern ausgestellt = unentgeltlich (Freikarte bzw. Crew)
    preisCent:     0,
    mwstSatz,
    ausgestelltVon: userId,
  }))
  const rows = await db.insert(tickets).values(neu).returning()
  const { ticketBasisUrl } = await ladeMandant(db, mandantId)
  return rows.map(t => zuTicketAdmin(t, event, baender, ticketBasisUrl))
}

export async function storniereTicket(db: Db, mandantId: string, ticketId: string): Promise<TicketAdmin> {
  const [t] = await db.select().from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.mandantId, mandantId))).limit(1)
  if (!t) throw new TicketError(404, 'Ticket nicht gefunden')
  if (t.status === 'storniert') throw new TicketError(409, 'Ticket ist bereits storniert')
  const [neu] = await db.update(tickets).set({ status: 'storniert', updatedAt: new Date() })
    .where(eq(tickets.id, ticketId)).returning()
  const event   = await ladeEvent(db, mandantId, t.eventId)
  const baender = await ladeBaender(db, t.eventId)
  const { ticketBasisUrl } = await ladeMandant(db, mandantId)
  return zuTicketAdmin(neu!, event, baender, ticketBasisUrl)
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

export async function holeTicketEinstellungen(db: Db, mandantId: string): Promise<{ ticketBasisUrl: string | null }> {
  const { ticketBasisUrl } = await ladeMandant(db, mandantId)
  return { ticketBasisUrl }
}

export async function setzeTicketEinstellungen(
  db: Db, mandantId: string, ticketBasisUrl: string | null,
): Promise<{ ticketBasisUrl: string | null }> {
  const url = ticketBasisUrl ? ticketBasisUrl.replace(/\/+$/, '') : null
  await db.update(mandanten).set({ ticketBasisUrl: url, updatedAt: new Date() }).where(eq(mandanten.id, mandantId))
  return { ticketBasisUrl: url }
}

// ---------------------------------------------------------------------------
// Öffentliche Ansicht + Druckdaten
// ---------------------------------------------------------------------------

interface TicketMitKontext {
  ticket:     TicketRow
  event:      TicketEventRow
  baender:    TicketBandRow[]
  verkaeufer: string
  basisUrl:   string | null
}

/** Ticket über seinen Code — mandantenübergreifend, der Code ist systemweit eindeutig. */
async function ladeTicketMitKontext(db: Db, code: string): Promise<TicketMitKontext | null> {
  const [row] = await db.select({ ticket: tickets, event: ticketEvents, mandant: {
    firmenname: mandanten.firmenname, ticketBasisUrl: mandanten.ticketBasisUrl,
  } })
    .from(tickets)
    .innerJoin(ticketEvents, eq(ticketEvents.id, tickets.eventId))
    .innerJoin(mandanten, eq(mandanten.id, tickets.mandantId))
    .where(eq(tickets.code, code)).limit(1)
  // Reservierte (noch unbezahlte) Tickets gibt es nach außen nicht.
  if (!row || row.ticket.status === 'reserviert') return null
  return {
    ticket: row.ticket, event: row.event, baender: await ladeBaender(db, row.event.id),
    verkaeufer: row.mandant.firmenname, basisUrl: row.mandant.ticketBasisUrl,
  }
}

function zuOeffentlich(k: TicketMitKontext): TicketOeffentlich {
  const { ticket: t, event } = k
  const { band } = alterUndBand(t.geburtsdatum, event, k.baender)
  return {
    code:          t.code,
    typ:           t.typ as TicketTyp,
    rolle:         t.rolle,
    bezeichnung:   t.bezeichnung,
    name:          t.name,
    anzeigeStatus: anzeigeStatus(t, event.status),
    band:          band ? bandAnzeige(band) : null,
    event: {
      titel:        event.titel,
      beginn:       event.beginn.toISOString(),
      ende:         event.ende?.toISOString() ?? null,
      ort:          event.ort,
      adresse:      event.adresse,
      hinweis:      event.hinweis,
      status:       event.status as TicketEventStatus,
      veranstalter: event.veranstalter ?? k.verkaeufer,
    },
    verkaeufer:    k.verkaeufer,
  }
}

export async function holeOeffentlichesTicket(db: Db, code: string): Promise<TicketOeffentlich | null> {
  const k = await ladeTicketMitKontext(db, code)
  return k ? zuOeffentlich(k) : null
}

/**
 * Druckdaten für PDF/E-Mail. `urlFallback` greift, solange die Ticket-Adresse
 * nicht eingerichtet ist (z. B. aus dem Host der Anfrage abgeleitet).
 */
export async function holeTicketDruckdaten(
  db: Db, codes: string[], urlFallback: string | null,
): Promise<TicketPdfDaten[]> {
  const daten: TicketPdfDaten[] = []
  for (const code of codes) {
    const k = await ladeTicketMitKontext(db, code)
    if (!k) continue
    const basis = k.basisUrl ?? urlFallback
    const o = zuOeffentlich(k)
    daten.push({
      url:           basis ? ticketUrl(basis, o.code) : o.code,
      code:          o.code,
      typ:           o.typ,
      bezeichnung:   o.bezeichnung,
      name:          o.name,
      anzeigeStatus: o.anzeigeStatus,
      band:          o.band,
      event: {
        titel: o.event.titel, beginn: o.event.beginn, ort: o.event.ort, adresse: o.event.adresse,
        hinweis: o.event.hinweis, status: o.event.status, veranstalter: o.event.veranstalter,
      },
      verkaeufer:    o.verkaeufer,
    })
  }
  return daten
}

/** Codes der Tickets eines Mandanten (für Versand/Download aus dem Backoffice). */
export async function codesFuerTicketIds(db: Db, mandantId: string, ticketIds: string[]): Promise<string[]> {
  if (ticketIds.length === 0) return []
  const rows = await db.select({ code: tickets.code }).from(tickets)
    .where(and(eq(tickets.mandantId, mandantId), inArray(tickets.id, ticketIds)))
  return rows.map(r => r.code)
}
