import { z } from 'zod'

// ---------------------------------------------------------------------------
// Modifikator-Gruppe (z. B. "Größe", "Sauce", "Extras")
// ---------------------------------------------------------------------------

export const ModifikatorGruppeTypSchema = z.enum(['pflicht', 'optional'])
export type ModifikatorGruppeTyp = z.infer<typeof ModifikatorGruppeTypSchema>

export const ModifikatorSchema = z.object({
  id:              z.string().uuid(),
  gruppeId:        z.string().uuid(),
  name:            z.string(),
  aufschlagCent:   z.number().int(),
  reihenfolge:     z.number().int(),
  aktiv:           z.boolean(),
  /** Lagerstand dieser Variante (null = kein Countdown) */
  lagerstandMenge: z.number().int().nonnegative().nullable(),
  createdAt:       z.string(),
})
export type Modifikator = z.infer<typeof ModifikatorSchema>

export const ModifikatorGruppeSchema = z.object({
  id:          z.string().uuid(),
  mandantId:   z.string().uuid(),
  name:        z.string(),
  typ:         ModifikatorGruppeTypSchema,
  maxAuswahl:  z.number().int().nullable(),
  reihenfolge: z.number().int(),
  aktiv:       z.boolean(),
  modifikatoren: z.array(ModifikatorSchema),
  createdAt:   z.string(),
  updatedAt:   z.string(),
})
export type ModifikatorGruppe = z.infer<typeof ModifikatorGruppeSchema>

// ---------------------------------------------------------------------------
// Input-Schemas
// ---------------------------------------------------------------------------

export const ModifikatorGruppeErstellenSchema = z.object({
  name:        z.string().trim().min(1).max(100),
  typ:         ModifikatorGruppeTypSchema.default('optional'),
  maxAuswahl:  z.number().int().positive().nullable().default(null),
  reihenfolge: z.number().int().nonnegative().default(0),
})
export type ModifikatorGruppeErstellen = z.infer<typeof ModifikatorGruppeErstellenSchema>

export const ModifikatorGruppeAktualisierenSchema = z.object({
  name:        z.string().trim().min(1).max(100).optional(),
  typ:         ModifikatorGruppeTypSchema.optional(),
  maxAuswahl:  z.number().int().positive().nullable().optional(),
  reihenfolge: z.number().int().nonnegative().optional(),
  aktiv:       z.boolean().optional(),
})
export type ModifikatorGruppeAktualisieren = z.infer<typeof ModifikatorGruppeAktualisierenSchema>

export const ModifikatorErstellenSchema = z.object({
  name:            z.string().trim().min(1).max(100),
  aufschlagCent:   z.number().int().default(0),
  reihenfolge:     z.number().int().nonnegative().default(0),
  lagerstandMenge: z.number().int().nonnegative().nullable().default(null),
})
export type ModifikatorErstellen = z.infer<typeof ModifikatorErstellenSchema>

export const ModifikatorAktualisierenSchema = z.object({
  name:            z.string().trim().min(1).max(100).optional(),
  aufschlagCent:   z.number().int().optional(),
  reihenfolge:     z.number().int().nonnegative().optional(),
  aktiv:           z.boolean().optional(),
  lagerstandMenge: z.number().int().nonnegative().nullable().optional(),
})
export type ModifikatorAktualisieren = z.infer<typeof ModifikatorAktualisierenSchema>

// ---------------------------------------------------------------------------
// Artikel ↔ Gruppen-Zuweisung
// ---------------------------------------------------------------------------

export const ArtikelGruppenZuweisungSchema = z.object({
  gruppenIds: z.array(z.string().uuid()),
})
export type ArtikelGruppenZuweisung = z.infer<typeof ArtikelGruppenZuweisungSchema>

// ---------------------------------------------------------------------------
// Auswahl (was der Gast tatsächlich gewählt hat — in TabPosition gespeichert)
// ---------------------------------------------------------------------------

export const ModifikatorAuswahlSchema = z.object({
  modifikatorId:  z.string().uuid(),
  gruppeId:       z.string().uuid(),
  gruppeName:     z.string(),
  name:           z.string(),
  aufschlagCent:  z.number().int(),
})
export type ModifikatorAuswahl = z.infer<typeof ModifikatorAuswahlSchema>
