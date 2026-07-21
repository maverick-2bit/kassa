/**
 * SB-Bestellungs-Service — Selbstbedienungs-Terminal (Kiosk) + Abholmonitor.
 *
 * Lebenszyklus: zahlung → offen → bereit → abgeholt (bzw. abgebrochen).
 * Die Finalisierung (nach erfolgreicher Kartenzahlung) vergibt die tägliche
 * 4-stellige Bestellnummer, signiert den RKSV-Beleg und boniert an das KDS.
 * Sie läuft idempotent über einen Status-Claim ('finalisiere'), damit
 * konkurrierende Poll-Requests keinen Doppel-Beleg erzeugen können.
 */

import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import type {
  AbholungEintrag,
  SbBestellung,
  TerminalBestellungInput,
  TerminalBestellungStatus,
  TerminalSortiment,
} from '@kassa/shared'
import { formatSbNummer } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  artikel,
  kassen,
  kategorien,
  kdsBons,
  mandanten,
  sbBestellungen,
  type SbBestellungRow,
} from '../db/schema.js'
import type { BelegServiceDeps } from './beleg.service.js'
import { erstelleBarzahlungsbeleg } from './beleg.service.js'
import { bonierBestellung } from './bonier.service.js'
import { berechneVerfuegbareMenge, ladeRezepteAngereichert } from './bestandteil.service.js'
import { starteZahlung, getJob, abbrechen } from './zvt/zvt.service.js'
import { emitAbholungEvent } from '../sse/abholung-event-bus.js'
import { emitKasseEvent } from '../sse/event-bus.js'

export class SbBestellungError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export interface SbServiceDeps {
  db:        Db
  belegDeps: BelegServiceDeps
}

/** Heutiges Datum (Server-Lokalzeit) als YYYY-MM-DD — Tageskreis der Bestellnummern */
function heutigesDatum(): string {
  return new Date().toLocaleDateString('sv-SE')
}

// ---------------------------------------------------------------------------
// Kasse + Modul-Gating
// ---------------------------------------------------------------------------

type KasseRow = typeof kassen.$inferSelect

/** Kasse laden und prüfen, dass das SB-Terminal-Modul des Mandanten aktiv ist (403 sonst). */
export async function ladeTerminalKasse(db: Db, kasseId: string): Promise<KasseRow> {
  const [kasse] = await db.select().from(kassen).where(eq(kassen.id, kasseId)).limit(1)
  if (!kasse) throw new SbBestellungError(404, 'Kasse nicht gefunden')

  const [mandant] = await db
    .select({ aktiv: mandanten.modulSbTerminalAktiv })
    .from(mandanten)
    .where(eq(mandanten.id, kasse.mandantId))
    .limit(1)
  if (!mandant?.aktiv) throw new SbBestellungError(403, 'SB-Terminal-Modul ist nicht aktiviert')

  return kasse
}

// ---------------------------------------------------------------------------
// Sortiment (effektive Terminal-Sichtbarkeit)
// ---------------------------------------------------------------------------

/**
 * Terminal-Sortiment: Kategorien mit terminalSichtbar=true; Artikel deren
 * Override true ist ODER (Override null UND Kategorie sichtbar). Ausgeschlossen:
 * inaktive, serialisierte (kein Serial-Picker am Kiosk) und ausverkaufte Artikel.
 */
export async function holeTerminalSortiment(db: Db, kasseId: string): Promise<TerminalSortiment> {
  const kasse = await ladeTerminalKasse(db, kasseId)

  const [mandant] = await db
    .select({ firmenname: mandanten.firmenname })
    .from(mandanten)
    .where(eq(mandanten.id, kasse.mandantId))
    .limit(1)

  const alleKategorien = await db
    .select({
      id:               kategorien.id,
      name:             kategorien.name,
      farbe:            kategorien.farbe,
      terminalSichtbar: kategorien.terminalSichtbar,
      reihenfolge:      kategorien.reihenfolge,
    })
    .from(kategorien)
    .where(and(eq(kategorien.mandantId, kasse.mandantId), eq(kategorien.aktiv, true)))
    .orderBy(asc(kategorien.reihenfolge))

  const sichtbareKategorieIds = new Set(alleKategorien.filter(k => k.terminalSichtbar).map(k => k.id))

  const alleArtikel = await db
    .select({
      id:                 artikel.id,
      bezeichnung:        artikel.bezeichnung,
      preisBruttoCent:    artikel.preisBruttoCent,
      kategorieId:        artikel.kategorieId,
      bild:               artikel.bild,
      terminalSichtbar:   artikel.terminalSichtbar,
      seriennummernAktiv: artikel.seriennummernAktiv,
      lagerstandAktiv:    artikel.lagerstandAktiv,
      lagerstandMenge:    artikel.lagerstandMenge,
      istBestandteil:     artikel.istBestandteil,
      reihenfolge:        artikel.reihenfolge,
    })
    .from(artikel)
    .where(and(eq(artikel.mandantId, kasse.mandantId), eq(artikel.aktiv, true)))
    .orderBy(asc(artikel.reihenfolge))

  // Rezept-Verfügbarkeit: zusammengesetzte Artikel sind ausverkauft, wenn ein Bestandteil fehlt.
  const rezepte = await ladeRezepteAngereichert(db, alleArtikel.map(a => a.id))

  const sichtbareArtikel = alleArtikel.filter(a => {
    const effektivSichtbar =
      a.terminalSichtbar === true ||
      (a.terminalSichtbar === null && a.kategorieId !== null && sichtbareKategorieIds.has(a.kategorieId))
    if (!effektivSichtbar) return false
    if (a.seriennummernAktiv) return false
    if (a.istBestandteil) return false  // Rohstoffe sind nicht direkt bestellbar
    if (a.lagerstandAktiv && (a.lagerstandMenge === null || a.lagerstandMenge <= 0)) return false
    const verfuegbar = berechneVerfuegbareMenge(rezepte.get(a.id) ?? [])
    if (verfuegbar !== null && verfuegbar <= 0) return false
    return true
  })

  // Kategorien-Tabs: sichtbare Kategorien + Kategorien mit per-Override sichtbaren Artikeln
  const benutzteKategorieIds = new Set(sichtbareArtikel.map(a => a.kategorieId).filter((id): id is string => id !== null))
  const tabs = alleKategorien.filter(k => sichtbareKategorieIds.has(k.id) || benutzteKategorieIds.has(k.id))

  return {
    kasse: {
      id:          kasse.id,
      bezeichnung: kasse.bezeichnung,
      firmenname:  mandant?.firmenname ?? '',
    },
    kategorien: tabs.map(k => ({ id: k.id, name: k.name, farbe: k.farbe })),
    artikel: sichtbareArtikel.map(a => ({
      id:              a.id,
      bezeichnung:     a.bezeichnung,
      preisBruttoCent: a.preisBruttoCent,
      kategorieId:     a.kategorieId,
      bild:            a.bild,
    })),
  }
}

// ---------------------------------------------------------------------------
// Bestellung anlegen (Terminal, öffentlich)
// ---------------------------------------------------------------------------

export async function erstelleSbBestellung(
  input: TerminalBestellungInput,
  deps:  SbServiceDeps,
): Promise<TerminalBestellungStatus> {
  const kasse = await ladeTerminalKasse(deps.db, input.kasseId)

  // Artikel serverseitig laden — Preise NIE vom Client übernehmen
  const artikelIds = input.positionen.map(p => p.artikelId)
  const rows = await deps.db
    .select()
    .from(artikel)
    .where(and(eq(artikel.mandantId, kasse.mandantId), inArray(artikel.id, artikelIds)))
  const byId = new Map(rows.map(a => [a.id, a]))

  const sortimentKategorien = await deps.db
    .select({ id: kategorien.id, terminalSichtbar: kategorien.terminalSichtbar })
    .from(kategorien)
    .where(eq(kategorien.mandantId, kasse.mandantId))
  const katSichtbar = new Map(sortimentKategorien.map(k => [k.id, k.terminalSichtbar]))

  // Rezept-Verfügbarkeit der bestellten Artikel
  const rezepte = await ladeRezepteAngereichert(deps.db, artikelIds)

  for (const p of input.positionen) {
    const a = byId.get(p.artikelId)
    if (!a || !a.aktiv) throw new SbBestellungError(400, 'Artikel nicht verfügbar')
    const effektivSichtbar =
      a.terminalSichtbar === true ||
      (a.terminalSichtbar === null && a.kategorieId !== null && (katSichtbar.get(a.kategorieId) ?? false))
    if (!effektivSichtbar || a.seriennummernAktiv || a.istBestandteil) {
      throw new SbBestellungError(400, 'Artikel ist am Terminal nicht bestellbar')
    }
    if (a.lagerstandAktiv && (a.lagerstandMenge === null || a.lagerstandMenge < p.menge)) {
      throw new SbBestellungError(400, `„${a.bezeichnung}" ist nicht mehr in ausreichender Menge verfügbar`)
    }
    const verfuegbar = berechneVerfuegbareMenge(rezepte.get(a.id) ?? [])
    if (verfuegbar !== null && verfuegbar < p.menge) {
      throw new SbBestellungError(400, `„${a.bezeichnung}" ist nicht mehr in ausreichender Menge verfügbar`)
    }
  }

  const positionen = input.positionen.map(p => {
    const a = byId.get(p.artikelId)!
    return {
      artikelId:       a.id,
      bezeichnung:     a.bezeichnung,
      menge:           p.menge,
      preisBruttoCent: a.preisBruttoCent,
    }
  })
  const summeCent = positionen.reduce((s, p) => s + p.preisBruttoCent * p.menge, 0)
  if (summeCent <= 0) throw new SbBestellungError(400, 'Bestellsumme muss größer 0 sein')

  const demoZahlung = !kasse.zvtAktiv

  const [row] = await deps.db.insert(sbBestellungen).values({
    mandantId:  kasse.mandantId,
    kasseId:    kasse.id,
    datum:      heutigesDatum(),
    positionen,
    summeCent,
    status:     'zahlung',
  }).returning()
  if (!row) throw new SbBestellungError(500, 'Bestellung konnte nicht angelegt werden')

  // Kartenzahlung starten (echtes Terminal oder Stub) — Demo-Modus wartet auf /bestaetigen
  if (!demoZahlung) {
    try {
      const { jobId } = await starteZahlung(
        { kasseId: kasse.id, betragCent: summeCent },
        kasse.mandantId,
        { db: deps.db },
      )
      await deps.db.update(sbBestellungen).set({ zvtJobId: jobId }).where(eq(sbBestellungen.id, row.id))
      row.zvtJobId = jobId
    } catch (err) {
      // Zahlung kam nie zustande → Bestellung nicht als Zombie in 'zahlung' zurücklassen
      await deps.db.update(sbBestellungen).set({ status: 'abgebrochen' }).where(eq(sbBestellungen.id, row.id))
      throw err
    }
  }

  return statusDto(row, demoZahlung)
}

// ---------------------------------------------------------------------------
// Status-Poll + idempotente Finalisierung
// ---------------------------------------------------------------------------

export async function holeSbBestellungStatus(
  id:   string,
  deps: SbServiceDeps,
): Promise<TerminalBestellungStatus> {
  const [row] = await deps.db.select().from(sbBestellungen).where(eq(sbBestellungen.id, id)).limit(1)
  if (!row) throw new SbBestellungError(404, 'Bestellung nicht gefunden')

  const [kasse] = await deps.db.select().from(kassen).where(eq(kassen.id, row.kasseId)).limit(1)
  const demoZahlung = !kasse?.zvtAktiv

  if (row.status !== 'zahlung' || demoZahlung) return statusDto(row, demoZahlung)

  // ZVT-Zwischenstand prüfen
  const job = row.zvtJobId ? getJob(row.zvtJobId) : null
  if (!job) {
    // Job verloren (Server-Neustart / TTL) — Zahlungsausgang unbekannt → abbrechen
    await deps.db
      .update(sbBestellungen)
      .set({ status: 'abgebrochen' })
      .where(and(eq(sbBestellungen.id, row.id), eq(sbBestellungen.status, 'zahlung')))
    const [neu] = await deps.db.select().from(sbBestellungen).where(eq(sbBestellungen.id, id)).limit(1)
    return statusDto(neu ?? row, demoZahlung)
  }

  if (job.status === 'erfolg') {
    const finalisiert = await finalisiereSbBestellung(row.id, deps)
    return statusDto(finalisiert, demoZahlung)
  }
  if (job.status === 'fehler' || job.status === 'abgebrochen') {
    await deps.db
      .update(sbBestellungen)
      .set({ status: 'abgebrochen' })
      .where(and(eq(sbBestellungen.id, row.id), eq(sbBestellungen.status, 'zahlung')))
    const [neu] = await deps.db.select().from(sbBestellungen).where(eq(sbBestellungen.id, id)).limit(1)
    return statusDto(neu ?? row, demoZahlung, job)
  }

  return statusDto(row, demoZahlung, job)
}

/** Demo-Modus (Kasse ohne ZVT): Zahlung manuell bestätigen → finalisieren. */
export async function bestaetigeDemoZahlung(
  id:   string,
  deps: SbServiceDeps,
): Promise<TerminalBestellungStatus> {
  const [row] = await deps.db.select().from(sbBestellungen).where(eq(sbBestellungen.id, id)).limit(1)
  if (!row) throw new SbBestellungError(404, 'Bestellung nicht gefunden')

  const [kasse] = await deps.db.select().from(kassen).where(eq(kassen.id, row.kasseId)).limit(1)
  if (kasse?.zvtAktiv) throw new SbBestellungError(409, 'Kasse nutzt ZVT — Bestätigung nur im Demo-Modus möglich')
  if (row.status !== 'zahlung') return statusDto(row, true)

  const finalisiert = await finalisiereSbBestellung(row.id, deps)
  return statusDto(finalisiert, true)
}

export async function bricheSbBestellungAb(id: string, deps: SbServiceDeps): Promise<TerminalBestellungStatus> {
  const [row] = await deps.db.select().from(sbBestellungen).where(eq(sbBestellungen.id, id)).limit(1)
  if (!row) throw new SbBestellungError(404, 'Bestellung nicht gefunden')

  if (row.status === 'zahlung') {
    if (row.zvtJobId) abbrechen(row.zvtJobId)
    await deps.db
      .update(sbBestellungen)
      .set({ status: 'abgebrochen' })
      .where(and(eq(sbBestellungen.id, row.id), eq(sbBestellungen.status, 'zahlung')))
  }
  const [neu] = await deps.db.select().from(sbBestellungen).where(eq(sbBestellungen.id, id)).limit(1)
  const [kasse] = await deps.db.select().from(kassen).where(eq(kassen.id, row.kasseId)).limit(1)
  return statusDto(neu ?? row, !kasse?.zvtAktiv)
}

/**
 * Zahlung erfolgreich → Bestellung finalisieren:
 * Nummer vergeben, RKSV-Beleg signieren, KDS bonieren, Events pushen.
 * Idempotent: der Status-Claim 'zahlung'→'finalisiere' gewinnt genau einmal;
 * Verlierer liefern den aktuellen Zustand zurück.
 */
async function finalisiereSbBestellung(id: string, deps: SbServiceDeps): Promise<SbBestellungRow> {
  // Claim — nur ein Aufrufer darf finalisieren
  const [claimed] = await deps.db
    .update(sbBestellungen)
    .set({ status: 'finalisiere' })
    .where(and(eq(sbBestellungen.id, id), eq(sbBestellungen.status, 'zahlung')))
    .returning()

  if (!claimed) {
    // Bereits finalisiert (oder gerade in Arbeit) → aktuellen Stand liefern
    const [aktuell] = await deps.db.select().from(sbBestellungen).where(eq(sbBestellungen.id, id)).limit(1)
    if (!aktuell) throw new SbBestellungError(404, 'Bestellung nicht gefunden')
    return aktuell
  }

  let belegId: string
  let nummer: number
  try {
    // 1. Tägliche Bestellnummer vergeben (Unique-Konflikt bei Gleichzeitigkeit → Retry)
    nummer = await vergebeBestellNummer(deps.db, claimed)

    // 2. RKSV-Beleg signieren (Kartenzahlung über die Terminal-Kasse)
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
  } catch (err) {
    // Kein Beleg entstanden → Claim zurückgeben, nächster Poll versucht es erneut
    await deps.db
      .update(sbBestellungen)
      .set({ status: 'zahlung', bestellNummer: null })
      .where(eq(sbBestellungen.id, id))
    throw err
  }

  // Ab hier existiert der Beleg → Bestellung wird in jedem Fall 'offen'
  const [fertig] = await deps.db
    .update(sbBestellungen)
    .set({ status: 'offen', belegId })
    .where(eq(sbBestellungen.id, id))
    .returning()
  const row = fertig ?? claimed

  // 3. KDS bonieren — Fehler nicht fatal (Bestellung + Beleg existieren bereits)
  try {
    await bonierBestellung(
      {
        kasseId:    claimed.kasseId,
        tisch:      `SB ${formatSbNummer(nummer)}`,
        kellner:    'SB-Terminal',
        positionen: claimed.positionen.map(p => ({ artikelId: p.artikelId, menge: p.menge })),
      },
      { db: deps.db },
      { sb: { bestellungId: id, bestellNummer: formatSbNummer(nummer) } },
    )
  } catch (err) {
    console.error('SB-Bonierung fehlgeschlagen:', err)
  }

  // 4. Events: Abholmonitor + zentrale Kassa
  emitAbholungEvent(claimed.mandantId, { typ: 'update', bestellung: abholungEintrag(row) })
  emitKasseEvent(claimed.mandantId, {
    typ:              'neue_sb_bestellung',
    bestellungId:     id,
    kasseId:          claimed.kasseId,
    bestellNummer:    nummer,
    anzahlPositionen: claimed.positionen.reduce((s, p) => s + p.menge, 0),
    summeCent:        claimed.summeCent,
  })

  return row
}

/** Nächste freie Tagesnummer (max+1) mit Retry bei Unique-Konflikt. */
async function vergebeBestellNummer(db: Db, row: SbBestellungRow): Promise<number> {
  for (let versuch = 0; versuch < 5; versuch++) {
    try {
      const [r] = await db
        .update(sbBestellungen)
        .set({
          bestellNummer: sql`(SELECT COALESCE(MAX(s2.bestell_nummer), 0) + 1 FROM sb_bestellungen s2 WHERE s2.mandant_id = ${row.mandantId} AND s2.datum = ${row.datum})`,
        })
        .where(eq(sbBestellungen.id, row.id))
        .returning({ nummer: sbBestellungen.bestellNummer })
      if (r?.nummer != null) return r.nummer
    } catch {
      // Unique-Konflikt (gleichzeitige Finalisierung) → erneut versuchen
    }
  }
  throw new SbBestellungError(500, 'Bestellnummer konnte nicht vergeben werden')
}

// ---------------------------------------------------------------------------
// Status-Übergänge (Kassa / KDS)
// ---------------------------------------------------------------------------

export async function setzeBereit(db: Db, id: string, mandantId: string): Promise<SbBestellung> {
  const [row] = await db
    .update(sbBestellungen)
    .set({ status: 'bereit', bereitAt: new Date() })
    .where(and(
      eq(sbBestellungen.id, id),
      eq(sbBestellungen.mandantId, mandantId),
      eq(sbBestellungen.status, 'offen'),
    ))
    .returning()
  if (!row) throw new SbBestellungError(404, 'Bestellung nicht gefunden oder nicht im Status „offen"')

  emitAbholungEvent(mandantId, { typ: 'update', bestellung: abholungEintrag(row) })
  return toDto(row)
}

export async function setzeAbgeholt(db: Db, id: string, mandantId: string): Promise<SbBestellung> {
  const [row] = await db
    .update(sbBestellungen)
    .set({ status: 'abgeholt', abgeholtAt: new Date() })
    .where(and(
      eq(sbBestellungen.id, id),
      eq(sbBestellungen.mandantId, mandantId),
      inArray(sbBestellungen.status, ['offen', 'bereit']),
    ))
    .returning()
  if (!row) throw new SbBestellungError(404, 'Bestellung nicht gefunden oder bereits abgeholt')

  emitAbholungEvent(mandantId, { typ: 'entfernt', bestellungId: row.id })
  return toDto(row)
}

/**
 * Auto-„bereit": nach jedem KDS-Bon-erledigt prüfen, ob ALLE Bons der
 * SB-Bestellung erledigt sind — dann Status offen→bereit (idempotent).
 */
export async function sbAutoBereitNachBonErledigt(
  db:             Db,
  sbBestellungId: string,
  mandantId:      string,
): Promise<void> {
  const bons = await db
    .select({ status: kdsBons.status })
    .from(kdsBons)
    .where(and(eq(kdsBons.sbBestellungId, sbBestellungId), eq(kdsBons.mandantId, mandantId)))
  if (bons.length === 0 || !bons.every(b => b.status === 'erledigt')) return

  const [row] = await db
    .update(sbBestellungen)
    .set({ status: 'bereit', bereitAt: new Date() })
    .where(and(
      eq(sbBestellungen.id, sbBestellungId),
      eq(sbBestellungen.mandantId, mandantId),
      eq(sbBestellungen.status, 'offen'),
    ))
    .returning()
  if (row) emitAbholungEvent(mandantId, { typ: 'update', bestellung: abholungEintrag(row) })
}

// ---------------------------------------------------------------------------
// Listen (Kassa-Verwaltung + Abholmonitor-Snapshot)
// ---------------------------------------------------------------------------

export async function listeSbBestellungen(db: Db, mandantId: string, datum?: string): Promise<SbBestellung[]> {
  const tag = datum ?? heutigesDatum()
  const rows = await db
    .select()
    .from(sbBestellungen)
    .where(and(eq(sbBestellungen.mandantId, mandantId), eq(sbBestellungen.datum, tag)))
    .orderBy(asc(sbBestellungen.erstelltAt))
  return rows.map(toDto)
}

/** Snapshot für den Abholmonitor: heutige offene + bereite Bestellungen (nur Nummern/Zeiten). */
export async function heutigeAbholungEintraege(db: Db, mandantId: string): Promise<AbholungEintrag[]> {
  const rows = await db
    .select()
    .from(sbBestellungen)
    .where(and(
      eq(sbBestellungen.mandantId, mandantId),
      eq(sbBestellungen.datum, heutigesDatum()),
      inArray(sbBestellungen.status, ['offen', 'bereit']),
    ))
    .orderBy(asc(sbBestellungen.erstelltAt))
  return rows.map(abholungEintrag)
}

// ---------------------------------------------------------------------------
// DTO-Mapper
// ---------------------------------------------------------------------------

/** Interner Claim-Status 'finalisiere' bleibt nach außen 'zahlung'. */
function externerStatus(status: string): SbBestellung['status'] {
  return (status === 'finalisiere' ? 'zahlung' : status) as SbBestellung['status']
}

function toDto(row: SbBestellungRow): SbBestellung {
  return {
    id:            row.id,
    kasseId:       row.kasseId,
    bestellNummer: row.bestellNummer ?? 0,
    datum:         row.datum,
    positionen:    row.positionen,
    summeCent:     row.summeCent,
    status:        externerStatus(row.status),
    belegId:       row.belegId,
    erstelltAt:    row.erstelltAt.toISOString(),
    bereitAt:      row.bereitAt?.toISOString() ?? null,
    abgeholtAt:    row.abgeholtAt?.toISOString() ?? null,
  }
}

function abholungEintrag(row: SbBestellungRow): AbholungEintrag {
  return {
    id:            row.id,
    bestellNummer: row.bestellNummer ?? 0,
    status:        row.status === 'bereit' ? 'bereit' : 'offen',
    erstelltAt:    row.erstelltAt.toISOString(),
    bereitAt:      row.bereitAt?.toISOString() ?? null,
  }
}

function statusDto(
  row:         SbBestellungRow,
  demoZahlung: boolean,
  job?:        { status: string; meldung?: string | undefined } | null,
): TerminalBestellungStatus {
  return {
    id:            row.id,
    status:        externerStatus(row.status),
    summeCent:     row.summeCent,
    bestellNummer: row.bestellNummer,
    demoZahlung,
    zahlung: job ? { status: job.status, ...(job.meldung ? { meldung: job.meldung } : {}) } : null,
  }
}
