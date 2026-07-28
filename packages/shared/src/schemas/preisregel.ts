import { z } from 'zod'

// ---------------------------------------------------------------------------
// Preisregeln — zeitgesteuerte Aktionen („Aktionen", früher Happy Hour)
//
// Eine Regel greift, wenn JETZT innerhalb eines ihrer Zeitfenster liegt UND der
// Tag passt (Wochentag ODER konkretes Datum) UND — falls gesetzt — innerhalb des
// Aktionszeitraums (gueltigVon..gueltigBis). Optional nur für bestimmte
// Warengruppen und/oder Einzel-Artikel. Wochentage: 1 = Montag … 7 = Sonntag.
//
// Zwei Arten der Preissenkung, kombinierbar:
//   • rabattProzent  — prozentualer Abschlag auf den Basispreis
//   • artikelPreise  — fixer AKTIONSPREIS je Artikel (z. B. „alle Pizzen 7,50")
// Der fixe Preis ist die speziellere Angabe und schlägt den Prozentsatz.
// ---------------------------------------------------------------------------

export const WochentagSchema = z.number().int().min(1).max(7)

export const WOCHENTAG_LABELS: Record<number, string> = {
  1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 7: 'So',
}

const ZeitSchema  = z.string().regex(/^\d{2}:\d{2}$/, 'Uhrzeit im Format HH:MM')
const DatumSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format YYYY-MM-DD')

export const ZeitfensterSchema = z.object({ von: ZeitSchema, bis: ZeitSchema })
export type Zeitfenster = z.infer<typeof ZeitfensterSchema>

/** Fixer Aktionspreis für genau einen Artikel */
export const ArtikelPreisSchema = z.object({
  artikelId: z.string().uuid(),
  preisCent: z.number().int().nonnegative(),
})
export type ArtikelPreis = z.infer<typeof ArtikelPreisSchema>

const PreisregelBaseSchema = z.object({
  name:          z.string().trim().min(1).max(80),
  aktiv:         z.boolean().default(true),
  /** Wochentage (leer erlaubt, wenn stattdessen konkrete Datumstage gesetzt sind) */
  wochentage:    z.array(WochentagSchema).max(7).default([]),
  /** Konkrete Kalendertage (YYYY-MM-DD), z. B. Feiertage/Events */
  datumTage:     z.array(DatumSchema).max(60).default([]),
  /** Ein oder mehrere Zeitfenster am Tag */
  zeitfenster:   z.array(ZeitfensterSchema).min(1, 'Mindestens ein Zeitfenster').max(10),
  /** Aktionszeitraum (optional): Regel gilt nur zwischen diesen Daten (inklusive) */
  gueltigVon:    DatumSchema.nullable().default(null),
  gueltigBis:    DatumSchema.nullable().default(null),
  /** Prozentualer Abschlag; 0 = kein Prozentrabatt (dann müssen Aktionspreise gesetzt sein) */
  rabattProzent: z.number().int().min(0).max(100),
  /** Fixe Aktionspreise je Artikel — schlagen den Prozentsatz */
  artikelPreise: z.array(ArtikelPreisSchema).max(500).default([]),
  /** Betroffene Warengruppen (leer = keine Einschränkung über Warengruppen) */
  kategorieIds:  z.array(z.string().uuid()).max(200).default([]),
  /** Betroffene Einzel-Artikel (leer = keine Einschränkung über Artikel).
   *  kategorieIds UND artikelIds leer = gilt für ALLE Artikel. */
  artikelIds:    z.array(z.string().uuid()).max(500).default([]),
})

export const PreisregelInputSchema = PreisregelBaseSchema
  .refine(
    d => d.wochentage.length > 0 || d.datumTage.length > 0,
    { message: 'Mindestens ein Wochentag oder ein konkretes Datum erforderlich', path: ['wochentage'] },
  )
  .refine(
    d => d.rabattProzent > 0 || d.artikelPreise.length > 0,
    { message: 'Entweder einen Prozent-Rabatt oder mindestens einen Aktionspreis angeben', path: ['rabattProzent'] },
  )
export type PreisregelInput = z.infer<typeof PreisregelInputSchema>

export const PreisregelUpdateSchema = PreisregelBaseSchema.partial()
export type PreisregelUpdate = z.infer<typeof PreisregelUpdateSchema>

export const PreisregelSchema = z.object({
  id:            z.string().uuid(),
  name:          z.string(),
  aktiv:         z.boolean(),
  wochentage:    z.array(WochentagSchema),
  datumTage:     z.array(z.string()),
  zeitfenster:   z.array(ZeitfensterSchema),
  gueltigVon:    z.string().nullable(),
  gueltigBis:    z.string().nullable(),
  rabattProzent: z.number().int(),
  artikelPreise: z.array(ArtikelPreisSchema),
  kategorieIds:  z.array(z.string().uuid()),
  artikelIds:    z.array(z.string().uuid()),
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

/** Liegt `jetzt` in mindestens einem der Zeitfenster? */
export function imAnyZeitfenster(zeitfenster: Zeitfenster[], jetzt: Date): boolean {
  return zeitfenster.some(zf => imZeitfenster(zf.von, zf.bis, jetzt))
}

/** ISO-Wochentag 1=Mo..7=So aus einem Date. */
export function isoWochentag(jetzt: Date): number {
  return jetzt.getDay() === 0 ? 7 : jetzt.getDay()
}

/** Lokales Datum als "YYYY-MM-DD". */
export function datumISO(jetzt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${jetzt.getFullYear()}-${p(jetzt.getMonth() + 1)}-${p(jetzt.getDate())}`
}

/**
 * Gilt die Regel für einen Artikel (mit seiner Kategorie) zum Zeitpunkt `jetzt`?
 * Tag passt, wenn der Wochentag ODER das konkrete Datum passt. Aktionszeitraum
 * (falls gesetzt) begrenzt zusätzlich. Geltungsbereich: sind Warengruppen und
 * Artikel leer, gilt die Regel für ALLE Artikel; sonst muss Artikel ODER
 * Warengruppe passen.
 */
export function regelGiltJetzt(
  regel: Preisregel,
  artikelId: string,
  kategorieId: string | null,
  jetzt: Date,
): boolean {
  if (!regel.aktiv) return false

  // Aktionszeitraum (String-Vergleich funktioniert für YYYY-MM-DD)
  const heute = datumISO(jetzt)
  if (regel.gueltigVon && heute < regel.gueltigVon) return false
  if (regel.gueltigBis && heute > regel.gueltigBis) return false

  // Tag: Wochentag ODER konkretes Datum
  const tagPasst = regel.wochentage.includes(isoWochentag(jetzt)) || regel.datumTage.includes(heute)
  if (!tagPasst) return false

  // Zeit: irgendein Zeitfenster
  if (!imAnyZeitfenster(regel.zeitfenster, jetzt)) return false

  // Geltungsbereich Artikel/Warengruppe
  const hatScope = regel.kategorieIds.length > 0 || regel.artikelIds.length > 0
  if (hatScope) {
    const artikelMatch   = regel.artikelIds.includes(artikelId)
    const kategorieMatch = kategorieId !== null && regel.kategorieIds.includes(kategorieId)
    if (!artikelMatch && !kategorieMatch) return false
  }
  return true
}

/**
 * Höchster gerade gültiger Rabatt-Prozentsatz für einen Artikel (0 = keiner).
 * Bei mehreren passenden Regeln gewinnt der größte Rabatt.
 */
export function aktiverRabattProzent(
  regeln: Preisregel[],
  artikelId: string,
  kategorieId: string | null,
  jetzt: Date = new Date(),
): number {
  let max = 0
  for (const r of regeln) {
    if (regelGiltJetzt(r, artikelId, kategorieId, jetzt) && r.rabattProzent > max) max = r.rabattProzent
  }
  return max
}

/**
 * Niedrigster gerade gültiger FIXER Aktionspreis für einen Artikel
 * (null = keine Regel setzt einen festen Preis).
 */
export function aktiverFixpreisCent(
  regeln: Preisregel[],
  artikelId: string,
  kategorieId: string | null,
  jetzt: Date = new Date(),
): number | null {
  let min: number | null = null
  for (const r of regeln) {
    if (!regelGiltJetzt(r, artikelId, kategorieId, jetzt)) continue
    const treffer = (r.artikelPreise ?? []).find(p => p.artikelId === artikelId)
    if (treffer && (min === null || treffer.preisCent < min)) min = treffer.preisCent
  }
  return min
}

/** Was gilt gerade für diesen Artikel? (für Badges an der Kasse) */
export type AktiveAktion =
  | { typ: 'fix';     preisCent: number }
  | { typ: 'prozent'; prozent: number }
  | null

export function aktiveAktion(
  regeln: Preisregel[],
  artikelId: string,
  kategorieId: string | null,
  jetzt: Date = new Date(),
): AktiveAktion {
  // Fixpreis ist die speziellere Angabe und gewinnt gegen den Prozentsatz
  const fix = aktiverFixpreisCent(regeln, artikelId, kategorieId, jetzt)
  if (fix !== null) return { typ: 'fix', preisCent: fix }
  const prozent = aktiverRabattProzent(regeln, artikelId, kategorieId, jetzt)
  return prozent > 0 ? { typ: 'prozent', prozent } : null
}

/**
 * Aktuell gültiger Verkaufspreis eines Artikels: fixer Aktionspreis, sonst
 * Prozent-Abschlag auf den Basispreis (kaufmännisch gerundet), sonst Basispreis.
 */
export function aktionsPreisCent(
  basisPreisCent: number,
  regeln: Preisregel[],
  artikelId: string,
  kategorieId: string | null,
  jetzt: Date = new Date(),
): number {
  const aktion = aktiveAktion(regeln, artikelId, kategorieId, jetzt)
  if (aktion === null)        return basisPreisCent
  if (aktion.typ === 'fix')   return aktion.preisCent
  return Math.round(basisPreisCent * (100 - aktion.prozent) / 100)
}

/** @deprecated Alter Name aus der „Happy Hour"-Zeit — nutze aktionsPreisCent. */
export const happyHourPreisCent = aktionsPreisCent
