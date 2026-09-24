import { z } from 'zod'
import { MwStSatzSchema, type MwStSatz } from './artikel.js'

// ---------------------------------------------------------------------------
// Ticketing — Events, Bänder (Jugendschutz), Ticketarten, Tickets
// ---------------------------------------------------------------------------

export const TicketEventStatusSchema = z.enum(['entwurf', 'test', 'veroeffentlicht', 'abgesagt'])
export type TicketEventStatus = z.infer<typeof TicketEventStatusSchema>

export const TICKET_EVENT_STATUS_LABELS: Record<TicketEventStatus, string> = {
  entwurf:         'Entwurf',
  test:            'Interner Test',
  veroeffentlicht: 'Veröffentlicht',
  abgesagt:        'Abgesagt',
}

/** einzel = genau 1× Einlass | mehrfach = beliebig oft (Crew, Feuerwehr, …) */
export const TicketTypSchema = z.enum(['einzel', 'mehrfach'])
export type TicketTyp = z.infer<typeof TicketTypSchema>

/** Gespeicherter Lebenszyklus. „Eingelöst" ist KEIN Status, sondern ergibt sich aus dem ersten Einlass. */
export const TicketStatusSchema = z.enum(['reserviert', 'gueltig', 'storniert'])
export type TicketStatus = z.infer<typeof TicketStatusSchema>

/** Was ein Ticket nach außen zeigt (Ticketseite, Einlass). */
export type TicketAnzeigeStatus = 'gueltig' | 'eingeloest' | 'storniert' | 'abgesagt'

export const TICKET_ANZEIGE_STATUS_LABELS: Record<TicketAnzeigeStatus, string> = {
  gueltig:    'gültig',
  eingeloest: 'eingelöst',
  storniert:  'storniert',
  abgesagt:   'abgesagt',
}

/** Vorschläge fürs Ausstellen von Mehrfachtickets — die Rolle bleibt Freitext. */
export const MEHRFACH_ROLLEN_VORSCHLAEGE = [
  'Crew', 'Feuerwehr', 'Technik', 'Reinigung', 'Security', 'Rettung', 'Künstler',
] as const

// ---------------------------------------------------------------------------
// Ticket-Code
// ---------------------------------------------------------------------------

/**
 * Alphabet ohne verwechselbare Zeichen (kein 0/o, 1/l/i) — der Code muss am
 * Einlass notfalls von Hand eintippbar sein. 31 Zeichen × 16 Stellen ≈ 79 Bit:
 * nicht erratbar, auch nicht durch massenhaftes Durchprobieren.
 */
export const TICKET_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
export const TICKET_CODE_LAENGE   = 16
export const TICKET_CODE_REGEX    = /^[a-hjkmnp-z2-9]{16}$/

/** Link zur öffentlichen Ticketseite — genau dieser Text steht im QR-Code. */
export function ticketUrl(basisUrl: string, code: string): string {
  return `${basisUrl.replace(/\/+$/, '')}/t/${code}`
}

/**
 * Holt den Ticket-Code aus einem gescannten QR-Inhalt. Akzeptiert den Link zur
 * Ticketseite (egal unter welcher Domain ausgestellt) ebenso wie den nackten
 * Code — Handscanner und Tippfehler-Groß/Klein inklusive. null = kein Ticket.
 */
export function ticketCodeAusScan(inhalt: string): string | null {
  const text = inhalt.trim()
  const ausLink = /\/t\/([A-Za-z0-9]{16})(?:[/?#].*)?$/.exec(text)
  const kandidat = (ausLink ? ausLink[1]! : text).toLowerCase()
  return TICKET_CODE_REGEX.test(kandidat) ? kandidat : null
}

// ---------------------------------------------------------------------------
// Alter + Band
// ---------------------------------------------------------------------------

const WIEN_TAG = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Kalendertag eines Zeitpunkts in Wiener Zeit, als YYYY-MM-DD. */
export function wienerTag(zeitpunkt: Date | string): string {
  const teile = WIEN_TAG.formatToParts(new Date(zeitpunkt))
  const teil = (typ: string) => teile.find(t => t.type === typ)?.value ?? '00'
  return `${teil('year')}-${teil('month')}-${teil('day')}`
}

const EVENT_ZEIT = new Intl.DateTimeFormat('de-AT', {
  timeZone: 'Europe/Vienna', weekday: 'short', day: '2-digit', month: '2-digit',
  year: 'numeric', hour: '2-digit', minute: '2-digit',
})

/** „Sa., 17.10.2026, 15:00" — so steht der Beginn auf Ticketseite, PDF und E-Mail. */
export function eventZeitText(beginn: Date | string): string {
  return EVENT_ZEIT.format(new Date(beginn))
}

/** „Test-Buffet (1 Person)" bzw. „Crew · Mehrfachticket" */
export function ticketTitel(t: { typ: TicketTyp; bezeichnung: string }): string {
  return t.typ === 'mehrfach' ? `${t.bezeichnung} · Mehrfachticket` : `${t.bezeichnung} (1 Person)`
}

/** Hinweistext unter dem QR-Code — für Einzel- und Mehrfachtickets verschieden. */
export function ticketGueltigkeitsHinweis(typ: TicketTyp): { titel: string; text: string } {
  return typ === 'mehrfach'
    ? {
        titel: 'Mehrfachticket.',
        text:  'Gilt für beliebig viele Eintritte während des Events. ' +
               'Nur für die genannte Person bzw. Funktion — nicht weitergeben.',
      }
    : {
        titel: 'Nur 1× gültig.',
        text:  'Das zuerst gescannte Ticket gilt – jede Kopie danach wird am Einlass abgewiesen. ' +
               'Nur an die Person weiterleiten, für die das Ticket gedacht ist.',
      }
}

function zerlegeDatum(datum: string): [number, number, number] {
  const [j = 0, m = 0, t = 0] = datum.split('-').map(Number)
  return [j, m, t]
}

/**
 * Alter in vollendeten Jahren an einem Stichtag (beide YYYY-MM-DD).
 *
 * Maßgeblich ist der Eventtag, nicht der Bestelltag: wer im Juli bestellt und
 * im Oktober 18 wird, bekommt beim Oktober-Event das 18er-Band.
 * Am 29. Februar Geborene werden in Nicht-Schaltjahren erst am 1. März ein
 * Jahr älter — die vorsichtigere Lesart, passend zum Jugendschutz.
 */
export function alterAm(geburtsdatum: string, stichtag: string): number {
  const [gj, gm, gt] = zerlegeDatum(geburtsdatum)
  const [sj, sm, st] = zerlegeDatum(stichtag)
  const hatteGeburtstag = sm > gm || (sm === gm && st >= gt)
  return sj - gj - (hatteGeburtstag ? 0 : 1)
}

/** Was eine Band-Regel braucht — erfüllt von DB-Zeilen wie von Eingaben. */
export interface BandRegel {
  alterVon:     number | null
  alterBis:     number | null
  reihenfolge?: number | undefined
}

/** Erstes Band (nach Reihenfolge), in dessen Altersbereich das Alter fällt. */
export function bandFuerAlter<B extends BandRegel>(baender: readonly B[], alter: number): B | null {
  const sortiert = [...baender].sort((a, b) => (a.reihenfolge ?? 0) - (b.reihenfolge ?? 0))
  return sortiert.find(b =>
    (b.alterVon === null || alter >= b.alterVon) &&
    (b.alterBis === null || alter <= b.alterBis),
  ) ?? null
}

/** „ab 18 Jahre", „16–17 Jahre", „unter 16 Jahre" — so steht es auf dem Ticket. */
export function bandAltersText(b: BandRegel): string {
  if (b.alterVon !== null && b.alterBis !== null) {
    return b.alterVon === b.alterBis ? `${b.alterVon} Jahre` : `${b.alterVon}–${b.alterBis} Jahre`
  }
  if (b.alterVon !== null) return `ab ${b.alterVon} Jahre`
  if (b.alterBis !== null) return `unter ${b.alterBis + 1} Jahre`
  return 'alle Altersgruppen'
}

const HexFarbeSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe im Format #rrggbb')
const AlterSchema    = z.number().int().min(0).max(120)

export const TicketBandInputSchema = z.object({
  bezeichnung: z.string().trim().min(1, 'Bezeichnung erforderlich').max(60),
  farbe:       HexFarbeSchema,
  alterVon:    AlterSchema.nullable(),
  alterBis:    AlterSchema.nullable(),
  hinweis:     z.string().trim().max(200).nullable().optional(),
  reihenfolge: z.number().int().min(0).max(99).optional(),
}).refine(b => b.alterVon === null || b.alterBis === null || b.alterVon <= b.alterBis, {
  message: '„Alter von" darf nicht größer als „bis" sein', path: ['alterBis'],
})
export type TicketBandInput = z.infer<typeof TicketBandInputSchema>

/**
 * Bänder eines Events komplett ersetzen. Überlappende Altersbereiche sind ein
 * Fehler: sonst wäre offen, welches Band ein 17-Jähriger bekommt.
 */
export const TicketBaenderSetzenSchema = z.object({
  baender: z.array(TicketBandInputSchema).max(10),
}).superRefine((v, ctx) => {
  const bereich = (b: TicketBandInput): [number, number] => [b.alterVon ?? 0, b.alterBis ?? 999]
  v.baender.forEach((a, i) => {
    v.baender.forEach((b, j) => {
      if (j <= i) return
      const [av, ab] = bereich(a)
      const [bv, bb] = bereich(b)
      if (av <= bb && bv <= ab) {
        ctx.addIssue({
          code: 'custom', path: ['baender', j, 'alterVon'],
          message: `Altersbereich überschneidet sich mit Band „${a.bezeichnung}"`,
        })
      }
    })
  })
})
export type TicketBaenderSetzen = z.infer<typeof TicketBaenderSetzenSchema>

/**
 * Vorbelegung nach dem österreichweit einheitlichen Jugendschutz (Alkohol ab 16,
 * Spirituosen ab 18). Farben und Grenzen sind je Event frei änderbar.
 */
export const STANDARD_BAENDER: TicketBandInput[] = [
  { bezeichnung: 'Grün', farbe: '#16a34a', alterVon: 18,   alterBis: null, hinweis: 'Alle Getränke',                    reihenfolge: 0 },
  { bezeichnung: 'Gelb', farbe: '#eab308', alterVon: 16,   alterBis: 17,   hinweis: 'Keine Spirituosen',                reihenfolge: 1 },
  { bezeichnung: 'Rot',  farbe: '#dc2626', alterVon: null, alterBis: 15,   hinweis: 'Kein Alkohol',                     reihenfolge: 2 },
]

// ---------------------------------------------------------------------------
// Eingaben
// ---------------------------------------------------------------------------

const IsoZeitSchema = z.string().datetime({ offset: true })

/** Geburtsdatum als YYYY-MM-DD — echtes Kalenderdatum, nicht in der Zukunft, höchstens 120 Jahre. */
export const GeburtsdatumSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Geburtsdatum im Format JJJJ-MM-TT')
  .refine(s => {
    const [j, m, t] = zerlegeDatum(s)
    const d = new Date(Date.UTC(j, m - 1, t))
    return d.getUTCFullYear() === j && d.getUTCMonth() === m - 1 && d.getUTCDate() === t
  }, 'Kein gültiges Datum')
  .refine(s => s <= wienerTag(new Date()), 'Geburtsdatum liegt in der Zukunft')
  .refine(s => alterAm(s, wienerTag(new Date())) <= 120, 'Geburtsdatum unplausibel')

const TicketEventBasisSchema = z.object({
  titel:        z.string().trim().min(1, 'Titel erforderlich').max(200),
  beschreibung: z.string().trim().max(5000).nullable().optional(),
  beginn:       IsoZeitSchema,
  ende:         IsoZeitSchema.nullable().optional(),
  ort:          z.string().trim().min(1, 'Ort erforderlich').max(200),
  adresse:      z.string().trim().max(300).nullable().optional(),
  hinweis:      z.string().trim().max(200).nullable().optional(),
  veranstalter: z.string().trim().max(200).nullable().optional(),
  status:       TicketEventStatusSchema.optional(),
  mindestalter: z.number().int().min(0).max(99).nullable().optional(),
  namePflicht:  z.boolean().optional(),
  datenLoeschenNachTagen: z.number().int().min(1).max(365).optional(),
})

const endeNachBeginn = (e: { beginn?: string | undefined; ende?: string | null | undefined }) =>
  !e.beginn || !e.ende || new Date(e.ende) > new Date(e.beginn)
const ENDE_FEHLER = { message: 'Das Ende muss nach dem Beginn liegen', path: ['ende'] }

export const TicketEventInputSchema  = TicketEventBasisSchema.refine(endeNachBeginn, ENDE_FEHLER)
export const TicketEventUpdateSchema = TicketEventBasisSchema.partial().refine(endeNachBeginn, ENDE_FEHLER)
export type TicketEventInput  = z.infer<typeof TicketEventInputSchema>
export type TicketEventUpdate = z.infer<typeof TicketEventUpdateSchema>

export const TicketArtInputSchema = z.object({
  bezeichnung:      z.string().trim().min(1, 'Bezeichnung erforderlich').max(120),
  beschreibung:     z.string().trim().max(2000).nullable().optional(),
  preisCent:        z.number().int().min(0).max(100_000_00),
  mwstSatz:         MwStSatzSchema,
  kontingent:       z.number().int().min(0).max(1_000_000).nullable().optional(),
  maxProBestellung: z.number().int().min(1).max(50).optional(),
  verkaufAb:        IsoZeitSchema.nullable().optional(),
  verkaufBis:       IsoZeitSchema.nullable().optional(),
  onlineVerkauf:    z.boolean().optional(),
  reihenfolge:      z.number().int().min(0).max(999).optional(),
})
export const TicketArtUpdateSchema = TicketArtInputSchema.partial()
export type TicketArtInput  = z.infer<typeof TicketArtInputSchema>
export type TicketArtUpdate = z.infer<typeof TicketArtUpdateSchema>

/**
 * Intern ausstellen (Backoffice): Freikarten als Einzeltickets oder
 * Mehrfachtickets für Crew, Feuerwehr, Technik …
 * Name und Geburtsdatum nur bei genau einem Ticket — für 20 anonyme Crew-Tickets
 * wäre ein gemeinsames Geburtsdatum Unsinn.
 */
export const TicketAusstellenInputSchema = z.object({
  typ:          TicketTypSchema,
  /** Einzelticket: Pflicht. Mehrfachticket: optional (Preis/MwSt 0). */
  ticketArtId:  z.string().uuid().nullable().optional(),
  /** Mehrfachticket: Pflicht — steht groß auf Ticket und am Einlass */
  rolle:        z.string().trim().min(1).max(60).optional(),
  anzahl:       z.number().int().min(1).max(200),
  name:         z.string().trim().min(1).max(200).optional(),
  geburtsdatum: GeburtsdatumSchema.optional(),
  email:        z.string().trim().email('Ungültige E-Mail-Adresse').max(254).optional(),
  /** Tickets sofort an `email` schicken (bei mehreren: alle in einer Mail) */
  senden:       z.boolean().optional(),
}).superRefine((v, ctx) => {
  if (v.typ === 'einzel' && !v.ticketArtId) {
    ctx.addIssue({ code: 'custom', path: ['ticketArtId'], message: 'Ticketart wählen' })
  }
  if (v.typ === 'mehrfach' && !v.rolle) {
    ctx.addIssue({ code: 'custom', path: ['rolle'], message: 'Rolle angeben (z. B. Crew)' })
  }
  if (v.anzahl > 1 && (v.name || v.geburtsdatum)) {
    ctx.addIssue({ code: 'custom', path: ['name'], message: 'Name und Geburtsdatum nur bei einem einzelnen Ticket' })
  }
  if (v.senden && !v.email) {
    ctx.addIssue({ code: 'custom', path: ['email'], message: 'Für den Versand eine E-Mail-Adresse angeben' })
  }
})
export type TicketAusstellenInput = z.infer<typeof TicketAusstellenInputSchema>

export const TicketSendenInputSchema = z.object({
  email: z.string().trim().email('Ungültige E-Mail-Adresse').max(254),
})
export type TicketSendenInput = z.infer<typeof TicketSendenInputSchema>

export const TicketEinstellungenSchema = z.object({
  /** Öffentliche Adresse der Ticket-App, z. B. https://tickets.example.at */
  ticketBasisUrl: z.string().trim().url('Vollständige Adresse inkl. https://').max(300).nullable(),
})
export type TicketEinstellungen = z.infer<typeof TicketEinstellungenSchema>

// ---------------------------------------------------------------------------
// Antworten
// ---------------------------------------------------------------------------

export interface TicketBand {
  id:          string
  bezeichnung: string
  farbe:       string
  alterVon:    number | null
  alterBis:    number | null
  hinweis:     string | null
  reihenfolge: number
}

/** Band, wie es auf einem Ticket erscheint */
export interface TicketBandAnzeige {
  bezeichnung: string
  farbe:       string
  altersText:  string
  hinweis:     string | null
}

export interface TicketArt {
  id:               string
  eventId:          string
  bezeichnung:      string
  beschreibung:     string | null
  preisCent:        number
  mwstSatz:         MwStSatz
  kontingent:       number | null
  maxProBestellung: number
  verkaufAb:        string | null
  verkaufBis:       string | null
  onlineVerkauf:    boolean
  reihenfolge:      number
  /** Gültige (nicht stornierte) Tickets dieser Art */
  ausgegeben:       number
}

/**
 * Einlass-Stand eines Events. `besucher` zählt jedes Ticket genau einmal beim
 * ERSTEN Einlass — Mehrfachtickets gehen also nur einmal ein, egal wie oft die
 * Crew rein und raus geht.
 */
export interface TicketEinlassStand {
  /** Gültige Tickets insgesamt (Einzel + Mehrfach) */
  tickets:          number
  mehrfach:         number
  besucher:         number
  besucherMehrfach: number
  /** Beim Einlass ausgegebene Bänder je Farbe — für den Bänder-Vorrat */
  proBand: Array<{ bandId: string | null; bezeichnung: string; farbe: string | null; anzahl: number }>
}

export interface TicketEventUebersicht {
  id:        string
  titel:     string
  beginn:    string
  ende:      string | null
  ort:       string
  status:    TicketEventStatus
  tickets:   number
  besucher:  number
}

export interface TicketEventDetail {
  id:            string
  titel:         string
  beschreibung:  string | null
  beginn:        string
  ende:          string | null
  ort:           string
  adresse:       string | null
  hinweis:       string | null
  veranstalter:  string | null
  status:        TicketEventStatus
  mindestalter:  number | null
  namePflicht:   boolean
  datenLoeschenNachTagen: number
  datenGeloeschtAt:       string | null
  baender:       TicketBand[]
  arten:         TicketArt[]
  stand:         TicketEinlassStand
}

/** Ticket in der Backoffice-Liste — MIT Geburtsdatum (nur für Berechtigte). */
export interface TicketAdmin {
  id:              string
  code:            string
  typ:             TicketTyp
  rolle:           string | null
  bezeichnung:     string
  ticketArtId:     string | null
  name:            string | null
  geburtsdatum:    string | null
  /** Alter am Eventtag */
  alter:           number | null
  band:            TicketBandAnzeige | null
  email:           string | null
  status:          TicketStatus
  anzeigeStatus:   TicketAnzeigeStatus
  preisCent:       number
  ersterEinlassAt: string | null
  einlassAnzahl:   number
  createdAt:       string
  /** Link zur Ticketseite; null solange die Ticket-Adresse nicht eingerichtet ist */
  url:             string | null
}

export interface TicketAusstellenAntwort {
  tickets:  TicketAdmin[]
  /** Nur gesetzt, wenn Versand angefordert war */
  versand?: { erfolgreich: boolean; fehler?: string }
}

/**
 * Öffentliche Ticketseite — bewusst OHNE Geburtsdatum und E-Mail: die Seite
 * ist zum Weiterleiten gedacht. Das Band reicht; das genaue Alter sieht nur
 * das Einlasspersonal.
 */
export interface TicketOeffentlich {
  code:          string
  typ:           TicketTyp
  rolle:         string | null
  bezeichnung:   string
  name:          string | null
  anzeigeStatus: TicketAnzeigeStatus
  band:          TicketBandAnzeige | null
  event: {
    titel:        string
    beginn:       string
    ende:         string | null
    ort:          string
    adresse:      string | null
    hinweis:      string | null
    status:       TicketEventStatus
    veranstalter: string
  }
  /** Firmenname des Verkäufers (Mandant) */
  verkaeufer:    string
}
