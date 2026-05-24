import { z } from 'zod'

export const BonierbonEventSchema = z.object({
  typ:      z.literal('bonierbon'),
  bonNummer: z.string(),
  tisch:    z.string(),
  kellner:  z.string(),
  stationen: z.array(z.object({
    station:     z.string(),
    ip:          z.string(),
    positionen:  z.number().int(),
    erfolgreich: z.boolean(),
    fehler:      z.string().optional(),
  })),
})
export type BonierbonEvent = z.infer<typeof BonierbonEventSchema>

export const KasseEventSchema = BonierbonEventSchema
export type KasseEvent = BonierbonEvent
