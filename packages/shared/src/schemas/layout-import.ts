import { z } from 'zod'
import { HexFarbeSchema, KATEGORIE_MAX_TIEFE } from './kategorie.js'
import { StationSchema } from './station.js'

// ---------------------------------------------------------------------------
// Layout-Import (z. B. aus der alten Asello-Kasse): Gruppenbaum, Raster-Slots,
// Farben und Favoriten als JSON — wird per POST /artikel/layout-import angewendet.
// ---------------------------------------------------------------------------

/** Optionsgruppe eines Artikels (Asello: „Variante" / „Optionen") samt Optionen. */
export const LayoutOptionsgruppeSchema = z.object({
  gruppe:  z.string().trim().min(1).max(100),
  /** true → Pflichtgruppe (typ 'pflicht'), sonst optional */
  pflicht: z.boolean().default(false),
  /** true → beliebig viele Optionen (maxAuswahl null), sonst genau eine (maxAuswahl 1) */
  mehrfach: z.boolean().default(false),
  optionen: z.array(z.object({
    name:          z.string().trim().min(1).max(100),
    /** Aufschlag in Cent, kann negativ sein („Ohne Soda") */
    aufschlagCent: z.number().int().default(0),
  })).min(1).max(100),
})
export type LayoutOptionsgruppe = z.infer<typeof LayoutOptionsgruppeSchema>

export const LayoutArtikelSchema = z.object({
  name:        z.string().trim().min(1).max(200),
  nr:          z.string().nullable().optional(),
  /** Cent; negativ erlaubt (Pfand-Rückgabe) */
  preisCent:   z.number().int(),
  /** Steuersatz als Anteil: 0.2 / 0.1 / 0.13 / 0.19 / 0 */
  mwst:        z.number().min(0).max(1),
  /** Eigene Farbe als #rrggbb; null = erbt die Farbe der Gruppe */
  farbe:       HexFarbeSchema.nullable().optional(),
  /** Position im Raster der Gruppe (1..n); fehlende Nummern = leere Felder */
  slot:        z.number().int().positive().max(999),
  individuell: z.boolean().optional(),
  variante:    z.string().nullable().optional(),
  optionen:    z.array(LayoutOptionsgruppeSchema).max(50).default([]),
})
export type LayoutArtikel = z.infer<typeof LayoutArtikelSchema>

export interface LayoutGruppe {
  name:          string
  pfad?:         string | undefined
  farbe:         string
  farbeGesetzt?: boolean | undefined
  /** KDS-Station der Gruppe (null/fehlend = von den bisherigen Gruppen der Artikel erben) */
  station?:      z.infer<typeof StationSchema> | null | undefined
  reihenfolge?:  number | undefined
  artikel:       LayoutArtikel[]
  untergruppen:  LayoutGruppe[]
}

export const LayoutGruppeSchema: z.ZodType<LayoutGruppe, z.ZodTypeDef, unknown> = z.lazy(() => z.object({
  name:          z.string().trim().min(1).max(80),
  pfad:          z.string().optional(),
  farbe:         HexFarbeSchema,
  farbeGesetzt:  z.boolean().optional(),
  station:       StationSchema.nullable().optional(),
  reihenfolge:   z.number().int().optional(),
  artikel:       z.array(LayoutArtikelSchema).max(2000).default([]),
  untergruppen:  z.array(LayoutGruppeSchema).max(500).default([]),
}))

/** Tiefe des Gruppenbaums (1 = nur Hauptgruppen) und Anzahl aller Gruppen/Artikel. */
export function layoutGroesse(gruppen: readonly LayoutGruppe[]): { tiefe: number; gruppen: number; artikel: number } {
  let tiefe = 0, anzahlGruppen = 0, anzahlArtikel = 0
  const rein = (gs: readonly LayoutGruppe[], ebene: number) => {
    for (const g of gs) {
      tiefe = Math.max(tiefe, ebene)
      anzahlGruppen++
      anzahlArtikel += g.artikel.length
      rein(g.untergruppen, ebene + 1)
    }
  }
  rein(gruppen, 1)
  return { tiefe, gruppen: anzahlGruppen, artikel: anzahlArtikel }
}

export const LayoutFavoritSchema = z.object({
  name: z.string().trim().min(1).max(200),
  pfad: z.string().max(500),
})
export type LayoutFavorit = z.infer<typeof LayoutFavoritSchema>

export const LayoutImportSchema = z.object({
  quelle:    z.string().optional(),
  /** Spalten des Kassen-Rasters (Asello: 3) */
  spalten:   z.number().int().min(2).max(6).optional(),
  gruppen:   z.array(LayoutGruppeSchema).min(1).max(500),
  favoriten: z.array(LayoutFavoritSchema).max(200).default([]),
}).superRefine((layout, ctx) => {
  const g = layoutGroesse(layout.gruppen)
  if (g.tiefe > KATEGORIE_MAX_TIEFE) {
    ctx.addIssue({ code: 'custom', message: `Gruppen sind maximal ${KATEGORIE_MAX_TIEFE} Ebenen tief erlaubt (gefunden: ${g.tiefe})` })
  }
  if (g.gruppen > 2000 || g.artikel > 10000) {
    ctx.addIssue({ code: 'custom', message: 'Layout zu groß (max. 2000 Gruppen / 10000 Artikel)' })
  }
})
export type LayoutImport = z.infer<typeof LayoutImportSchema>

// ---------------------------------------------------------------------------
// Bericht
// ---------------------------------------------------------------------------

export interface LayoutBericht {
  dryRun: boolean
  /** Lesbare Zusammenfassung in Stichpunkten (deutsch) */
  zusammenfassung: string[]
  zaehler: {
    gruppen: {
      imLayout: number
      /** Bestehende Kassa-Gruppe wiederverwendet */
      gefunden: number
      /** Neu angelegt */
      neu: number
      /** Davon geändert (Elterngruppe, Farbe oder Reihenfolge) */
      geaendert: number
      /** Davon mit neuer Elterngruppe */
      umgehaengt: number
    }
    artikel: {
      imLayout: number
      zugeordnet: number
      neu: number
      mehrdeutig: number
      nichtGefundenNichtAngelegt: number
      /** Zugeordnete Artikel, bei denen sich Gruppe/Farbe/Slot/Reihenfolge ändert */
      geaendert: number
    }
    favoriten: {
      gesetzt: number
      nichtAufgeloest: number
      /** Bisherige Favoriten, die es nicht mehr sind */
      entfernt: number
      /** Gelöschte Kassen-eigene Favoritenlisten-Zeilen (kasse_favoriten) */
      kassenFavoritenGeloescht: number
    }
    kassen: { rasterAufSpaltenGesetzt: number }
    optionen: {
      /** Neu angelegte Optionsgruppen (inhaltsgleiche nur einmal) */
      gruppenNeu: number
      gruppenWiederverwendet: number
      zuordnungenNeu: number
      /** Optionsgruppen im Layout, die wegen mehrdeutiger/nicht angelegter Artikel entfallen */
      uebersprungen: number
    }
  }
  /** Nur bei katalogLoeschen: was vorher gelöscht wird (bzw. im dryRun würde) */
  katalogLoeschen: {
    aktiv: boolean
    geloescht: {
      artikel: number; gruppen: number; optionsgruppen: number
      seriennummern: number; inventurPositionen: number
      sichtbarkeiten: number; kassenFavoriten: number; preisregelnBereinigt: number
    }
    /** Nur deaktiviert statt gelöscht, weil laufende Vorgänge daran hängen */
    nurDeaktiviert: { artikel: { name: string; grund: string }[]; gruppen: { name: string; grund: string }[] }
  }
  probleme: {
    mehrdeutig: { name: string; pfad: string; kandidaten: { id: string; gruppe: string }[] }[]
    nichtGefunden: { name: string; pfad: string; grund?: string }[]
    doppelteSlots: { name: string; pfad: string; slot: number }[]
    favoritenNichtAufgeloest: { name: string; pfad: string; grund: string }[]
    /** Kassa-Gruppen ohne Gegenstück im Layout (bleiben unverändert, evtl. aufräumen) */
    nichtZugeordneteKassaGruppen: { id: string; name: string; artikel: number }[]
  }
}

/** Optionen des Imports (Abfrageparameter) */
export interface LayoutImportOptionen {
  dryRun:            boolean
  fehlendeAnlegen:   boolean
  /** artikel_pro_zeile aller Kassen des Mandanten auf `spalten` setzen */
  spaltenSetzen:     boolean
  /**
   * „Sauberer Neustart": vorher ALLE Artikel, Warengruppen und Optionsgruppen des Mandanten
   * LÖSCHEN (nicht rückgängig; Belege/DEP bleiben), Kassen-Sichtbarkeitslisten und Kassen-Favoriten leeren —
   * danach wird alles neu angelegt (Altbestand wird NICHT wiederverwendet, auch nicht bei Wiederholung).
   * Artikel mit laufenden Vorgängen (offener Tisch, offene Inventur …) werden nur deaktiviert.
   */
  katalogLoeschen:     boolean
}
