import { useSyncExternalStore } from 'react'

/**
 * Kassen-Seite: Zusatzleisten (FinanzOnline-Hinweis, Kontext-Leiste mit Tisch/Kellner)
 * per Knopf ausblenden, damit am Tablet im Querformat mehr Artikel ohne Wischen
 * sichtbar sind. Zustand pro Gerät in localStorage; Standard: eingeblendet.
 */
const KEY = 'kassa:kassenLeistenAusgeblendet'
const listeners = new Set<() => void>()

function lese(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

let aktuell = lese()

export function setKassenLeistenAusgeblendet(wert: boolean): void {
  aktuell = wert
  try { localStorage.setItem(KEY, wert ? '1' : '0') } catch { /* ignorieren */ }
  listeners.forEach(l => l())
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export function useKassenLeistenAusgeblendet(): boolean {
  return useSyncExternalStore(subscribe, () => aktuell, () => false)
}
