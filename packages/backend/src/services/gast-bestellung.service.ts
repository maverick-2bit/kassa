/**
 * Gast-Bestellungs-Service — Handy-Bestellung am Tisch, sofort online bezahlt.
 *
 * Ablauf: Gast bestellt → Stripe-Checkout → Zahlungserfolg (Webhook) →
 * finalisieren: RKSV-Beleg signieren + an KDS/Warengruppen-Drucker bonieren.
 * Kein Zahlkellner, kein offener Tab, keine Abholnummer (Tischservice).
 *
 * Baut auf den SB-Bausteinen auf (sb-bestellung.service): idempotenter Status-Claim,
 * erstelleBarzahlungsbeleg (Betrag in karteCent), bonierBestellung. Ohne ZVT — die
 * Zahlung kommt von Stripe; ohne Stripe-Keys läuft der Demo-Pfad (Dev/Test).
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { artikel, belege, gastBestellungen, kassen, mandanten, type GastBestellungRow } from '../db/schema.js'
import type { BelegServiceDeps } from './beleg.service.js'
import { erstelleBarzahlungsbeleg } from './beleg.service.js'
import { bonierBestellung } from './bonier.service.js'
import { berechneVerfuegbareMenge, ladeRezepteAngereichert } from './bestandteil.service.js'
import { belegRowZuDto } from './drucker.service.js'
import { emitKasseEvent } from '../sse/event-bus.js'
import { isStripeAktiv, erstelleCheckoutSession } from './stripe.service.js'

export class GastBestellungError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export interface GastServiceDeps {
  db:        Db
  belegDeps: BelegServiceDeps
  config:    Config
}

export interface GastBestellPosition { artikelId: string; menge: number }
export interface GastBestellInput {
  kasseId:     string
  tischNummer: string
  positionen:  GastBestellPosition[]
}

/** Externer Status: der interne Claim-Zustand 'finalisiere' erscheint als 'zahlung'. */
function externerStatus(status: string): 'zahlung' | 'bezahlt' | 'abgebrochen' {
  if (status === 'bezahlt' || status === 'abgebrochen') return status
  return 'zahlung'
}

// ---------------------------------------------------------------------------
// Bestellung anlegen (öffentlich) → Checkout-URL oder Demo-Sofortfinalisierung
// ---------------------------------------------------------------------------

export async function erstelleGastBestellung(
  input: GastBestellInput,
  deps:  GastServiceDeps,
): Promise<{ bestellungId: string; checkoutUrl: string | null }> {
  const [kasse] = await deps.db.select().from(kassen).where(eq(kassen.id, input.kasseId)).limit(1)
  if (!kasse) throw new GastBestellungError(404, 'Kasse nicht gefunden')
  if (!kasse.gastBestellungAktiv) throw new GastBestellungError(403, 'Gast-Bestellung ist für diese Kasse nicht aktiv')

  const stripeAktiv = isStripeAktiv(deps.config)
  if (!stripeAktiv && deps.config.NODE_ENV === 'production') {
    throw new GastBestellungError(503, 'Online-Zahlung ist nicht konfiguriert')
  }

  // Artikel serverseitig laden + bepreisen — nie Client-Preise übernehmen
  const artikelIds = [...new Set(input.positionen.map(p => p.artikelId))]
  const rows = await deps.db
    .select()
    .from(artikel)
    .where(and(eq(artikel.mandantId, kasse.mandantId), inArray(artikel.id, artikelIds)))
  const byId = new Map(rows.map(a => [a.id, a]))
  const rezepte = await ladeRezepteAngereichert(deps.db, artikelIds)

  for (const p of input.positionen) {
    const a = byId.get(p.artikelId)
    if (!a || !a.aktiv || a.istBestandteil) throw new GastBestellungError(400, 'Artikel nicht verfügbar')
    if (a.lagerstandAktiv && (a.lagerstandMenge === null || a.lagerstandMenge < p.menge)) {
      throw new GastBestellungError(400, `„${a.bezeichnung}" ist nicht mehr in ausreichender Menge verfügbar`)
    }
    const verfuegbar = berechneVerfuegbareMenge(rezepte.get(a.id) ?? [])
    if (verfuegbar !== null && verfuegbar < p.menge) {
      throw new GastBestellungError(400, `„${a.bezeichnung}" ist nicht mehr in ausreichender Menge verfügbar`)
    }
  }

  const positionen = input.positionen.map(p => {
    const a = byId.get(p.artikelId)!
    return { artikelId: a.id, bezeichnung: a.bezeichnung, menge: p.menge, preisBruttoCent: a.preisBruttoCent }
  })
  const summeCent = positionen.reduce((s, p) => s + p.preisBruttoCent * p.menge, 0)
  if (summeCent <= 0) throw new GastBestellungError(400, 'Bestellsumme muss größer 0 sein')

  const [row] = await deps.db.insert(gastBestellungen).values({
    mandantId:   kasse.mandantId,
    kasseId:     kasse.id,
    tischNummer: input.tischNummer,
    positionen,
    summeCent,
    status:      'zahlung',
  }).returning()
  if (!row) throw new GastBestellungError(500, 'Bestellung konnte nicht angelegt werden')

  // Demo-Pfad (kein Stripe konfiguriert, nur Dev/Test): sofort finalisieren.
  if (!stripeAktiv) {
    await finalisiereGastBestellung(row.id, deps)
    return { bestellungId: row.id, checkoutUrl: null }
  }

  // Stripe-Checkout-Session erzeugen; Rücksprung in die Gast-App über gastBasisUrl.
  const basis = kasse.gastBasisUrl ?? ''
  const sep = basis.includes('?') ? '&' : '?'
  try {
    const session = await erstelleCheckoutSession({
      bestellungId: row.id,
      positionen:   positionen.map(p => ({ bezeichnung: p.bezeichnung, preisBruttoCent: p.preisBruttoCent, menge: p.menge })),
      successUrl:   `${basis}${sep}bestellung=${row.id}`,
      cancelUrl:    `${basis}${sep}bestellung=${row.id}&abbruch=1`,
    }, deps.config)
    await deps.db.update(gastBestellungen).set({ stripeSessionId: session.id, updatedAt: new Date() }).where(eq(gastBestellungen.id, row.id))
    return { bestellungId: row.id, checkoutUrl: session.url }
  } catch (err) {
    await deps.db.update(gastBestellungen).set({ status: 'abgebrochen', updatedAt: new Date() }).where(eq(gastBestellungen.id, row.id))
    throw err
  }
}

// ---------------------------------------------------------------------------
// Status-Poll (öffentlich, über die nicht erratbare Bestell-ID)
// ---------------------------------------------------------------------------

export interface GastBestellStatus {
  id:        string
  status:    'zahlung' | 'bezahlt' | 'abgebrochen'
  summeCent: number
  belegId:   string | null
  /** Belegdaten für den Bildschirm-Beleg (nur wenn bezahlt) */
  beleg:     { firmenname: string; uid: string; kassenId: string; beleg: ReturnType<typeof belegRowZuDto> } | null
}

export async function holeGastBestellungStatus(id: string, deps: GastServiceDeps): Promise<GastBestellStatus> {
  const [row] = await deps.db.select().from(gastBestellungen).where(eq(gastBestellungen.id, id)).limit(1)
  if (!row) throw new GastBestellungError(404, 'Bestellung nicht gefunden')

  let beleg: GastBestellStatus['beleg'] = null
  if (row.status === 'bezahlt' && row.belegId) {
    const [b] = await deps.db.select().from(belege).where(eq(belege.id, row.belegId)).limit(1)
    if (b) {
      const [mandant] = await deps.db
        .select({ firmenname: mandanten.firmenname, uid: mandanten.uid })
        .from(mandanten).where(eq(mandanten.id, b.mandantId)).limit(1)
      const [kasse] = await deps.db
        .select({ kassenId: kassen.kassenId }).from(kassen).where(eq(kassen.id, b.kasseId)).limit(1)
      beleg = {
        firmenname: mandant?.firmenname ?? '',
        uid:        mandant?.uid ?? '',
        kassenId:   kasse?.kassenId ?? '',
        beleg:      belegRowZuDto(b),
      }
    }
  }

  return { id: row.id, status: externerStatus(row.status), summeCent: row.summeCent, belegId: row.belegId, beleg }
}

// ---------------------------------------------------------------------------
// Finalisierung nach erfolgreicher Zahlung (idempotent) — Webhook oder Demo
// ---------------------------------------------------------------------------

export async function finalisiereGastBestellung(id: string, deps: GastServiceDeps): Promise<GastBestellungRow> {
  // Idempotenter Claim — nur ein Aufrufer (Poll/Webhook-Retry) darf finalisieren
  const [claimed] = await deps.db
    .update(gastBestellungen)
    .set({ status: 'finalisiere', updatedAt: new Date() })
    .where(and(eq(gastBestellungen.id, id), eq(gastBestellungen.status, 'zahlung')))
    .returning()
  if (!claimed) {
    const [aktuell] = await deps.db.select().from(gastBestellungen).where(eq(gastBestellungen.id, id)).limit(1)
    if (!aktuell) throw new GastBestellungError(404, 'Bestellung nicht gefunden')
    return aktuell
  }

  let belegId: string
  let belegNummer: number
  try {
    const beleg = await erstelleBarzahlungsbeleg({
      kasseId: claimed.kasseId,
      positionen: claimed.positionen.map(p => ({
        artikelId:              p.artikelId,
        menge:                  p.menge,
        einzelpreisBreuttoCent: p.preisBruttoCent,
      })),
      zahlung: { barCent: 0, karteCent: claimed.summeCent, sonstigeCent: 0 },
    }, deps.belegDeps)
    belegId = beleg.id
    belegNummer = beleg.belegNummer
  } catch (err) {
    // Kein Beleg → Claim zurückgeben, nächster Webhook/Poll versucht es erneut
    await deps.db.update(gastBestellungen).set({ status: 'zahlung', updatedAt: new Date() }).where(eq(gastBestellungen.id, id))
    throw err
  }

  const [fertig] = await deps.db
    .update(gastBestellungen)
    .set({ status: 'bezahlt', belegId, updatedAt: new Date() })
    .where(eq(gastBestellungen.id, id))
    .returning()
  const row = fertig ?? claimed

  // Bonieren an KDS/Warengruppen-Drucker mit dem echten Tisch — Fehler nicht fatal
  try {
    await bonierBestellung(
      {
        kasseId:    claimed.kasseId,
        tisch:      claimed.tischNummer,
        kellner:    'Gast',
        positionen: claimed.positionen.map(p => ({ artikelId: p.artikelId, menge: p.menge })),
      },
      { db: deps.db },
      { sb: { bestellungId: id, bestellNummer: String(belegNummer) } },
    )
  } catch (err) {
    console.error('Gast-Bonierung fehlgeschlagen:', err)
  }

  // POS-Toast (bestehendes Event der Gast-Bestellung)
  emitKasseEvent(claimed.mandantId, {
    typ:              'neue_gastbestellung',
    kasseId:          claimed.kasseId,
    tischNummer:      claimed.tischNummer,
    anzahlPositionen: claimed.positionen.reduce((s, p) => s + p.menge, 0),
    gesamtbetragCent: claimed.summeCent,
  })

  return row
}
