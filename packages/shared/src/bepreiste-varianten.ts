/**
 * Bepreiste Varianten — Artikel, bei denen die Option den Preis bestimmt.
 *
 * Aus dem Altsystem kommen Artikel, deren Preis erst in der Option steht: „Bier" mit Basispreis 0,00 und den
 * Varianten „0,33l" (+4,00) und „0,5l" (+5,00), oder „Spritzer" 4,00 mit „Muskatellerspritzer" (+0,50).
 * Solange die Kasse nach Optionen fragt, passt das. Wird die Abfrage abgeschaltet (Artikel → Warengruppe →
 * Kasse, siehe optionen-abfrage.ts), fällt die Preisauswahl weg und der Artikel wird mit dem Basispreis
 * boniert — beim Bier also mit 0,00.
 *
 * Hier steht, wie solche Artikel gefunden werden und was beim Auflösen entsteht:
 *  - `findeBepreisteVarianten` listet die Artikel samt ihren preisbestimmenden Optionen; `kassenOhneAbfrage`
 *    sagt, an welchen Kassen schon jetzt falsch boniert wird (akuter Fall).
 *  - `planeVariantenArtikel` rechnet Bezeichnung und Preis der eigenen Artikel aus, die daraus werden.
 *
 * WICHTIG: Optionsgruppen werden geteilt — dieselbe Gruppe „Variante (0,33l / 0,5l)" hängt oft an allen
 * Bieren (der Import verwendet inhaltsgleiche Gruppen wieder). Aufgelöst wird deshalb immer nur das Paar
 * Artikel + Gruppe: die Gruppe wird von DIESEM Artikel gelöst, für die anderen bleibt sie unberührt.
 */

import { fragtNachOptionen, warengruppenWahl, type OptionenAbfrageWahl } from './optionen-abfrage.js'

/** Artikel, soweit für die Erkennung nötig. */
export interface VariantenArtikel {
  id:               string
  bezeichnung:      string
  preisBruttoCent:  number
  kategorieId:      string | null
  aktiv:            boolean
  optionenAbfrage?: OptionenAbfrageWahl | undefined
}

/** Optionsgruppe samt Optionen, soweit für die Erkennung nötig. */
export interface VariantenGruppe {
  id:            string
  name:          string
  aktiv:         boolean
  modifikatoren: readonly { id: string; name: string; aufschlagCent: number; aktiv: boolean }[]
}

/** Warengruppe, soweit für die Vererbung der Abfrage nötig. */
export interface VariantenKategorie {
  id:               string
  parentId:         string | null
  optionenAbfrage?: OptionenAbfrageWahl | undefined
}

/** Kasse mit ihrer Einstellung „Optionen im Direktverkauf abfragen". */
export interface VariantenKasse {
  name:            string
  optionenAbfrage: boolean
}

/** Eine Option, die den Preis bestimmt (Auf- oder Abschlag ≠ 0). */
export interface BepreisteOption {
  id:            string
  name:          string
  aufschlagCent: number
}

/** Eine Optionsgruppe eines Artikels mit ihren preisbestimmenden Optionen. */
export interface BetroffeneGruppe {
  gruppeId:   string
  gruppeName: string
  /** Nur die noch offenen Optionen mit Auf-/Abschlag, in Reihenfolge der Gruppe */
  optionen:   BepreisteOption[]
  /** Anzahl WEITERER Artikel an derselben Gruppe — dort bleibt sie unberührt */
  weitereArtikel: number
}

/** Ein Artikel, dessen Preis an den Optionen hängt. */
export interface BetroffenerArtikel {
  artikelId:       string
  bezeichnung:     string
  preisBruttoCent: number
  kategorieId:     string | null
  gruppen:         BetroffeneGruppe[]
  /** Namen der Kassen, an denen im Direktverkauf NICHT gefragt wird — dort fehlt die Preisauswahl */
  kassenOhneAbfrage: string[]
}

/** Wird der Artikel an mindestens einer Kasse ohne Preisauswahl boniert? Dann ist der Preis jetzt falsch. */
export const istAkut = (a: Pick<BetroffenerArtikel, 'kassenOhneAbfrage'>): boolean => a.kassenOhneAbfrage.length > 0

/**
 * Alle Artikel, deren Optionen den Preis bestimmen — akute zuerst (dort wird schon jetzt falsch boniert),
 * danach alphabetisch.
 *
 * Gezählt wird nur, was im Verkauf wirkt: aktive Artikel, aktive Gruppen, aktive Optionen mit Aufschlag ≠ 0.
 * Bereits erledigte Optionen (eigener Artikel angelegt oder verworfen) fallen heraus; eine Gruppe ohne offene
 * Option erscheint nicht mehr.
 */
export function findeBepreisteVarianten(eingabe: {
  artikel:     readonly VariantenArtikel[]
  kategorien:  readonly VariantenKategorie[]
  gruppen:     readonly VariantenGruppe[]
  zuweisungen: readonly { artikelId: string; gruppeId: string }[]
  kassen:      readonly VariantenKasse[]
  /** Paare, die der Benutzer schon aufgelöst hat */
  erledigt?:   readonly { artikelId: string; modifikatorId: string }[]
}): BetroffenerArtikel[] {
  const { artikel, kategorien, gruppen, zuweisungen, kassen } = eingabe

  const gruppeById = new Map(gruppen.map(g => [g.id, g] as const))
  const erledigt   = new Set((eingabe.erledigt ?? []).map(e => `${e.artikelId}|${e.modifikatorId}`))

  // Wie oft hängt eine Gruppe an einem aktiven Artikel? (für „weitereArtikel")
  const aktiveArtikelIds = new Set(artikel.filter(a => a.aktiv).map(a => a.id))
  const artikelJeGruppe  = new Map<string, number>()
  for (const z of zuweisungen) {
    if (!aktiveArtikelIds.has(z.artikelId)) continue
    artikelJeGruppe.set(z.gruppeId, (artikelJeGruppe.get(z.gruppeId) ?? 0) + 1)
  }

  const gruppenJeArtikel = new Map<string, string[]>()
  for (const z of zuweisungen) {
    const liste = gruppenJeArtikel.get(z.artikelId) ?? []
    liste.push(z.gruppeId)
    gruppenJeArtikel.set(z.artikelId, liste)
  }

  const treffer: BetroffenerArtikel[] = []

  for (const a of artikel) {
    if (!a.aktiv) continue

    const betroffene: BetroffeneGruppe[] = []
    for (const gruppeId of gruppenJeArtikel.get(a.id) ?? []) {
      const gruppe = gruppeById.get(gruppeId)
      if (!gruppe || !gruppe.aktiv) continue
      const optionen = gruppe.modifikatoren
        .filter(m => m.aktiv && m.aufschlagCent !== 0 && !erledigt.has(`${a.id}|${m.id}`))
        .map(m => ({ id: m.id, name: m.name, aufschlagCent: m.aufschlagCent }))
      if (optionen.length === 0) continue
      betroffene.push({
        gruppeId:       gruppe.id,
        gruppeName:     gruppe.name,
        optionen,
        weitereArtikel: Math.max(0, (artikelJeGruppe.get(gruppe.id) ?? 0) - 1),
      })
    }
    if (betroffene.length === 0) continue

    // Die Abfrage-Regel ist je Kasse verschieden (Rangfolge Artikel → Warengruppe → Kasse)
    const warengruppe = warengruppenWahl(
      kategorien.map(k => ({ id: k.id, parentId: k.parentId, optionenAbfrage: k.optionenAbfrage })),
      a.kategorieId,
    )
    const kassenOhneAbfrage = kassen
      .filter(k => !fragtNachOptionen({ kasse: k.optionenAbfrage, warengruppe, artikel: a.optionenAbfrage }))
      .map(k => k.name)

    treffer.push({
      artikelId:       a.id,
      bezeichnung:     a.bezeichnung,
      preisBruttoCent: a.preisBruttoCent,
      kategorieId:     a.kategorieId,
      gruppen:         betroffene,
      kassenOhneAbfrage,
    })
  }

  return treffer.sort((x, y) =>
    Number(istAkut(y)) - Number(istAkut(x)) ||
    x.bezeichnung.localeCompare(y.bezeichnung, 'de')
  )
}

// ---------------------------------------------------------------------------
// Auflösen: aus einer Option wird ein eigener Artikel
// ---------------------------------------------------------------------------

const klein = (s: string) => s.trim().toLocaleLowerCase('de')

/**
 * Bezeichnung des eigenen Artikels: Artikel + Option („Bier" + „0,5l" → „Bier 0,5l").
 * Steckt der Artikelname schon in der Option, bleibt die Option allein stehen — aus „Spritzer" +
 * „Muskatellerspritzer" wird „Muskatellerspritzer", nicht „Spritzer Muskatellerspritzer".
 */
export function variantenBezeichnung(artikel: string, option: string): string {
  const a = klein(artikel), o = klein(option)
  if (a.length > 0 && o.includes(a)) return option.trim()
  return `${artikel.trim()} ${option.trim()}`.trim()
}

/** Preis des eigenen Artikels: Basispreis + Aufschlag, nie unter 0 (Abschläge können größer sein als der Preis). */
export const variantenPreisCent = (basisCent: number, aufschlagCent: number): number =>
  Math.max(0, basisCent + aufschlagCent)

export interface VariantenPlanEintrag {
  modifikatorId:   string
  bezeichnung:     string
  preisBruttoCent: number
  /** Ein Artikel dieses Namens liegt in derselben Warengruppe schon vor → wird nicht noch einmal angelegt */
  vorhanden:       boolean
}

/**
 * Was beim Anlegen entsteht — dieselbe Rechnung zeigt die Vorschau und führt der Server aus.
 *
 * Doppelanlagen werden vermieden: gleiche Bezeichnung (ohne Groß-/Kleinschreibung) in derselben Warengruppe
 * gilt als vorhanden, auch wenn sie erst in diesem Plan weiter oben steht.
 */
export function planeVariantenArtikel(
  artikel:    Pick<VariantenArtikel, 'bezeichnung' | 'preisBruttoCent' | 'kategorieId'>,
  optionen:   readonly BepreisteOption[],
  vorhandene: readonly { bezeichnung: string; kategorieId: string | null }[],
): VariantenPlanEintrag[] {
  const belegt = new Set(
    vorhandene
      .filter(v => (v.kategorieId ?? null) === (artikel.kategorieId ?? null))
      .map(v => klein(v.bezeichnung)),
  )
  return optionen.map(o => {
    const bezeichnung = variantenBezeichnung(artikel.bezeichnung, o.name)
    const schluessel  = klein(bezeichnung)
    const vorhanden   = belegt.has(schluessel)
    belegt.add(schluessel)
    return {
      modifikatorId:   o.id,
      bezeichnung,
      preisBruttoCent: variantenPreisCent(artikel.preisBruttoCent, o.aufschlagCent),
      vorhanden,
    }
  })
}

/**
 * Soll der Ursprungsartikel deaktiviert werden, sobald alle seine bepreisten Varianten aufgelöst sind?
 *
 * Ja bei Basispreis 0,00 — „Bier" für 0,00 ist als Kachel sinnlos und gefährlich, sobald die Abfrage aus ist.
 * Nein bei eigenem Preis: „Spritzer" 4,00 bleibt neben „Spritzer Muskateller" 4,50 ein verkäuflicher Artikel.
 */
export const ursprungDeaktivieren = (preisBruttoCent: number, alleAufgeloest: boolean): boolean =>
  alleAufgeloest && preisBruttoCent === 0
