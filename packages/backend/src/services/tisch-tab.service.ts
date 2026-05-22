import { and, eq } from 'drizzle-orm'
import type {
  TabPosition,
  TischTabBezahlenInput,
  TischTabErstellenInput,
  TischTabResponse,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kassen, tischTabs } from '../db/schema.js'
import type { BelegServiceDeps } from './beleg.service.js'
import { erstelleBarzahlungsbeleg } from './beleg.service.js'

export interface TischTabServiceDeps {
  db:        Db
  belegDeps: BelegServiceDeps
}

export class TischTabError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

function berechneGesamtCent(positionen: TabPosition[]): number {
  return positionen.reduce((sum, p) => sum + p.preisBruttoCent * p.menge, 0)
}

function toResponse(row: typeof tischTabs.$inferSelect): TischTabResponse {
  const positionen = (row.positionen as TabPosition[]) ?? []
  return {
    id:              row.id,
    kasseId:         row.kasseId,
    tischNummer:     row.tischNummer,
    kellner:         row.kellner,
    positionen,
    status:          row.status as 'offen' | 'bezahlt',
    summeGesamtCent: berechneGesamtCent(positionen),
    geoffnetAm:      row.geoffnetAm.toISOString(),
    createdAt:       row.createdAt.toISOString(),
    updatedAt:       row.updatedAt.toISOString(),
  }
}

export async function listOffeneTabs(
  mandantId: string,
  kasseId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse[]> {
  const rows = await deps.db
    .select()
    .from(tischTabs)
    .where(and(
      eq(tischTabs.mandantId, mandantId),
      eq(tischTabs.kasseId, kasseId),
      eq(tischTabs.status, 'offen'),
    ))
    .orderBy(tischTabs.geoffnetAm)
  return rows.map(toResponse)
}

export async function erstelleTab(
  input: TischTabErstellenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse> {
  const [kasse] = await deps.db
    .select({ id: kassen.id })
    .from(kassen)
    .where(and(eq(kassen.id, input.kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  if (!kasse) throw new TischTabError(404, 'Kasse nicht gefunden')

  const [row] = await deps.db
    .insert(tischTabs)
    .values({
      mandantId,
      kasseId:     input.kasseId,
      tischNummer: input.tischNummer,
      kellner:     input.kellner,
      positionen:  [],
      status:      'offen',
      geoffnetAm:  new Date(),
    })
    .returning()
  if (!row) throw new TischTabError(500, 'Tab konnte nicht erstellt werden')
  return toResponse(row)
}

export async function getTab(
  id: string,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse> {
  const [row] = await deps.db
    .select()
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  return toResponse(row)
}

export async function aktualisierePositionen(
  id: string,
  positionen: TabPosition[],
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<TischTabResponse> {
  const [existing] = await deps.db
    .select({ id: tischTabs.id, status: tischTabs.status })
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  if (existing.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist nicht mehr offen')

  const [row] = await deps.db
    .update(tischTabs)
    .set({ positionen, updatedAt: new Date() })
    .where(eq(tischTabs.id, id))
    .returning()
  if (!row) throw new TischTabError(500, 'Update fehlgeschlagen')
  return toResponse(row)
}

export async function bezahleTab(
  id: string,
  input: TischTabBezahlenInput,
  mandantId: string,
  deps: TischTabServiceDeps,
): Promise<{ tab: TischTabResponse; belegId: string }> {
  const [existing] = await deps.db
    .select()
    .from(tischTabs)
    .where(and(eq(tischTabs.id, id), eq(tischTabs.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new TischTabError(404, 'Tisch-Tab nicht gefunden')
  if (existing.status !== 'offen') throw new TischTabError(409, 'Tisch-Tab ist bereits bezahlt')

  const positionen = (existing.positionen as TabPosition[]) ?? []
  if (positionen.length === 0) throw new TischTabError(400, 'Keine Positionen im Tab')

  const beleg = await erstelleBarzahlungsbeleg({
    kasseId:    existing.kasseId,
    positionen: positionen.map(p => ({ artikelId: p.artikelId, menge: p.menge })),
    zahlung:    input.zahlung,
  }, deps.belegDeps)

  const [row] = await deps.db
    .update(tischTabs)
    .set({ status: 'bezahlt', geschlossenAm: new Date(), belegId: beleg.id, updatedAt: new Date() })
    .where(eq(tischTabs.id, id))
    .returning()
  if (!row) throw new TischTabError(500, 'Tab konnte nicht geschlossen werden')

  return { tab: toResponse(row), belegId: beleg.id }
}
