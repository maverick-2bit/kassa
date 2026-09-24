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

import { createHash } from 'node:crypto'
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import {
  EINLASS_ZUGELASSEN,
  ticketCodeAusScan,
  type EinlassErgebnis,
  type EinlassErgebnisArt,
  type EinlassEvent,
  type EinlassGeraet,
  type EinlassLogEintrag,
  type EinlassOfflineListe,
  type EinlassSyncAntwort,
  type EinlassSyncErgebnis,
  type EinlassSyncInput,
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
import { alterUndBand, bandAnzeige, holeEinlassStand, ladeBaender, ladeEvent, zuBand } from './ticket.service.js'

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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

interface Einloesung {
  ergebnis:      EinlassErgebnisArt
  ticket:        TicketRow | null
  anderesEvent?: { titel: string; beginn: string }
}

/**
 * Kern der Einlösung — ohne Protokoll. Online ist `zeitpunkt` jetzt, beim
 * nachgereichten Offline-Scan der Moment am Eingang. `updatedAt` ist immer
 * die echte Zeit: daran hängt der Abgleich der Offline-Listen.
 */
async function loeseEin(
  db: Db | Tx,
  geraet: Pick<EinlassGeraetRow, 'name' | 'mandantId'>,
  event: TicketEventRow,
  code: string | null,
  zeitpunkt: Date,
): Promise<Einloesung> {
  const mandantId = geraet.mandantId
  if (!code) return { ergebnis: 'unbekannt', ticket: null }

  // Das Event selbst muss Einlass zulassen — ein abgesagtes Event löst NICHTS ein.
  if (event.status === 'abgesagt' || event.status === 'entwurf') {
    const [t] = await db.select().from(tickets)
      .where(and(eq(tickets.code, code), eq(tickets.eventId, event.id))).limit(1)
    return { ergebnis: event.status === 'abgesagt' ? 'abgesagt' : 'nicht_freigegeben', ticket: t ?? null }
  }

  const geaendert = new Date()
  const dasTicket = and(
    eq(tickets.code, code), eq(tickets.eventId, event.id),
    eq(tickets.mandantId, mandantId), eq(tickets.status, 'gueltig'),
  )

  // 1× gültig: nur einlösen, wenn noch nie eingelöst (atomar, siehe Kopfkommentar)
  const [einzel] = await db.update(tickets).set({
    ersterEinlassAt: zeitpunkt, letzterEinlassAt: zeitpunkt, einlassAnzahl: 1,
    ersterEinlassGeraet: geraet.name, updatedAt: geaendert,
  }).where(and(dasTicket, eq(tickets.typ, 'einzel'), isNull(tickets.ersterEinlassAt))).returning()
  if (einzel) return { ergebnis: 'zugelassen', ticket: einzel }

  // Mehrfachticket: jeder Eintritt zählt hoch, der erste Einlass bleibt stehen.
  // Nachgereichte Offline-Eintritte können älter sein als der letzte Online-Eintritt.
  const zeit = sql`${zeitpunkt.toISOString()}::timestamptz`
  const [mehrfach] = await db.update(tickets).set({
    ersterEinlassAt:     sql`least(coalesce(${tickets.ersterEinlassAt}, ${zeit}), ${zeit})`,
    ersterEinlassGeraet: sql`coalesce(${tickets.ersterEinlassGeraet}, ${geraet.name})`,
    letzterEinlassAt:    sql`greatest(coalesce(${tickets.letzterEinlassAt}, ${zeit}), ${zeit})`,
    einlassAnzahl:       sql`${tickets.einlassAnzahl} + 1`,
    updatedAt:           geaendert,
  }).where(and(dasTicket, eq(tickets.typ, 'mehrfach'))).returning()
  if (mehrfach) return { ergebnis: 'mehrfach', ticket: mehrfach }

  // Warum nicht? — Ticket unabhängig vom Event nachschlagen
  const [t] = await db.select().from(tickets).where(eq(tickets.code, code)).limit(1)
  if (!t || t.mandantId !== mandantId) return { ergebnis: 'unbekannt', ticket: null }   // fremde Mandanten nie offenlegen
  if (t.eventId !== event.id) {
    const [anderes] = await db.select({ titel: ticketEvents.titel, beginn: ticketEvents.beginn })
      .from(ticketEvents).where(eq(ticketEvents.id, t.eventId)).limit(1)
    return {
      ergebnis: 'falsches_event', ticket: t,
      ...(anderes ? { anderesEvent: { titel: anderes.titel, beginn: anderes.beginn.toISOString() } } : {}),
    }
  }
  if (t.status === 'storniert')  return { ergebnis: 'storniert', ticket: t }
  if (t.status === 'reserviert') return { ergebnis: 'nicht_bezahlt', ticket: t }
  return { ergebnis: 'bereits_eingeloest', ticket: t }
}

/** Ticket für die Anzeige — bei „anderes Event" ohne Band/Alter (dessen Bänder gelten hier nicht). */
function ticketFuerAnzeige(r: Einloesung, event: TicketEventRow, baender: TicketBandRow[]): EinlassTicket | null {
  if (!r.ticket) return null
  if (r.ergebnis === 'falsches_event') return { ...zuEinlassTicket(r.ticket, event, []), band: null, alter: null }
  return zuEinlassTicket(r.ticket, event, baender)
}

export async function scanne(
  db: Db,
  geraet: Pick<EinlassGeraetRow, 'id' | 'name' | 'mandantId'>,
  input: { eventId: string; inhalt: string },
): Promise<EinlassErgebnis> {
  const event   = await ladeEvent(db, geraet.mandantId, input.eventId)
  const baender = await ladeBaender(db, event.id)
  const code    = ticketCodeAusScan(input.inhalt)

  const r = await loeseEin(db, geraet, event, code, new Date())
  await db.insert(ticketEinlassLog).values({
    mandantId: geraet.mandantId, eventId: event.id, ticketId: r.ticket?.id ?? null,
    geraetId: geraet.id, geraetName: geraet.name,
    code: code ?? input.inhalt.slice(0, 64), ergebnis: r.ergebnis,
  })
  return {
    ergebnis:   r.ergebnis,
    zugelassen: EINLASS_ZUGELASSEN.has(r.ergebnis),
    ticket:     ticketFuerAnzeige(r, event, baender),
    ...(r.anderesEvent ? { anderesEvent: r.anderesEvent } : {}),
    stand:      await holeEinlassStand(db, event, baender),
  }
}

// ---------------------------------------------------------------------------
// Offline-Einlass: Liste fürs Gerät + Nachreichen der Scans
// ---------------------------------------------------------------------------

/**
 * Liste der Tickets eines Events für den Offline-Betrieb. Statt des Codes nur
 * dessen SHA-256 — wer ein Einlass-Handy findet, kann daraus keine gültigen
 * QR-Codes bauen. Reservierte (noch unbezahlte) Tickets fehlen bewusst.
 * Mit `seit` nur die seither geänderten Tickets (Abgleich im laufenden Betrieb).
 */
export async function holeOfflineListe(
  db: Db, geraet: Pick<EinlassGeraetRow, 'mandantId'>, eventId: string, seit: Date | null,
): Promise<EinlassOfflineListe> {
  // Zeitstempel VOR dem Lesen: was währenddessen geändert wird, kommt beim nächsten Abgleich
  const erstelltAt = new Date()
  const event   = await ladeEvent(db, geraet.mandantId, eventId)
  const baender = await ladeBaender(db, event.id)
  const bedingungen = [eq(tickets.eventId, event.id), inArray(tickets.status, ['gueltig', 'storniert'])]
  if (seit) bedingungen.push(gt(tickets.updatedAt, seit))
  const rows = await db.select().from(tickets).where(and(...bedingungen))

  return {
    eventId:      event.id,
    erstelltAt:   erstelltAt.toISOString(),
    vollstaendig: seit === null,
    event:        { titel: event.titel, beginn: event.beginn.toISOString(), status: event.status as TicketEventStatus },
    baender:      baender.map(zuBand),
    stand:        await holeEinlassStand(db, event, baender),
    tickets:      rows.map(t => ({
      h:                   createHash('sha256').update(t.code, 'utf8').digest('hex'),
      typ:                 t.typ as TicketTyp,
      rolle:               t.rolle,
      bezeichnung:         t.bezeichnung,
      name:                t.name,
      geburtsdatum:        t.geburtsdatum,
      status:              t.status as 'gueltig' | 'storniert',
      ersterEinlassAt:     t.ersterEinlassAt?.toISOString() ?? null,
      ersterEinlassGeraet: t.ersterEinlassGeraet,
      einlassAnzahl:       t.einlassAnzahl,
    })),
  }
}

/** Online-Einlass und nachgereichter Offline-Scan desselben Geräts so nah beieinander = derselbe Einlass */
const GLEICHER_EINLASS_MS = 60_000

/**
 * Offline entschiedene Scans nachreichen. Eingelassene werden jetzt wirklich
 * eingelöst (mit dem Zeitpunkt am Eingang); ist das Ticket inzwischen woanders
 * eingelöst oder storniert, ist das ein KONFLIKT — der Gast ist schon drin,
 * das Protokoll zeigt es dem Veranstalter. Abgewiesene werden nur protokolliert.
 *
 * Wiederholbar: die Scan-ID wird zuerst im Protokoll beansprucht (eindeutiger
 * Index), erst dann eingelöst — ein zweites Nachreichen derselben Scans (Netz
 * riss nach dem Senden ab) löst nichts doppelt ein, auch nicht gleichzeitig.
 */
export async function synchronisiere(
  db: Db, geraet: Pick<EinlassGeraetRow, 'id' | 'name' | 'mandantId'>, input: EinlassSyncInput,
): Promise<EinlassSyncAntwort> {
  const event   = await ladeEvent(db, geraet.mandantId, input.eventId)
  const baender = await ladeBaender(db, event.id)
  const jetzt   = new Date()
  const scans   = [...input.scans].sort((a, b) => Date.parse(a.zeitpunkt) - Date.parse(b.zeitpunkt))

  const ergebnisse: EinlassSyncErgebnis[] = []
  for (const scan of scans) {
    // Uhr des Geräts vorgehend? Nie „in der Zukunft" einlassen
    const zeitpunkt   = new Date(Math.min(Date.parse(scan.zeitpunkt), jetzt.getTime()))
    const code        = ticketCodeAusScan(scan.inhalt)
    const eingelassen = EINLASS_ZUGELASSEN.has(scan.lokal)

    const neu = await db.transaction(async (tx): Promise<EinlassSyncErgebnis | null> => {
      const [anspruch] = await tx.insert(ticketEinlassLog).values({
        mandantId: geraet.mandantId, eventId: event.id, geraetId: geraet.id, geraetName: geraet.name,
        code: code ?? scan.inhalt.slice(0, 64), ergebnis: scan.lokal, offline: true, zeitpunkt,
        scanId: scan.scanId, lokalesErgebnis: scan.lokal,
      }).onConflictDoNothing().returning({ id: ticketEinlassLog.id })
      if (!anspruch) return null   // schon nachgereicht

      let r: Einloesung
      if (eingelassen) {
        r = await loeseEin(tx, geraet, event, code, zeitpunkt)
        // Online-Antwort ging unterwegs verloren (Zeitlimit), das Gerät entschied
        // denselben Scan offline noch einmal: gleiches Gerät, gleiche Minute →
        // derselbe Einlass, kein Konflikt. Eine echte zweite Nutzung am selben
        // Gerät weist schon dessen eigene Liste ab.
        const t = r.ticket
        if (r.ergebnis === 'bereits_eingeloest' && t?.ersterEinlassAt && t.ersterEinlassGeraet === geraet.name
            && Math.abs(t.ersterEinlassAt.getTime() - zeitpunkt.getTime()) < GLEICHER_EINLASS_MS) {
          r = { ...r, ergebnis: 'zugelassen' }
        }
      } else {
        // Abgewiesen bleibt abgewiesen — nur fürs Protokoll dem Ticket zuordnen
        const [t] = code
          ? await tx.select().from(tickets).where(and(eq(tickets.code, code), eq(tickets.eventId, event.id))).limit(1)
          : []
        r = { ergebnis: scan.lokal, ticket: t ?? null }
      }
      await tx.update(ticketEinlassLog).set({ ergebnis: r.ergebnis, ticketId: r.ticket?.id ?? null })
        .where(eq(ticketEinlassLog.id, anspruch.id))
      return {
        scanId: scan.scanId, ergebnis: r.ergebnis, lokal: scan.lokal,
        konflikt: eingelassen && !EINLASS_ZUGELASSEN.has(r.ergebnis),
        ticket: ticketFuerAnzeige(r, event, baender),
      }
    })
    ergebnisse.push(neu ?? await syncErgebnisAusLog(db, scan.scanId, event, baender))
  }
  return { ergebnisse, stand: await holeEinlassStand(db, event, baender) }
}

/** Schon nachgereichter Scan: Ergebnis so zurückgeben, wie es damals festgehalten wurde. */
async function syncErgebnisAusLog(
  db: Db, scanId: string, event: TicketEventRow, baender: TicketBandRow[],
): Promise<EinlassSyncErgebnis> {
  const [zeile] = await db.select({ log: ticketEinlassLog, ticket: tickets })
    .from(ticketEinlassLog)
    .leftJoin(tickets, eq(tickets.id, ticketEinlassLog.ticketId))
    .where(eq(ticketEinlassLog.scanId, scanId)).limit(1)
  const ergebnis = zeile!.log.ergebnis as EinlassErgebnisArt
  const lokal    = (zeile!.log.lokalesErgebnis ?? ergebnis) as EinlassErgebnisArt
  return {
    scanId, ergebnis, lokal,
    konflikt: EINLASS_ZUGELASSEN.has(lokal) && !EINLASS_ZUGELASSEN.has(ergebnis),
    ticket:   zeile!.ticket ? ticketFuerAnzeige({ ergebnis, ticket: zeile!.ticket }, event, baender) : null,
  }
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
    lokal:      (log.lokalesErgebnis as EinlassErgebnisArt | null) ?? null,
    konflikt:   log.lokalesErgebnis !== null
      && EINLASS_ZUGELASSEN.has(log.lokalesErgebnis as EinlassErgebnisArt)
      && !EINLASS_ZUGELASSEN.has(log.ergebnis as EinlassErgebnisArt),
    ticket:     ticket?.bezeichnung
      ? { bezeichnung: ticket.bezeichnung, typ: ticket.typ as TicketTyp, name: ticket.name }
      : null,
  }))
}
