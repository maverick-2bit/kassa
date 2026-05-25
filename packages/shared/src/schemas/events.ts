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

export const NeueBestellungEventSchema = z.object({
  typ:              z.literal('neue_bestellung'),
  bestellungId:     z.string().uuid(),
  provider:         z.string(),
  gesamtbetragCent: z.number().int(),
  positionen:       z.number().int(),
})
export type NeueBestellungEvent = z.infer<typeof NeueBestellungEventSchema>

export const KasseEventSchema = z.discriminatedUnion('typ', [
  BonierbonEventSchema,
  NeueBestellungEventSchema,
])
export type KasseEvent = z.infer<typeof KasseEventSchema>
