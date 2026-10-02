/**
 * sichtbarkeit.ts — welche Warengruppen eine Kasse zeigt (kasse_kategorie_sichtbarkeit).
 *
 * EINE Logik für beide Oberflächen: die Matrix „Warengruppen-Verteilung" (Einstellungen → Kassen)
 * und den Tab „Warengruppen" der POS-Konfiguration.
 *
 * Gespeichert wird weiter nur eine Liste von Gruppen-IDs (Backend unverändert):
 *   - LEERE Liste = ALLE Warengruppen sichtbar (auch künftig angelegte)
 *   - sonst die explizit eingeschalteten Gruppen
 *
 * Die Kasse (ArtikelGrid, Tisch) wertet die Liste mit `erweitereSichtbarkeit` aus: Nachkommen einer
 * sichtbaren Gruppe sind sichtbar, Vorfahren einer sichtbaren Untergruppe ebenfalls (als Zugang).
 * Damit Oberfläche und Kasse nie auseinanderlaufen, gilt hier dieselbe Auslegung:
 *
 *   an        die Gruppe ist eingeschaltet — samt ALLEN ihren Untergruppen (Schalter gilt für den Teilbaum)
 *   teilweise nur einzelne Untergruppen sind an; die Gruppe selbst bleibt als Zugang sichtbar
 *             (Halbzustand / Indeterminate-Haken)
 *   aus       weder die Gruppe noch eine ihrer Untergruppen ist sichtbar
 *
 * Schaltet man eine Untergruppe unter einer eingeschalteten Elterngruppe aus, wird die Elterngruppe
 * `teilweise`; sind danach alle Untergruppen wieder an, ist sie wieder `an`.
 * Gespeichert wird immer die VOLLE Menge der „an"-Gruppen (nicht nur die obersten): so stimmt die
 * Liste auch für Verbraucher ohne Teilbaum-Auswertung (Gast-Karte, Kellner-App).
 * Sind alle Gruppen an, wird [] gespeichert („alle sichtbar"). Mindestens eine Gruppe bleibt sichtbar —
 * die letzte lässt sich nicht abwählen, damit die Liste nie versehentlich auf „alle" kippt.
 */

import type { Kategorie } from '@kassa/shared'
import { baumFlach, nachkommenIds, pfadIds } from './kategorie-baum'

export type Gruppe = Pick<Kategorie, 'id' | 'parentId' | 'name' | 'reihenfolge'> & { aktiv?: boolean }
export type SichtbarkeitsZustand = 'an' | 'teilweise' | 'aus'

/** Leere Liste = alle Warengruppen sichtbar. */
export const alleAktiv = (liste: readonly string[]): boolean => liste.length === 0

/** Eine Gruppe, deren sämtliche Untergruppen an sind, ist selbst an (von unten nach oben). */
function hochziehen(menge: readonly Gruppe[], an: Set<string>): void {
  const ids = new Set(menge.map(k => k.id))
  const kinder = new Map<string, string[]>()
  for (const k of menge) {
    if (k.parentId && ids.has(k.parentId)) kinder.set(k.parentId, [...(kinder.get(k.parentId) ?? []), k.id])
  }
  const besucht = new Set<string>()
  const rein = (id: string): void => {
    if (besucht.has(id)) return
    besucht.add(id)
    const ks = kinder.get(id) ?? []
    for (const c of ks) rein(c)
    if (!an.has(id) && ks.length > 0 && ks.every(c => an.has(c))) an.add(id)
  }
  for (const k of menge) if (!k.parentId || !ids.has(k.parentId)) rein(k.id)
}

/** Alle Gruppen, die „an" sind (nach unten abgeschlossen: eine Gruppe an ⇒ alle Untergruppen an). */
function angeschaltet(menge: readonly Gruppe[], liste: readonly string[]): Set<string> {
  const ids = new Set(menge.map(k => k.id))
  if (alleAktiv(liste)) return ids
  const an = new Set<string>()
  for (const id of liste) {
    if (!ids.has(id)) continue
    an.add(id)
    for (const n of nachkommenIds(menge, id)) an.add(n)
  }
  hochziehen(menge, an)
  return an
}

/** Zustand jeder Gruppe (an / teilweise / aus) für die gespeicherte Liste. */
export function sichtbarkeitsZustaende(menge: readonly Gruppe[], liste: readonly string[]): Map<string, SichtbarkeitsZustand> {
  const an = angeschaltet(menge, liste)
  const teilweise = new Set<string>()
  for (const id of an) for (const p of pfadIds(menge, id)) if (!an.has(p)) teilweise.add(p)
  return new Map(menge.map(k => [k.id, an.has(k.id) ? 'an' : teilweise.has(k.id) ? 'teilweise' : 'aus'] as const))
}

/** Zeigt die Kasse diese Gruppe (selbst an oder als Zugang zu einer eingeschalteten Untergruppe)? */
export function istSichtbar(menge: readonly Gruppe[], liste: readonly string[], id: string): boolean {
  if (alleAktiv(liste)) return true
  return (sichtbarkeitsZustaende(menge, liste).get(id) ?? 'aus') !== 'aus'
}

/** Für die Beschriftung: wie viele der AKTIVEN Gruppen sind an der Kasse sichtbar? */
export function zaehlung(menge: readonly Gruppe[], liste: readonly string[]): { sichtbar: number; gesamt: number } {
  const zustaende = sichtbarkeitsZustaende(menge, liste)
  const aktive = menge.filter(k => k.aktiv !== false)
  return { gesamt: aktive.length, sichtbar: aktive.filter(k => zustaende.get(k.id) !== 'aus').length }
}

/** Menge der „an"-Gruppen → zu speichernde Liste: [] wenn alle an sind, sonst alle an-Gruppen in Baumreihenfolge. */
function alsListe(menge: readonly Gruppe[], an: ReadonlySet<string>): string[] {
  if (an.size >= menge.length) return []
  const inBaumReihenfolge = baumFlach(menge).map(e => e.kategorie.id).filter(id => an.has(id))
  const rest = [...an].filter(id => !inBaumReihenfolge.includes(id))
  return [...inBaumReihenfolge, ...rest]
}

export interface ToggleErgebnis {
  /** Neue, zu speichernde Liste ([] = alle sichtbar). Bei `blockiert` unverändert. */
  liste: string[]
  /** 'letzte': Die letzte sichtbare Warengruppe lässt sich nicht abwählen. */
  blockiert: 'letzte' | null
}

/**
 * Klick auf den Schalter einer Gruppe:
 *   aus / teilweise → die Gruppe samt allen Untergruppen einschalten
 *   an              → die Gruppe samt allen Untergruppen ausschalten; liegt sie unter einer eingeschalteten
 *                     Elterngruppe, wird diese `teilweise` (bleibt als Zugang für die übrigen Untergruppen)
 * Aus „alle sichtbar" heraus ergibt das eine explizite Liste aller Gruppen außer dem Teilbaum.
 */
export function toggle(menge: readonly Gruppe[], liste: readonly string[], id: string): ToggleErgebnis {
  if (!menge.some(k => k.id === id)) return { liste: [...liste], blockiert: null }
  const an = angeschaltet(menge, liste)
  const neu = new Set(an)
  const teilbaum = [id, ...nachkommenIds(menge, id)]
  if (!an.has(id)) {
    for (const u of teilbaum) neu.add(u)
    hochziehen(menge, neu)
  } else {
    for (const u of teilbaum) neu.delete(u)
    for (const vorfahr of pfadIds(menge, id)) neu.delete(vorfahr)
  }
  if (neu.size === 0) return { liste: [...liste], blockiert: 'letzte' }
  return { liste: alsListe(menge, neu), blockiert: null }
}

/** Auswahl neu beginnen (POS-Konfiguration „Keine"): nur diese Gruppe samt Untergruppen sichtbar. */
export function waehleNur(menge: readonly Gruppe[], id: string): string[] {
  if (!menge.some(k => k.id === id)) return []
  const an = new Set([id, ...nachkommenIds(menge, id)])
  hochziehen(menge, an)
  return alsListe(menge, an)
}
