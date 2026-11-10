/**
 * Sprachbestellung — Synonyme bereinigen und Konflikte finden (rein, ohne DB/IO).
 */

import type { SynonymKonflikt } from '@kassa/shared'
import { tokenisiere } from './text.js'

/** Schreibweise für Eindeutigkeit und Abgleich: normalisiert, ohne Kommas, Wörter durch Leerzeichen. */
export function synonymSchluessel(text: string): string {
  return tokenisiere(text).filter(t => t !== ',').join(' ')
}

export interface BereinigtesSynonym {
  /** Anzeige-Schreibweise (getrimmt, wie eingegeben) */
  text:     string
  /** normalisierter Schlüssel */
  textNorm: string
}

/**
 * Entfernt Leeres, Dubletten (erste Schreibweise bleibt) und die eigene Bezeichnung des Artikels —
 * die ist als Synonym wirkungslos. Reihenfolge bleibt erhalten.
 */
export function bereinigeSynonyme(texte: string[], eigeneBezeichnung: string): BereinigtesSynonym[] {
  const eigen = synonymSchluessel(eigeneBezeichnung)
  const gesehen = new Set<string>([eigen])
  const ergebnis: BereinigtesSynonym[] = []
  for (const roh of texte) {
    const text = roh.trim()
    const textNorm = synonymSchluessel(text)
    if (textNorm === '' || gesehen.has(textNorm)) continue
    gesehen.add(textNorm)
    ergebnis.push({ text, textNorm })
  }
  return ergebnis
}

export interface AndererArtikelName {
  artikelId:   string
  bezeichnung: string
  /** normalisierter Schlüssel der Bezeichnung bzw. des Synonyms */
  textNorm:    string
  art:         'bezeichnung' | 'synonym'
}

/**
 * Synonyme, die auch einen ANDEREN Artikel meinen. Eine Bezeichnung hat Vorrang vor einem Synonym,
 * je Synonym wird nur der erste Treffer gemeldet.
 */
export function findeKonflikte(neu: BereinigtesSynonym[], andere: AndererArtikelName[]): SynonymKonflikt[] {
  const nachSchluessel = new Map<string, AndererArtikelName>()
  for (const a of andere) {
    const vorhanden = nachSchluessel.get(a.textNorm)
    if (!vorhanden || (vorhanden.art === 'synonym' && a.art === 'bezeichnung')) nachSchluessel.set(a.textNorm, a)
  }
  const konflikte: SynonymKonflikt[] = []
  for (const s of neu) {
    const treffer = nachSchluessel.get(s.textNorm)
    if (treffer) {
      konflikte.push({ text: s.text, artikelId: treffer.artikelId, artikelBezeichnung: treffer.bezeichnung, art: treffer.art })
    }
  }
  return konflikte
}
