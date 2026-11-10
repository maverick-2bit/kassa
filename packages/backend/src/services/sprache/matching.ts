/**
 * Sprachbestellung — unscharfer Abgleich Text ↔ Artikel/Modifikator (rein, ohne DB/IO).
 *
 * Bewertung 0..1 je Schreibweise:
 *  - Dice über Wörter: wie viel vom Gesagten und vom Artikelnamen passt zusammen?
 *  - Enthalten: alles Gesagte kommt im Namen vor ("Schnitzel" ↔ "Wiener Schnitzel"). Je kürzer das
 *    Gesagte im Vergleich zum Namen, desto weniger sicher (0.8 … 1.0), damit der vollständige
 *    Name einen Teiltreffer schlägt und mehrdeutige Kurzformen auffallen.
 */

import type { ArtikelEintrag, ModifikatorEintrag, SprachKatalog, Variante } from './katalog.js'
import { koelnerPhonetik, wortAehnlichkeit } from './text.js'

/** Wörter, die eine Option einleiten statt zum Artikelnamen zu gehören. */
export const POLARITAET: Record<string, 'ohne' | 'mit'> = {
  ohne: 'ohne', kein: 'ohne', keine: 'ohne', keinen: 'ohne', keinem: 'ohne',
  mit: 'mit', extra: 'mit',
}

/** Mindest-Wortähnlichkeit, ab der zwei Wörter als „dasselbe" zählen. */
const WORT_SCHWELLE = 0.7

export interface Phrase {
  tokens: string[]
  codes:  string[]
}

export function machePhrase(tokens: string[]): Phrase {
  return { tokens, codes: tokens.map(koelnerPhonetik) }
}

/** Bewertung einer gesagten Phrase gegen eine Schreibweise (0..1). */
export function bewerte(
  phrase: Phrase,
  v: Variante,
  wortSim: (i: number, j: number) => number = (i, j) => wortAehnlichkeit(phrase.tokens[i]!, v.tokens[j]!, phrase.codes[i], v.codes[j]),
): number {
  const p = phrase.tokens, n = p.length, m = v.tokens.length
  if (n === 0 || m === 0) return 0

  // Alle Wortpaare bewerten, dann gierig die besten zuerst zuordnen (jedes Wort nur einmal)
  const paare: { i: number; j: number; s: number }[] = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const s = wortSim(i, j)
      if (s >= WORT_SCHWELLE) paare.push({ i, j, s })
    }
  }
  paare.sort((a, b) => b.s - a.s)
  const benutztP = new Set<number>(), benutztV = new Set<number>()
  let summe = 0
  for (const x of paare) {
    if (benutztP.has(x.i) || benutztV.has(x.j)) continue
    benutztP.add(x.i); benutztV.add(x.j)
    summe += x.s
  }

  const dice = (2 * summe) / (n + m)
  if (benutztP.size < n) return dice
  const enthalten = (summe / n) * (0.8 + 0.2 * (n / m))
  return Math.max(dice, enthalten)
}

export interface Treffer {
  eintrag: ArtikelEintrag
  score:   number
}

/** Bester Wert über alle Schreibweisen eines Artikels. */
export function bewerteArtikel(phrase: Phrase, e: ArtikelEintrag): number {
  let best = 0
  for (const v of e.varianten) best = Math.max(best, bewerte(phrase, v))
  return best
}

const MAX_CACHE_WOERTER = 3000

/** Katalogwörter, die einem gesagten Wort ähnlich genug sind (mit Ähnlichkeit) — je Wort einmal berechnet. */
function aehnlicheKatalogwoerter(katalog: SprachKatalog, token: string): Map<string, number> {
  let treffer = katalog.aehnlichkeiten.get(token)
  if (treffer) return treffer
  if (katalog.aehnlichkeiten.size >= MAX_CACHE_WOERTER) katalog.aehnlichkeiten.clear()
  treffer = new Map()
  const code = koelnerPhonetik(token)
  for (const [wort, refs] of katalog.wortIndex) {
    const s = wortAehnlichkeit(token, wort, code, refs[0]!.variante.codes[refs[0]!.variante.tokens.indexOf(wort)])
    if (s >= WORT_SCHWELLE) treffer.set(wort, s)
  }
  katalog.aehnlichkeiten.set(token, treffer)
  return treffer
}

/** Alle Artikel mit Score ≥ minScore, beste zuerst. Geprüft werden nur Artikel mit mindestens einem ähnlichen Wort. */
export function findeArtikel(katalog: SprachKatalog, tokens: string[], minScore = 0.5): Treffer[] {
  const phrase = machePhrase(tokens)
  const sims = tokens.map(t => aehnlicheKatalogwoerter(katalog, t))

  // Kandidaten: Schreibweisen, die mindestens ein ähnliches Wort enthalten
  const kandidaten = new Map<number, Set<Variante>>()
  for (const treffer of sims) {
    for (const wort of treffer.keys()) {
      for (const ref of katalog.wortIndex.get(wort)!) {
        const menge = kandidaten.get(ref.eintrag)
        if (menge) menge.add(ref.variante)
        else kandidaten.set(ref.eintrag, new Set([ref.variante]))
      }
    }
  }

  const ergebnis: Treffer[] = []
  for (const [idx, varianten] of kandidaten) {
    let score = 0
    for (const v of varianten) {
      score = Math.max(score, bewerte(phrase, v, (i, j) => sims[i]!.get(v.tokens[j]!) ?? 0))
    }
    if (score >= minScore) ergebnis.push({ eintrag: katalog.eintraege[idx]!, score })
  }
  return ergebnis.sort((a, b) => b.score - a.score)
}

export interface SpanTreffer {
  /** Tokenbereich [von, bis) im untersuchten Satzteil */
  von: number
  bis: number
  /** Kandidaten für genau diesen Bereich, beste zuerst */
  kandidaten: Treffer[]
}

const MAX_SPAN = 6

/**
 * Sucht im Satzteil den zusammenhängenden Bereich, der am besten zu einem Artikel passt.
 * Die übrigen Wörter ("großes", "ohne Zwiebel") sind dann Optionen. Bei gleichem Score gewinnt
 * der längere Bereich. Bereiche dürfen nicht mit einem Optionswort ("ohne", "mit") beginnen/enden.
 */
export function findeBestenBereich(katalog: SprachKatalog, tokens: string[], minScore = 0.6): SpanTreffer | null {
  let bester: SpanTreffer | null = null
  let besterScore = 0
  for (let von = 0; von < tokens.length; von++) {
    if (tokens[von]! in POLARITAET) continue
    // Wörter direkt nach „ohne"/„mit" sind Optionen, kein Artikel („Schnitzel ohne Pommes" ≠ Pommes bestellt)
    if (von > 0 && tokens[von - 1]! in POLARITAET) continue
    for (let bis = von + 1; bis <= Math.min(tokens.length, von + MAX_SPAN); bis++) {
      if (tokens[bis - 1]! in POLARITAET) continue
      const kandidaten = findeArtikel(katalog, tokens.slice(von, bis), minScore)
      const top = kandidaten[0]
      if (!top) continue
      const besser = top.score > besterScore + 0.001
        || (Math.abs(top.score - besterScore) <= 0.001 && bester && bis - von > bester.bis - bester.von)
      if (besser) {
        besterScore = top.score
        bester = { von, bis, kandidaten: kandidaten.slice(0, 4) }
      }
    }
  }
  return bester
}

export interface ModifikatorTreffer {
  eintrag: ModifikatorEintrag
  score:   number
}

/** Bester passender Modifikator des Artikels für die Phrase (nur eindeutig, sonst null). */
export function findeModifikator(artikel: ArtikelEintrag, tokens: string[], minScore = 0.85): ModifikatorTreffer | null {
  if (tokens.length === 0) return null
  const phrase = machePhrase(tokens)
  const gesagtOhne = POLARITAET[tokens[0]!] === 'ohne'
  const liste: ModifikatorTreffer[] = []
  for (const eintrag of artikel.modifikatoren) {
    let score = 0
    for (const v of eintrag.varianten) {
      // „mit Zwiebel" darf nie auf die Option „ohne Zwiebel" passen (und umgekehrt)
      if ((POLARITAET[v.tokens[0]!] === 'ohne') !== gesagtOhne) continue
      score = Math.max(score, bewerte(phrase, v))
    }
    if (score >= minScore) liste.push({ eintrag, score })
  }
  liste.sort((a, b) => b.score - a.score)
  const top = liste[0]
  if (!top) return null
  const zweiter = liste[1]
  if (zweiter && top.score - zweiter.score < 0.05) return null // mehrdeutig → Hinweis statt Raten
  return top
}
