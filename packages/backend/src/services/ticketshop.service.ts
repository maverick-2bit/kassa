/**
 * Ticketshop — Online-Kauf von Tickets (Ticketing Release 3).
 *
 * Ablauf: Käufer wählt Tickets und gibt je Gast das Geburtsdatum an →
 * die Bestellung reserviert die Tickets im Kontingent (Status „reserviert") →
 * Stripe-Checkout, der nach TICKETSHOP_RESERVIERUNG_MINUTEN abläuft →
 * Zahlung bestätigt (Webhook) → RKSV-Beleg auf der Verkaufskasse, Tickets
 * gültig, E-Mail mit Tickets und Beleg.
 *
 * Reservierung: reservierte Tickets zählen im Kontingent mit. Läuft die Zahlung
 * ab (Stripe meldet „expired", der Käufer bricht ab oder der Aufräum-Job findet
 * sie überfällig), werden sie GELÖSCHT — sie waren nie gültig und nie sichtbar.
 * Bevor der Aufräum-Job etwas freigibt, fragt er Stripe: eine bezahlte Session
 * wird abgeschlossen statt verworfen.
 *
 * Überverkauf: parallele Bestellungen derselben Ticketart warten per
 * SELECT … FOR UPDATE aufeinander; Zählen und Anlegen passieren in derselben
 * Transaktion.
 */

import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import {
  TICKETSHOP_RESERVIERUNG_MINUTEN,
  alterAm,
  berechneSteueraufteilung,
  generiereRechnungHtml,
  wienerTag,
  type MwStSatz,
  type ShopArtStatus,
  type ShopBestellStatus,
  type ShopBestellung,
  type ShopBestellungAntwort,
  type ShopBestellungInput,
  type ShopEvent,
  type ShopEventKurz,
  type ShopRechtliches,
  type ShopVeranstalter,
  type TicketBestellungAdmin,
  type TicketBestellungStatus,
  type TicketEventStatus,
  type TicketShopEinstellungen,
  type TicketShopEinstellungenAntwort,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import {
  belege,
  kassen,
  mandanten,
  ticketArten,
  ticketBestellungen,
  ticketEvents,
  tickets,
  type TicketArtRow,
  type TicketBestellPosition,
  type TicketBestellungRow,
  type TicketEventRow,
} from '../db/schema.js'
import { erstelleBarzahlungsbeleg, holeBeleg, type BelegServiceDeps } from './beleg.service.js'
import { isEmailAktiv, sendeTicketEmail, type TicketKaufInfo } from './email.service.js'
import {
  beendeCheckoutSession,
  erstelleTicketCheckoutSession,
  holeCheckoutSessionStand,
  ladeStripeKonfig,
  type CheckoutSessionStand,
  type StripeKonfig,
  type TicketCheckoutInput,
} from './stripe.service.js'
import { erzeugeTicketCode, holeTicketDruckdaten } from './ticket.service.js'

export class TicketShopError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

/** Stripe-Zugriffe des Shops — in Tests ersetzbar (kein Netz). */
export interface ShopStripe {
  erstelleCheckout: (input: TicketCheckoutInput, konfig: StripeKonfig) => Promise<{ id: string; url: string }>
  holeSession:      (id: string, konfig: StripeKonfig) => Promise<CheckoutSessionStand>
  beendeSession:    (id: string, konfig: StripeKonfig) => Promise<void>
}

export const STRIPE_ECHT: ShopStripe = {
  erstelleCheckout: erstelleTicketCheckoutSession,
  holeSession:      holeCheckoutSessionStand,
  beendeSession:    beendeCheckoutSession,
}

export interface TicketShopDeps {
  db:        Db
  belegDeps: BelegServiceDeps
  config:    Config
  /** Nur Tests: Stripe ersetzen */
  stripe?:   ShopStripe
}

/** Aufräum-Job greift erst so lange nach dem Reservierungsende (Webhook-Verzögerung) */
const NACHLAUF_MS = 10 * 60_000
/** Verzögerte Zahlarten (SEPA-Lastschrift …): so lange bleiben die Tickets reserviert */
const ASYNC_ZAHLUNG_MS = 3 * 24 * 3_600_000

const OEFFENTLICHE_STATUS = ['veroeffentlicht', 'test'] as const

const stripeVon = (deps: TicketShopDeps): ShopStripe => deps.stripe ?? STRIPE_ECHT

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

/** Verkaufsende: Ende des Events, ohne Ende dessen Beginn */
function verkaufsende(event: Pick<TicketEventRow, 'beginn' | 'ende'>): Date {
  return event.ende ?? event.beginn
}

function artStatus(art: TicketArtRow, event: TicketEventRow, belegt: number, jetzt: Date): ShopArtStatus {
  if (art.verkaufAb && jetzt < art.verkaufAb) return 'noch_nicht'
  if ((art.verkaufBis && jetzt > art.verkaufBis) || jetzt > verkaufsende(event)) return 'beendet'
  if (art.kontingent !== null && belegt >= art.kontingent) return 'ausverkauft'
  return 'verfuegbar'
}

const DATUM_ZEIT = new Intl.DateTimeFormat('de-AT', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna',
})

interface ShopMandant {
  id:              string
  firmenname:      string
  uid:             string
  modulAktiv:      boolean
  ticketBasisUrl:  string | null
  verkaufKasseId:  string | null
  agbUrl:          string | null
  datenschutzUrl:  string | null
  impressumUrl:    string | null
  kaufhinweis:     string | null
}

async function ladeShopMandant(db: Db, mandantId: string): Promise<ShopMandant | null> {
  const [m] = await db.select({
    id:             mandanten.id,
    firmenname:     mandanten.firmenname,
    uid:            mandanten.uid,
    modulAktiv:     mandanten.modulTicketsAktiv,
    ticketBasisUrl: mandanten.ticketBasisUrl,
    verkaufKasseId: mandanten.ticketVerkaufKasseId,
    agbUrl:         mandanten.ticketAgbUrl,
    datenschutzUrl: mandanten.ticketDatenschutzUrl,
    impressumUrl:   mandanten.ticketImpressumUrl,
    kaufhinweis:    mandanten.ticketKaufhinweis,
  }).from(mandanten).where(eq(mandanten.id, mandantId)).limit(1)
  return m ?? null
}

function rechtliches(m: ShopMandant): ShopRechtliches {
  return { agbUrl: m.agbUrl, datenschutzUrl: m.datenschutzUrl, impressumUrl: m.impressumUrl, kaufhinweis: m.kaufhinweis }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Nicht stornierte Tickets je Ticketart (reservierte zählen mit — sie sind vergeben). */
async function belegteTickets(db: Db | Tx, artIds: string[]): Promise<Map<string, number>> {
  if (artIds.length === 0) return new Map()
  const rows = await db.select({
    artId:  tickets.ticketArtId,
    anzahl: sql<number>`count(*)`.mapWith(Number),
  }).from(tickets)
    .where(and(inArray(tickets.ticketArtId, artIds), sql`${tickets.status} <> 'storniert'`))
    .groupBy(tickets.ticketArtId)
  return new Map(rows.filter(r => r.artId).map(r => [r.artId!, r.anzahl]))
}

/** Öffentlich sichtbares Event (veröffentlicht oder im Test) eines aktiven Ticket-Moduls. */
async function ladeOeffentlichesEvent(db: Db, eventId: string): Promise<{ event: TicketEventRow; mandant: ShopMandant }> {
  const [event] = await db.select().from(ticketEvents)
    .where(and(eq(ticketEvents.id, eventId), inArray(ticketEvents.status, [...OEFFENTLICHE_STATUS]))).limit(1)
  const mandant = event ? await ladeShopMandant(db, event.mandantId) : null
  if (!event || !mandant?.modulAktiv) throw new TicketShopError(404, 'Event nicht gefunden')
  return { event, mandant }
}

/** Kann dieser Mandant gerade Geld annehmen? (Verkaufskasse + Stripe; ohne Stripe nur Demo außerhalb Produktion) */
async function zahlungMoeglich(deps: TicketShopDeps, m: ShopMandant): Promise<boolean> {
  if (!m.verkaufKasseId) return false
  const konfig = await ladeStripeKonfig(deps.db, m.id, deps.config)
  return konfig !== null || deps.config.NODE_ENV !== 'production'
}

export function maskiereEmail(email: string): string {
  // Nach der Datenschutz-Löschung ist die Adresse leer
  if (!email.includes('@')) return '(gelöscht)'
  const [lokal = '', domain = ''] = email.split('@')
  return `${lokal.slice(0, 1)}…@${domain}`
}

function externerStatus(status: string): ShopBestellStatus {
  if (status === 'bezahlt' || status === 'abgelaufen' || status === 'abgebrochen') return status
  return 'zahlung'
}

const ohneSchraegstrich = (url: string) => url.replace(/\/+$/, '')

// ---------------------------------------------------------------------------
// Öffentlich: Veranstalter-Übersicht + Eventseite
// ---------------------------------------------------------------------------

export async function holeVeranstalter(deps: TicketShopDeps, mandantId: string, jetzt = new Date()): Promise<ShopVeranstalter> {
  const m = await ladeShopMandant(deps.db, mandantId)
  if (!m?.modulAktiv) throw new TicketShopError(404, 'Veranstalter nicht gefunden')

  const events = await deps.db.select().from(ticketEvents)
    .where(and(
      eq(ticketEvents.mandantId, mandantId),
      eq(ticketEvents.status, 'veroeffentlicht'),
      sql`coalesce(${ticketEvents.ende}, ${ticketEvents.beginn}) > ${jetzt.toISOString()}::timestamptz`,
    ))
    .orderBy(asc(ticketEvents.beginn))
  const arten = events.length === 0 ? [] : await deps.db.select().from(ticketArten)
    .where(and(inArray(ticketArten.eventId, events.map(e => e.id)), eq(ticketArten.onlineVerkauf, true)))
  const belegt = await belegteTickets(deps.db, arten.map(a => a.id))

  const kurz: ShopEventKurz[] = events.map(e => {
    const eigene = arten.filter(a => a.eventId === e.id)
    const stati  = eigene.map(a => ({ art: a, status: artStatus(a, e, belegt.get(a.id) ?? 0, jetzt) }))
    const kaufbar = stati.filter(s => s.status === 'verfuegbar' || s.status === 'noch_nicht')
    return {
      id: e.id, titel: e.titel, beginn: e.beginn.toISOString(), ende: e.ende?.toISOString() ?? null,
      ort: e.ort, hinweis: e.hinweis,
      abPreisCent: kaufbar.length > 0 ? Math.min(...kaufbar.map(s => s.art.preisCent)) : null,
      ausverkauft: stati.length > 0 && stati.every(s => s.status === 'ausverkauft'),
    }
  })
  return { firmenname: m.firmenname, events: kurz, rechtliches: rechtliches(m) }
}

export async function holeShopEvent(deps: TicketShopDeps, eventId: string, jetzt = new Date()): Promise<ShopEvent> {
  const { event, mandant: m } = await ladeOeffentlichesEvent(deps.db, eventId)
  const arten = await deps.db.select().from(ticketArten)
    .where(and(eq(ticketArten.eventId, event.id), eq(ticketArten.onlineVerkauf, true)))
    .orderBy(asc(ticketArten.reihenfolge), asc(ticketArten.createdAt))
  const belegt = await belegteTickets(deps.db, arten.map(a => a.id))

  let verkaufHinweis: string | null = null
  if (arten.length === 0) verkaufHinweis = 'Für dieses Event gibt es keine Tickets im Online-Verkauf.'
  else if (jetzt > verkaufsende(event)) verkaufHinweis = 'Der Online-Verkauf für dieses Event ist beendet.'
  else if (arten.some(a => a.preisCent > 0) && !(await zahlungMoeglich(deps, m))) {
    verkaufHinweis = 'Der Online-Verkauf ist derzeit nicht möglich.'
  }

  return {
    id:           event.id,
    titel:        event.titel,
    beschreibung: event.beschreibung,
    beginn:       event.beginn.toISOString(),
    ende:         event.ende?.toISOString() ?? null,
    ort:          event.ort,
    adresse:      event.adresse,
    hinweis:      event.hinweis,
    veranstalter: event.veranstalter ?? m.firmenname,
    status:       event.status as TicketEventStatus,
    mindestalter: event.mindestalter,
    namePflicht:  event.namePflicht,
    arten: arten.map(a => {
      const b = belegt.get(a.id) ?? 0
      return {
        id:               a.id,
        bezeichnung:      a.bezeichnung,
        beschreibung:     a.beschreibung,
        preisCent:        a.preisCent,
        maxProBestellung: a.maxProBestellung,
        verfuegbar:       a.kontingent === null ? null : Math.max(0, a.kontingent - b),
        status:           artStatus(a, event, b, jetzt),
        verkaufAb:        a.verkaufAb?.toISOString() ?? null,
        verkaufBis:       a.verkaufBis?.toISOString() ?? null,
      }
    }),
    verkaeufer:     m.firmenname,
    rechtliches:    rechtliches(m),
    verkaufOffen:   verkaufHinweis === null,
    verkaufHinweis,
  }
}

// ---------------------------------------------------------------------------
// Bestellen
// ---------------------------------------------------------------------------

/**
 * Legt die Bestellung an und reserviert die Tickets. Mit Stripe kommt die
 * Bezahlseite zurück; kostenlose Bestellungen (und der Demo-Pfad ohne Stripe
 * außerhalb der Produktion) werden sofort abgeschlossen.
 *
 * @param basisUrl Adresse der Ticket-App, über die bestellt wird (Rücksprung von Stripe)
 */
export async function erstelleShopBestellung(
  deps: TicketShopDeps, input: ShopBestellungInput, basisUrl: string, jetzt = new Date(),
): Promise<ShopBestellungAntwort> {
  const { event, mandant: m } = await ladeOeffentlichesEvent(deps.db, input.eventId)

  // Mengen je Ticketart in der Reihenfolge des Formulars
  const mengen = new Map<string, number>()
  for (const t of input.tickets) mengen.set(t.ticketArtId, (mengen.get(t.ticketArtId) ?? 0) + 1)
  const artIds = [...mengen.keys()]

  const arten = await deps.db.select().from(ticketArten)
    .where(and(inArray(ticketArten.id, artIds), eq(ticketArten.eventId, event.id)))
  const artById = new Map(arten.map(a => [a.id, a]))
  if (arten.length !== artIds.length) throw new TicketShopError(400, 'Eine Ticketart gehört nicht zu diesem Event')

  for (const art of arten) {
    if (!art.onlineVerkauf) throw new TicketShopError(400, `„${art.bezeichnung}" ist nicht online erhältlich`)
    const status = artStatus(art, event, 0, jetzt)
    if (status === 'noch_nicht') {
      throw new TicketShopError(409, `Der Verkauf für „${art.bezeichnung}" startet am ${DATUM_ZEIT.format(art.verkaufAb!)}`)
    }
    if (status === 'beendet') throw new TicketShopError(409, `Der Verkauf für „${art.bezeichnung}" ist beendet`)
    const menge = mengen.get(art.id) ?? 0
    if (menge > art.maxProBestellung) {
      throw new TicketShopError(400, `Höchstens ${art.maxProBestellung} × „${art.bezeichnung}" je Bestellung`)
    }
  }

  // Je Gast: Mindestalter am Eventtag, Name bei personalisierten Tickets
  const eventTag = wienerTag(event.beginn)
  input.tickets.forEach((t, i) => {
    const nr = input.tickets.length > 1 ? `Ticket ${i + 1}: ` : ''
    if (event.mindestalter !== null && alterAm(t.geburtsdatum, eventTag) < event.mindestalter) {
      throw new TicketShopError(422, `${nr}Mindestalter ${event.mindestalter} Jahre am Eventtag`)
    }
    if (event.namePflicht && !t.name?.trim()) {
      throw new TicketShopError(422, `${nr}Name des Gastes ist Pflicht (personalisierte Tickets)`)
    }
  })

  const positionen: TicketBestellPosition[] = artIds.map(id => {
    const art = artById.get(id)!
    return { ticketArtId: id, bezeichnung: art.bezeichnung, menge: mengen.get(id)!, preisCent: art.preisCent, mwstSatz: art.mwstSatz }
  })
  const summeCent = positionen.reduce((s, p) => s + p.preisCent * p.menge, 0)

  let stripeKonfig: StripeKonfig | null = null
  if (summeCent > 0) {
    if (!m.verkaufKasseId) throw new TicketShopError(503, 'Der Online-Verkauf ist noch nicht eingerichtet')
    stripeKonfig = await ladeStripeKonfig(deps.db, m.id, deps.config)
    if (!stripeKonfig && deps.config.NODE_ENV === 'production') {
      throw new TicketShopError(503, 'Die Online-Zahlung ist nicht eingerichtet')
    }
  }

  const reserviertBis = new Date(jetzt.getTime() + TICKETSHOP_RESERVIERUNG_MINUTEN * 60_000)
  const basis = ohneSchraegstrich(m.ticketBasisUrl ?? basisUrl)

  const bestellung = await deps.db.transaction(async (tx) => {
    // Ticketarten sperren (feste Reihenfolge gegen Deadlocks) — parallele
    // Bestellungen derselben Art warten hier, bis diese Transaktion durch ist.
    const gesperrt = await tx.select().from(ticketArten)
      .where(inArray(ticketArten.id, artIds)).orderBy(asc(ticketArten.id)).for('update')
    const belegt = await belegteTickets(tx, artIds)
    for (const art of gesperrt) {
      if (art.kontingent === null) continue
      const frei = Math.max(0, art.kontingent - (belegt.get(art.id) ?? 0))
      const menge = mengen.get(art.id) ?? 0
      if (menge > frei) {
        throw new TicketShopError(409, frei === 0
          ? `„${art.bezeichnung}" ist ausverkauft`
          : `Von „${art.bezeichnung}" sind nur noch ${frei} verfügbar`)
      }
    }

    const [b] = await tx.insert(ticketBestellungen).values({
      mandantId:       m.id,
      eventId:         event.id,
      status:          'zahlung',
      name:            input.kaeufer.name,
      email:           input.kaeufer.email,
      rechnung:        input.rechnung
        ? { firma: input.rechnung.firma, strasse: input.rechnung.strasse, plz: input.rechnung.plz,
            ort: input.rechnung.ort, land: input.rechnung.land, uid: input.rechnung.uid?.trim() || null }
        : null,
      positionen,
      summeCent,
      reserviertBis,
      basisUrl:        basis,
      agbAkzeptiertAt: jetzt,
    }).returning()

    // createdAt je Ticket um 1 ms versetzt: in EINEM Insert hätten alle denselben
    // Zeitstempel — die Bestellseite zeigt sie so in der Reihenfolge des Formulars.
    await tx.insert(tickets).values(input.tickets.map((t, i) => {
      const art = artById.get(t.ticketArtId)!
      return {
        createdAt:    new Date(jetzt.getTime() + i),
        mandantId:    m.id,
        eventId:      event.id,
        ticketArtId:  art.id,
        code:         erzeugeTicketCode(),
        typ:          'einzel',
        bezeichnung:  art.bezeichnung,
        name:         t.name?.trim() || null,
        geburtsdatum: t.geburtsdatum,
        email:        input.kaeufer.email,
        status:       'reserviert',
        preisCent:    art.preisCent,
        mwstSatz:     art.mwstSatz,
        bestellungId: b!.id,
      }
    }))
    return b!
  })

  // Kostenlos — oder Demo-Pfad ohne Stripe (nur außerhalb der Produktion): sofort fertig.
  // Scheitert das, gibt es keine Zahlung, auf die man warten müsste → gleich freigeben.
  if (!stripeKonfig) {
    try {
      await finalisiereShopBestellung(deps, bestellung.id)
    } catch (err) {
      await gibReservierungFrei(deps, bestellung.id, 'abgebrochen')
      throw err
    }
    return { bestellungId: bestellung.id, checkoutUrl: null }
  }

  try {
    const session = await stripeVon(deps).erstelleCheckout({
      bestellungId: bestellung.id,
      positionen:   positionen.map(p => ({
        bezeichnung: `${event.titel} – ${p.bezeichnung}`, preisBruttoCent: p.preisCent, menge: p.menge,
      })),
      email:      input.kaeufer.email,
      successUrl: `${basis}/b/${bestellung.id}`,
      cancelUrl:  `${basis}/b/${bestellung.id}?abbruch=1`,
      laeuftAbAt: reserviertBis,
    }, stripeKonfig)
    await deps.db.update(ticketBestellungen).set({ stripeSessionId: session.id, updatedAt: new Date() })
      .where(eq(ticketBestellungen.id, bestellung.id))
    return { bestellungId: bestellung.id, checkoutUrl: session.url }
  } catch (err) {
    await gibReservierungFrei(deps, bestellung.id, 'abgebrochen')
    throw err
  }
}

// ---------------------------------------------------------------------------
// Abschließen / Freigeben
// ---------------------------------------------------------------------------

/**
 * Nach bestätigter Zahlung (Webhook, Aufräum-Job, Demo) — idempotent: nur wer
 * den Status von „zahlung" auf „finalisiere" dreht, macht weiter. Schlägt der
 * Beleg fehl, geht der Status zurück; Stripe wiederholt den Webhook.
 */
export async function finalisiereShopBestellung(deps: TicketShopDeps, id: string): Promise<TicketBestellungRow> {
  const [claimed] = await deps.db.update(ticketBestellungen)
    .set({ status: 'finalisiere', updatedAt: new Date() })
    .where(and(eq(ticketBestellungen.id, id), eq(ticketBestellungen.status, 'zahlung')))
    .returning()
  if (!claimed) {
    const [aktuell] = await deps.db.select().from(ticketBestellungen).where(eq(ticketBestellungen.id, id)).limit(1)
    if (!aktuell) throw new TicketShopError(404, 'Bestellung nicht gefunden')
    return aktuell
  }

  let fertig: TicketBestellungRow
  try {
    let belegId: string | null = null
    if (claimed.summeCent > 0) {
      const m = await ladeShopMandant(deps.db, claimed.mandantId)
      if (!m?.verkaufKasseId) throw new TicketShopError(503, 'Keine Verkaufskasse für den Ticketshop eingerichtet')
      const [event] = await deps.db.select({ titel: ticketEvents.titel }).from(ticketEvents)
        .where(eq(ticketEvents.id, claimed.eventId)).limit(1)
      const r = claimed.rechnung
      const beleg = await erstelleBarzahlungsbeleg({
        kasseId: m.verkaufKasseId,
        positionen: claimed.positionen.map(p => ({
          bezeichnung:     `Ticket ${event?.titel ?? ''} – ${p.bezeichnung}`.slice(0, 200),
          preisBruttoCent: p.preisCent,
          mwstSatz:        p.mwstSatz as MwStSatz,
          menge:           p.menge,
        })),
        zahlung: { barCent: 0, karteCent: claimed.summeCent, sonstigeCent: 0 },
        // Rechnung auf Firma → Kunde anlegen, damit Name und Anschrift auf dem Beleg stehen
        ...(r ? {
          neuerKunde: {
            firma: r.firma, strasse: r.strasse, plz: r.plz, ort: r.ort, land: r.land,
            ...(r.uid ? { uid: r.uid } : {}), email: claimed.email, kreditAktiv: false,
          },
        } : {}),
      }, deps.belegDeps)
      belegId = beleg.id
    }

    fertig = await deps.db.transaction(async (tx) => {
      await tx.update(tickets).set({ status: 'gueltig', updatedAt: new Date() })
        .where(and(eq(tickets.bestellungId, id), eq(tickets.status, 'reserviert')))
      const [row] = await tx.update(ticketBestellungen)
        .set({ status: 'bezahlt', belegId, bezahltAt: new Date(), updatedAt: new Date() })
        .where(eq(ticketBestellungen.id, id)).returning()
      return row!
    })
  } catch (err) {
    await deps.db.update(ticketBestellungen).set({ status: 'zahlung', updatedAt: new Date() })
      .where(eq(ticketBestellungen.id, id))
    throw err
  }

  // Tickets zustellen — ein Mailfehler macht den Kauf nicht rückgängig
  // (die Tickets stehen auch auf der Bestellseite, Versand im Backoffice wiederholbar).
  await sendeBestellEmail(deps, id).catch(() => {})
  return fertig
}

/** Reservierung aufheben: Bestellung beenden, reservierte (nie gültige) Tickets löschen. */
export async function gibReservierungFrei(
  deps: TicketShopDeps, id: string, ziel: 'abgelaufen' | 'abgebrochen',
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx.update(ticketBestellungen).set({ status: ziel, updatedAt: new Date() })
      .where(and(eq(ticketBestellungen.id, id), eq(ticketBestellungen.status, 'zahlung'))).returning()
    if (!row) return false
    await tx.delete(tickets).where(and(eq(tickets.bestellungId, id), eq(tickets.status, 'reserviert')))
    return true
  })
}

/**
 * Käufer ist von der Bezahlseite zurück („Abbrechen"): Session bei Stripe
 * schließen und die Tickets sofort freigeben. War sie inzwischen doch bezahlt
 * (zweiter Tab), wird abgeschlossen statt verworfen.
 */
export async function brecheShopBestellungAb(deps: TicketShopDeps, id: string): Promise<ShopBestellung> {
  const [row] = await deps.db.select().from(ticketBestellungen).where(eq(ticketBestellungen.id, id)).limit(1)
  if (!row) throw new TicketShopError(404, 'Bestellung nicht gefunden')
  if (row.status !== 'zahlung') return holeShopBestellung(deps, id)

  const konfig = row.stripeSessionId ? await ladeStripeKonfig(deps.db, row.mandantId, deps.config) : null
  if (row.stripeSessionId && konfig) {
    try {
      await stripeVon(deps).beendeSession(row.stripeSessionId, konfig)
    } catch {
      const stand = await stripeVon(deps).holeSession(row.stripeSessionId, konfig).catch(() => null)
      if (stand?.status === 'complete') {
        if (stand.bezahlt) await finalisiereShopBestellung(deps, id)
        return holeShopBestellung(deps, id)
      }
      // Stand unklar (Stripe nicht erreichbar) → nichts freigeben, der Aufräum-Job klärt es
      if (stand?.status !== 'expired') return holeShopBestellung(deps, id)
    }
  }
  await gibReservierungFrei(deps, id, 'abgebrochen')
  return holeShopBestellung(deps, id)
}

/**
 * Stripe-Ereignis einer Ticket-Bestellung. `mandantIdAusUrl` = Mandant des
 * Webhook-Endpunkts (dessen Secret die Signatur bestätigt hat); null = globales
 * Konto. Ereignisse für Bestellungen eines anderen Kontos werden ignoriert —
 * sonst könnte ein Konto fremde Bestellungen als bezahlt melden.
 */
export async function verarbeiteShopWebhook(
  deps: TicketShopDeps,
  mandantIdAusUrl: string | null,
  typ: string,
  session: { id?: string; payment_status?: string | null; metadata?: Record<string, string> | null },
): Promise<void> {
  const id = session.metadata?.ticketBestellungId
  if (!id) return
  const [row] = await deps.db.select().from(ticketBestellungen).where(eq(ticketBestellungen.id, id)).limit(1)
  if (!row) return
  if (mandantIdAusUrl ? row.mandantId !== mandantIdAusUrl : (await ladeStripeKonfig(deps.db, row.mandantId, deps.config))?.eigene) return
  if (row.stripeSessionId && session.id && session.id !== row.stripeSessionId) return

  switch (typ) {
    case 'checkout.session.completed':
      if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
        await finalisiereShopBestellung(deps, id)
      } else {
        // Verzögerte Zahlart (SEPA …): Tickets reserviert lassen, bis Stripe das Geld meldet
        await deps.db.update(ticketBestellungen)
          .set({ reserviertBis: new Date(Date.now() + ASYNC_ZAHLUNG_MS), updatedAt: new Date() })
          .where(and(eq(ticketBestellungen.id, id), eq(ticketBestellungen.status, 'zahlung')))
      }
      break
    case 'checkout.session.async_payment_succeeded':
      await finalisiereShopBestellung(deps, id)
      break
    case 'checkout.session.async_payment_failed':
      await gibReservierungFrei(deps, id, 'abgebrochen')
      break
    case 'checkout.session.expired':
      await gibReservierungFrei(deps, id, 'abgelaufen')
      break
  }
}

/**
 * Aufräum-Job (minütlich): überfällige Zahlungen klären. Mit Stripe-Session
 * wird zuerst nachgefragt — bezahlt → abschließen, verfallen → freigeben,
 * noch offen/nicht erreichbar → nächste Runde.
 */
export async function raeumeReservierungenAuf(
  deps: TicketShopDeps, jetzt = new Date(),
): Promise<{ freigegeben: number; abgeschlossen: number }> {
  const grenze = new Date(jetzt.getTime() - NACHLAUF_MS)
  const faellig = await deps.db.select().from(ticketBestellungen)
    .where(and(eq(ticketBestellungen.status, 'zahlung'), lt(ticketBestellungen.reserviertBis, grenze)))
    .orderBy(asc(ticketBestellungen.reserviertBis)).limit(50)

  let freigegeben = 0
  let abgeschlossen = 0
  for (const row of faellig) {
    const konfig = row.stripeSessionId ? await ladeStripeKonfig(deps.db, row.mandantId, deps.config) : null
    if (!row.stripeSessionId || !konfig) {
      if (await gibReservierungFrei(deps, row.id, 'abgelaufen')) freigegeben++
      continue
    }
    let stand: CheckoutSessionStand
    try {
      stand = await stripeVon(deps).holeSession(row.stripeSessionId, konfig)
    } catch {
      continue   // Stripe nicht erreichbar → nächste Runde
    }
    if (stand.status === 'complete' && stand.bezahlt) {
      await finalisiereShopBestellung(deps, row.id)
      abgeschlossen++
    } else if (stand.status === 'complete') {
      await deps.db.update(ticketBestellungen)
        .set({ reserviertBis: new Date(jetzt.getTime() + ASYNC_ZAHLUNG_MS), updatedAt: new Date() })
        .where(eq(ticketBestellungen.id, row.id))
    } else if (stand.status === 'expired') {
      if (await gibReservierungFrei(deps, row.id, 'abgelaufen')) freigegeben++
    } else {
      // Noch offen, obwohl längst abgelaufen (Uhr?) → schließen; nächste Runde gibt frei
      await stripeVon(deps).beendeSession(row.stripeSessionId, konfig).catch(() => {})
    }
  }
  return { freigegeben, abgeschlossen }
}

// ---------------------------------------------------------------------------
// Bestellseite + E-Mail + Rechnung
// ---------------------------------------------------------------------------

export async function holeShopBestellung(deps: TicketShopDeps, id: string): Promise<ShopBestellung> {
  const [row] = await deps.db.select({ b: ticketBestellungen, event: ticketEvents, belegNummer: belege.belegNummer })
    .from(ticketBestellungen)
    .innerJoin(ticketEvents, eq(ticketEvents.id, ticketBestellungen.eventId))
    .leftJoin(belege, eq(belege.id, ticketBestellungen.belegId))
    .where(eq(ticketBestellungen.id, id)).limit(1)
  if (!row) throw new TicketShopError(404, 'Bestellung nicht gefunden')
  const { b, event } = row
  const status = externerStatus(b.status)

  const eigeneTickets = status === 'bezahlt'
    ? await deps.db.select({ code: tickets.code, bezeichnung: tickets.bezeichnung, name: tickets.name })
        .from(tickets).where(and(eq(tickets.bestellungId, id), sql`${tickets.status} <> 'reserviert'`))
        .orderBy(asc(tickets.createdAt), asc(tickets.code))
    : []

  return {
    id:      b.id,
    status,
    eventId: event.id,
    event:   { titel: event.titel, beginn: event.beginn.toISOString(), ort: event.ort, adresse: event.adresse },
    summeCent:  b.summeCent,
    positionen: b.positionen.map(p => ({ bezeichnung: p.bezeichnung, menge: p.menge, preisCent: p.preisCent })),
    tickets:    eigeneTickets,
    emailMaskiert: maskiereEmail(b.email),
    emailStatus:   b.emailGesendetAt ? 'gesendet' : b.emailFehler ? 'fehlgeschlagen' : 'ausstehend',
    belegNummer:   row.belegNummer ?? null,
    reserviertBis: status === 'zahlung' ? b.reserviertBis.toISOString() : null,
  }
}

/** Rechnung (A4-HTML zum Drucken/Speichern) einer bezahlten Bestellung; null ohne Beleg. */
export async function holeBestellRechnungHtml(deps: TicketShopDeps, id: string): Promise<string | null> {
  const [b] = await deps.db.select().from(ticketBestellungen).where(eq(ticketBestellungen.id, id)).limit(1)
  if (!b?.belegId || b.status !== 'bezahlt') return null
  const beleg = await holeBeleg(deps.db, b.belegId, b.mandantId)
  const m = await ladeShopMandant(deps.db, b.mandantId)
  if (!beleg || !m) return null
  // Ohne das automatische Drucken der Kassen-Vorlage: der Käufer öffnet die
  // Rechnung meist am Handy und speichert sie selbst (Drucken/Teilen im Browser).
  return generiereRechnungHtml(beleg, { firmenname: m.firmenname, uid: m.uid })
    .replace(/<script>window\.onload = \(\) => window\.print\(\)<\/script>/, '')
}

/**
 * Tickets (+ Beleg) per E-Mail an den Käufer — oder an `empfaenger`
 * (Backoffice: „an andere Adresse senden"). Ergebnis steht an der Bestellung.
 */
export async function sendeBestellEmail(
  deps: TicketShopDeps, id: string, empfaenger?: string,
): Promise<{ erfolgreich: boolean; fehler?: string }> {
  const [b] = await deps.db.select().from(ticketBestellungen).where(eq(ticketBestellungen.id, id)).limit(1)
  if (!b) throw new TicketShopError(404, 'Bestellung nicht gefunden')
  if (b.status !== 'bezahlt') throw new TicketShopError(409, 'Die Bestellung ist noch nicht bezahlt')

  const merke = (fehler: string | null) => deps.db.update(ticketBestellungen).set({
    ...(fehler ? { emailFehler: fehler.slice(0, 500) } : { emailFehler: null, emailGesendetAt: new Date() }),
    updatedAt: new Date(),
  }).where(eq(ticketBestellungen.id, id))

  if (!isEmailAktiv(deps.config)) {
    const fehler = 'E-Mail-Versand ist nicht eingerichtet (SMTP)'
    await merke(fehler)
    return { erfolgreich: false, fehler }
  }

  try {
    const m = await ladeShopMandant(deps.db, b.mandantId)
    const basis = m?.ticketBasisUrl ?? b.basisUrl
    const codes = (await deps.db.select({ code: tickets.code }).from(tickets)
      .where(and(eq(tickets.bestellungId, id), eq(tickets.status, 'gueltig')))
      .orderBy(asc(tickets.createdAt), asc(tickets.code))).map(t => t.code)
    const daten = await holeTicketDruckdaten(deps.db, codes, basis)
    if (daten.length === 0) throw new Error('Keine gültigen Tickets in dieser Bestellung')

    const kauf: TicketKaufInfo = {
      summeCent:  b.summeCent,
      positionen: b.positionen.map(p => ({ bezeichnung: p.bezeichnung, menge: p.menge, preisCent: p.preisCent })),
      bestellUrl: basis ? `${basis}/b/${b.id}` : null,
      beleg:      null,
    }
    if (b.belegId && m) {
      const beleg = await holeBeleg(deps.db, b.belegId, b.mandantId)
      if (beleg) {
        kauf.beleg = {
          belegNummer: beleg.belegNummer,
          belegDatum:  beleg.belegDatum,
          firmenname:  m.firmenname,
          uid:         m.uid,
          steuer:      berechneSteueraufteilung(beleg).map(z => ({ label: z.label, nettoCent: z.nettoCent, ustCent: z.ustCent, bruttoCent: z.bruttoCent })),
          maschinenlesbareCode: beleg.maschinenlesbareCode,
          rechnungUrl: basis ? `${basis}/api/ticketshop/bestellungen/${b.id}/rechnung` : null,
        }
      }
    }
    await sendeTicketEmail(empfaenger ?? b.email, daten, deps.config, kauf)
    await merke(null)
    return { erfolgreich: true }
  } catch (err) {
    const fehler = err instanceof Error ? err.message : String(err)
    await merke(fehler)
    return { erfolgreich: false, fehler }
  }
}

// ---------------------------------------------------------------------------
// Backoffice
// ---------------------------------------------------------------------------

export async function listeBestellungen(db: Db, mandantId: string, eventId: string): Promise<TicketBestellungAdmin[]> {
  const rows = await db.select({
    b:           ticketBestellungen,
    belegNummer: belege.belegNummer,
    // Tabelle ausgeschrieben — siehe listeEvents (Drizzle setzt Spalten im Select unqualifiziert ein)
    anzahl:      sql<number>`(SELECT count(*) FROM tickets t WHERE t.bestellung_id = ticket_bestellungen.id)`.mapWith(Number),
  }).from(ticketBestellungen)
    .leftJoin(belege, eq(belege.id, ticketBestellungen.belegId))
    .where(and(eq(ticketBestellungen.mandantId, mandantId), eq(ticketBestellungen.eventId, eventId)))
    .orderBy(desc(ticketBestellungen.createdAt))
    .limit(1000)

  return rows.map(({ b, belegNummer, anzahl }) => ({
    id:              b.id,
    status:          b.status as TicketBestellungStatus,
    name:            b.name,
    email:           b.email,
    rechnungFirma:   b.rechnung?.firma ?? null,
    summeCent:       b.summeCent,
    // Abgelaufene haben keine Tickets mehr — dann zählt, was bestellt war
    anzahlTickets:   anzahl > 0 ? anzahl : b.positionen.reduce((s, p) => s + p.menge, 0),
    positionen:      b.positionen.map(p => ({ bezeichnung: p.bezeichnung, menge: p.menge, preisCent: p.preisCent })),
    createdAt:       b.createdAt.toISOString(),
    bezahltAt:       b.bezahltAt?.toISOString() ?? null,
    belegNummer:     belegNummer ?? null,
    emailGesendetAt: b.emailGesendetAt?.toISOString() ?? null,
    emailFehler:     b.emailFehler,
  }))
}

/** Bestellung eines Mandanten laden (Backoffice-Aktionen) — 404 bei fremder ID. */
export async function pruefeBestellungDesMandanten(db: Db, mandantId: string, id: string): Promise<void> {
  const [b] = await db.select({ id: ticketBestellungen.id }).from(ticketBestellungen)
    .where(and(eq(ticketBestellungen.id, id), eq(ticketBestellungen.mandantId, mandantId))).limit(1)
  if (!b) throw new TicketShopError(404, 'Bestellung nicht gefunden')
}

export async function holeShopEinstellungen(deps: Pick<TicketShopDeps, 'db' | 'config'>, mandantId: string): Promise<TicketShopEinstellungenAntwort> {
  const m = await ladeShopMandant(deps.db, mandantId)
  if (!m) throw new TicketShopError(404, 'Mandant nicht gefunden')
  const konfig = await ladeStripeKonfig(deps.db, mandantId, deps.config)
  return {
    verkaufKasseId: m.verkaufKasseId,
    agbUrl:         m.agbUrl,
    datenschutzUrl: m.datenschutzUrl,
    impressumUrl:   m.impressumUrl,
    kaufhinweis:    m.kaufhinweis,
    stripe:         { konfiguriert: konfig !== null, eigenesKonto: konfig?.eigene ?? false },
    shopUrl:        m.ticketBasisUrl ? `${m.ticketBasisUrl}/v/${m.id}` : null,
  }
}

export async function setzeShopEinstellungen(
  deps: Pick<TicketShopDeps, 'db' | 'config'>, mandantId: string, input: TicketShopEinstellungen,
): Promise<TicketShopEinstellungenAntwort> {
  if (input.verkaufKasseId) {
    const [k] = await deps.db.select({ id: kassen.id }).from(kassen)
      .where(and(eq(kassen.id, input.verkaufKasseId), eq(kassen.mandantId, mandantId))).limit(1)
    if (!k) throw new TicketShopError(400, 'Kasse nicht gefunden')
  }
  const leer = (s: string | null) => (s && s.trim() ? s.trim() : null)
  await deps.db.update(mandanten).set({
    ticketVerkaufKasseId: input.verkaufKasseId,
    ticketAgbUrl:         leer(input.agbUrl),
    ticketDatenschutzUrl: leer(input.datenschutzUrl),
    ticketImpressumUrl:   leer(input.impressumUrl),
    ticketKaufhinweis:    leer(input.kaufhinweis),
    updatedAt:            new Date(),
  }).where(eq(mandanten.id, mandantId))
  return holeShopEinstellungen(deps, mandantId)
}
