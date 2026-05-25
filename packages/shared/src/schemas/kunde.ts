import { z } from 'zod'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lesbarer Anzeigename: "Firma / Vorname Nachname", fallback auf verfügbare Teile */
export function kundeBezeichnung(k: {
  firma?: string | null
  vorname?: string | null
  nachname?: string | null
}): string {
  const name = [k.vorname, k.nachname].filter(Boolean).join(' ')
  if (k.firma && name) return `${k.firma} / ${name}`
  return k.firma ?? name ?? '(Unbekannt)'
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const KundeInputSchema = z.object({
  firma:    z.string().trim().max(200).optional(),
  vorname:  z.string().trim().max(100).optional(),
  nachname: z.string().trim().max(100).optional(),
  email:    z.string().trim().max(200).optional(),
  telefon:  z.string().trim().max(50).optional(),
  strasse:  z.string().trim().max(200).optional(),
  plz:      z.string().trim().max(20).optional(),
  ort:      z.string().trim().max(100).optional(),
  land:         z.string().trim().length(2).default('AT'),
  uid:          z.string().trim().max(30).optional(),
  kreditAktiv:  z.boolean().default(false),
}).refine(d => d.firma || d.nachname, {
  message: 'Firma oder Nachname ist erforderlich',
  path:    ['nachname'],
})
export type KundeInput = z.infer<typeof KundeInputSchema>

export const KundeUpdateSchema = z.object({
  firma:    z.string().trim().max(200).optional(),
  vorname:  z.string().trim().max(100).optional(),
  nachname: z.string().trim().max(100).optional(),
  email:    z.string().trim().max(200).optional(),
  telefon:  z.string().trim().max(50).optional(),
  strasse:  z.string().trim().max(200).optional(),
  plz:      z.string().trim().max(20).optional(),
  ort:      z.string().trim().max(100).optional(),
  land:        z.string().trim().length(2).optional(),
  uid:         z.string().trim().max(30).optional(),
  aktiv:       z.boolean().optional(),
  kreditAktiv: z.boolean().optional(),
})
export type KundeUpdate = z.infer<typeof KundeUpdateSchema>

export const KundeSchema = z.object({
  id:          z.string().uuid(),
  nummer:      z.number().int(),
  bezeichnung: z.string(),
  firma:       z.string().optional(),
  vorname:     z.string().optional(),
  nachname:    z.string().optional(),
  email:       z.string().optional(),
  telefon:     z.string().optional(),
  strasse:     z.string().optional(),
  plz:         z.string().optional(),
  ort:         z.string().optional(),
  land:        z.string(),
  uid:         z.string().optional(),
  aktiv:       z.boolean(),
  kreditAktiv: z.boolean(),
  createdAt:   z.string(),
  updatedAt:   z.string(),
})
export type Kunde = z.infer<typeof KundeSchema>

/** Eingefrierter Snapshot zum Zeitpunkt des Belegs */
export const KundeSnapshotSchema = z.object({
  id:          z.string().uuid(),
  nummer:      z.number().int(),
  bezeichnung: z.string(),
  firma:       z.string().optional(),
  vorname:     z.string().optional(),
  nachname:    z.string().optional(),
  email:       z.string().optional(),
  telefon:     z.string().optional(),
  strasse:     z.string().optional(),
  plz:         z.string().optional(),
  ort:         z.string().optional(),
  land:        z.string().optional(),
  uid:         z.string().optional(),
  kreditAktiv: z.boolean().optional(),
})
export type KundeSnapshot = z.infer<typeof KundeSnapshotSchema>

/** Kompakte Beleg-Zusammenfassung für die Rechnungshistorie eines Kunden */
export const KundeBelegVorschauSchema = z.object({
  id:               z.string().uuid(),
  belegNummer:      z.number().int(),
  belegDatum:       z.string(),
  belegTyp:         z.string(),
  gesamtbetragCent: z.number().int(),
  summeBarCent:     z.number().int(),
  summeKarteCent:   z.number().int(),
})
export type KundeBelegVorschau = z.infer<typeof KundeBelegVorschauSchema>

export const KundeSuchfilterSchema = z.object({
  suche: z.string().trim().max(200).optional(),
  nurAktive: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(50),
})
export type KundeSuchfilter = z.infer<typeof KundeSuchfilterSchema>
