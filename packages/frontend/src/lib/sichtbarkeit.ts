/**
 * sichtbarkeit.ts — welche Warengruppen eine Kasse zeigt (kasse_kategorie_sichtbarkeit).
 *
 * EINE Logik für beide Oberflächen: die Matrix „Warengruppen-Verteilung" (Einstellungen → Kassen)
 * und den Tab „Warengruppen" der POS-Konfiguration. Die Kasse selbst (Raster, Tisch, Kellner-App,
 * Gast-Karte) wertet dieselbe Liste mit `sichtbarkeitsMengen` (@kassa/shared) aus — Oberfläche und
 * Kasse laufen so nie auseinander.
 *
 * Gespeichert wird weiter nur eine Liste von Gruppen-IDs (Backend unverändert):
 *   - LEERE Liste = ALLE Warengruppen gewählt (auch künftig angelegte)
 *   - sonst die ausdrücklich gewählten Gruppen — jede UNABHÄNGIG: ein Haken gilt nur für diese Gruppe
 *     und ihre eigenen Artikel, NICHT für ihre Untergruppen (wer „Alkoholfrei" wählt, hat damit nicht
 *     automatisch „Limonaden" und „Säfte")
 *
 * Zustand je Gruppe (Haken):
 *   an      ausdrücklich gewählt: die eigenen Artikel der Gruppe erscheinen an der Kasse
 *   zugang  nicht gewählt, aber eine Untergruppe ist gewählt: die Gruppe bleibt als reiner ZUGANG
 *           (Reiter/Kachel, die zur gewählten Untergruppe führt) sichtbar — OHNE eigene Artikel
 *           (Halbzustand / Indeterminate-Haken)
 *   aus     weder die Gruppe noch eine ihrer Untergruppen ist gewählt
 *
 * Gespeichert wird immer die VOLLE Menge der gewählten Gruppen (nicht nur die obersten) in Baumreihenfolge;
 * sind alle Gruppen gewählt, wird [] gespeichert („alle sichtbar"). Mindestens eine Gruppe bleibt
 * gewählt — die letzte lässt sich nicht abwählen, damit die Liste nie versehentlich auf „alle" kippt.
 * Ältere gespeicherte Listen mit vollen Teilbäumen (Gruppe + alle Untergruppen) enthalten die Untergruppen
 * ausdrücklich und verhalten sich unverändert.
 *
 * Komfort „samt Untergruppen" (`toggleTeilbaum`): schaltet eine Gruppe und alle ihre Nachkommen auf einmal
 * — bewusst ein eigener Knopf, nicht der Standard-Klick.
 *
 * „Alle sichtbar" / „Alle ausblenden" (Knöpfe je Kasse, am Ende dieser Datei): „Keine Gruppe" ist auf dem
 * Server NICHT darstellbar (leer = alle). „Alle ausblenden" ist deshalb nur ein Auswahl-NEUSTART in der
 * Oberfläche (Auswahl.neustart): alle Haken leer, nichts gespeichert; die erste danach eingeschaltete Gruppe
 * legt die neue Auswahl fest. Zwei Klicks auf denselben Knopf schalten zwischen „alle sichtbar" und
 * „alle ausgeblendet" um.
 */

import type { Kategorie } from '@kassa/shared'
import { baumFlach, nachkommenIds, sichtbarkeitsMengen } from './kategorie-baum'

export type Gruppe = Pick<Kategorie, 'id' | 'parentId' | 'name' | 'reihenfolge'> & { aktiv?: boolean }
export type SichtbarkeitsZustand = 'an' | 'zugang' | 'aus'

/** Leere Liste = alle Warengruppen sichtbar. */
export const alleAktiv = (liste: readonly string[]): boolean => liste.length === 0

/** Die ausdrücklich gewählten Gruppen (bei leerer Liste: alle) — nur bekannte Gruppen. */
function gewaehlt(menge: readonly Gruppe[], liste: readonly string[]): Set<string> {
  return new Set(sichtbarkeitsMengen(menge, liste).sichtbar)
}

/** Zustand jeder Gruppe (an / zugang / aus) für die gespeicherte Liste. */
export function sichtbarkeitsZustaende(menge: readonly Gruppe[], liste: readonly string[]): Map<string, SichtbarkeitsZustand> {
  const m = sichtbarkeitsMengen(menge, liste)
  return new Map(menge.map(k => [k.id, m.sichtbar.has(k.id) ? 'an' : m.zugang.has(k.id) ? 'zugang' : 'aus'] as const))
}

/** Erscheint die Gruppe an der Kasse — gewählt oder als Zugang zu einer gewählten Untergruppe? */
export function istSichtbar(menge: readonly Gruppe[], liste: readonly string[], id: string): boolean {
  if (alleAktiv(liste)) return true
  return (sichtbarkeitsZustaende(menge, liste).get(id) ?? 'aus') !== 'aus'
}

/** Für die Beschriftung: wie viele der AKTIVEN Gruppen sind an der Kasse gewählt (ihre Artikel erscheinen)? */
export function zaehlung(menge: readonly Gruppe[], liste: readonly string[]): { sichtbar: number; gesamt: number } {
  const zustaende = sichtbarkeitsZustaende(menge, liste)
  const aktive = menge.filter(k => k.aktiv !== false)
  return { gesamt: aktive.length, sichtbar: aktive.filter(k => zustaende.get(k.id) === 'an').length }
}

/** Menge der gewählten Gruppen → zu speichernde Liste: [] wenn alle gewählt sind, sonst alle gewählten in Baumreihenfolge. */
function alsListe(menge: readonly Gruppe[], an: ReadonlySet<string>): string[] {
  if (an.size >= menge.length) return []
  const inBaumReihenfolge = baumFlach(menge).map(e => e.kategorie.id).filter(id => an.has(id))
  const rest = [...an].filter(id => !inBaumReihenfolge.includes(id))
  return [...inBaumReihenfolge, ...rest]
}

export interface ToggleErgebnis {
  /** Neue, zu speichernde Liste ([] = alle sichtbar). Bei `blockiert` unverändert. */
  liste: string[]
  /** 'letzte': Die letzte gewählte Warengruppe lässt sich nicht abwählen. */
  blockiert: 'letzte' | null
}

/**
 * Klick auf den Haken einer Gruppe: schaltet NUR diese Gruppe um (gewählt ↔ nicht gewählt). Untergruppen
 * und Elterngruppen bleiben, wie sie sind; eine Elterngruppe ohne eigene Wahl bleibt als Zugang sichtbar,
 * solange eine ihrer Untergruppen gewählt ist. Aus „alle sichtbar" heraus ergibt das eine explizite Liste
 * aller Gruppen außer dieser.
 */
export function toggle(menge: readonly Gruppe[], liste: readonly string[], id: string): ToggleErgebnis {
  if (!menge.some(k => k.id === id)) return { liste: [...liste], blockiert: null }
  const neu = gewaehlt(menge, liste)
  if (neu.has(id)) neu.delete(id)
  else neu.add(id)
  if (neu.size === 0) return { liste: [...liste], blockiert: 'letzte' }
  return { liste: alsListe(menge, neu), blockiert: null }
}

/**
 * Komfort „samt Untergruppen": die Gruppe und alle ihre Nachkommen auf einmal. Sind schon ALLE davon gewählt,
 * werden alle abgewählt, sonst alle gewählt. Die letzte gewählte Gruppe bleibt auch hier.
 */
export function toggleTeilbaum(menge: readonly Gruppe[], liste: readonly string[], id: string): ToggleErgebnis {
  if (!menge.some(k => k.id === id)) return { liste: [...liste], blockiert: null }
  const neu = gewaehlt(menge, liste)
  const teilbaum = [id, ...nachkommenIds(menge, id)]
  if (teilbaum.every(u => neu.has(u))) for (const u of teilbaum) neu.delete(u)
  else for (const u of teilbaum) neu.add(u)
  if (neu.size === 0) return { liste: [...liste], blockiert: 'letzte' }
  return { liste: alsListe(menge, neu), blockiert: null }
}

/**
 * Auswahl neu beginnen (erste Gruppe nach „Alle ausblenden"): nur diese Gruppe — mit `samtUntergruppen`
 * auch alle ihre Nachkommen. Deckt die Wahl alle Gruppen ab, wird [] („alle sichtbar") daraus.
 */
export function waehleNur(menge: readonly Gruppe[], id: string, samtUntergruppen = false): string[] {
  if (!menge.some(k => k.id === id)) return []
  return alsListe(menge, new Set(samtUntergruppen ? [id, ...nachkommenIds(menge, id)] : [id]))
}

// ---------------------------------------------------------------------------
// „Alle sichtbar" / „Alle ausblenden" — gemeinsam für die Matrix und die POS-Konfiguration
// ---------------------------------------------------------------------------

/**
 * Zustand EINER Kasse in der Oberfläche. `liste` ist der Serverstand (gespeichert; [] = alle sichtbar).
 * `neustart` gibt es nur in der Oberfläche: „Alle ausblenden" speichert NICHTS. Der Zustand lebt im
 * Komponentenzustand — Verlassen der Seite, Neuladen und Kassenwechsel verwerfen ihn, dann gilt wieder der
 * Serverstand (er erscheint nie still als „alle ausgeblendet").
 */
export interface Auswahl {
  liste:    readonly string[]
  neustart: boolean
}

/** alle = alle Haken gesetzt (Liste leer) · teilweise = explizite Auswahl · keine = Neustart (alle Haken leer, nichts gespeichert) */
export type AuswahlArt = 'alle' | 'teilweise' | 'keine'

export interface AuswahlStatus {
  art:     AuswahlArt
  sichtbar: number
  gesamt:  number
  /** Beschriftung für die Kasse: „alle sichtbar" / „N von M sichtbar" / „alle ausgeblendet (…)" */
  text:    string
}

/** Texte, die beide Oberflächen gleich verwenden (die E2E-Specs vergleichen sie wörtlich). */
export const SICHTBARKEIT_TEXTE = {
  statusAlle:      'alle sichtbar',
  statusKeine:     'alle ausgeblendet (Auswahl wird gleich neu begonnen)',
  knopfAlle:       'Alle sichtbar',
  knopfAusblenden: 'Alle ausblenden',
  neustartHinweis: 'Noch nichts gespeichert — die erste Warengruppe, die du jetzt einschaltest, legt die neue Auswahl fest. Solange gilt die bisherige Auswahl weiter.',
  letzteHinweis:   'Mindestens eine Warengruppe muss an dieser Kasse sichtbar bleiben.',
  teilbaumTitel:   'Diese Gruppe samt allen Untergruppen auf einmal ein- bzw. ausschalten (sind schon alle gewählt, werden alle abgewählt). Ein einzelner Haken gilt nur für die Gruppe selbst.',
} as const

/** Erklärung des Hakens/Schalters einer Gruppe (Tooltip) — je nach Zustand. */
export function zustandTitel(zustand: SichtbarkeitsZustand, pfad: string): string {
  if (zustand === 'an') return `${pfad} — gewählt: die Artikel dieser Gruppe erscheinen an der Kasse (Untergruppen werden einzeln gewählt)`
  if (zustand === 'zugang') return `${pfad} — nicht gewählt: bleibt nur als Zugang zu einer gewählten Untergruppe sichtbar, ohne eigene Artikel`
  return `${pfad} — an dieser Kasse ausgeblendet`
}

/** Erklärung des Knopfes „Alle sichtbar" (Tooltip) — je nach Zustand der Kasse. */
export function alleSichtbarTitel(art: AuswahlArt): string {
  if (art === 'alle') return 'Alle Warengruppen sind an dieser Kasse sichtbar. Ein weiterer Klick blendet alle aus — die Auswahl wird dann neu begonnen.'
  if (art === 'keine') return 'Zurück zu „alle sichtbar": alle Warengruppen erscheinen an dieser Kasse — auch künftig angelegte.'
  return 'Alle Warengruppen an dieser Kasse sichtbar machen — auch künftig angelegte.'
}

/** Erklärung des Knopfes „Alle ausblenden" (Tooltip) — je nach Zustand der Kasse. */
export function alleAusblendenTitel(art: AuswahlArt): string {
  if (art === 'keine') return 'Neustart abbrechen: wieder alle Warengruppen sichtbar.'
  return 'Alle Haken entfernen und die Auswahl neu beginnen: Die erste Warengruppe, die du danach einschaltest, legt die neue Auswahl fest. Bis dahin wird nichts gespeichert.'
}

/** Zustand der Kasse für die Beschriftung und die Knöpfe. */
export function auswahlStatus(menge: readonly Gruppe[], auswahl: Auswahl): AuswahlStatus {
  const z = zaehlung(menge, auswahl.liste)
  if (auswahl.neustart) return { art: 'keine', sichtbar: 0, gesamt: z.gesamt, text: SICHTBARKEIT_TEXTE.statusKeine }
  if (alleAktiv(auswahl.liste)) return { art: 'alle', ...z, text: SICHTBARKEIT_TEXTE.statusAlle }
  return { art: 'teilweise', ...z, text: `${z.sichtbar} von ${z.gesamt} sichtbar` }
}

/** Zustand jeder Gruppe, wie die Haken/Schalter ihn zeigen: im Neustart sind ALLE aus, sonst gilt die gespeicherte Liste. */
export function anzeigeZustaende(menge: readonly Gruppe[], auswahl: Auswahl): Map<string, SichtbarkeitsZustand> {
  return auswahl.neustart
    ? new Map<string, SichtbarkeitsZustand>(menge.map(k => [k.id, 'aus'] as const))
    : sichtbarkeitsZustaende(menge, auswahl.liste)
}

/** Ergebnis eines Klicks: neuer Neustart-Zustand der Oberfläche und — falls nötig — die zu speichernde Liste. */
export interface Uebergang {
  neustart:  boolean
  /** Zu speichernde Liste; null = nichts speichern. Eine gespeicherte [] heißt „alle sichtbar". */
  speichern: string[] | null
  /** 'letzte': Die letzte gewählte Warengruppe lässt sich nicht abwählen (es ändert sich nichts). */
  blockiert: 'letzte' | null
}

const neustartBeginnen: Uebergang = { neustart: true, speichern: null, blockiert: null }

/** Zurück zu „alle sichtbar": gespeichert wird [] nur, wenn der Serverstand nicht ohnehin schon [] ist. */
const zurueckAufAlle = (auswahl: Auswahl): Uebergang =>
  ({ neustart: false, speichern: alleAktiv(auswahl.liste) ? null : [], blockiert: null })

/**
 * Klick auf „Alle sichtbar":
 *   schon „alle sichtbar" (alle Haken gesetzt) → blendet alle aus (Neustart, nichts gespeichert)
 *   „N von M" oder Neustart                   → alle sichtbar ([] speichern)
 */
export function alleSichtbarKlick(auswahl: Auswahl): Uebergang {
  if (!auswahl.neustart && alleAktiv(auswahl.liste)) return neustartBeginnen
  return zurueckAufAlle(auswahl)
}

/**
 * Klick auf „Alle ausblenden":
 *   Neustart läuft schon → zurück auf „alle sichtbar"
 *   sonst                → Neustart: alle Haken leer, NICHTS gespeichert (der Server kennt „keine Gruppe" nicht)
 */
export function alleAusblendenKlick(auswahl: Auswahl): Uebergang {
  if (auswahl.neustart) return zurueckAufAlle(auswahl)
  return neustartBeginnen
}

/**
 * Klick auf den Haken/Schalter einer Gruppe:
 *   im Neustart → die erste Gruppe legt die neue Auswahl fest: nur sie wird gespeichert (ohne Untergruppen)
 *   sonst       → nur diese Gruppe umschalten (toggle); die letzte gewählte Gruppe bleibt (blockiert)
 */
export function gruppeKlick(menge: readonly Gruppe[], auswahl: Auswahl, id: string): Uebergang {
  // Unbekannte Gruppe: nichts tun — vor allem im Neustart nichts speichern (waehleNur würde [] = „alle" liefern)
  if (!menge.some(k => k.id === id)) return { neustart: auswahl.neustart, speichern: null, blockiert: null }
  if (auswahl.neustart) return { neustart: false, speichern: waehleNur(menge, id), blockiert: null }
  const ergebnis = toggle(menge, auswahl.liste, id)
  if (ergebnis.blockiert) return { neustart: false, speichern: null, blockiert: ergebnis.blockiert }
  return { neustart: false, speichern: ergebnis.liste, blockiert: null }
}

/**
 * Klick auf „samt Untergruppen" einer Gruppe:
 *   im Neustart → die Gruppe samt allen Untergruppen wird die neue Auswahl
 *   sonst       → Gruppe und alle Nachkommen auf einmal umschalten (toggleTeilbaum)
 */
export function teilbaumKlick(menge: readonly Gruppe[], auswahl: Auswahl, id: string): Uebergang {
  if (!menge.some(k => k.id === id)) return { neustart: auswahl.neustart, speichern: null, blockiert: null }
  if (auswahl.neustart) return { neustart: false, speichern: waehleNur(menge, id, true), blockiert: null }
  const ergebnis = toggleTeilbaum(menge, auswahl.liste, id)
  if (ergebnis.blockiert) return { neustart: false, speichern: null, blockiert: ergebnis.blockiert }
  return { neustart: false, speichern: ergebnis.liste, blockiert: null }
}

/** Wendet einen Übergang auf den Oberflächenzustand an: `liste` ist danach das, was gespeichert wurde bzw. wird. */
export function uebernimm(auswahl: Auswahl, u: Uebergang): Auswahl {
  return { liste: u.speichern ?? auswahl.liste, neustart: u.neustart }
}

/**
 * Neustart-Merker mehrerer Kassen (Matrix: eine Spalte je Kasse). Liefert eine NEUE Menge — der Neustart einer
 * Kasse berührt die anderen Spalten nie.
 */
export function mitNeustart(neustartKassen: ReadonlySet<string>, kasseId: string, neustart: boolean): Set<string> {
  const neu = new Set(neustartKassen)
  if (neustart) neu.add(kasseId)
  else neu.delete(kasseId)
  return neu
}
