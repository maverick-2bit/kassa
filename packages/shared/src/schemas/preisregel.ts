import { z } from 'zod'

// ---------------------------------------------------------------------------
// Preisregeln — zeitgesteuerte Preise (Happy Hour)
//
// Eine Regel senkt den Preis um einen Prozentsatz in bestimmten Zeitfenstern
// an bestimmten Wochentagen, optional nur für bestimmte Warengruppen.
// Wochentage: 1 = Montag … 7 = Sonntag (ISO-8601).
// ---------------------------------------------------------------------------

export const WochentagSchema = z.number().int().min(1).max(7)

export const WOCHENTAG_LABELS: Record<number, string> = {
  1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 7: 'So',
}

const ZeitSchema = z.string().regex(/^\d{2}:\d{2}$/, 'Uhrzeit im Format HH:MM')

export const PreisregelInputSchema = z.object({
  name:          z.string().trim().min(1).max(80),
  aktiv:         z.boolean().default(true),
  wochentage:    z.array(WochentagSchema).min(1, 'Mindestens ein Wochentag').max(7),
  vonZeit:       ZeitSchema,
  bisZeit:       ZeitSchema,
  rabattProzent: z.number().int().min(1).max(100),
  /** Betroffene Warengruppen — leer = alle Artikel */
  kategorieIds:  z.array(z.string().uuid()).max(200).default([]),
})
export type PreisregelInput = z.infer<typeof PreisregelInputSchema>

export const PreisregelUpdateSchema = PreisregelInputSchema.partial()
export type PreisregelUpdate = z.infer<typeof PreisregelUpdateSchema>

export const PreisregelSchema = z.object({
  id:            z.string().uuid(),
  name:          z.string(),
  aktiv:         z.boolean(),
  wochentage:    z.array(WochentagSchema),
  vonZeit:       z.string(),
  bisZeit:       z.string(),
  rabattProzent: z.number().int(),
  kategorieIds:  z.array(z.string().uuid()),
  createdAt:     z.string(),
  updatedAt:     z.string(),
})
export type Preisregel = z.infer<typeof PreisregelSchema>

// ---------------------------------------------------------------------------
// Anwendungslogik (geteilt Frontend ↔ Tests): gilt eine Regel jetzt?
// ---------------------------------------------------------------------------

/** Minuten seit Mitternacht aus "HH:MM". */
function zeitZuMinuten(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

/** Liegt `jetzt` im Zeitfenster [von, bis)? Unterstützt über Mitternacht (von > bis). */
export function imZeitfenster(vonZeit: string, bisZeit: string, jetzt: Date): boolean {
  const t   = jetzt.getHours() * 60 + jetzt.getMinutes()
  const von = zeitZuMinuten(vonZeit)
  const bis = zeitZuMinuten(bisZeit)
  return von <= bis ? (t >= von && t < bis) : (t >= von || t < bis)
}

/** ISO-Wochentag 1=Mo..7=So aus einem Date. */
export function isoWochentag(jetzt: Date): number {
  return jetzt.getDay() === 0 ? 7 : jetzt.getDay()
}

/** Gilt die Regel für die Kategorie zum Zeitpunkt `jetzt`? */
export function regelGiltJetzt(regel: Preisregel, kategorieId: string | null, jetzt: Date): boolean {
  if (!regel.aktiv) return false
  if (!regel.wochentage.includes(isoWochentag(jetzt))) return false
  if (!imZeitfenster(regel.vonZeit, regel.bisZeit, jetzt)) return false
  if (regel.kategorieIds.length > 0) {
    if (!kategorieId || !regel.kategorieIds.includes(kategorieId)) return false
  }
  return true
}

/**
 * Höchster gerade gültiger Rabatt-Prozentsatz für eine Kategorie (0 = keiner).
 * Bei mehreren passenden Regeln gewinnt der größte Rabatt.
 */
export function aktiverRabattProzent(
  regeln: Preisregel[],
  kategorieId: string | null,
  jetzt: Date = new Date(),
): number {
  let max = 0
  for (const r of regeln) {
    if (regelGiltJetzt(r, kategorieId, jetzt) && r.rabattProzent > max) max = r.rabattProzent
  }
  return max
}

/** Wendet den aktuell gültigen Happy-Hour-Rabatt auf einen Basispreis an (kaufmännisch gerundet). */
export function happyHourPreisCent(
  basisPreisCent: number,
  regeln: Preisregel[],
  kategorieId: string | null,
  jetzt: Date = new Date(),
): number {
  const prozent = aktiverRabattProzent(regeln, kategorieId, jetzt)
  if (prozent === 0) return basisPreisCent
  return Math.round(basisPreisCent * (100 - prozent) / 100)
}
