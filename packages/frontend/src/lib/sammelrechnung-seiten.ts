/**
 * Seitenumbruch der A4-Sammelrechnung. Jede Zeile hat eine feste Höhe (mm); die Zeilen werden so auf
 * Seiten verteilt, dass jede Seite unten eine Zwischensumme („Übertrag auf Seite n+1") und die Folgeseite oben
 * den passenden Übertrag zeigt. Rein und ohne DOM → gut testbar.
 */

export type ZeilenArt = 'kopf' | 'pos' | 'leer'

export interface SeitenZeile {
  art:        ZeilenArt
  /** Feste Höhe in mm */
  hoehe:      number
  /** Betrag der Zeile in Cent (nur Positionen) */
  betragCent?: number
}

export interface Seite<T extends SeitenZeile> {
  zeilen:            T[]
  /** Übertrag aus den Vorseiten (erste Zeile der Folgeseiten); auf Seite 1 nicht vorhanden */
  uebertragVor:      number | null
  /** Zwischensumme am Seitenende; auf der letzten Seite nicht vorhanden */
  zwischensummeNach: number | null
  letzte:            boolean
}

export const MASSE = {
  /** Eine Positionszeile mit einer Textzeile; jede weitere Textzeile addiert `zusatzZeile` */
  position:      8,
  zusatzZeile:   4.5,
  /** Hinweiszeile „LS L-0007 vom 01.10.2026" */
  kopf:          9,
  /** Leerzeile zwischen zwei Lieferscheinen (es sind immer zwei) */
  leer:          6,
  uebertrag:     8,
  zwischensumme: 9,
  /** Zeichen je Textzeile in der Bezeichnungsspalte (bewusst knapp gerechnet) */
  zeichenJeZeile: 36,
  maxZeilen:     3,
} as const

/** Höhe einer Positionszeile anhand der Bezeichnungslänge */
export function positionsHoehe(bezeichnung: string): number {
  const zeilen = Math.min(MASSE.maxZeilen, Math.max(1, Math.ceil(bezeichnung.length / MASSE.zeichenJeZeile)))
  return MASSE.position + (zeilen - 1) * MASSE.zusatzZeile
}

export interface Kapazitaet {
  /** Verfügbare Höhe für Zeilen auf Seite 1 (mm) */
  erste:     number
  /** … auf jeder Folgeseite, vor Abzug der Übertragszeile */
  folge:     number
  /** Höhe des Abschlussblocks (Steuer, Summe, Zahlung), der unter die letzte Zeile gehört */
  abschluss: number
}

const summe = (zeilen: SeitenZeile[]): number => zeilen.reduce((s, z) => s + z.hoehe, 0)
const betrag = (zeilen: SeitenZeile[]): number => zeilen.reduce((s, z) => s + (z.betragCent ?? 0), 0)

export function paginiere<T extends SeitenZeile>(zeilen: T[], kap: Kapazitaet): Seite<T>[] {
  const seiten: Seite<T>[] = []
  let i = 0
  let lauf = 0

  for (let schutz = 0; schutz < 10_000; schutz++) {
    const erste = seiten.length === 0
    // Leerzeilen am Seitenanfang entfallen
    while (zeilen[i]?.art === 'leer') i++

    const verfuegbar = (erste ? kap.erste : kap.folge) - (erste ? 0 : MASSE.uebertrag)
    const rest = zeilen.slice(i)

    // Passt der Rest samt Abschlussblock auf diese Seite → letzte Seite
    if (summe(rest) + kap.abschluss <= verfuegbar) {
      seiten.push({ zeilen: rest, uebertragVor: erste ? null : lauf, zwischensummeNach: null, letzte: true })
      return seiten
    }

    // Sonst: so viele Zeilen wie neben der Zwischensumme Platz haben
    const grenze = verfuegbar - MASSE.zwischensumme
    const genommen: T[] = []
    let belegt = 0
    for (const z of rest) {
      if (belegt + z.hoehe > grenze && genommen.length > 0) break
      genommen.push(z)
      belegt += z.hoehe
    }
    // Keine verwaiste Hinweis- oder Leerzeile am Seitenende — sie gehört zu den Positionen der nächsten Seite
    while (genommen.length > 1 && genommen[genommen.length - 1]!.art !== 'pos') genommen.pop()

    lauf += betrag(genommen)
    seiten.push({ zeilen: genommen, uebertragVor: erste ? null : lauf - betrag(genommen), zwischensummeNach: lauf, letzte: false })
    i += genommen.length
  }
  return seiten
}
