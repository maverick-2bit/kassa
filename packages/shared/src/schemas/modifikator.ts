import { z } from 'zod'

// ---------------------------------------------------------------------------
// Modifikator-Gruppe (z. B. "Größe", "Sauce", "Extras")
// ---------------------------------------------------------------------------

export const ModifikatorGruppeTypSchema = z.enum(['pflicht', 'optional'])
export type ModifikatorGruppeTyp = z.infer<typeof ModifikatorGruppeTypSchema>

export const ModifikatorSchema = z.object({
  id:              z.string().guid(),
  gruppeId:        z.string().guid(),
  name:            z.string(),
  aufschlagCent:   z.number().int(),
  reihenfolge:     z.number().int(),
  aktiv:           z.boolean(),
  /** Lagerstand dieser Variante (null = kein Countdown) */
  lagerstandMenge: z.number().int().nonnegative().nullable(),
  createdAt:       z.string(),
})
export type Modifikator = z.infer<typeof ModifikatorSchema>

export const ModifikatorGruppeSchema = z.object({
  id:          z.string().guid(),
  mandantId:   z.string().guid(),
  name:        z.string(),
  typ:         ModifikatorGruppeTypSchema,
  maxAuswahl:  z.number().int().nullable(),
  /** true = jede gewählte Option (samt Anzahl) wird eine eigene Position (z. B. 3 Spritzer statt 1 mit 3 Optionen) */
  jeAuswahlArtikel: z.boolean(),
  reihenfolge: z.number().int(),
  aktiv:       z.boolean(),
  modifikatoren: z.array(ModifikatorSchema),
  createdAt:   z.string(),
  updatedAt:   z.string(),
})
export type ModifikatorGruppe = z.infer<typeof ModifikatorGruppeSchema>

// ---------------------------------------------------------------------------
// Input-Schemas
// ---------------------------------------------------------------------------

export const ModifikatorGruppeErstellenSchema = z.object({
  name:        z.string().trim().min(1).max(100),
  typ:         ModifikatorGruppeTypSchema.default('optional'),
  maxAuswahl:  z.number().int().positive().nullable().default(null),
  jeAuswahlArtikel: z.boolean().optional(),
  reihenfolge: z.number().int().nonnegative().default(0),
})
export type ModifikatorGruppeErstellen = z.infer<typeof ModifikatorGruppeErstellenSchema>

export const ModifikatorGruppeAktualisierenSchema = z.object({
  name:        z.string().trim().min(1).max(100).optional(),
  typ:         ModifikatorGruppeTypSchema.optional(),
  maxAuswahl:  z.number().int().positive().nullable().optional(),
  jeAuswahlArtikel: z.boolean().optional(),
  reihenfolge: z.number().int().nonnegative().optional(),
  aktiv:       z.boolean().optional(),
})
export type ModifikatorGruppeAktualisieren = z.infer<typeof ModifikatorGruppeAktualisierenSchema>

export const ModifikatorErstellenSchema = z.object({
  name:            z.string().trim().min(1).max(100),
  aufschlagCent:   z.number().int().default(0),
  reihenfolge:     z.number().int().nonnegative().default(0),
  lagerstandMenge: z.number().int().nonnegative().nullable().default(null),
})
export type ModifikatorErstellen = z.infer<typeof ModifikatorErstellenSchema>

export const ModifikatorAktualisierenSchema = z.object({
  name:            z.string().trim().min(1).max(100).optional(),
  aufschlagCent:   z.number().int().optional(),
  reihenfolge:     z.number().int().nonnegative().optional(),
  aktiv:           z.boolean().optional(),
  lagerstandMenge: z.number().int().nonnegative().nullable().optional(),
})
export type ModifikatorAktualisieren = z.infer<typeof ModifikatorAktualisierenSchema>

// ---------------------------------------------------------------------------
// Artikel ↔ Gruppen-Zuweisung
// ---------------------------------------------------------------------------

export const ArtikelGruppenZuweisungSchema = z.object({
  gruppenIds: z.array(z.string().guid()),
})
export type ArtikelGruppenZuweisung = z.infer<typeof ArtikelGruppenZuweisungSchema>

// ---------------------------------------------------------------------------
// Auswahl (was der Gast tatsächlich gewählt hat — in TabPosition gespeichert)
// ---------------------------------------------------------------------------

export const ModifikatorAuswahlSchema = z.object({
  modifikatorId:  z.string().guid(),
  gruppeId:       z.string().guid(),
  gruppeName:     z.string(),
  name:           z.string(),
  aufschlagCent:  z.number().int(),
  /** Anzahl dieser Option — Standard 1 wenn nicht gesetzt */
  menge:          z.number().int().positive().optional(),
})
export type ModifikatorAuswahl = z.infer<typeof ModifikatorAuswahlSchema>

// ---------------------------------------------------------------------------
// Bepreiste Varianten auflösen (siehe bepreiste-varianten.ts)
//
// Pro Artikel + Optionsgruppe wird je Option entschieden: `anlegen` macht einen eigenen Artikel daraus
// („Bier 0,5l" für 5,00), `verwerfen` übernimmt sie nicht. Sind danach alle bepreisten Optionen der Gruppe
// erledigt, wird die Gruppe von diesem Artikel gelöst — an anderen Artikeln bleibt sie unberührt.
// ---------------------------------------------------------------------------

export const VariantenAufloesenSchema = z.object({
  gruppeId:  z.string().guid(),
  anlegen:   z.array(z.string().guid()).max(200).default([]),
  verwerfen: z.array(z.string().guid()).max(200).default([]),
}).refine(
  d => d.anlegen.length + d.verwerfen.length > 0,
  { message: 'Mindestens eine Option angeben' },
)
export type VariantenAufloesen = z.infer<typeof VariantenAufloesenSchema>

export interface VariantenAufloesenErgebnis {
  /** Neu entstandene Artikel */
  angelegt: { modifikatorId: string; artikelId: string; bezeichnung: string; preisBruttoCent: number }[]
  /** Nicht angelegt, weil es den Artikel in der Warengruppe schon gibt (gilt trotzdem als erledigt) */
  uebersprungen: { modifikatorId: string; bezeichnung: string; grund: string }[]
  /** Anzahl verworfener Varianten */
  verworfen: number
  /** Die Gruppe wurde von diesem Artikel gelöst (alle bepreisten Optionen erledigt) */
  gruppeGeloest: boolean
  /** Der Ursprungsartikel wurde deaktiviert (Basispreis 0,00 und alles aufgelöst) */
  ursprungDeaktiviert: boolean
}

/** Eine schon getroffene Entscheidung — damit die Übersicht offene von erledigten Varianten trennt. */
export interface VarianteErledigt {
  artikelId:     string
  modifikatorId: string
  art:           'angelegt' | 'verworfen'
  artikelNeuId:  string | null
}

// ---------------------------------------------------------------------------
// Excel-Import: Optionsgruppen samt Optionen und Artikel-Zuordnung
// ---------------------------------------------------------------------------

export const OptionenImportEintragSchema = z.object({
  /** Artikelbezeichnung — Zuordnung über Name (+ Warengruppe), ohne Groß/klein */
  artikel:     z.string().trim().min(1).max(200),
  /** Warengruppe zur Unterscheidung gleichnamiger Artikel (leer = nur über den Namen) */
  warengruppe: z.string().trim().max(100).default(''),
  gruppe:      z.string().trim().min(1).max(100),
  typ:         ModifikatorGruppeTypSchema.default('optional'),
  maxAuswahl:  z.number().int().positive().nullable().default(null),
  optionen:    z.array(z.object({
    name:          z.string().trim().min(1).max(100),
    aufschlagCent: z.number().int().default(0),
  })).min(1).max(100),
})
export type OptionenImportEintrag = z.infer<typeof OptionenImportEintragSchema>

export const OptionenImportSchema = z.object({
  eintraege: z.array(OptionenImportEintragSchema).min(1).max(1000),
})
export type OptionenImport = z.infer<typeof OptionenImportSchema>

export interface OptionenImportErgebnis {
  gruppenNeu:             number
  gruppenWiederverwendet: number
  zuweisungenNeu:         number
  /** Einträge, deren Artikel nicht (eindeutig) gefunden wurde — Index bezieht sich auf `eintraege` */
  fehler: { index: number; artikel: string; warengruppe: string; fehler: string }[]
}
