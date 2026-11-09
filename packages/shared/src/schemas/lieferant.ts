import { z } from 'zod'

export const LieferantSchema = z.object({
  id:        z.string().guid(),
  mandantId: z.string().guid(),
  name:      z.string(),
  kontakt:   z.string().nullable(),
  email:     z.string().nullable(),
  telefon:   z.string().nullable(),
  notiz:     z.string().nullable(),
  strasse:   z.string().nullable(),
  plz:       z.string().nullable(),
  ort:       z.string().nullable(),
  land:      z.string().length(2),
  uid:       z.string().nullable(),
  /** Unsere Kundennummer beim Lieferanten */
  kundennummer:      z.string().nullable(),
  zahlungsbedingung: z.string().nullable(),
  lieferzeitTage:    z.number().int().nullable(),
  aktiv:     z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Lieferant = z.infer<typeof LieferantSchema>

export const LieferantInputSchema = z.object({
  name:    z.string().trim().min(1, 'Name erforderlich').max(200),
  kontakt: z.string().max(200).optional().nullable(),
  email:   z.string().email('Ungültige E-Mail').max(200).optional().nullable(),
  telefon: z.string().max(50).optional().nullable(),
  notiz:   z.string().optional().nullable(),
  strasse: z.string().trim().max(200).optional().nullable(),
  plz:     z.string().trim().max(20).optional().nullable(),
  ort:     z.string().trim().max(100).optional().nullable(),
  land:    z.string().trim().toUpperCase().length(2, 'Ländercode mit 2 Buchstaben (z. B. AT)').optional(),
  uid:     z.string().trim().max(30).optional().nullable(),
  kundennummer:      z.string().trim().max(60).optional().nullable(),
  zahlungsbedingung: z.string().trim().max(200).optional().nullable(),
  lieferzeitTage:    z.number().int().min(0).max(365).optional().nullable(),
})
export type LieferantInput = z.infer<typeof LieferantInputSchema>

export const LieferantUpdateSchema = LieferantInputSchema.partial().extend({
  aktiv: z.boolean().optional(),
})
export type LieferantUpdate = z.infer<typeof LieferantUpdateSchema>
