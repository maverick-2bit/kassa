import { z } from 'zod'

// ---------------------------------------------------------------------------
// Bondrucker-Bibliothek — mandantenweiter Pool von Rechnungs-/Bondruckern.
// Jede Kasse wählt daraus ihren Drucker (kassen.druckerId). Die Inline-Felder
// der Kasse sind der aufgelöste Snapshot; der Druckpfad bleibt unverändert.
// ---------------------------------------------------------------------------

export const DruckerPoolSchema = z.object({
  id:         z.string().uuid(),
  mandantId:  z.string().uuid(),
  name:       z.string(),
  ip:         z.string(),
  port:       z.number().int(),
  /** Zeichen pro Zeile — 32 (58mm) / 42 / 48 (80mm) */
  breite:     z.number().int(),
  /** TCP-Timeout in Sekunden */
  timeoutSek: z.number().int(),
  aktiv:      z.boolean(),
  createdAt:  z.string(),
  updatedAt:  z.string(),
})
export type DruckerPool = z.infer<typeof DruckerPoolSchema>

export const DruckerPoolInputSchema = z.object({
  name:       z.string().trim().min(1, 'Name erforderlich').max(80),
  ip:         z.string().trim().min(1, 'IP-Adresse erforderlich').max(64),
  port:       z.number().int().min(1).max(65535).default(9100),
  breite:     z.number().int().min(20).max(80).default(42),
  timeoutSek: z.number().int().min(1).max(30).default(5),
  aktiv:      z.boolean().default(true),
})
export type DruckerPoolInput = z.infer<typeof DruckerPoolInputSchema>

export const DruckerPoolUpdateSchema = z.object({
  name:       z.string().trim().min(1).max(80).optional(),
  ip:         z.string().trim().min(1).max(64).optional(),
  port:       z.number().int().min(1).max(65535).optional(),
  breite:     z.number().int().min(20).max(80).optional(),
  timeoutSek: z.number().int().min(1).max(30).optional(),
  aktiv:      z.boolean().optional(),
})
export type DruckerPoolUpdate = z.infer<typeof DruckerPoolUpdateSchema>
