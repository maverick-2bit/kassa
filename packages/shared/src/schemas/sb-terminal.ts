import { z } from 'zod'

// ---------------------------------------------------------------------------
// SB-Terminal — Selbstbedienungs-Bestellungen (Kiosk + Abholmonitor)
// ---------------------------------------------------------------------------

/**
 * Lebenszyklus einer SB-Bestellung:
 *   zahlung    → am Terminal angelegt, Kartenzahlung läuft
 *   offen      → bezahlt (Beleg signiert), in Zubereitung (Monitor „Bestellt")
 *   bereit     → zur Abholung bereit (Kassa quittiert ODER letzter KDS-Bon erledigt)
 *   abgeholt   → am KDS quittiert, verschwindet vom Monitor
 *   abgebrochen→ Zahlung abgebrochen/fehlgeschlagen, kein Beleg
 */
export const SbBestellungStatusSchema = z.enum(['zahlung', 'offen', 'bereit', 'abgeholt', 'abgebrochen'])
export type SbBestellungStatus = z.infer<typeof SbBestellungStatusSchema>

export const SB_STATUS_LABELS: Record<SbBestellungStatus, string> = {
  zahlung:     'Zahlung läuft',
  offen:       'In Zubereitung',
  bereit:      'Zur Abholung bereit',
  abgeholt:    'Abgeholt',
  abgebrochen: 'Abgebrochen',
}

/** Positions-Snapshot (Preise server-seitig eingefroren) */
export const SbPositionSchema = z.object({
  artikelId:       z.string().uuid(),
  bezeichnung:     z.string(),
  menge:           z.number().int().positive(),
  preisBruttoCent: z.number().int(),
})
export type SbPosition = z.infer<typeof SbPositionSchema>

export const SbBestellungSchema = z.object({
  id:           z.string().uuid(),
  kasseId:      z.string().uuid(),
  /** 4-stellig, täglich ab 1 je Mandant (Anzeige mit führenden Nullen) */
  bestellNummer: z.number().int(),
  datum:        z.string(),
  positionen:   z.array(SbPositionSchema),
  summeCent:    z.number().int(),
  status:       SbBestellungStatusSchema,
  belegId:      z.string().uuid().nullable(),
  erstelltAt:   z.string(),
  bereitAt:     z.string().nullable(),
  abgeholtAt:   z.string().nullable(),
})
export type SbBestellung = z.infer<typeof SbBestellungSchema>

/** Bestellnummer als 4-stellige Anzeige (1 → „0001") */
export function formatSbNummer(nummer: number): string {
  return String(nummer).padStart(4, '0')
}

// ---------------------------------------------------------------------------
// Terminal (öffentliche Kiosk-API)
// ---------------------------------------------------------------------------

export const TerminalBestellungInputSchema = z.object({
  kasseId: z.string().uuid(),
  positionen: z
    .array(z.object({
      artikelId: z.string().uuid(),
      menge:     z.number().int().min(1).max(99),
    }))
    .min(1, 'Mindestens eine Position erforderlich')
    .max(50)
    .refine(
      arr => new Set(arr.map(p => p.artikelId)).size === arr.length,
      { message: 'Doppelte artikelId' },
    ),
})
export type TerminalBestellungInput = z.infer<typeof TerminalBestellungInputSchema>

export const TerminalArtikelSchema = z.object({
  id:              z.string().uuid(),
  bezeichnung:     z.string(),
  preisBruttoCent: z.number().int(),
  kategorieId:     z.string().uuid().nullable(),
  bild:            z.string().nullable(),
})
export type TerminalArtikel = z.infer<typeof TerminalArtikelSchema>

export const TerminalSortimentSchema = z.object({
  kasse: z.object({
    id:          z.string().uuid(),
    bezeichnung: z.string().nullable(),
    firmenname:  z.string(),
  }),
  kategorien: z.array(z.object({
    id:    z.string().uuid(),
    name:  z.string(),
    farbe: z.string(),
  })),
  artikel: z.array(TerminalArtikelSchema),
})
export type TerminalSortiment = z.infer<typeof TerminalSortimentSchema>

/** Antwort auf POST /terminal/bestellung + GET /terminal/bestellung/:id */
export const TerminalBestellungStatusSchema = z.object({
  id:        z.string().uuid(),
  status:    SbBestellungStatusSchema,
  summeCent: z.number().int(),
  /** erst nach erfolgreicher Zahlung gesetzt */
  bestellNummer: z.number().int().nullable(),
  /** true = Kasse hat kein ZVT — Terminal zeigt Demo-Bestätigung */
  demoZahlung: z.boolean(),
  /** ZVT-Zwischenstand während status='zahlung' */
  zahlung: z.object({
    status:  z.string(),
    meldung: z.string().optional(),
  }).nullable(),
})
export type TerminalBestellungStatus = z.infer<typeof TerminalBestellungStatusSchema>

// ---------------------------------------------------------------------------
// Abholmonitor (öffentlicher SSE-Stream)
// ---------------------------------------------------------------------------

/** Monitor zeigt NUR Nummern + Zeiten — keine Positionen/Beträge (öffentlich!) */
export const AbholungEintragSchema = z.object({
  id:            z.string().uuid(),
  bestellNummer: z.number().int(),
  status:        z.enum(['offen', 'bereit']),
  erstelltAt:    z.string(),
  bereitAt:      z.string().nullable(),
})
export type AbholungEintrag = z.infer<typeof AbholungEintragSchema>

export const AbholungEventSchema = z.discriminatedUnion('typ', [
  z.object({ typ: z.literal('snapshot'), bestellungen: z.array(AbholungEintragSchema) }),
  /** offen→bereit (Spaltenwechsel) oder neue Bestellung */
  z.object({ typ: z.literal('update'), bestellung: AbholungEintragSchema }),
  /** abgeholt/storniert → vom Monitor entfernen */
  z.object({ typ: z.literal('entfernt'), bestellungId: z.string().uuid() }),
])
export type AbholungEvent = z.infer<typeof AbholungEventSchema>
