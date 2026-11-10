/**
 * Sprachbestellung — die Liste der Vorschläge im Dialog (rein, ohne Browser-API).
 *
 * Ein Eintrag ist ein Vorschlag des Servers plus das, was der Kellner daran geändert hat: Menge und —
 * bei mehrdeutigen Treffern — der gewählte Artikel. Alles unveränderlich, damit React-State einfach bleibt.
 */

import type { SprachVorschlag, SprachVorschlagStatus, SpracheBestellungErgebnis } from '@kassa/shared'

const ZAHLWOERTER = ['', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf']

export const MENGE_MAX = 99

export interface SprachEintrag {
  /** Laufende Nummer im Dialog (stabiler Schlüssel) */
  id:        number
  vorschlag: SprachVorschlag
  /** Gewählter Artikel (null = nicht erkannt) — standardmäßig der beste Treffer */
  artikelId: string | null
  menge:     number
}

/** Einträge aus einem Server-Ergebnis; `startId` = nächste freie Nummer. */
export function ausErgebnis(e: SpracheBestellungErgebnis, startId: number): SprachEintrag[] {
  return e.vorschlaege.map((vorschlag, i) => ({
    id:        startId + i,
    vorschlag,
    artikelId: vorschlag.artikel?.id ?? null,
    menge:     vorschlag.menge,
  }))
}

/** Hat der Kellner statt des besten Treffers einen anderen Artikel gewählt? */
export function alternativeGewaehlt(eintrag: SprachEintrag): boolean {
  return eintrag.artikelId !== null && eintrag.artikelId !== (eintrag.vorschlag.artikel?.id ?? null)
}

export function waehleArtikel(eintrag: SprachEintrag, artikelId: string): SprachEintrag {
  return { ...eintrag, artikelId }
}

export function aendereMenge(eintrag: SprachEintrag, delta: number): SprachEintrag {
  return { ...eintrag, menge: Math.min(MENGE_MAX, Math.max(1, eintrag.menge + delta)) }
}

/**
 * Optionen des Vorschlags — gelten nur für den ursprünglich erkannten Artikel. Wählt der Kellner eine
 * Alternative, gehören sie zu einem anderen Artikel mit anderen Optionsgruppen und entfallen.
 */
export function optionenFuer(eintrag: SprachEintrag): SprachVorschlag['modifikatoren'] {
  return alternativeGewaehlt(eintrag) ? [] : eintrag.vorschlag.modifikatoren
}

/** Gesagte Optionen ohne passenden Modifikator (z. B. „ohne senf") — bleiben auch bei Alternative erhalten. */
export function hinweiseFuer(eintrag: SprachEintrag): string[] {
  return eintrag.vorschlag.hinweise
}

/** Ampel für die Anzeige: eine bewusst gewählte Alternative zählt als bestätigt. */
export function anzeigeStatus(eintrag: SprachEintrag): SprachVorschlagStatus {
  if (eintrag.artikelId === null) return 'unbekannt'
  if (alternativeGewaehlt(eintrag)) return 'sicher'
  return eintrag.vorschlag.status
}

/** Artikel zur Auswahl: der beste Treffer zuerst, dann die Alternativen des Servers. */
export function auswahlArtikel(eintrag: SprachEintrag): { id: string; bezeichnung: string }[] {
  const liste: { id: string; bezeichnung: string }[] = []
  if (eintrag.vorschlag.artikel) liste.push(eintrag.vorschlag.artikel)
  for (const a of eintrag.vorschlag.alternativen) liste.push({ id: a.id, bezeichnung: a.bezeichnung })
  return liste
}

/**
 * Text zum Vorlesen für die AKTUELLE Liste (also inklusive Änderungen des Kellners und weiterer Sätze).
 * Kurz gehalten: nur, was zur Kontrolle nötig ist.
 */
export function vorlesetextFuer(eintraege: readonly SprachEintrag[]): string {
  if (eintraege.length === 0) return 'Nichts verstanden.'
  const teile = eintraege.map(e => {
    if (e.artikelId === null) return `unklar: ${e.vorschlag.text}`
    const name = auswahlArtikel(e).find(a => a.id === e.artikelId)?.bezeichnung ?? e.vorschlag.text
    const zahl = ZAHLWOERTER[e.menge] || String(e.menge)
    return [`${zahl} ${name}`, ...optionenFuer(e).map(o => o.name), ...hinweiseFuer(e)].join(' ')
  })
  const alleSicher = eintraege.every(e => anzeigeStatus(e) === 'sicher')
  return `${teile.join(', ')}. ${alleSicher ? 'Richtig?' : 'Bitte prüfen.'}`
}

/** „Tisch 12", „12" und „tisch12" sind derselbe Tisch. */
function tischSchluessel(t: string): string {
  return t.toLowerCase().replace(/tisch/g, '').replace(/\s+/g, '')
}

/** Stimmt der gehörte Tisch mit dem geöffneten überein? (Ohne gehörten Tisch: ja.) */
export function tischStimmt(gehoert: string | null, geoeffnet: string | null): boolean {
  if (gehoert === null || geoeffnet === null) return true
  return tischSchluessel(gehoert) === tischSchluessel(geoeffnet)
}
