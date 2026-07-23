import { z } from 'zod'

/** offen = zählbar/änderbar; abgeschlossen = gebucht, schreibgeschützt */
export const InventurStatusEnum = z.enum(['offen', 'abgeschlossen'])
export type InventurStatus = z.infer<typeof InventurStatusEnum>

/** Anlage einer neuen Inventur (Bezeichnung optional → serverseitig „Inventur <Datum>"). */
export const InventurAnlageSchema = z.object({
  bezeichnung: z.string().trim().min(1).max(120).optional(),
})
export type InventurAnlage = z.infer<typeof InventurAnlageSchema>

/** Bulk-Erfassung gezählter Mengen. istMenge = null → wieder als „ungezählt" markieren. */
export const InventurZaehlSchema = z.object({
  positionen: z.array(z.object({
    artikelId: z.string().uuid(),
    istMenge:  z.number().int().min(0).max(1_000_000).nullable(),
  })).min(1).max(5000),
})
export type InventurZaehl = z.infer<typeof InventurZaehlSchema>
