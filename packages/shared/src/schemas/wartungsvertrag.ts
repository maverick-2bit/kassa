import { z } from 'zod'
import { MwStSatzSchema } from './artikel.js'
import { KundeSnapshotSchema } from './kunde.js'

// ---------------------------------------------------------------------------
// Intervalle
// ---------------------------------------------------------------------------

export const WartungsIntervallSchema = z.enum(['monatlich', 'quartal', 'halbjahr', 'jahr'])
export type  WartungsIntervall = z.infer<typeof WartungsIntervallSchema>

export const WARTUNGS_INTERVALL_LABELS: Record<WartungsIntervall, string> = {
  monatlich: 'Monatlich',
  quartal:   'Vierteljährlich',
  halbjahr:  'Halbjährlich',
  jahr:      'Jährlich',
}

export const WARTUNGS_INTERVALL_MONATE: Record<WartungsIntervall, number> = {
  monatlich: 1,
  quartal:   3,
  halbjahr:  6,
  jahr:      12,
}

export const WartungsvertragStatusSchema = z.enum(['aktiv', 'beendet'])
export type  WartungsvertragStatus = z.infer<typeof WartungsvertragStatusSchema>

export const WARTUNGSVERTRAG_STATUS_LABELS: Record<WartungsvertragStatus, string> = {
  aktiv:    'Aktiv',
  beendet:  'Beendet',
}

// ---------------------------------------------------------------------------
// Perioden-Rechnung (Monat = "YYYY-MM") — rein, ohne Zeitzone/Datum-Objekte
// ---------------------------------------------------------------------------

export function monatsIndex(periode: string): number {
  const [j, m] = periode.split('-').map(Number) as [number, number]
  return j * 12 + (m - 1)
}

export function periodeVonIndex(index: number): string {
  const j = Math.floor(index / 12)
  const m = (index % 12) + 1
  return `${j}-${String(m).padStart(2, '0')}`
}

export function addMonate(periode: string, n: number): string {
  return periodeVonIndex(monatsIndex(periode) + n)
}

/** Erste abzurechnende Periode: der Monat nach dem Beginn — der Startmonat zählt nie, egal an welchem Tag. */
export function ersteVertragsperiode(beginn: string): string {
  return addMonate(beginn.slice(0, 7), 1)
}

/** Letzte abzurechnende Periode: der Endmonat zählt immer, auch wenn er nur angefangen ist. */
export function letzteVertragsperiode(ende: string): string {
  return ende.slice(0, 7)
}

/** Alle Perioden von der ersten bis `bisPeriode` — begrenzt durch die letzte Vertragsperiode. */
export function vertragsPerioden(beginn: string, ende: string | null | undefined, bisPeriode: string): string[] {
  const erste = ersteVertragsperiode(beginn)
  const endePeriode = ende ? letzteVertragsperiode(ende) : undefined
  const letzte = endePeriode && endePeriode < bisPeriode ? endePeriode : bisPeriode
  const ergebnis: string[] = []
  for (let i = monatsIndex(erste); i <= monatsIndex(letzte); i++) ergebnis.push(periodeVonIndex(i))
  return ergebnis
}

/**
 * Ist die Position in dieser Periode fällig? Der Anker-Monat (1–12) legt fest, in welchem
 * Monat des Jahres z. B. das jährliche Zertifikat berechnet wird; ohne Anker gilt der Monat
 * der ersten Vertragsperiode.
 */
export function positionFaellig(
  pos:          { intervall: WartungsIntervall; ankerMonat?: number | null | undefined },
  periode:      string,
  erstePeriode: string,
): boolean {
  const anker   = pos.ankerMonat ?? Number(erstePeriode.slice(5, 7))
  const monat   = Number(periode.slice(5, 7))
  const abstand = (((monat - anker) % 12) + 12) % 12
  return abstand % WARTUNGS_INTERVALL_MONATE[pos.intervall] === 0
}

/**
 * Schließt diese Periode einen Rechnungsblock ab? Die Blöcke zählen ab der ersten
 * Vertragsperiode (bei „quartal" also Monat 3, 6, 9, …). Mit dem Lieferschein des
 * letzten Monats im Block wird die Sammelrechnung fällig.
 */
export function rechnungFaellig(
  rechnungsIntervall: WartungsIntervall,
  periode:            string,
  erstePeriode:       string,
): boolean {
  const seit = monatsIndex(periode) - monatsIndex(erstePeriode)
  return seit >= 0 && (seit + 1) % WARTUNGS_INTERVALL_MONATE[rechnungsIntervall] === 0
}

/**
 * Letzter Monat des Rechnungsblocks, in dem diese Periode liegt — ab hier ist der
 * Lieferschein dieser Periode verrechenbar.
 */
export function rechnungsBlockEnde(
  rechnungsIntervall: WartungsIntervall,
  periode:            string,
  erstePeriode:       string,
): string {
  const n    = WARTUNGS_INTERVALL_MONATE[rechnungsIntervall]
  const seit = Math.max(0, monatsIndex(periode) - monatsIndex(erstePeriode))
  return addMonate(erstePeriode, (Math.floor(seit / n) + 1) * n - 1)
}

// ---------------------------------------------------------------------------
// Positionen
// ---------------------------------------------------------------------------

export const WartungsPositionInputSchema = z.object({
  artikelId:          z.string().guid().optional(),
  bezeichnung:        z.string().trim().min(1).max(200),
  menge:              z.number().int().min(1).max(9999).default(1),
  einzelpreisBreutto: z.number().int(),
  mwstSatz:           MwStSatzSchema,
  intervall:          WartungsIntervallSchema.default('monatlich'),
  /** Monat des Jahres (1–12), in dem die Position fällig wird; leer = Monat des Vertragsbeginns */
  ankerMonat:         z.number().int().min(1).max(12).optional(),
})
export type WartungsPositionInput = z.infer<typeof WartungsPositionInputSchema>

export const WartungsPositionResponseSchema = WartungsPositionInputSchema.extend({
  id:         z.string().guid(),
  menge:      z.number().int(),
  intervall:  WartungsIntervallSchema,
})
export type WartungsPositionResponse = z.infer<typeof WartungsPositionResponseSchema>

// ---------------------------------------------------------------------------
// Vertrag
// ---------------------------------------------------------------------------

const Datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const WartungsvertragInputSchema = z.object({
  kasseId:            z.string().guid(),
  kundeId:            z.string().guid(),
  bezeichnung:        z.string().trim().min(1).max(200),
  beginn:             Datum,
  ende:               Datum.optional(),
  rechnungsIntervall: WartungsIntervallSchema.default('monatlich'),
  status:             WartungsvertragStatusSchema.default('aktiv'),
  notiz:              z.string().trim().max(2000).optional(),
  positionen:         z.array(WartungsPositionInputSchema).min(1, 'Mindestens eine Position erforderlich').max(100),
}).refine(d => !d.ende || d.ende >= d.beginn, { message: 'Das Ende liegt vor dem Beginn', path: ['ende'] })
export type WartungsvertragInput = z.infer<typeof WartungsvertragInputSchema>

export const WartungsvertragUpdateSchema = z.object({
  kundeId:            z.string().guid().optional(),
  bezeichnung:        z.string().trim().min(1).max(200).optional(),
  beginn:             Datum.optional(),
  /** null = unbefristet */
  ende:               Datum.nullable().optional(),
  rechnungsIntervall: WartungsIntervallSchema.optional(),
  status:             WartungsvertragStatusSchema.optional(),
  notiz:              z.string().trim().max(2000).nullable().optional(),
  positionen:         z.array(WartungsPositionInputSchema).min(1).max(100).optional(),
})
export type WartungsvertragUpdate = z.infer<typeof WartungsvertragUpdateSchema>

export const WartungsvertragResponseSchema = z.object({
  id:                 z.string().guid(),
  nummer:             z.number().int(),
  kasseId:            z.string().guid(),
  kundeId:            z.string().guid(),
  kunde:              KundeSnapshotSchema.optional(),
  bezeichnung:        z.string(),
  beginn:             Datum,
  ende:               Datum.optional(),
  rechnungsIntervall: WartungsIntervallSchema,
  status:             WartungsvertragStatusSchema,
  notiz:              z.string().optional(),
  positionen:         z.array(WartungsPositionResponseSchema),
  /** Letzte Periode, für die ein Lieferschein erzeugt wurde ("YYYY-MM") */
  letztePeriode:      z.string().optional(),
  /** Anzahl offener (noch nicht verrechneter) Wartungslieferscheine */
  offeneLieferscheine: z.number().int(),
  createdAt:          z.string(),
})
export type WartungsvertragResponse = z.infer<typeof WartungsvertragResponseSchema>

// ---------------------------------------------------------------------------
// Monatslauf + Abrechnung
// ---------------------------------------------------------------------------

export const WartungslaufInputSchema = z.object({
  /** true = nur anzeigen, was erzeugt würde */
  vorschau: z.boolean().default(false),
})
export type WartungslaufInput = z.infer<typeof WartungslaufInputSchema>

export const WartungslaufEintragSchema = z.object({
  vertragId:     z.string().guid(),
  vertragNummer: z.number().int(),
  periode:       z.string(),
  positionen:    z.number().int(),
  betragCent:    z.number().int(),
  lieferscheinNummer: z.number().int().optional(),
})
export type WartungslaufEintrag = z.infer<typeof WartungslaufEintragSchema>

export const WartungslaufResponseSchema = z.object({
  vorschau:   z.boolean(),
  eintraege:  z.array(WartungslaufEintragSchema),
})
export type WartungslaufResponse = z.infer<typeof WartungslaufResponseSchema>

export const WartungRechnungFaelligSchema = z.object({
  vertragId:       z.string().guid(),
  vertragNummer:   z.number().int(),
  bezeichnung:     z.string(),
  kunde:           KundeSnapshotSchema.optional(),
  lieferscheinIds: z.array(z.string().guid()),
  perioden:        z.array(z.string()),
  betragCent:      z.number().int(),
})
export type WartungRechnungFaellig = z.infer<typeof WartungRechnungFaelligSchema>
