import { and, asc, eq, inArray, max } from 'drizzle-orm'
import { kategoriePfadNormalisiert, normalisiereKategoriePfad } from '@kassa/shared'
import type {
  ModifikatorGruppe,
  ModifikatorGruppeErstellen,
  ModifikatorGruppeAktualisieren,
  ModifikatorErstellen,
  ModifikatorAktualisieren,
  ArtikelGruppenZuweisung,
  OptionenImport,
  OptionenImportErgebnis,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  artikel,
  artikelModifikatorGruppen,
  kategorien,
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

// ---------------------------------------------------------------------------
// Excel-Import
// ---------------------------------------------------------------------------

const klein = (s: string) => s.trim().toLocaleLowerCase('de')

/** Inhaltsschlüssel einer Gruppe: gleiche Gruppen werden nur einmal angelegt. */
function gruppenSchluessel(g: {
  name: string; typ: string; maxAuswahl: number | null
  optionen: { name: string; aufschlagCent: number }[]
}): string {
  return JSON.stringify([
    klein(g.name), g.typ, g.maxAuswahl,
    g.optionen.map(o => [klein(o.name), o.aufschlagCent]),
  ])
}

/** Schlüssel (Inhalt) → ID der vorhandenen aktiven Optionsgruppen eines Mandanten. */
export interface OptionenKontext {
  vorhandene:      Map<string, string>
  wiederverwendet: Set<string>
}

export async function ladeOptionenKontext(tx: Db | Parameters<Parameters<Db['transaction']>[0]>[0], mandantId: string): Promise<OptionenKontext> {
  const vorhandene = new Map<string, string>()
  for (const g of await fetchGruppenMitModifikatoren(mandantId, tx as unknown as Db)) {
    if (!g.aktiv) continue
    const aktiveOptionen = g.modifikatoren.filter(m => m.aktiv)
    vorhandene.set(gruppenSchluessel({ ...g, optionen: aktiveOptionen }), g.id)
  }
  return { vorhandene, wiederverwendet: new Set() }
}

/** Inhaltsschlüssel einer Optionsgruppe (für die Vorab-Zählung im Layout-Import). */
export { gruppenSchluessel as optionsgruppenSchluessel }

/**
 * Legt die Optionsgruppe an (oder nimmt eine inhaltsgleiche aktive wieder) und hängt sie an
 * den Artikel; vorhandene Zuordnungen bleiben. Gemeinsamer Kern von Excel- und Layout-Import.
 */
export async function ordneOptionsgruppeZu(
  tx: Db | Parameters<Parameters<Db['transaction']>[0]>[0],
  mandantId: string,
  kontext: OptionenKontext,
  artikelId: string,
  e: { name: string; typ: 'pflicht' | 'optional'; maxAuswahl: number | null; optionen: { name: string; aufschlagCent: number }[] },
  zaehler: { gruppenNeu: number; gruppenWiederverwendet: number; zuweisungenNeu: number },
): Promise<void> {
  const schluessel = gruppenSchluessel(e)
  let gruppeId = kontext.vorhandene.get(schluessel)
  if (gruppeId) {
    if (!kontext.wiederverwendet.has(gruppeId)) { kontext.wiederverwendet.add(gruppeId); zaehler.gruppenWiederverwendet++ }
  } else {
    const [g] = await tx.insert(modifikatorGruppen)
      .values({ mandantId, name: e.name, typ: e.typ, maxAuswahl: e.maxAuswahl })
      .returning({ id: modifikatorGruppen.id })
    gruppeId = g!.id
    await tx.insert(modifikatoren).values(e.optionen.map((o, i) => ({
      mandantId, gruppeId: gruppeId!, name: o.name, aufschlagCent: o.aufschlagCent, reihenfolge: i,
    })))
    kontext.vorhandene.set(schluessel, gruppeId)
    // In dieser Sitzung neu angelegt → spätere Einträge zählen nicht als „wiederverwendet"
    kontext.wiederverwendet.add(gruppeId)
    zaehler.gruppenNeu++
  }

  const [letzte] = await tx
    .select({ max: max(artikelModifikatorGruppen.reihenfolge) })
    .from(artikelModifikatorGruppen)
    .where(eq(artikelModifikatorGruppen.artikelId, artikelId))
  const neu = await tx.insert(artikelModifikatorGruppen)
    .values({ artikelId, gruppeId, reihenfolge: (letzte?.max ?? -1) + 1 })
    .onConflictDoNothing()
    .returning({ artikelId: artikelModifikatorGruppen.artikelId })
  zaehler.zuweisungenNeu += neu.length
}

/**
 * Legt Optionsgruppen samt Optionen an und hängt sie an die genannten Artikel.
 *
 * - Artikel werden über Bezeichnung (+ Warengruppe, falls angegeben) gefunden,
 *   nur aktive Artikel des Mandanten. Nicht oder mehrdeutig gefundene Einträge
 *   landen in `fehler` und blockieren die anderen nicht.
 * - Inhaltsgleiche Gruppen (Name, Typ, Max, Optionen in Reihenfolge) werden
 *   wiederverwendet — auch bereits vorhandene aktive Gruppen. Ein zweiter
 *   Import derselben Datei legt daher nichts doppelt an.
 * - Zuordnungen werden ergänzt, bestehende bleiben erhalten.
 * Alles in einer Transaktion: ein unerwarteter Fehler hinterlässt keine halben Gruppen.
 */
export async function importiereOptionen(
  input: OptionenImport,
  mandantId: string,
  db: Db,
): Promise<OptionenImportErgebnis> {
  return db.transaction(async (tx) => {
    const artikelRows = await tx
      .select({ id: artikel.id, bezeichnung: artikel.bezeichnung, kategorieId: artikel.kategorieId })
      .from(artikel)
      .where(and(eq(artikel.mandantId, mandantId), eq(artikel.aktiv, true)))
    // Warengruppen samt Elterngruppe: mehrere Gruppen dürfen gleich heißen (z. B. „Alkoholfrei" unter
    // verschiedenen Eltern) — dann trennt nur der Pfad („Atriumbar/Alkoholfrei") die Artikel
    const gruppen = await tx
      .select({ id: kategorien.id, name: kategorien.name, parentId: kategorien.parentId })
      .from(kategorien)
      .where(eq(kategorien.mandantId, mandantId))
    const gruppeVon = new Map(gruppen.map(g => [g.id, g] as const))

    const nachName = new Map<string, { id: string; kategorie: string; pfad: string }[]>()
    for (const a of artikelRows) {
      const k = klein(a.bezeichnung)
      const liste = nachName.get(k) ?? []
      const gruppe = a.kategorieId ? gruppeVon.get(a.kategorieId) : undefined
      liste.push({
        id: a.id,
        kategorie: klein(gruppe?.name ?? ''),
        pfad: gruppe ? kategoriePfadNormalisiert(gruppen, gruppe.id) : '',
      })
      nachName.set(k, liste)
    }

    const kontext = await ladeOptionenKontext(tx, mandantId)

    const ergebnis: OptionenImportErgebnis = {
      gruppenNeu: 0, gruppenWiederverwendet: 0, zuweisungenNeu: 0, fehler: [],
    }

    for (const [index, e] of input.eintraege.entries()) {
      const wgName = klein(e.warengruppe)
      const wgPfad = normalisiereKategoriePfad(e.warengruppe)
      const kandidaten = (nachName.get(klein(e.artikel)) ?? [])
        .filter(a => !e.warengruppe || a.kategorie === wgName || a.pfad === wgPfad)
      const fehler = (text: string) =>
        ergebnis.fehler.push({ index, artikel: e.artikel, warengruppe: e.warengruppe, fehler: text })
      if (kandidaten.length === 0) {
        fehler(e.warengruppe ? 'Artikel in dieser Warengruppe nicht gefunden' : 'Artikel nicht gefunden')
        continue
      }
      if (kandidaten.length > 1) {
        fehler(e.warengruppe
          ? `Artikel ${kandidaten.length}× in gleichnamigen Warengruppen — bitte den Pfad angeben, z. B. Atriumbar/Alkoholfrei`
          : `Artikel ${kandidaten.length}× vorhanden — bitte Warengruppe angeben`)
        continue
      }
      await ordneOptionsgruppeZu(tx, mandantId, kontext, kandidaten[0]!.id, { ...e, name: e.gruppe }, ergebnis)
    }

    return ergebnis
  })
}
