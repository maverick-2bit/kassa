/**
 * Sprachbestellung — Synonyme eines Artikels bearbeiten (rein, ohne Browser/Server).
 *
 * Der Server bereinigt und prüft alles noch einmal (services/sprache/synonyme.ts); die Regeln hier
 * sorgen dafür, dass der Betrieb SOFORT beim Eintippen eine verständliche Rückmeldung bekommt, statt
 * erst nach dem Speichern zu sehen, dass etwas still weggefallen ist.
 */

import { SYNONYME_MAX_JE_ARTIKEL, type SynonymKonflikt } from '@kassa/shared'

export const SYNONYM_MAX_LAENGE = 80

/** Schreibweise zum Vergleichen: Klein, ohne Umlaute/Akzente/Satzzeichen — „Krügerl" = „kruegerl" = „KRÜGERL!". */
export function synonymSchluessel(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface HinzufuegenErgebnis {
  /** Neue Liste (alle gültigen Eingaben sind drin) */
  liste:  string[]
  /** Erste Meldung zu einer abgelehnten Eingabe, sonst null */
  fehler: string | null
}

/**
 * Fügt eine Eingabe hinzu. Mehrere Namen mit Komma, Semikolon oder Zeilenumbruch getrennt („Seidl, Seidel")
 * werden einzeln übernommen. Ungültiges wird übersprungen, das Gültige bleibt — und die erste Meldung kommt zurück.
 */
export function fuegeSynonymeHinzu(liste: readonly string[], eingabe: string, eigeneBezeichnung: string): HinzufuegenErgebnis {
  // Trenner: Semikolon, Zeilenumbruch und Kommas — aber NICHT das Dezimalkomma zwischen Ziffern („Bier 0,3l")
  const teile = eingabe.split(/[;\n]|,(?!\d)|(?<!\d),/).map(t => t.trim()).filter(t => t !== '')
  if (teile.length === 0) return { liste: [...liste], fehler: 'Bitte einen Namen eingeben.' }

  const ergebnis = [...liste]
  const bekannt = new Set(ergebnis.map(synonymSchluessel))
  const eigen = synonymSchluessel(eigeneBezeichnung)
  let fehler: string | null = null
  const melde = (text: string) => { fehler ??= text }

  for (const text of teile) {
    const schluessel = synonymSchluessel(text)
    if (text.length > SYNONYM_MAX_LAENGE) { melde(`Höchstens ${SYNONYM_MAX_LAENGE} Zeichen.`); continue }
    if (schluessel === '') { melde('Bitte einen Namen mit Buchstaben oder Ziffern eingeben.'); continue }
    if (schluessel === eigen) { melde('Das ist schon der Name des Artikels.'); continue }
    if (bekannt.has(schluessel)) { melde('Dieses Synonym gibt es schon.'); continue }
    if (ergebnis.length >= SYNONYME_MAX_JE_ARTIKEL) { melde(`Höchstens ${SYNONYME_MAX_JE_ARTIKEL} Synonyme je Artikel.`); continue }
    ergebnis.push(text)
    bekannt.add(schluessel)
  }
  return { liste: ergebnis, fehler }
}

export function entferneSynonym(liste: readonly string[], index: number): string[] {
  return liste.filter((_, i) => i !== index)
}

/** Haben sich die Listen inhaltlich geändert (Reihenfolge zählt)? */
export function synonymeGeaendert(vorher: readonly string[], jetzt: readonly string[]): boolean {
  return vorher.length !== jetzt.length || vorher.some((s, i) => s !== jetzt[i])
}

/** Warntext zu einem Konflikt — sagt, WAS die Sprachbestellung deshalb tut. */
export function konfliktText(k: SynonymKonflikt): string {
  const was = k.art === 'bezeichnung' ? 'der Name von' : 'auch ein Synonym von'
  return `„${k.text}" ist ${was} „${k.artikelBezeichnung}". Die Sprachbestellung fragt dann nach, welcher gemeint ist.`
}
