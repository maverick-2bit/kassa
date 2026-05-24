import { and, asc, eq, inArray } from 'drizzle-orm'
import type {
  ModifikatorGruppe,
  ModifikatorGruppeErstellen,
  ModifikatorGruppeAktualisieren,
  ModifikatorErstellen,
  ModifikatorAktualisieren,
  ArtikelGruppenZuweisung,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  artikel,
  artikelModifikatorGruppen,
  modifikatorGruppen,
  modifikatoren,
} from '../db/schema.js'

export class ModifikatorError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Helper: DB-Rows → Response-Typ
// ---------------------------------------------------------------------------

async function fetchGruppenMitModifikatoren(
  mandantId: string,
  db: Db,
  filter?: { gruppenIds: string[] },
): Promise<ModifikatorGruppe[]> {
  const whereKlausel = filter
    ? and(
        eq(modifikatorGruppen.mandantId, mandantId),
        inArray(modifikatorGruppen.id, filter.gruppenIds),
      )
    : and(eq(modifikatorGruppen.mandantId, mandantId))

  const gruppen = await db
    .select()
    .from(modifikatorGruppen)
    .where(whereKlausel)
    .orderBy(asc(modifikatorGruppen.reihenfolge), asc(modifikatorGruppen.name))

  if (gruppen.length === 0) return []

  const gruppenIds = gruppen.map(g => g.id)
  const mods = await db
    .select()
    .from(modifikatoren)
    .where(
      and(
        eq(modifikatoren.mandantId, mandantId),
        inArray(modifikatoren.gruppeId, gruppenIds),
      ),
    )
    .orderBy(asc(modifikatoren.reihenfolge), asc(modifikatoren.name))

  return gruppen.map(g => ({
    id:          g.id,
    mandantId:   g.mandantId,
    name:        g.name,
    typ:         g.typ as 'pflicht' | 'optional',
    maxAuswahl:  g.maxAuswahl,
    reihenfolge: g.reihenfolge,
    aktiv:       g.aktiv,
    createdAt:   g.createdAt.toISOString(),
    updatedAt:   g.updatedAt.toISOString(),
    modifikatoren: mods
      .filter(m => m.gruppeId === g.id)
      .map(m => ({
        id:              m.id,
        gruppeId:        m.gruppeId,
        name:            m.name,
        aufschlagCent:   m.aufschlagCent,
        reihenfolge:     m.reihenfolge,
        aktiv:           m.aktiv,
        lagerstandMenge: m.lagerstandMenge,
        createdAt:       m.createdAt.toISOString(),
      })),
  }))
}

// ---------------------------------------------------------------------------
// Gruppen-CRUD
// ---------------------------------------------------------------------------

export async function listeGruppen(mandantId: string, db: Db): Promise<ModifikatorGruppe[]> {
  return fetchGruppenMitModifikatoren(mandantId, db)
}

export async function erstelleGruppe(
  input: ModifikatorGruppeErstellen,
  mandantId: string,
  db: Db,
): Promise<ModifikatorGruppe> {
  const [row] = await db
    .insert(modifikatorGruppen)
    .values({
      mandantId,
      name:        input.name,
      typ:         input.typ,
      maxAuswahl:  input.maxAuswahl ?? null,
      reihenfolge: input.reihenfolge,
    })
    .returning()
  if (!row) throw new ModifikatorError(500, 'Gruppe konnte nicht erstellt werden')

  return {
    id:            row.id,
    mandantId:     row.mandantId,
    name:          row.name,
    typ:           row.typ as 'pflicht' | 'optional',
    maxAuswahl:    row.maxAuswahl,
    reihenfolge:   row.reihenfolge,
    aktiv:         row.aktiv,
    modifikatoren: [],
    createdAt:     row.createdAt.toISOString(),
    updatedAt:     row.updatedAt.toISOString(),
  }
}

export async function aktualisiereGruppe(
  id: string,
  input: ModifikatorGruppeAktualisieren,
  mandantId: string,
  db: Db,
): Promise<ModifikatorGruppe> {
  const [existing] = await db
    .select({ id: modifikatorGruppen.id })
    .from(modifikatorGruppen)
    .where(and(eq(modifikatorGruppen.id, id), eq(modifikatorGruppen.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new ModifikatorError(404, 'Gruppe nicht gefunden')

  const updates: Partial<typeof modifikatorGruppen.$inferInsert> = { updatedAt: new Date() }
  if (input.name        !== undefined) updates.name        = input.name
  if (input.typ         !== undefined) updates.typ         = input.typ
  if (input.maxAuswahl  !== undefined) updates.maxAuswahl  = input.maxAuswahl
  if (input.reihenfolge !== undefined) updates.reihenfolge = input.reihenfolge
  if (input.aktiv       !== undefined) updates.aktiv       = input.aktiv

  await db.update(modifikatorGruppen).set(updates).where(eq(modifikatorGruppen.id, id))

  const [result] = await fetchGruppenMitModifikatoren(mandantId, db, { gruppenIds: [id] })
  if (!result) throw new ModifikatorError(500, 'Gruppe nach Update nicht gefunden')
  return result
}

export async function loescheGruppe(id: string, mandantId: string, db: Db): Promise<void> {
  const [existing] = await db
    .select({ id: modifikatorGruppen.id })
    .from(modifikatorGruppen)
    .where(and(eq(modifikatorGruppen.id, id), eq(modifikatorGruppen.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new ModifikatorError(404, 'Gruppe nicht gefunden')
  // ON DELETE CASCADE entfernt auch modifikatoren + artikel_modifikator_gruppen Einträge
  await db.delete(modifikatorGruppen).where(eq(modifikatorGruppen.id, id))
}

// ---------------------------------------------------------------------------
// Modifikatoren-CRUD (innerhalb einer Gruppe)
// ---------------------------------------------------------------------------

export async function erstelleModifikator(
  gruppeId: string,
  input: ModifikatorErstellen,
  mandantId: string,
  db: Db,
): Promise<ModifikatorGruppe> {
  const [gruppe] = await db
    .select({ id: modifikatorGruppen.id })
    .from(modifikatorGruppen)
    .where(and(eq(modifikatorGruppen.id, gruppeId), eq(modifikatorGruppen.mandantId, mandantId)))
    .limit(1)
  if (!gruppe) throw new ModifikatorError(404, 'Gruppe nicht gefunden')

  await db.insert(modifikatoren).values({
    mandantId,
    gruppeId,
    name:            input.name,
    aufschlagCent:   input.aufschlagCent,
    reihenfolge:     input.reihenfolge,
    lagerstandMenge: input.lagerstandMenge ?? null,
  })

  const [result] = await fetchGruppenMitModifikatoren(mandantId, db, { gruppenIds: [gruppeId] })
  if (!result) throw new ModifikatorError(500, 'Gruppe nach Insert nicht gefunden')
  return result
}

export async function aktualisiereModifikator(
  modId: string,
  input: ModifikatorAktualisieren,
  mandantId: string,
  db: Db,
): Promise<ModifikatorGruppe> {
  const [existing] = await db
    .select({ id: modifikatoren.id, gruppeId: modifikatoren.gruppeId })
    .from(modifikatoren)
    .where(and(eq(modifikatoren.id, modId), eq(modifikatoren.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new ModifikatorError(404, 'Modifikator nicht gefunden')

  const updates: Partial<typeof modifikatoren.$inferInsert> = {}
  if (input.name            !== undefined) updates.name            = input.name
  if (input.aufschlagCent   !== undefined) updates.aufschlagCent   = input.aufschlagCent
  if (input.reihenfolge     !== undefined) updates.reihenfolge     = input.reihenfolge
  if (input.aktiv           !== undefined) updates.aktiv           = input.aktiv
  if (input.lagerstandMenge !== undefined) updates.lagerstandMenge = input.lagerstandMenge

  if (Object.keys(updates).length > 0) {
    await db.update(modifikatoren).set(updates).where(eq(modifikatoren.id, modId))
  }

  const [result] = await fetchGruppenMitModifikatoren(mandantId, db, { gruppenIds: [existing.gruppeId] })
  if (!result) throw new ModifikatorError(500, 'Gruppe nach Update nicht gefunden')
  return result
}

export async function loescheModifikator(modId: string, mandantId: string, db: Db): Promise<void> {
  const [existing] = await db
    .select({ id: modifikatoren.id })
    .from(modifikatoren)
    .where(and(eq(modifikatoren.id, modId), eq(modifikatoren.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new ModifikatorError(404, 'Modifikator nicht gefunden')
  await db.delete(modifikatoren).where(eq(modifikatoren.id, modId))
}

// ---------------------------------------------------------------------------
// Artikel ↔ Gruppen-Zuweisung
// ---------------------------------------------------------------------------

export async function getGruppenFuerArtikel(
  artikelId: string,
  mandantId: string,
  db: Db,
): Promise<ModifikatorGruppe[]> {
  // Artikel-Zugehörigkeit prüfen
  const [art] = await db
    .select({ id: artikel.id })
    .from(artikel)
    .where(and(eq(artikel.id, artikelId), eq(artikel.mandantId, mandantId)))
    .limit(1)
  if (!art) throw new ModifikatorError(404, 'Artikel nicht gefunden')

  const zuweisungen = await db
    .select({ gruppeId: artikelModifikatorGruppen.gruppeId })
    .from(artikelModifikatorGruppen)
    .where(eq(artikelModifikatorGruppen.artikelId, artikelId))
    .orderBy(asc(artikelModifikatorGruppen.reihenfolge))

  if (zuweisungen.length === 0) return []
  const gruppenIds = zuweisungen.map(z => z.gruppeId)
  return fetchGruppenMitModifikatoren(mandantId, db, { gruppenIds })
}

/**
 * Gibt alle Artikel-Gruppe-Zuweisungen als flache Liste zurück.
 * Frontend baut daraus Map<artikelId, ModifikatorGruppe[]>.
 */
export async function listeArtikelGruppenZuweisungen(
  mandantId: string,
  db: Db,
): Promise<{ artikelId: string; gruppeId: string; reihenfolge: number }[]> {
  // Wir joinen nur über mandant — doppelter Check (artikel + gruppe) nicht nötig da FKs bestehen
  const rows = await db
    .select({
      artikelId:   artikelModifikatorGruppen.artikelId,
      gruppeId:    artikelModifikatorGruppen.gruppeId,
      reihenfolge: artikelModifikatorGruppen.reihenfolge,
    })
    .from(artikelModifikatorGruppen)
    .innerJoin(artikel, eq(artikelModifikatorGruppen.artikelId, artikel.id))
    .where(eq(artikel.mandantId, mandantId))
    .orderBy(asc(artikelModifikatorGruppen.reihenfolge))

  return rows
}

export async function setzeGruppenFuerArtikel(
  artikelId: string,
  input: ArtikelGruppenZuweisung,
  mandantId: string,
  db: Db,
): Promise<ModifikatorGruppe[]> {
  const [art] = await db
    .select({ id: artikel.id })
    .from(artikel)
    .where(and(eq(artikel.id, artikelId), eq(artikel.mandantId, mandantId)))
    .limit(1)
  if (!art) throw new ModifikatorError(404, 'Artikel nicht gefunden')

  // Alle vorhandenen löschen und neu einfügen (Replace-all-Strategie)
  await db.delete(artikelModifikatorGruppen).where(eq(artikelModifikatorGruppen.artikelId, artikelId))

  if (input.gruppenIds.length > 0) {
    await db.insert(artikelModifikatorGruppen).values(
      input.gruppenIds.map((gruppeId, idx) => ({ artikelId, gruppeId, reihenfolge: idx }))
    )
  }

  return getGruppenFuerArtikel(artikelId, mandantId, db)
}
