/**
 * Sprachbestellung — Katalog-Index (rein, ohne DB/IO).
 *
 * Der Aufrufer (später die Route) lädt Artikel + Synonyme + Modifikatoren des Mandanten und
 * baut hieraus einmal einen Index. Der Index ist unveränderlich und wird zwischengespeichert;
 * bei Artikeländerungen wird er verworfen und neu gebaut.
 */

import { koelnerPhonetik, tokenisiere } from './text.js'

export interface SprachModifikator {
  id:        string
  gruppeId:  string
  name:      string
  synonyme?: string[]
}

export interface SprachArtikel {
  id:            string
  bezeichnung:   string
  /** Umgangssprachliche Namen ("Gespritzter", "Kracherl", "Seidl") */
  synonyme?:     string[]
  /** Modifikatoren aller Gruppen dieses Artikels (flach) */
  modifikatoren?: SprachModifikator[]
}

/** Eine Schreibweise (Bezeichnung oder Synonym) in vorberechneter Form. */
export interface Variante {
  tokens: string[]
  codes:  string[]
}

export interface ModifikatorEintrag {
  modifikator: SprachModifikator
  varianten:   Variante[]
}

export interface ArtikelEintrag {
  artikel:       SprachArtikel
  varianten:     Variante[]
  modifikatoren: ModifikatorEintrag[]
}

/** Verweis von einem Wort des Katalogs auf die Schreibweise, in der es vorkommt. */
export interface VarianteRef {
  eintrag:  number
  variante: Variante
}

export interface SprachKatalog {
  eintraege: ArtikelEintrag[]
  /** Wort → alle Schreibweisen (über alle Artikel), die es enthalten. Damit werden nur Artikel geprüft, die überhaupt ein ähnliches Wort haben. */
  wortIndex: Map<string, VarianteRef[]>
  /** Gesagtes Wort → (Katalogwort → Ähnlichkeit ≥ Schwelle). Wächst mit dem Gesagten, wird bei Überlauf geleert. */
  aehnlichkeiten: Map<string, Map<string, number>>
}

export function baueVariante(text: string): Variante {
  const tokens = tokenisiere(text).filter(t => t !== ',')
  return { tokens, codes: tokens.map(koelnerPhonetik) }
}

function bauVarianten(namen: string[]): Variante[] {
  const gesehen = new Set<string>()
  const ergebnis: Variante[] = []
  for (const name of namen) {
    const v = baueVariante(name)
    const schluessel = v.tokens.join(' ')
    if (v.tokens.length === 0 || gesehen.has(schluessel)) continue
    gesehen.add(schluessel)
    ergebnis.push(v)
  }
  return ergebnis
}

export function baueKatalog(artikel: SprachArtikel[]): SprachKatalog {
  const eintraege: ArtikelEintrag[] = artikel.map(a => ({
    artikel:   a,
    varianten: bauVarianten([a.bezeichnung, ...(a.synonyme ?? [])]),
    modifikatoren: (a.modifikatoren ?? []).map(m => ({
      modifikator: m,
      varianten:   bauVarianten([m.name, ...(m.synonyme ?? [])]),
    })),
  }))
  const wortIndex = new Map<string, VarianteRef[]>()
  eintraege.forEach((e, idx) => {
    for (const variante of e.varianten) {
      for (const token of new Set(variante.tokens)) {
        const liste = wortIndex.get(token)
        if (liste) liste.push({ eintrag: idx, variante })
        else wortIndex.set(token, [{ eintrag: idx, variante }])
      }
    }
  })
  return { eintraege, wortIndex, aehnlichkeiten: new Map() }
}
