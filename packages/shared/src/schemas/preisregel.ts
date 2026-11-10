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
//
// Dritte Art, NICHT kombinierbar mit den beiden anderen: Mengenaktion „X zum Preis von Y"
// (mengeKauf/mengeZahle/mengeModus). Sie wirkt als Rabattzeile im Warenkorb (siehe mengenRabattZeilen).
//
// Wiederholung: wiederkehrende Aktionen (Wochentage) können nach `wiederholungen` Aktionstagen enden. Gespeichert
// wird das berechnete Enddatum in gueltigBis (endeNachAktionstagen) — die Prüfung „gilt jetzt?" kennt nur Daten.
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
  artikelId: z.string().guid(),
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
  kategorieIds:  z.array(z.string().guid()).max(200).default([]),
  /** Betroffene Einzel-Artikel (leer = keine Einschränkung über Artikel).
   *  kategorieIds UND artikelIds leer = gilt für ALLE Artikel. */
  artikelIds:    z.array(z.string().guid()).max(500).default([]),
  /** Mengenaktion „kaufe X, zahle Y" (alle drei gesetzt oder alle null). Y < X. */
  mengeKauf:     z.number().int().min(2).max(20).nullable().default(null),
  mengeZahle:    z.number().int().min(1).max(19).nullable().default(null),
  /** Zählweise: je gleichem Artikel | über die ganze Auswahl (günstigster je X-er-Gruppe gratis) */
  mengeModus:    z.enum(['artikel', 'auswahl']).nullable().default(null),
  /** Ende nach so vielen Aktionstagen (nur mit Startdatum + Wochentagen); setzt gueltigBis */
  wiederholungen: z.number().int().min(1).max(500).nullable().default(null),
})

/** Teil der Regel, den die Querprüfungen brauchen (Anlegen und Ändern im Backend, Eingabe-Schema) */
export type PreisregelPruefung = Pick<z.infer<typeof PreisregelBaseSchema>,
  'wochentage' | 'datumTage' | 'rabattProzent' | 'artikelPreise' | 'mengeKauf' | 'mengeZahle' | 'mengeModus'
  | 'wiederholungen' | 'gueltigVon' | 'gueltigBis'>

/** Fachliche Querprüfung einer vollständigen Regel; liefert die Fehlermeldung oder null. */
export function preisregelFehler(d: PreisregelPruefung): string | null {
  if (d.wochentage.length === 0 && d.datumTage.length === 0) {
    return 'Mindestens ein Wochentag oder ein konkretes Datum erforderlich'
  }
  const mengenFelder = [d.mengeKauf, d.mengeZahle, d.mengeModus].filter(x => x !== null).length
  if (mengenFelder !== 0 && mengenFelder !== 3) {
    return 'Mengenaktion: „kaufe", „zahle" und die Zählweise müssen zusammen angegeben werden'
  }
  if (mengenFelder === 3) {
    if (d.mengeZahle! >= d.mengeKauf!) return 'Mengenaktion: „zahle" muss kleiner sein als „kaufe" (z. B. 3 für 2)'
    if (d.rabattProzent > 0 || d.artikelPreise.length > 0) {
      return 'Eine Mengenaktion kann nicht zugleich einen Prozent-Rabatt oder Aktionspreise haben — bitte eine eigene Aktion anlegen'
    }
  } else if (d.rabattProzent <= 0 && d.artikelPreise.length === 0) {
    return 'Entweder einen Prozent-Rabatt oder mindestens einen Aktionspreis angeben'
  }
  if (d.wiederholungen !== null) {
    if (d.wochentage.length === 0) return 'Wiederholungen gibt es nur bei Aktionen mit Wochentagen'
    if (!d.gueltigVon) return 'Für „nach X Aktionstagen" braucht die Aktion ein Startdatum („Aktion ab")'
  }
  if (d.gueltigVon && d.gueltigBis && d.gueltigBis < d.gueltigVon) {
    return '„Aktion bis" liegt vor „Aktion ab"'
  }
  return null
}

export const PreisregelInputSchema = PreisregelBaseSchema
  .superRefine((d, ctx) => {
    const f = preisregelFehler(d)
    if (f) ctx.addIssue({ code: 'custom', message: f, path: ['wochentage'] })
  })
export type PreisregelInput = z.infer<typeof PreisregelInputSchema>

export const PreisregelUpdateSchema = PreisregelBaseSchema.partial()
export type PreisregelUpdate = z.infer<typeof PreisregelUpdateSchema>

export const PreisregelSchema = z.object({
  id:            z.string().guid(),
  name:          z.string(),
  aktiv:         z.boolean(),
  wochentage:    z.array(WochentagSchema),
  datumTage:     z.array(z.string()),
  zeitfenster:   z.array(ZeitfensterSchema),
  gueltigVon:    z.string().nullable(),
  gueltigBis:    z.string().nullable(),
  rabattProzent: z.number().int(),
  artikelPreise: z.array(ArtikelPreisSchema),
  kategorieIds:  z.array(z.string().guid()),
  artikelIds:    z.array(z.string().guid()),
  mengeKauf:     z.number().int().nullable(),
  mengeZahle:    z.number().int().nullable(),
  mengeModus:    z.enum(['artikel', 'auswahl']).nullable(),
  wiederholungen: z.number().int().nullable(),
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
  // Negativpreise (Pfand-Rückgabe) werden nie durch Aktionen verändert
  if (basisPreisCent < 0)     return basisPreisCent
  const aktion = aktiveAktion(regeln, artikelId, kategorieId, jetzt)
  if (aktion === null)        return basisPreisCent
  if (aktion.typ === 'fix')   return aktion.preisCent
  return Math.round(basisPreisCent * (100 - aktion.prozent) / 100)
}

/** @deprecated Alter Name aus der „Happy Hour"-Zeit — nutze aktionsPreisCent. */
export const happyHourPreisCent = aktionsPreisCent

// ---------------------------------------------------------------------------
// Wiederholung: Enddatum aus „nach X Aktionstagen"
// ---------------------------------------------------------------------------

const TAG_MS = 24 * 60 * 60 * 1000

function istoZuUtc(iso: string): number {
  const [j, m, t] = iso.split('-').map(Number)
  return Date.UTC(j!, m! - 1, t!)
}
function utcZuIso(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}
function wochentagIso(ms: number): number {
  const w = new Date(ms).getUTCDay()
  return w === 0 ? 7 : w
}

/**
 * Datum des `anzahl`-ten Aktionstags ab `start` (einschließlich): jeder Tag, dessen Wochentag in `wochentage`
 * liegt, ist ein Aktionstag. Beispiel: Montags, 4 → der vierte Montag ab dem Startdatum. Rechnet auf
 * Kalendertagen (keine Zeitzonen-/Sommerzeit-Effekte). null bei leeren Wochentagen oder anzahl < 1.
 */
export function endeNachAktionstagen(start: string, wochentage: number[], anzahl: number): string | null {
  if (wochentage.length === 0 || anzahl < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null
  const tage = new Set(wochentage)
  let gezaehlt = 0
  const ab = istoZuUtc(start)
  // Obergrenze: auch bei einem einzigen Wochentag und 500 Wiederholungen weit genug
  for (let i = 0; i < 7 * anzahl + 7; i++) {
    const ms = ab + i * TAG_MS
    if (tage.has(wochentagIso(ms)) && ++gezaehlt === anzahl) return utcZuIso(ms)
  }
  return null
}

/** Wie viele Aktionstage bleiben ab `heute` (einschließlich) bis zum Ende? null = keine Begrenzung bekannt. */
export function verbleibendeAktionstage(
  regel: Pick<Preisregel, 'wochentage' | 'gueltigVon' | 'gueltigBis'>, heute: string,
): number | null {
  if (!regel.gueltigBis || regel.wochentage.length === 0) return null
  const von = regel.gueltigVon && regel.gueltigVon > heute ? regel.gueltigVon : heute
  if (von > regel.gueltigBis) return 0
  const tage = new Set(regel.wochentage)
  let n = 0
  for (let ms = istoZuUtc(von); ms <= istoZuUtc(regel.gueltigBis); ms += TAG_MS) if (tage.has(wochentagIso(ms))) n++
  return n
}

// ---------------------------------------------------------------------------
// Mengenaktion „X zum Preis von Y" — Rabattzeilen für den Warenkorb
// ---------------------------------------------------------------------------

export interface MengenPosition {
  artikelId:   string
  kategorieId: string | null
  bezeichnung: string
  mwstSatz:    string
  /** Anzahl Einheiten (nur ganze Zahlen zählen mit) */
  menge:       number
  /** Effektiver Einzelpreis in Cent (nach Aktionspreis/Preisliste) */
  preisCent:   number
  /** true = von Hand rabattiert o. ä.: nimmt nicht an der Mengenaktion teil */
  ausgenommen?: boolean
}

export interface MengenRabattZeile {
  regelId:     string
  regelName:   string
  /** Anzeige/Beleg: „<Aktion> (3 für 2): <Artikel>" */
  bezeichnung: string
  mwstSatz:    string
  /** Anzahl gratis gerechneter Einheiten */
  menge:       number
  /** Negativer Einzelpreis (= der erlassene Preis je Einheit) */
  preisCent:   number
}

/**
 * Berechnet die Rabattzeilen aller JETZT geltenden Mengenaktionen für einen Warenkorb.
 *
 * Je Aktion werden die Einheiten der passenden Positionen nach Preis absteigend zu Gruppen zu je `mengeKauf`
 * zusammengefasst; in jeder VOLLEN Gruppe sind die (kauf − zahle) günstigsten Einheiten gratis.
 *   • Zählweise „artikel": gezählt wird je Artikel getrennt (3 gleiche Pizzen).
 *   • Zählweise „auswahl": gezählt wird über alle Artikel im Geltungsbereich der Aktion.
 * Eine Einheit nimmt höchstens an EINER Aktion teil (Aktionen mit dem größten Nachlassanteil zuerst, dann nach Id) —
 * so gibt es nie einen doppelten Nachlass. Der Rabatt steht mit dem Steuersatz des jeweiligen Artikels auf der Zeile,
 * damit die Steueraufteilung auf dem Beleg stimmt.
 */
export function mengenRabattZeilen(regeln: Preisregel[], positionen: MengenPosition[], jetzt: Date): MengenRabattZeile[] {
  const mengenRegeln = regeln
    .filter(r => r.mengeKauf !== null && r.mengeZahle !== null && r.mengeModus !== null)
    .sort((a, b) =>
      (b.mengeKauf! - b.mengeZahle!) / b.mengeKauf! - (a.mengeKauf! - a.mengeZahle!) / a.mengeKauf!
      || a.id.localeCompare(b.id))
  if (mengenRegeln.length === 0) return []

  interface Einheit { pos: number; preisCent: number; verbraucht: boolean }
  const einheiten: Einheit[] = []
  positionen.forEach((p, pos) => {
    if (p.ausgenommen || p.preisCent <= 0 || !Number.isInteger(p.menge) || p.menge <= 0) return
    for (let i = 0; i < Math.min(p.menge, 1000); i++) einheiten.push({ pos, preisCent: p.preisCent, verbraucht: false })
  })

  const zeilen = new Map<string, MengenRabattZeile>()
  for (const regel of mengenRegeln) {
    const kauf = regel.mengeKauf!
    const gratisJeGruppe = kauf - regel.mengeZahle!
    const passend = einheiten.filter(e => {
      if (e.verbraucht) return false
      const p = positionen[e.pos]!
      return regelGiltJetzt(regel, p.artikelId, p.kategorieId, jetzt)
    })
    // Gruppen bilden: je Artikel getrennt oder über alles
    const toepfe = new Map<string, Einheit[]>()
    for (const e of passend) {
      const schluessel = regel.mengeModus === 'artikel' ? positionen[e.pos]!.artikelId : '*'
      const topf = toepfe.get(schluessel) ?? []
      topf.push(e)
      toepfe.set(schluessel, topf)
    }
    for (const topf of toepfe.values()) {
      topf.sort((a, b) => b.preisCent - a.preisCent)
      for (let start = 0; start + kauf <= topf.length; start += kauf) {
        const gruppe = topf.slice(start, start + kauf)
        for (const e of gruppe) e.verbraucht = true
        for (const gratis of gruppe.slice(kauf - gratisJeGruppe)) {
          const p = positionen[gratis.pos]!
          const key = `${regel.id}|${p.artikelId}|${p.mwstSatz}|${gratis.preisCent}`
          const vorhanden = zeilen.get(key)
          if (vorhanden) { vorhanden.menge++; continue }
          zeilen.set(key, {
            regelId: regel.id, regelName: regel.name,
            bezeichnung: `${regel.name} (${kauf} für ${regel.mengeZahle}): ${p.bezeichnung}`.slice(0, 200),
            mwstSatz: p.mwstSatz, menge: 1, preisCent: -gratis.preisCent,
          })
        }
      }
    }
  }
  return [...zeilen.values()]
}

/** Gerade geltende Mengenaktion für einen Artikel (für Hinweise an der Kasse); null = keine. */
export function aktiveMengenAktion(
  regeln: Preisregel[], artikelId: string, kategorieId: string | null, jetzt: Date = new Date(),
): { kauf: number; zahle: number } | null {
  let beste: { kauf: number; zahle: number } | null = null
  for (const r of regeln) {
    if (r.mengeKauf === null || r.mengeZahle === null) continue
    if (!regelGiltJetzt(r, artikelId, kategorieId, jetzt)) continue
    if (!beste || (r.mengeKauf - r.mengeZahle) / r.mengeKauf > (beste.kauf - beste.zahle) / beste.kauf) {
      beste = { kauf: r.mengeKauf, zahle: r.mengeZahle }
    }
  }
  return beste
}
