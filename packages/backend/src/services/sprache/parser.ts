/**
 * Sprachbestellung — Satz-Parser (rein, ohne DB/IO).
 *
 * "Tisch zwölf, zwei Bier und ein Schnitzel ohne Pommes" →
 *   Tisch 12 · 2× Bier · 1× Schnitzel (Hinweis: ohne Pommes)
 *
 * Jeder Vorschlag trägt eine Konfidenz und einen Status:
 *   sicher    eindeutig erkannt — kann ohne Rückfrage in den Korb
 *   pruefen   erkannt, aber unsicher/mehrdeutig/mit unklarer Option — Kellner bestätigt
 *   unbekannt kein Artikel gefunden — wird dem Kellner als „nicht verstanden" gezeigt
 * Der Parser bucht nie selbst; er liefert nur Vorschläge für den normalen Korb.
 */

import { baueKatalog, type ArtikelEintrag, type SprachArtikel, type SprachKatalog } from './katalog.js'
import { findeBestenBereich, findeModifikator, POLARITAET, type SpanTreffer } from './matching.js'
import { tokenisiere } from './text.js'
import { zahlwort } from './zahlen.js'

export const SCHWELLEN = {
  /** Mindest-Score für „sicher" */
  sicher:  0.85,
  /** Darunter: kein Artikel erkannt */
  min:     0.6,
  /** Abstand zum zweitbesten Artikel, ab dem ein Treffer eindeutig ist */
  abstand: 0.05,
} as const

export type VorschlagStatus = 'sicher' | 'pruefen' | 'unbekannt'

export interface VorschlagModifikator {
  id:       string
  gruppeId: string
  name:     string
}

export interface VorschlagAlternative {
  id:          string
  bezeichnung: string
  konfidenz:   number
}

export interface Vorschlag {
  menge:         number
  /** Das Gesagte (normalisiert), für Anzeige und Fehlersuche */
  text:          string
  artikel:       { id: string; bezeichnung: string } | null
  konfidenz:     number
  status:        VorschlagStatus
  alternativen:  VorschlagAlternative[]
  modifikatoren: VorschlagModifikator[]
  /** Gesagte Optionen, die keinem Modifikator zugeordnet werden konnten ("ohne zwiebel") */
  hinweise:      string[]
}

export interface ParseErgebnis {
  tisch:       string | null
  platz:       string | null
  vorschlaege: Vorschlag[]
}

// ---------------------------------------------------------------------------
// Vorverarbeitung
// ---------------------------------------------------------------------------

const FUELLWOERTER = new Set([
  'bitte', 'aehm', 'ahm', 'aeh', 'hm', 'also', 'mal', 'halt', 'ok', 'okay', 'danke', 'hallo',
  'mir', 'uns', 'moechte', 'moechten', 'haette', 'haetten', 'gern', 'gerne',
  'bring', 'bringen', 'bringst', 'brauche', 'brauchen', 'kriege', 'kriegen', 'bestellung',
])

/** Trenner zwischen Positionen. Nur „und" kann auch Teil eines Artikelnamens sein ("Gin und Tonic"). */
const TRENNER = new Set([',', 'und', 'dann', 'sowie', 'ausserdem', 'plus', 'noch', 'dazu'])

const VOR_TISCH = new Set(['an', 'fuer', 'auf', 'bei', 'zu', 'am'])

function wert(token: string): string {
  const n = zahlwort(token)
  return n === null ? token.toUpperCase() : String(n)
}

/** Zieht „Tisch 12" und „Platz 2" aus dem Satz und gibt die restlichen Wörter zurück. */
function extrahiereTisch(tokens: string[]): { rest: string[]; tisch: string | null; platz: string | null } {
  const rest: string[] = []
  let tisch: string | null = null, platz: string | null = null
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const naechstes = tokens[i + 1]
    if (t === 'tisch' && naechstes !== undefined && naechstes !== ',') {
      tisch = wert(naechstes)
      i++
      if (rest.length > 0 && VOR_TISCH.has(rest[rest.length - 1]!)) rest.pop() // „an Tisch 5"
    } else if ((t === 'platz' || t === 'sitz') && naechstes !== undefined && naechstes !== ',') {
      platz = wert(naechstes)
      i++
    } else {
      rest.push(t)
    }
  }
  return { rest, tisch, platz }
}

interface Segment {
  trenner: string
  tokens:  string[]
}

function teileInSegmente(tokens: string[]): Segment[] {
  const segmente: Segment[] = []
  let aktuell: Segment = { trenner: '', tokens: [] }
  for (const t of tokens) {
    if (TRENNER.has(t)) {
      if (aktuell.tokens.length > 0) segmente.push(aktuell)
      aktuell = { trenner: t, tokens: [] }
    } else {
      aktuell.tokens.push(t)
    }
  }
  if (aktuell.tokens.length > 0) segmente.push(aktuell)
  return segmente
}

/** Führende Mengenangabe abtrennen. */
function trenneMenge(tokens: string[]): { menge: number; rest: string[] } {
  const n = tokens.length > 1 ? zahlwort(tokens[0]!) : null
  return n === null ? { menge: 1, rest: tokens } : { menge: Math.min(n, 99), rest: tokens.slice(1) }
}

/**
 * „Gin und Tonic" wird an „und" getrennt. Gibt es aber einen Artikel, der die zusammengesetzte Phrase
 * (fast) exakt trifft, gehören beide Teile zusammen.
 */
function fuegeUndNamenZusammen(katalog: SprachKatalog, segmente: Segment[]): Segment[] {
  const ergebnis: Segment[] = []
  for (let i = 0; i < segmente.length; i++) {
    const seg = segmente[i]!
    const naechstes = segmente[i + 1]
    if (naechstes && naechstes.trenner === 'und') {
      const { rest } = trenneMenge(seg.tokens)
      const zusammen = [...rest, 'und', ...naechstes.tokens]
      const bereich = findeBestenBereich(katalog, zusammen, 0.95)
      if (bereich && bereich.von === 0 && bereich.bis === zusammen.length) {
        const mengenToken = seg.tokens.slice(0, seg.tokens.length - rest.length)
        ergebnis.push({ trenner: seg.trenner, tokens: [...mengenToken, ...zusammen] })
        i++
        continue
      }
    }
    ergebnis.push(seg)
  }
  return ergebnis
}

// ---------------------------------------------------------------------------
// Optionen (Modifikatoren)
// ---------------------------------------------------------------------------

type Polaritaet = 'ohne' | 'mit' | null

interface OptionsGruppe {
  polaritaet: Polaritaet
  woerter:    string[]
}

/** Zerlegt übrige Wörter in Gruppen je „ohne"/„mit"; an den Grenzen des Artikelbereichs wird getrennt. */
function bildeOptionsGruppen(tokens: string[], bereich: { von: number; bis: number } | null): OptionsGruppe[] {
  const gruppen: OptionsGruppe[] = []
  let pol: Polaritaet = null
  let woerter: string[] = []
  const abschliessen = () => {
    if (woerter.length > 0) gruppen.push({ polaritaet: pol, woerter })
    woerter = []
  }
  for (let i = 0; i < tokens.length; i++) {
    if (bereich && i >= bereich.von && i < bereich.bis) {
      if (i === bereich.von) { abschliessen(); pol = null }
      continue
    }
    const marker = POLARITAET[tokens[i]!]
    if (marker) { abschliessen(); pol = marker; continue }
    woerter.push(tokens[i]!)
  }
  abschliessen()
  return gruppen
}

function loeseOptionen(
  artikel: ArtikelEintrag,
  gruppen: OptionsGruppe[],
  ziel: Pick<Vorschlag, 'modifikatoren' | 'hinweise'>,
): void {
  const beschriftung = (g: OptionsGruppe, w: string[]) => (g.polaritaet ? `${g.polaritaet} ` : '') + w.join(' ')
  const suche = (g: OptionsGruppe, w: string[]) => findeModifikator(artikel, g.polaritaet === 'ohne' ? ['ohne', ...w] : w)
  const nimm = (m: NonNullable<ReturnType<typeof suche>>) => {
    const { modifikator } = m.eintrag
    if (!ziel.modifikatoren.some(x => x.id === modifikator.id)) {
      ziel.modifikatoren.push({ id: modifikator.id, gruppeId: modifikator.gruppeId, name: modifikator.name })
    }
  }
  for (const g of gruppen) {
    const ganz = suche(g, g.woerter)
    if (ganz) { nimm(ganz); continue }
    // „ohne Zwiebel Gurken": jedes Wort einzeln — nur übernehmen, wenn ALLE passen
    if (g.woerter.length > 1) {
      const einzeln = g.woerter.map(w => suche(g, [w]))
      if (einzeln.every(x => x !== null)) { einzeln.forEach(x => nimm(x!)); continue }
    }
    ziel.hinweise.push(beschriftung(g, g.woerter))
  }
}

// ---------------------------------------------------------------------------
// Hauptfunktion
// ---------------------------------------------------------------------------

function bewerteStatus(bereich: SpanTreffer, hatHinweise: boolean): { status: VorschlagStatus; konfidenz: number } {
  const [top, zweiter] = bereich.kandidaten
  const konfidenz = top!.score
  const eindeutig = !zweiter || top!.score - zweiter.score >= SCHWELLEN.abstand
  if (konfidenz >= SCHWELLEN.sicher && eindeutig && !hatHinweise) return { status: 'sicher', konfidenz }
  return { status: 'pruefen', konfidenz }
}

/** `katalog` einmal mit baueKatalog() bauen; bei Artikeländerungen verwerfen und neu bauen. */
export function parseBestellung(katalog: SprachKatalog, transkript: string): ParseErgebnis {
  const alle = tokenisiere(transkript).filter(t => !FUELLWOERTER.has(t))
  const { rest, tisch, platz } = extrahiereTisch(alle)
  const segmente = fuegeUndNamenZusammen(katalog, teileInSegmente(rest))

  const vorschlaege: Vorschlag[] = []
  /** Polarität am Ende des letzten Segments: „ohne Zwiebel *und Gurken*" hängt „Gurken" an den Vorschlag davor */
  let offen: { vorschlag: Vorschlag; eintrag: ArtikelEintrag; polaritaet: Polaritaet } | null = null

  for (const seg of segmente) {
    const { menge, rest: tokens } = trenneMenge(seg.tokens)
    if (tokens.length === 0) continue
    // Mit Mengenangabe ("… und ein Sushi") beginnt immer eine neue Position
    const hatMenge = tokens.length < seg.tokens.length

    // Beginnt mit „ohne"/„mit": gehört zum Vorschlag davor
    if (offen && !hatMenge && tokens[0]! in POLARITAET) {
      const gruppen = bildeOptionsGruppen(tokens, null)
      loeseOptionen(offen.eintrag, gruppen, offen.vorschlag)
      offen.polaritaet = gruppen.at(-1)?.polaritaet ?? null
      if (offen.vorschlag.hinweise.length > 0 && offen.vorschlag.status === 'sicher') offen.vorschlag.status = 'pruefen'
      continue
    }

    const bereich = findeBestenBereich(katalog, tokens, SCHWELLEN.min)

    if (!bereich) {
      // Kein Artikel: nach „ohne Zwiebel und …" ist es eine weitere Option, sonst nicht verstanden
      if (offen && offen.polaritaet && !hatMenge) {
        const gruppen: OptionsGruppe[] = [{ polaritaet: offen.polaritaet, woerter: tokens }]
        loeseOptionen(offen.eintrag, gruppen, offen.vorschlag)
        if (offen.vorschlag.hinweise.length > 0 && offen.vorschlag.status === 'sicher') offen.vorschlag.status = 'pruefen'
        continue
      }
      offen = null
      vorschlaege.push({
        menge, text: tokens.join(' '), artikel: null, konfidenz: 0, status: 'unbekannt',
        alternativen: [], modifikatoren: [], hinweise: [],
      })
      continue
    }

    const top = bereich.kandidaten[0]!
    const vorschlag: Vorschlag = {
      menge,
      text:      tokens.join(' '),
      artikel:   { id: top.eintrag.artikel.id, bezeichnung: top.eintrag.artikel.bezeichnung },
      konfidenz: top.score,
      status:    'pruefen',
      alternativen: bereich.kandidaten.slice(1)
        .filter(k => k.score >= top.score - 0.25)
        .map(k => ({ id: k.eintrag.artikel.id, bezeichnung: k.eintrag.artikel.bezeichnung, konfidenz: k.score })),
      modifikatoren: [],
      hinweise:      [],
    }
    const gruppen = bildeOptionsGruppen(tokens, bereich)
    loeseOptionen(top.eintrag, gruppen, vorschlag)
    Object.assign(vorschlag, bewerteStatus(bereich, vorschlag.hinweise.length > 0))
    vorschlaege.push(vorschlag)

    // Hängt die letzte Gruppe hinter dem Artikel mit „ohne/mit", kann der nächste Satzteil dazugehören
    const letzte = gruppen.at(-1)
    offen = { vorschlag, eintrag: top.eintrag, polaritaet: letzte?.polaritaet ?? null }
  }

  return { tisch, platz, vorschlaege }
}

/** Bequemer Einstieg für Tests und einmalige Aufrufe: Index bauen und parsen. */
export function parseBestellungAusArtikeln(artikel: SprachArtikel[], transkript: string): ParseErgebnis {
  return parseBestellung(baueKatalog(artikel), transkript)
}
