import { z } from 'zod'
import { AngebotPositionSchema } from './angebot.js'
import { KundeSnapshotSchema } from './kunde.js'

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const LiferscheinStatusSchema = z.enum(['offen', 'abgeschlossen'])
export type  LiferscheinStatus = z.infer<typeof LiferscheinStatusSchema>

export const LIEFERSCHEIN_STATUS_LABELS: Record<LiferscheinStatus, string> = {
  offen:         'Offen',
  abgeschlossen: 'Abgeschlossen',
}

// ---------------------------------------------------------------------------
// Input / Update
// ---------------------------------------------------------------------------

/** Zuweisung von Seriennummern zu einer Position (Index in angebot.positionen). */
export const SerialZuweisungSchema = z.object({
  positionIndex: z.number().int().nonnegative(),
  seriennummern: z.array(z.string().trim().min(1)).min(1),
})
export type SerialZuweisung = z.infer<typeof SerialZuweisungSchema>

export const LiferscheinInputSchema = z.object({
  angebotId: z.string().guid(),
  notiz:     z.string().trim().max(2000).optional(),
  /** Pro serialisierter Position die gewählten Seriennummern aus dem Pool */
  serialZuweisungen: z.array(SerialZuweisungSchema).optional(),
})
export type LiferscheinInput = z.infer<typeof LiferscheinInputSchema>

export const LiferscheinUpdateSchema = z.object({
  status: LiferscheinStatusSchema.optional(),
  notiz:  z.string().trim().max(2000).optional(),
})
export type LiferscheinUpdate = z.infer<typeof LiferscheinUpdateSchema>

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const LiferscheinResponseSchema = z.object({
  id:            z.string().guid(),
  nummer:        z.number().int(),
  datum:         z.string(),
  status:        LiferscheinStatusSchema,
  /** Bei Wartungslieferscheinen fehlt der Angebotsbezug — dafür gibt es den Vertragsbezug */
  angebotId:     z.string().guid().optional(),
  angebotNummer: z.number().int().optional(),
  wartungsvertragId:     z.string().guid().optional(),
  wartungsvertragNummer: z.number().int().optional(),
  /** Abrechnungsmonat eines Wartungslieferscheins ("YYYY-MM") */
  periode:       z.string().optional(),
  positionen:    z.array(AngebotPositionSchema),
  notiz:         z.string().optional(),
  kunde:         KundeSnapshotSchema.optional(),
  createdAt:     z.string(),
})
export type LiferscheinResponse = z.infer<typeof LiferscheinResponseSchema>

// ---------------------------------------------------------------------------
// Sammelrechnung
// ---------------------------------------------------------------------------

export const SammelrechnungInputSchema = z.object({
  lieferscheinIds: z.array(z.string().guid()).min(1).max(100),
})
export type SammelrechnungInput = z.infer<typeof SammelrechnungInputSchema>

export const SammelrechnungResponseSchema = z.object({
  id:               z.string().guid(),
  nummer:           z.number().int(),
  datum:            z.string(),
  kunde:            KundeSnapshotSchema.optional(),
  lieferscheine:    z.array(LiferscheinResponseSchema),
  gesamtbetragCent: z.number().int(),
  /** Aus einem Wartungsvertrag entstanden */
  wartungsvertragId: z.string().guid().optional(),
  /** Automatischer Mailversand: Ziel, Zustellung, letzter Fehler */
  emailEmpfaenger:  z.string().optional(),
  emailVersandtAm:  z.string().optional(),
  emailFehler:      z.string().optional(),
  /** Ausdruck für die Buchhaltung erledigt */
  buchhaltungGedrucktAm: z.string().optional(),
  /** Wartungsrechnungen: Freigabe durch den Betreiber; erst danach Versand/Druck */
  freigegebenAm:    z.string().optional(),
  /** Storniert: die Rechnung bleibt bestehen, ihre Lieferscheine sind wieder offen */
  storniertAm:      z.string().optional(),
  stornoGrund:      z.string().optional(),
  /** Nummer der Stornorechnung und Stand des Mails an den Kunden */
  stornoNummer:          z.number().int().optional(),
  stornoEmailVersandtAm: z.string().optional(),
  stornoEmailFehler:     z.string().optional(),
  createdAt:        z.string(),
})
export type SammelrechnungResponse = z.infer<typeof SammelrechnungResponseSchema>

export const SammelrechnungFreigabeSchema = z.object({
  ids: z.array(z.string().guid()).min(1).max(200),
})
export type SammelrechnungFreigabe = z.infer<typeof SammelrechnungFreigabeSchema>

export const SammelrechnungFreigabeErgebnisSchema = z.object({
  freigegeben: z.array(SammelrechnungResponseSchema),
  abgelehnt:   z.array(z.object({ id: z.string(), nummer: z.number().int(), grund: z.string() })),
})
export type SammelrechnungFreigabeErgebnis = z.infer<typeof SammelrechnungFreigabeErgebnisSchema>

export const SammelrechnungStornoSchema = z.object({
  grund: z.string().trim().max(500).optional(),
})
export type SammelrechnungStorno = z.infer<typeof SammelrechnungStornoSchema>
