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
  bestellungId:     z.string().guid(),
  provider:         z.string(),
  gesamtbetragCent: z.number().int(),
  positionen:       z.number().int(),
})
export type NeueBestellungEvent = z.infer<typeof NeueBestellungEventSchema>

export const LagerstandWarnungEventSchema = z.object({
  typ:            z.literal('lagerstand_warnung'),
  artikelId:      z.string().guid(),
  bezeichnung:    z.string(),
  menge:          z.number().int(),
  mindestbestand: z.number().int(),
  /** true wenn Bestand = 0 (ausverkauft) */
  ausverkauft:    z.boolean(),
})
export type LagerstandWarnungEvent = z.infer<typeof LagerstandWarnungEventSchema>

export const KdsNachrichtEventSchema = z.object({
  typ:     z.literal('kds_nachricht'),
  text:    z.string().min(1).max(500),
  station: z.string(),
  /** ISO-8601-Timestamp */
  zeit:    z.string(),
  /**
   * Gezielte Empfänger-Kassen (UUIDs).
   * Leer = Broadcast an alle Kassen des Mandanten.
   */
  kasseIds: z.array(z.string().guid()).default([]),
})
export type KdsNachrichtEvent = z.infer<typeof KdsNachrichtEventSchema>

export const GastBestellungEventSchema = z.object({
  typ:              z.literal('neue_gastbestellung'),
  kasseId:          z.string().guid(),
  tischNummer:      z.string(),
  anzahlPositionen: z.number().int(),
  gesamtbetragCent: z.number().int(),
})
export type GastBestellungEvent = z.infer<typeof GastBestellungEventSchema>

export const NeueReservierungEventSchema = z.object({
  typ:            z.literal('neue_reservierung'),
  reservierungId: z.string().guid(),
  kasseId:        z.string().guid(),
  datum:          z.string(),
  zeitVon:        z.string(),
  name:           z.string(),
})
export type NeueReservierungEvent = z.infer<typeof NeueReservierungEventSchema>

export const ZahlungAngefordertEventSchema = z.object({
  typ:         z.literal('zahlung_angefordert'),
  kasseId:     z.string().guid(),
  tischNummer: z.string(),
  tabId:       z.string().guid(),
  summeCent:   z.number().int(),
})
export type ZahlungAngefordertEvent = z.infer<typeof ZahlungAngefordertEventSchema>

export const SbBestellungEventSchema = z.object({
  typ:              z.literal('neue_sb_bestellung'),
  bestellungId:     z.string().guid(),
  kasseId:          z.string().guid(),
  bestellNummer:    z.number().int(),
  anzahlPositionen: z.number().int(),
  summeCent:        z.number().int(),
})
export type SbBestellungEvent = z.infer<typeof SbBestellungEventSchema>

/**
 * Die Liste offener Bon-Probleme einer Kasse hat sich geändert (neue Meldung, „Nochmal senden“, „Verstanden“).
 * Nur ein Anstoß zum Neuladen: maßgeblich ist GET /api/kassen/:id/bon-probleme — ein verpasstes Ereignis
 * (Kasse war zu) geht deshalb nichts verloren. Betrifft nur die genannte Kasse.
 */
export const BonProblemeEventSchema = z.object({
  typ:     z.literal('bon_probleme'),
  kasseId: z.string().guid(),
})
export type BonProblemeEvent = z.infer<typeof BonProblemeEventSchema>

export const KasseEventSchema = z.discriminatedUnion('typ', [
  BonierbonEventSchema,
  NeueBestellungEventSchema,
  LagerstandWarnungEventSchema,
  KdsNachrichtEventSchema,
  GastBestellungEventSchema,
  NeueReservierungEventSchema,
  ZahlungAngefordertEventSchema,
  SbBestellungEventSchema,
  BonProblemeEventSchema,
])
export type KasseEvent = z.infer<typeof KasseEventSchema>
