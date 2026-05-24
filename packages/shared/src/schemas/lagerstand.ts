import { z } from 'zod'

export const LagerstandEintragSchema = z.object({
  id:    z.string().uuid(),
  menge: z.number().int().nonnegative(),
})
export type LagerstandEintrag = z.infer<typeof LagerstandEintragSchema>

export const LagerstandBulkInputSchema = z.object({
  /** absolut = Bestand auf diesen Wert setzen (Inventur)
   *  wareneingang = Menge zum aktuellen Bestand addieren */
  modus:         z.enum(['absolut', 'wareneingang']),
  artikel:       z.array(LagerstandEintragSchema).default([]),
  modifikatoren: z.array(LagerstandEintragSchema).default([]),
})
export type LagerstandBulkInput = z.infer<typeof LagerstandBulkInputSchema>
