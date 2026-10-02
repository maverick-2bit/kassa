/**
 * Geschäftstag — der „Tag" eines Betriebs, je Mandant frei verschiebbar.
 *
 * Ein Lokal, das bis 03:00 früh offen hat, will eine Schicht, die um 18:00
 * beginnt und um 02:00 endet, auf EINEM Tag sehen — nicht auf zwei. Dafür
 * beginnt der Geschäftstag nicht um 00:00, sondern z. B. um 06:00 und läuft bis
 * 06:00 des Folgetages (Tagesabschluss, Berichte, Zeiterfassung).
 *
 * Definition (lückenlos und überschneidungsfrei):
 *
 *   start(D)     = Wiener Kalendertag D um beginn(D) Wiener Ortszeit
 *   Geschäftstag D = [ start(D) , start(D + 1) )
 *
 * `beginn(D)` ist der Tagesbeginn, der am Kalendertag D gilt: der Eintrag mit
 * dem größten `gueltigAb <= D`, ohne Eintrag 00:00. Dadurch greift eine
 * Änderung erst AB einem Stichtag; der Übergangstag wird länger oder kürzer,
 * aber nie entstehen Lücken oder Überschneidungen — jeder Zeitpunkt gehört zu
 * genau einem Geschäftstag. Sommer-/Winterzeit steckt in `start(D)` (23- und
 * 25-Stunden-Tage ergeben sich von selbst).
 *
 * Mit dem Standard 00:00 ist der Geschäftstag der Wiener Kalendertag — alles
 * Bestehende verhält sich dann unverändert.
 *
 * NICHT betroffen: alles, was gesetzlich ein Kalenderbegriff ist (RKSV:
 * Startbeleg, Monatsbeleg = Kalendermonat, Jahresbeleg = Kalenderjahr,
 * Belegnummern, Signaturkette, DEP-Export). Belege behalten ihre exakten
 * Zeitstempel; nur die AUSWERTUNGS-Tage folgen dem Geschäftstag.
 *
 * Reine Funktionen ohne Abhängigkeiten — Backend, Frontend und Tests rechnen
 * mit derselben Definition.
 */

/** Tagesbeginn ohne Eintrag: Mitternacht (Geschäftstag = Kalendertag). */
export const STANDARD_TAGESBEGINN = '00:00'

const WIEN = 'Europe/Vienna'

/** Ein Eintrag der Tagesbeginn-Historie eines Mandanten. */
export interface TagesbeginnEintrag {
  /** Wiener Kalendertag (YYYY-MM-DD), ab dem dieser Tagesbeginn gilt */
  gueltigAb: string
  /** Uhrzeit des Tagesbeginns (HH:MM, Wiener Ortszeit) */
  beginn:    string
}

/** Die Historie eines Mandanten (Reihenfolge beliebig — die Funktionen sortieren nicht voraus). */
export type TagesRegel = readonly TagesbeginnEintrag[]

// ---------------------------------------------------------------------------
// Prüfung + Kalenderarithmetik (rein kalendarisch, ohne Zeitzonen-Effekte)
// ---------------------------------------------------------------------------

const DATUM_MUSTER  = /^(\d{4})-(\d{2})-(\d{2})$/
const BEGINN_MUSTER = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Echtes Kalenderdatum im Format YYYY-MM-DD (kein 2026-02-30). */
export function istKalenderDatum(s: string): boolean {
  const m = DATUM_MUSTER.exec(s)
  if (!m) return false
  const j = Number(m[1]), mo = Number(m[2]), t = Number(m[3])
  const d = new Date(Date.UTC(j, mo - 1, t))
  return d.getUTCFullYear() === j && d.getUTCMonth() === mo - 1 && d.getUTCDate() === t
}

/** Uhrzeit HH:MM von 00:00 bis 23:59. */
export function istTagesbeginn(s: string): boolean {
  return BEGINN_MUSTER.test(s)
}

/**
 * Verschiebt einen Kalendertag (YYYY-MM-DD) um `tage` Tage.
 * Rein kalendarisch über Date.UTC — keine Sommerzeit-, keine Zeitzonen-Effekte.
 */
export function addTage(datum: string, tage: number): string {
  const [j, m, t] = datum.split('-').map(Number)
  return new Date(Date.UTC(j!, m! - 1, t! + tage)).toISOString().slice(0, 10)
}

/** Stunde (0–23) eines Tagesbeginns HH:MM. */
export function beginnStunde(beginn: string): number {
  return Number(beginn.slice(0, 2))
}

/**
 * Stundenachse eines Tages, die beim Tagesbeginn anfängt:
 * Tagesbeginn 06:00 → [6, 7, …, 23, 0, 1, …, 5]; 00:00 → [0, 1, …, 23].
 */
export function stundenAchse(beginn: string): number[] {
  const start = beginnStunde(beginn)
  return Array.from({ length: 24 }, (_, i) => (start + i) % 24)
}

// ---------------------------------------------------------------------------
// Regel
// ---------------------------------------------------------------------------

/**
 * Bereinigt eine Historie: verwirft ungültige Einträge (z. B. aus einem alten
 * LocalStorage), sortiert aufsteigend nach `gueltigAb`, bei doppeltem Stichtag
 * gilt der spätere Eintrag der Liste.
 */
export function normalisiereRegel(eintraege: Iterable<TagesbeginnEintrag>): TagesbeginnEintrag[] {
  const proTag = new Map<string, TagesbeginnEintrag>()
  for (const e of eintraege) {
    if (e && istKalenderDatum(e.gueltigAb) && istTagesbeginn(e.beginn)) {
      proTag.set(e.gueltigAb, { gueltigAb: e.gueltigAb, beginn: e.beginn })
    }
  }
  return [...proTag.values()].sort((a, b) => (a.gueltigAb < b.gueltigAb ? -1 : a.gueltigAb > b.gueltigAb ? 1 : 0))
}

/**
 * Tagesbeginn, der am Wiener Kalendertag `datum` gilt: der Eintrag mit dem
 * größten `gueltigAb <= datum`; ohne passenden Eintrag 00:00.
 */
export function beginnFuer(regel: TagesRegel, datum: string): string {
  let bester = ''
  let beginn = STANDARD_TAGESBEGINN
  for (const e of regel) {
    if (e.gueltigAb <= datum && e.gueltigAb >= bester) {
      bester = e.gueltigAb
      beginn = e.beginn
    }
  }
  return beginn
}

/** true = die Regel verschiebt nirgends etwas (leer oder nur 00:00-Einträge). */
export function istStandardRegel(regel: TagesRegel): boolean {
  return regel.every(e => e.beginn === STANDARD_TAGESBEGINN)
}

/** true = der Geschäftstag `datum` ist ein gewöhnlicher Kalendertag (00:00 bis 00:00). */
export function istKalendertag(regel: TagesRegel, datum: string): boolean {
  return beginnFuer(regel, datum) === STANDARD_TAGESBEGINN
      && beginnFuer(regel, addTage(datum, 1)) === STANDARD_TAGESBEGINN
}

// ---------------------------------------------------------------------------
// Wiener Ortszeit ↔ Zeitpunkt
// ---------------------------------------------------------------------------

/** EIN wiederverwendeter Formatter — ein neuer je Aufruf wäre um Größenordnungen langsamer. */
const WIEN_TEILE = new Intl.DateTimeFormat('en-CA', {
  timeZone:  WIEN,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

export interface WienerZeit {
  /** Wiener Kalendertag, YYYY-MM-DD */
  datum:      string
  /** Wiener Uhrzeit, HH:MM */
  hm:         string
  /** Abstand der Wiener Ortszeit zu UTC in Minuten (60 Winter-, 120 Sommerzeit) */
  offsetMin:  number
}

/** Wiener Wanduhr eines Zeitpunkts. */
export function wienerZeit(zeitpunkt: Date): WienerZeit {
  const t: Record<string, string> = {}
  for (const teil of WIEN_TEILE.formatToParts(zeitpunkt)) {
    if (teil.type !== 'literal') t[teil.type] = teil.value
  }
  const lokalAlsUtc = Date.UTC(
    Number(t['year']), Number(t['month']) - 1, Number(t['day']),
    Number(t['hour']), Number(t['minute']), Number(t['second']),
  )
  const sekundenGenau = Math.floor(zeitpunkt.getTime() / 1000) * 1000
  return {
    datum:     `${t['year']}-${t['month']}-${t['day']}`,
    hm:        `${t['hour']}:${t['minute']}`,
    offsetMin: Math.round((lokalAlsUtc - sekundenGenau) / 60_000),
  }
}

/**
 * Zeitpunkt, zu dem die Wiener Wanduhr `datum` `hm` zeigt.
 *
 * In den zwei heiklen Stunden der Zeitumstellung entscheidet — wie in
 * PostgreSQL (`'…'::timestamp AT TIME ZONE 'Europe/Vienna'`) — die
 * Standardzeit (UTC+1):
 *  - Umstellung auf Sommerzeit: 02:30 gibt es nicht → gilt als 02:30 MEZ (= 03:30 MESZ)
 *  - Umstellung auf Winterzeit: 02:30 gibt es zweimal → gilt die zweite (MEZ)
 * So stimmen die Tagesgrenzen im Browser und in der Datenbank überein.
 */
export function wienerZeitpunkt(datum: string, hm: string): Date {
  const schluessel = `${datum} ${hm}`
  const bekannt = ZEITPUNKT_MERKER.get(schluessel)
  if (bekannt !== undefined) return new Date(bekannt)

  const [j, m, t] = datum.split('-').map(Number)
  const [h, mi]   = hm.split(':').map(Number)
  const lokalAlsUtc = Date.UTC(j!, m! - 1, t!, h!, mi!)

  let ergebnis: Date
  const mez = new Date(lokalAlsUtc - 60 * 60_000)
  if (wienerZeit(mez).offsetMin === 60) {
    ergebnis = mez                                         // Winterzeit (oder Überlappung)
  } else {
    const mesz = new Date(lokalAlsUtc - 120 * 60_000)
    ergebnis = wienerZeit(mesz).offsetMin === 120 ? mesz   // Sommerzeit
      : mez                                                // Lücke: Offset vor dem Wechsel
  }

  // Massenverarbeitung (Export über ein Jahr Belege) fragt immer wieder dieselben Tage ab
  if (ZEITPUNKT_MERKER.size >= 4000) ZEITPUNKT_MERKER.clear()
  ZEITPUNKT_MERKER.set(schluessel, ergebnis.getTime())
  return ergebnis
}

/** Gemerkte Ergebnisse von wienerZeitpunkt (rein, deshalb gefahrlos); begrenzt, damit nichts wächst. */
const ZEITPUNKT_MERKER = new Map<string, number>()

// ---------------------------------------------------------------------------
// Geschäftstag
// ---------------------------------------------------------------------------

/** Beginn des Geschäftstags `datum` als Zeitpunkt: `datum` um den dort geltenden Tagesbeginn. */
export function tagesBeginnZeitpunkt(regel: TagesRegel, datum: string): Date {
  return wienerZeitpunkt(datum, beginnFuer(regel, datum))
}

/**
 * Grenzen des Geschäftstags `datum`: [von, bis) — `bis` ist der Beginn des
 * Folgetags (und damit selbst schon der nächste Geschäftstag).
 */
export function tagesGrenzen(regel: TagesRegel, datum: string): { von: Date; bis: Date } {
  return {
    von: tagesBeginnZeitpunkt(regel, datum),
    bis: tagesBeginnZeitpunkt(regel, addTage(datum, 1)),
  }
}

/**
 * Zu welchem Geschäftstag (YYYY-MM-DD) gehört ein Zeitpunkt?
 *
 * Der Beginn eines Geschäftstags liegt immer auf dem Wiener Kalendertag, nach
 * dem er benannt ist. Ein Zeitpunkt am Kalendertag W gehört deshalb entweder zu
 * W (ab dem Beginn von W) oder noch zum Vortag — dessen Ende ist erst der
 * Beginn von W. Das gilt auch über Wechsel des Tagesbeginns hinweg.
 */
export function geschaeftstagVon(regel: TagesRegel, zeitpunkt: Date): string {
  const kalendertag = wienerZeit(zeitpunkt).datum
  return zeitpunkt.getTime() >= tagesBeginnZeitpunkt(regel, kalendertag).getTime()
    ? kalendertag
    : addTage(kalendertag, -1)
}

/** Der aktuelle Geschäftstag (um 02:00 nachts bei Tagesbeginn 06:00 noch der Vortag). */
export function heuteGeschaeftstag(regel: TagesRegel, jetzt: Date = new Date()): string {
  return geschaeftstagVon(regel, jetzt)
}

/** Der Wiener Kalendertag von `jetzt` — für reine Kalenderbegriffe (Reservierung, Gültigkeit). */
export function heuteKalendertagWien(jetzt: Date = new Date()): string {
  return wienerZeit(jetzt).datum
}

// ---------------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------------

/** 'TT.MM.JJJJ, HH:MM' in Wiener Ortszeit. */
function datumUhrzeitText(z: Date): string {
  const w = wienerZeit(z)
  const [j, m, t] = w.datum.split('-')
  return `${t}.${m}.${j}, ${w.hm}`
}

/**
 * 'Geschäftstag 02.10.2026, 06:00 – 03.10.2026, 06:00' — der ausgeschriebene
 * Zeitraum eines Geschäftstags (Tagesabschluss-Seite, Z-Bon, E-Mail).
 */
export function geschaeftstagText(von: Date | string, bis: Date | string): string {
  return `Geschäftstag ${datumUhrzeitText(new Date(von))} – ${datumUhrzeitText(new Date(bis))}`
}

/** Dauer des Geschäftstags in Stunden (24 ± Übergang ± Zeitumstellung). */
export function dauerStunden(grenzen: { von: Date; bis: Date }): number {
  return (grenzen.bis.getTime() - grenzen.von.getTime()) / 3_600_000
}

export interface UebergangsVorschau {
  /** Der Geschäftstag, der durch den Wechsel länger oder kürzer wird (Vortag des Stichtags) */
  datum:        string
  von:          Date
  bis:          Date
  dauerStunden: number
}

/**
 * Was passiert am Stichtag? Der Tag VOR `neu.gueltigAb` endet nicht mehr zum
 * alten, sondern zum neuen Tagesbeginn — er wird länger oder kürzer.
 */
export function uebergangsVorschau(regel: TagesRegel, neu: TagesbeginnEintrag): UebergangsVorschau {
  const datum = addTage(neu.gueltigAb, -1)
  const grenzen = tagesGrenzen(normalisiereRegel([...regel, neu]), datum)
  return { datum, ...grenzen, dauerStunden: dauerStunden(grenzen) }
}
