/**
 * Layout-Export: schreibt Warengruppen (mit Untergruppen) samt ihren Artikeln in das Layout-Format, das auch der
 * Layout-Import liest (layout-import.service.ts). So wandern Warengruppen mit Artikeln, Farben, Raster-Plätzen
 * und Optionen von einer Kassa (einem Mandanten) in eine andere: hier exportieren, dort importieren.
 *
 * Aufbau wie beim Import:
 *   baueLayoutExport()   reine Logik (kein DB-Zugriff): Ist-Zustand → Layout + Zusammenfassung + Hinweise
 *   exportiereLayout()   lädt den Zustand EINES Mandanten (mandantId kommt aus dem JWT) und ruft die reine Logik
 *
 * Mitgenommen: Gruppenbaum (Name, Farbe, Reihenfolge, KDS-Station), Artikel (Name, Nummer, Preis, MwSt, Farbe,
 * Raster-Platz, Allergene) und die Optionsgruppen der Artikel (Name, Pflicht, Auswahlgrenze, Optionen mit Aufschlag).
 * NICHT mitgenommen — gehört zum Mandanten bzw. zur Kassa: Bonierdrucker, Lager, Rezepte, Lieferanten, Bilder,
 * Aktionen (Preisregeln), Favoriten, Kassen-Sichtbarkeit; Rohstoffe und deaktivierte Gruppen/Artikel.
 */

import { and, eq } from 'drizzle-orm'
import {
  farbeZuHex, nachkommenIds, StationSchema, wurzelgruppen, untergruppenVon,
  type LayoutArtikel, type LayoutExport, type LayoutGruppe, type LayoutOptionsgruppe,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  artikel, artikelModifikatorGruppen, kategorien, mandanten, modifikatoren, modifikatorGruppen,
} from '../db/schema.js'
import { satzZuMwst, STANDARD_GRUPPENFARBE } from './layout-import.service.js'

// ---------------------------------------------------------------------------
// Ist-Zustand (reine Daten)
// ---------------------------------------------------------------------------

export interface ExportGruppe {
  id: string; name: string; parentId: string | null; farbe: string
  reihenfolge: number; station: string | null; aktiv: boolean
}
export interface ExportArtikel {
  id: string; bezeichnung: string; artikelnummer: string | null; preisBruttoCent: number; mwstSatz: string
  farbe: string | null; kategorieId: string | null; rasterPosition: number | null; reihenfolge: number
  allergene: string | null; aktiv: boolean; istBestandteil: boolean
}
export interface ExportOptionsgruppe {
  id: string; name: string; typ: string; maxAuswahl: number | null
  /** nur aktive Optionen */
  optionen: { name: string; aufschlagCent: number; reihenfolge: number }[]
}
export interface ExportZustand {
  firmenname: string
  gruppen: ExportGruppe[]
  artikel: ExportArtikel[]
  /** nur aktive Optionsgruppen */
  optionsgruppen: ExportOptionsgruppe[]
  zuordnungen: { artikelId: string; gruppeId: string; reihenfolge: number }[]
}

export interface ExportOptionen {
  /** Auszuwählende Warengruppen (samt Untergruppen); leer/fehlend = alle aktiven */
  kategorieIds?: readonly string[] | undefined
  /** Datum (JJJJ-MM-TT) für die Herkunftsangabe der Datei */
  datum?: string | undefined
}

const MAX_SLOT = 999
const MAX_OPTIONSGRUPPEN_JE_ARTIKEL = 50
const MAX_OPTIONEN_JE_GRUPPE = 100

const kuerze = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)

// ---------------------------------------------------------------------------
// Reine Logik
// ---------------------------------------------------------------------------

export function baueLayoutExport(z: ExportZustand, opts: ExportOptionen = {}): LayoutExport {
  const hinweise: string[] = []
  const aktive = z.gruppen.filter(g => g.aktiv)

  // --- Auswahl: gewählte Gruppen samt aller aktiven Untergruppen ------------------------------------
  const gewaehlt = new Set<string>()
  const alle = !opts.kategorieIds || opts.kategorieIds.length === 0
  if (alle) {
    for (const g of aktive) gewaehlt.add(g.id)
  } else {
    const aktivIds = new Set(aktive.map(g => g.id))
    for (const id of opts.kategorieIds!) {
      if (!aktivIds.has(id)) continue
      gewaehlt.add(id)
      for (const kind of nachkommenIds(aktive, id)) gewaehlt.add(kind)
    }
  }
  const menge = aktive.filter(g => gewaehlt.has(g.id))

  // --- Index ----------------------------------------------------------------------------------------
  const artikelNachGruppe = new Map<string, ExportArtikel[]>()
  let ohneGruppe = 0
  for (const a of z.artikel) {
    if (!a.aktiv || a.istBestandteil) continue
    if (!a.kategorieId) { ohneGruppe++; continue }
    artikelNachGruppe.set(a.kategorieId, [...(artikelNachGruppe.get(a.kategorieId) ?? []), a])
  }
  const optionsgruppeNachId = new Map(z.optionsgruppen.map(g => [g.id, g] as const))
  const zuordnungenNachArtikel = new Map<string, { gruppeId: string; reihenfolge: number }[]>()
  for (const zu of z.zuordnungen) {
    zuordnungenNachArtikel.set(zu.artikelId, [...(zuordnungenNachArtikel.get(zu.artikelId) ?? []), zu])
  }

  const verwendeteOptionsgruppen = new Set<string>()
  let anzahlGruppen = 0, anzahlArtikel = 0
  const ausgelasseneMwst = new Set<string>()
  const gekuerzt = new Set<string>()

  const optionenVon = (a: ExportArtikel): LayoutOptionsgruppe[] => {
    const zu = [...(zuordnungenNachArtikel.get(a.id) ?? [])].sort((x, y) => x.reihenfolge - y.reihenfolge)
    const ergebnis: LayoutOptionsgruppe[] = []
    for (const e of zu) {
      const og = optionsgruppeNachId.get(e.gruppeId)
      if (!og || og.optionen.length === 0) continue                      // inaktiv oder ohne aktive Optionen
      if (ergebnis.length >= MAX_OPTIONSGRUPPEN_JE_ARTIKEL) { gekuerzt.add(`Optionsgruppen von „${a.bezeichnung}"`); break }
      const optionen = [...og.optionen].sort((x, y) => x.reihenfolge - y.reihenfolge)
      if (optionen.length > MAX_OPTIONEN_JE_GRUPPE) gekuerzt.add(`Optionen der Gruppe „${og.name}"`)
      verwendeteOptionsgruppen.add(og.id)
      ergebnis.push({
        gruppe:      kuerze(og.name, 100),
        exakterName: true,
        pflicht:     og.typ === 'pflicht',
        mehrfach:    og.maxAuswahl === null,
        maxAuswahl:  og.maxAuswahl !== null && og.maxAuswahl > 0 ? og.maxAuswahl : null,
        optionen:    optionen.slice(0, MAX_OPTIONEN_JE_GRUPPE).map(o => ({ name: kuerze(o.name, 100), aufschlagCent: o.aufschlagCent })),
      })
    }
    return ergebnis
  }

  /** Artikel einer Gruppe samt Raster-Platz: gesetzte Plätze bleiben, die übrigen füllen die Lücken von vorn. */
  const artikelVon = (gruppeId: string): LayoutArtikel[] => {
    const liste = (artikelNachGruppe.get(gruppeId) ?? []).filter(a => {
      if (satzZuMwst(a.mwstSatz) !== undefined) return true
      ausgelasseneMwst.add(a.bezeichnung)
      return false
    })
    const sortiert = [...liste].sort((a, b) =>
      (a.rasterPosition ?? Number.MAX_SAFE_INTEGER) - (b.rasterPosition ?? Number.MAX_SAFE_INTEGER)
      || a.reihenfolge - b.reihenfolge || a.bezeichnung.localeCompare(b.bezeichnung, 'de'))

    const belegt = new Set<number>()
    const slotVon = new Map<string, number>()
    for (const a of sortiert) {
      const p = a.rasterPosition
      if (p !== null && p >= 1 && p <= MAX_SLOT && !belegt.has(p)) { slotVon.set(a.id, p); belegt.add(p) }
    }
    let frei = 1
    for (const a of sortiert) {
      if (slotVon.has(a.id)) continue
      while (belegt.has(frei)) frei++
      if (frei > MAX_SLOT) continue
      slotVon.set(a.id, frei); belegt.add(frei)
    }

    const ergebnis: LayoutArtikel[] = []
    for (const a of sortiert) {
      const slot = slotVon.get(a.id)
      if (slot === undefined) { gekuerzt.add(`Artikel „${a.bezeichnung}" (mehr als ${MAX_SLOT} Raster-Plätze)`); continue }
      const optionen = optionenVon(a)
      ergebnis.push({
        name:      kuerze(a.bezeichnung.trim(), 200),
        nr:        a.artikelnummer,
        preisCent: a.preisBruttoCent,
        mwst:      satzZuMwst(a.mwstSatz)!,
        farbe:     farbeZuHex(a.farbe) ?? null,
        slot,
        allergene: a.allergene,
        optionen,
      })
    }
    anzahlArtikel += ergebnis.length
    return ergebnis
  }

  const baue = (g: ExportGruppe, position: number): LayoutGruppe => {
    anzahlGruppen++
    const station = StationSchema.safeParse(g.station)
    if (g.name.length > 80) gekuerzt.add(`Gruppenname „${g.name}"`)
    return {
      name:         kuerze(g.name.trim(), 80),
      farbe:        farbeZuHex(g.farbe) ?? STANDARD_GRUPPENFARBE,
      station:      station.success ? station.data : null,
      reihenfolge:  position,
      artikel:      artikelVon(g.id),
      untergruppen: untergruppenVon(menge, g.id).map((kind, i) => baue(kind, i)),
    }
  }
  const gruppen = wurzelgruppen(menge).map((g, i) => baue(g, i))

  // --- Hinweise -------------------------------------------------------------------------------------
  if (ausgelasseneMwst.size > 0) {
    hinweise.push(`${ausgelasseneMwst.size} Artikel mit unbekanntem Steuersatz sind nicht enthalten: ${[...ausgelasseneMwst].slice(0, 5).join(', ')}${ausgelasseneMwst.size > 5 ? ' …' : ''}`)
  }
  if (gekuerzt.size > 0) {
    hinweise.push(`Gekürzt, weil es sonst nicht importierbar wäre: ${[...gekuerzt].slice(0, 5).join('; ')}${gekuerzt.size > 5 ? ' …' : ''}`)
  }
  if (alle && ohneGruppe > 0) {
    hinweise.push(`${ohneGruppe} Artikel ohne Warengruppe sind nicht enthalten (der Import ordnet Artikel über ihre Gruppe zu).`)
  }

  return {
    layout: {
      quelle:    `Kassa-Export ${z.firmenname}${opts.datum ? ` (${opts.datum})` : ''}`,
      gruppen,
      favoriten: [],
    },
    zusammenfassung: { gruppen: anzahlGruppen, artikel: anzahlArtikel, optionsgruppen: verwendeteOptionsgruppen.size },
    hinweise,
  }
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

/** Exportiert den Katalog des Mandanten. `mandantId` kommt IMMER aus dem JWT — nie aus der Anfrage. */
export async function exportiereLayout(db: Db, mandantId: string, opts: ExportOptionen = {}): Promise<LayoutExport> {
  const [mandant] = await db.select({ firmenname: mandanten.firmenname }).from(mandanten).where(eq(mandanten.id, mandantId)).limit(1)
  const gruppen = await db.select({
    id: kategorien.id, name: kategorien.name, parentId: kategorien.parentId, farbe: kategorien.farbe,
    reihenfolge: kategorien.reihenfolge, station: kategorien.station, aktiv: kategorien.aktiv,
  }).from(kategorien).where(eq(kategorien.mandantId, mandantId))
  const artikelRows = await db.select({
    id: artikel.id, bezeichnung: artikel.bezeichnung, artikelnummer: artikel.artikelnummer,
    preisBruttoCent: artikel.preisBruttoCent, mwstSatz: artikel.mwstSatz, farbe: artikel.farbe,
    kategorieId: artikel.kategorieId, rasterPosition: artikel.rasterPosition, reihenfolge: artikel.reihenfolge,
    allergene: artikel.allergene, aktiv: artikel.aktiv, istBestandteil: artikel.istBestandteil,
  }).from(artikel).where(eq(artikel.mandantId, mandantId))
  const ogRows = await db.select().from(modifikatorGruppen)
    .where(and(eq(modifikatorGruppen.mandantId, mandantId), eq(modifikatorGruppen.aktiv, true)))
  const modRows = await db.select().from(modifikatoren)
    .where(and(eq(modifikatoren.mandantId, mandantId), eq(modifikatoren.aktiv, true)))
  const zuordnungen = await db.select({
    artikelId: artikelModifikatorGruppen.artikelId, gruppeId: artikelModifikatorGruppen.gruppeId,
    reihenfolge: artikelModifikatorGruppen.reihenfolge,
  }).from(artikelModifikatorGruppen)
    .innerJoin(artikel, eq(artikelModifikatorGruppen.artikelId, artikel.id))
    .where(eq(artikel.mandantId, mandantId))

  return baueLayoutExport({
    firmenname: mandant?.firmenname ?? 'Kassa',
    gruppen,
    artikel: artikelRows,
    optionsgruppen: ogRows.map(g => ({
      id: g.id, name: g.name, typ: g.typ, maxAuswahl: g.maxAuswahl,
      optionen: modRows.filter(m => m.gruppeId === g.id).map(m => ({ name: m.name, aufschlagCent: m.aufschlagCent, reihenfolge: m.reihenfolge })),
    })),
    zuordnungen,
  }, opts)
}
