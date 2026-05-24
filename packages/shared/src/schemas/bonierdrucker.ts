import { z } from 'zod'

// ---------------------------------------------------------------------------
// Bonierdrucker — ESC/POS-Drucker für Bonierzettel (mandantenweit)
// ---------------------------------------------------------------------------

export const BonierdruckerSchema = z.object({
  id:        z.string().uuid(),
  mandantId: z.string().uuid(),
  name:      z.string(),
  ip:        z.string(),
  port:      z.number().int(),
  istBackup: z.boolean(),
  aktiv:     z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Bonierdrucker = z.infer<typeof BonierdruckerSchema>

export const BonierdruckerInputSchema = z.object({
  name:      z.string().trim().min(1, 'Name erforderlich').max(80),
  ip:        z.string().trim().min(1, 'IP-Adresse erforderlich').max(64),
  port:      z.number().int().min(1).max(65535).default(9100),
  istBackup: z.boolean().default(false),
})
export type BonierdruckerInput = z.infer<typeof BonierdruckerInputSchema>

export const BonierdruckerUpdateSchema = z.object({
  name:      z.string().trim().min(1).max(80).optional(),
  ip:        z.string().trim().min(1).max(64).optional(),
  port:      z.number().int().min(1).max(65535).optional(),
  istBackup: z.boolean().optional(),
  aktiv:     z.boolean().optional(),
})
export type BonierdruckerUpdate = z.infer<typeof BonierdruckerUpdateSchema>

// ---------------------------------------------------------------------------
// POS-Konfiguration pro Kasse
// ---------------------------------------------------------------------------

export const PosKonfigSchema = z.object({
  /** IDs der Kategorien, die in dieser Kasse im POS sichtbar sind */
  sichtbareKategorieIds: z.array(z.string().uuid()),
  /** Erlaubte Zahlungsarten */
  erlaubteZahlungsarten: z.array(z.enum(['bar', 'karte', 'sonstige'])),
})
export type PosKonfig = z.infer<typeof PosKonfigSchema>

export const PosKonfigUpdateSchema = z.object({
  sichtbareKategorieIds: z.array(z.string().uuid()).optional(),
  erlaubteZahlungsarten: z.array(z.enum(['bar', 'karte', 'sonstige'])).optional(),
})
export type PosKonfigUpdate = z.infer<typeof PosKonfigUpdateSchema>

// ---------------------------------------------------------------------------
// Reihenfolge-Update (Bulk)
// ---------------------------------------------------------------------------

export const ReihenfolgeUpdateSchema = z.object({
  /** Array von { id, reihenfolge } — wird als Bulk-Update angewendet */
  eintraege: z.array(z.object({
    id:          z.string().uuid(),
    reihenfolge: z.number().int().nonnegative(),
  })).min(1),
})
export type ReihenfolgeUpdate = z.infer<typeof ReihenfolgeUpdateSchema>

export const FavoritenReihenfolgeUpdateSchema = z.object({
  eintraege: z.array(z.object({
    id:                   z.string().uuid(),
    favoritenReihenfolge: z.number().int().nonnegative(),
  })).min(1),
})
export type FavoritenReihenfolgeUpdate = z.infer<typeof FavoritenReihenfolgeUpdateSchema>
