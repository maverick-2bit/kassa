/**
 * Auswahl im Optionen-Dialog → Positionen für den Warenkorb.
 *
 * Normal ist die Auswahl EINE Position mit allen gewählten Optionen (z. B. Schnitzel mit Senf und Kren).
 * Ist an einer Optionsgruppe „Jede Auswahl = eigener Artikel" gesetzt (`jeAuswahlArtikel`), wird dagegen jede gewählte
 * Option — samt ihrer Anzahl — eine eigene Position: „süß", „Sommer" und „weiß" bei einem Spritzer sind drei Getränke,
 * 2× „weiß" sind zwei. Die Optionen der übrigen Gruppen hängen an jeder dieser Positionen.
 *
 * Gibt es mehrere aufteilende Gruppen mit Auswahl, teilt nur die erste auf; die anderen verhalten sich wie normale
 * Gruppen (kein Kreuzprodukt).
 */

import type { ModifikatorAuswahl, ModifikatorGruppe } from './schemas/modifikator.js'

/** gruppeId → (optionId → Anzahl); fehlende oder 0 = nicht gewählt */
export type OptionenMengen = ReadonlyMap<string, ReadonlyMap<string, number>>

export interface AuswahlPosition {
  modifikatoren: ModifikatorAuswahl[]
  /** Anzahl dieser Position (bei aufgeteilten Gruppen: wie oft die Option gewählt wurde) */
  menge:         number
}

const anzahl = (mengen: OptionenMengen, gruppeId: string, optionId: string): number =>
  mengen.get(gruppeId)?.get(optionId) ?? 0

/** Summe der gewählten Anzahlen einer Gruppe. */
export function gruppenSumme(mengen: OptionenMengen, gruppeId: string): number {
  let summe = 0
  for (const n of mengen.get(gruppeId)?.values() ?? []) summe += n
  return summe
}

/** Sind alle Pflichtgruppen bedient (mindestens eine Option gewählt)? */
export function auswahlGueltig(gruppen: readonly ModifikatorGruppe[], mengen: OptionenMengen): boolean {
  return gruppen.filter(g => g.typ === 'pflicht').every(g => gruppenSumme(mengen, g.id) > 0)
}

/** Die Positionen, die aus der Auswahl entstehen (immer mindestens eine). */
export function baueAuswahlPositionen(
  gruppen: readonly ModifikatorGruppe[],
  mengen: OptionenMengen,
): AuswahlPosition[] {
  const gewaehlt = gruppen.map(gruppe => ({
    gruppe,
    eintraege: gruppe.modifikatoren
      .filter(m => anzahl(mengen, gruppe.id, m.id) > 0)
      .map(mod => ({ mod, n: anzahl(mengen, gruppe.id, mod.id) })),
  }))

  const alsAuswahl = (gruppe: ModifikatorGruppe, mod: ModifikatorGruppe['modifikatoren'][number], n: number): ModifikatorAuswahl => ({
    modifikatorId: mod.id,
    gruppeId:      gruppe.id,
    gruppeName:    gruppe.name,
    name:          mod.name,
    aufschlagCent: mod.aufschlagCent,
    ...(n > 1 && { menge: n }),
  })

  const teiler = gewaehlt.find(g => g.gruppe.jeAuswahlArtikel && g.eintraege.length > 0)
  const uebrige = gewaehlt
    .filter(g => g !== teiler)
    .flatMap(g => g.eintraege.map(e => alsAuswahl(g.gruppe, e.mod, e.n)))

  if (!teiler) return [{ modifikatoren: uebrige, menge: 1 }]

  return teiler.eintraege.map(e => ({
    // Die aufgeteilte Option steht einmal an der Position — die Anzahl steckt in `menge` der Position
    modifikatoren: [alsAuswahl(teiler.gruppe, e.mod, 1), ...uebrige],
    menge:         e.n,
  }))
}
