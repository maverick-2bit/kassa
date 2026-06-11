import { z } from 'zod'

// ---------------------------------------------------------------------------
// Mandanten-Module
// ---------------------------------------------------------------------------

export const MandantModulSchema = z.enum(['gastro', 'angebote', 'mergeport', 'reservierungen', 'zeiterfassung'])
export type MandantModul = z.infer<typeof MandantModulSchema>

export const MANDANT_MODUL_LABELS: Record<MandantModul, string> = {
  gastro:         'Gastro & Tischverwaltung',
  angebote:       'Angebote & Lieferscheine',
  mergeport:      'Lieferservice-Integration',
  reservierungen: 'Tischreservierungen',
  zeiterfassung:  'Personalzeiterfassung',
}

export const MANDANT_MODUL_BESCHREIBUNGEN: Record<MandantModul, string> = {
  gastro:
    'Tische, Tisch-Tabs, grafischer Tischplan und Bonierdrucker. ' +
    'Kernmodul für Restaurantbetrieb.',
  angebote:
    'Angebote erstellen, Lieferscheine drucken und Zielrechnungen / ' +
    'Sammelrechnungen stellen.',
  mergeport:
    'Eingehende Bestellungen von Lieferando, Mergeport und eigenen Quellen ' +
    'über Webhooks empfangen und verwalten.',
  reservierungen:
    'Tischreservierungen verwalten — intern anlegen und optional einen ' +
    'öffentlichen Online-Buchungslink für Gäste aktivieren.',
  zeiterfassung:
    'Mitarbeiter stempeln per PIN ein und aus. Schichtübersicht, ' +
    'Stundenauswertung und Monatsexport für die Lohnverrechnung.',
}

export const MandantModuleSchema = z.object({
  modulGastroAktiv:          z.boolean(),
  modulAngeboteAktiv:        z.boolean(),
  modulMergeportAktiv:       z.boolean(),
  modulReservierungenAktiv:  z.boolean(),
  modulZeiterfassungAktiv:   z.boolean(),
})
export type MandantModule = z.infer<typeof MandantModuleSchema>

export const MandantModuleUpdateSchema = MandantModuleSchema.partial()
export type MandantModuleUpdate = z.infer<typeof MandantModuleUpdateSchema>

// ---------------------------------------------------------------------------
// Mandant-Stammdaten (Firmeninfo + Belegtext)
// ---------------------------------------------------------------------------

export const MandantStammdatenSchema = z.object({
  firmenname:               z.string(),
  uid:                      z.string(),
  belegFusstext:            z.string().nullable(),
  belegKopftext:            z.string().nullable(),
  belegZeigeSteuertabelle:  z.boolean(),
  belegZeigeQr:             z.boolean(),
})
export type MandantStammdaten = z.infer<typeof MandantStammdatenSchema>

/** Nur Layout-Felder editierbar; firmenname/uid bleiben RKSV-seitig fixiert */
export const MandantStammdatenUpdateSchema = z.object({
  belegFusstext:           z.string().trim().max(500).nullable().optional(),
  belegKopftext:           z.string().trim().max(300).nullable().optional(),
  belegZeigeSteuertabelle: z.boolean().optional(),
  belegZeigeQr:            z.boolean().optional(),
})
export type MandantStammdatenUpdate = z.infer<typeof MandantStammdatenUpdateSchema>

// ---------------------------------------------------------------------------
// Kassenbezeichnung
// ---------------------------------------------------------------------------

export const KasseBezeichnungUpdateSchema = z.object({
  bezeichnung: z.string().trim().min(1, 'Bezeichnung erforderlich').max(100),
})
export type KasseBezeichnungUpdate = z.infer<typeof KasseBezeichnungUpdateSchema>
