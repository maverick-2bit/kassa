import { z } from 'zod'

// ---------------------------------------------------------------------------
// Mandanten-Module
// ---------------------------------------------------------------------------

export const MandantModulSchema = z.enum(['gastro', 'angebote', 'mergeport'])
export type MandantModul = z.infer<typeof MandantModulSchema>

export const MANDANT_MODUL_LABELS: Record<MandantModul, string> = {
  gastro:    'Gastro & Tischverwaltung',
  angebote:  'Angebote & Lieferscheine',
  mergeport: 'Lieferservice-Integration',
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
}

export const MandantModuleSchema = z.object({
  modulGastroAktiv:    z.boolean(),
  modulAngeboteAktiv:  z.boolean(),
  modulMergeportAktiv: z.boolean(),
})
export type MandantModule = z.infer<typeof MandantModuleSchema>

export const MandantModuleUpdateSchema = MandantModuleSchema.partial()
export type MandantModuleUpdate = z.infer<typeof MandantModuleUpdateSchema>
