import { z } from 'zod'
import { StationSchema } from './station.js'

// ---------------------------------------------------------------------------
// Farben – vordefinierte Farbschlüssel für Kategorie-Tabs
// ---------------------------------------------------------------------------

export const KategorieFarbeSchema = z.enum([
  'grau', 'rot', 'orange', 'gelb', 'gruen', 'blau', 'lila', 'pink',
  'tuerkis', 'mint', 'limette', 'oliv', 'braun', 'gold', 'koralle',
  'himmelblau', 'marine', 'violett', 'magenta', 'schiefer',
])
export type KategorieFarbe = z.infer<typeof KategorieFarbeSchema>

export const KATEGORIE_FARBE_LABELS: Record<KategorieFarbe, string> = {
  grau:       'Grau',
  rot:        'Rot',
  orange:     'Orange',
  gelb:       'Gelb',
  gruen:      'Grün',
  blau:       'Blau',
  lila:       'Lila',
  pink:       'Pink',
  tuerkis:    'Türkis',
  mint:       'Mint',
  limette:    'Limette',
  oliv:       'Oliv',
  braun:      'Braun',
  gold:       'Gold',
  koralle:    'Koralle',
  himmelblau: 'Himmelblau',
  marine:     'Marine',
  violett:    'Violett',
  magenta:    'Magenta',
  schiefer:   'Schiefer',
}

/**
 * Die EINE Hex-Quelle für alle Oberflächen (POS-Raster, Kellner-App,
 * Formulare, Konfiguration) — vorher lebten je 8 Farben als Tailwind-Klassen
 * verstreut in den Komponenten, was die Palette nicht erweiterbar machte.
 */
export const KATEGORIE_FARBE_HEX: Record<KategorieFarbe, string> = {
  grau:       '#9ca3af',
  rot:        '#ef4444',
  orange:     '#f97316',
  gelb:       '#eab308',
  gruen:      '#22c55e',
  blau:       '#3b82f6',
  lila:       '#a855f7',
  pink:       '#ec4899',
  tuerkis:    '#06b6d4',
  mint:       '#34d399',
  limette:    '#84cc16',
  oliv:       '#4d7c0f',
  braun:      '#92400e',
  gold:       '#d97706',
  koralle:    '#fb7185',
  himmelblau: '#38bdf8',
  marine:     '#1e40af',
  violett:    '#7c3aed',
  magenta:    '#d946ef',
  schiefer:   '#64748b',
}

// ---------------------------------------------------------------------------
// Kategorie
// ---------------------------------------------------------------------------

export const KategorieSchema = z.object({
  id:              z.string().uuid(),
  mandantId:       z.string().uuid(),
  name:            z.string(),
  farbe:           KategorieFarbeSchema,
  reihenfolge:     z.number().int(),
  aktiv:           z.boolean(),
  bonierdruckerId: z.string().uuid().nullable(),
  /** KDS-Stations-Vorgabe für alle Artikel dieser Warengruppe (Artikel können einzeln abweichen) */
  station:         StationSchema.nullable(),
  /** SB-Terminal: Artikel dieser Warengruppe am Bestellterminal anzeigen */
  terminalSichtbar: z.boolean(),
  createdAt:       z.string(),
  updatedAt:       z.string(),
})
export type Kategorie = z.infer<typeof KategorieSchema>

export const KategorieInputSchema = z.object({
  name:            z.string().trim().min(1, 'Name erforderlich').max(80),
  farbe:           KategorieFarbeSchema,
  reihenfolge:     z.number().int().nonnegative().default(0),
  bonierdruckerId: z.string().uuid().optional().nullable(),
  station:         StationSchema.optional().nullable(),
  terminalSichtbar: z.boolean().default(false),
})
export type KategorieInput = z.infer<typeof KategorieInputSchema>

export const KategorieUpdateSchema = z.object({
  name:            z.string().trim().min(1).max(80).optional(),
  farbe:           KategorieFarbeSchema.optional(),
  reihenfolge:     z.number().int().nonnegative().optional(),
  aktiv:           z.boolean().optional(),
  bonierdruckerId: z.string().uuid().nullable().optional(),
  station:         StationSchema.nullable().optional(),
  terminalSichtbar: z.boolean().optional(),
})
export type KategorieUpdate = z.infer<typeof KategorieUpdateSchema>
