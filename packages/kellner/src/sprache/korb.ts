/**
 * Sprachbestellung — aus den Einträgen Korb-Positionen bauen (rein, ohne Browser-API).
 *
 * Dieselben Regeln wie beim Antippen in der Artikelseite: Aufschläge der Optionen kommen auf den
 * Preis, „jede Auswahl = eigener Artikel" teilt in mehrere Positionen (@kassa/shared baueAuswahlPositionen),
 * Pflichtgruppen müssen bedient sein. Was sich daraus NICHT zweifelsfrei ergibt, wird nicht geraten,
 * sondern als „offen" zurückgegeben — der Kellner wählt die Optionen dann von Hand.
 */

import { baueAuswahlPositionen, type Artikel, type ModifikatorAuswahl, type ModifikatorGruppe } from '@kassa/shared'
import { hinweiseFuer, optionenFuer, type SprachEintrag } from './eintraege'

export interface KorbPosition {
  /** Artikel mit bereits eingerechnetem Options-Aufschlag (wie in der Artikelseite) */
  artikel:       Artikel
  menge:         number
  modifikatoren: ModifikatorAuswahl[]
}

export interface OffenerEintrag {
  eintrag: SprachEintrag
  /** null = nicht erkannt bzw. Artikel nicht (mehr) vorhanden → nur entfernen */
  artikel: Artikel | null
  grund:   string
}

export interface KorbErgebnis {
  positionen: KorbPosition[]
  offen:      OffenerEintrag[]
}

export function baueKorbPositionen(
  eintraege: readonly SprachEintrag[],
  artikelListe: readonly Artikel[],
  /** Optionsgruppen je Artikel-ID (nur aktive werden beachtet) */
  gruppenJe: ReadonlyMap<string, readonly ModifikatorGruppe[]>,
): KorbErgebnis {
  const positionen: KorbPosition[] = []
  const offen: OffenerEintrag[] = []

  for (const eintrag of eintraege) {
    if (eintrag.artikelId === null) {
      offen.push({ eintrag, artikel: null, grund: `Nicht verstanden: „${eintrag.vorschlag.text}"` })
      continue
    }
    const artikel = artikelListe.find(a => a.id === eintrag.artikelId)
    if (!artikel) {
      offen.push({ eintrag, artikel: null, grund: 'Artikel an dieser Kasse nicht verfügbar' })
      continue
    }
    if (artikel.lagerstandMenge !== null && artikel.lagerstandMenge !== undefined && artikel.lagerstandMenge <= 0) {
      offen.push({ eintrag, artikel, grund: 'Ausverkauft' })
      continue
    }

    const gruppen = (gruppenJe.get(artikel.id) ?? []).filter(g => g.aktiv)
    const mengen = new Map<string, Map<string, number>>()
    let grund: string | null = null

    for (const o of optionenFuer(eintrag)) {
      const gruppe = gruppen.find(g => g.id === o.gruppeId)
      const mod = gruppe?.modifikatoren.find(m => m.id === o.id && m.aktiv)
      if (!gruppe || !mod) { grund = `Option „${o.name}" nicht mehr verfügbar`; break }
      const inGruppe = mengen.get(gruppe.id) ?? new Map<string, number>()
      inGruppe.set(mod.id, 1)
      mengen.set(gruppe.id, inGruppe)
    }

    const hinweise = hinweiseFuer(eintrag)
    if (!grund && hinweise.length > 0) grund = `Nicht übernehmbar: ${hinweise.join(', ')}`

    if (!grund) {
      const zuViele = gruppen.find(g => g.maxAuswahl !== null && [...(mengen.get(g.id)?.values() ?? [])].reduce((s, n) => s + n, 0) > g.maxAuswahl)
      if (zuViele) grund = `Zu viele Optionen bei „${zuViele.name}"`
    }
    if (!grund) {
      const fehlend = gruppen.filter(g => g.typ === 'pflicht' && (mengen.get(g.id)?.size ?? 0) === 0)
      if (fehlend.length > 0) grund = `Pflicht-Option fehlt: ${fehlend.map(g => g.name).join(', ')}`
    }

    if (grund) {
      offen.push({ eintrag, artikel, grund })
      continue
    }

    for (const p of baueAuswahlPositionen(gruppen, mengen)) {
      const aufschlag = p.modifikatoren.reduce((s, m) => s + m.aufschlagCent * (m.menge ?? 1), 0)
      positionen.push({
        artikel:       { ...artikel, preisBruttoCent: artikel.preisBruttoCent + aufschlag },
        menge:         eintrag.menge * p.menge,
        modifikatoren: p.modifikatoren,
      })
    }
  }

  return { positionen, offen }
}
