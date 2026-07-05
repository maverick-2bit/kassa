/**
 * Theme-Verwaltung (hell/dunkel) für das KDS.
 *
 * Der Modus wird über die Klasse `dark` am <html>-Element gesteuert (siehe
 * index.css) und in localStorage persistiert. `initTheme()` läuft vor dem
 * ersten Render, damit kein Farbblitz entsteht.
 *
 * Standard ist HELL: Schwarz auf Weiß liest sich an den Küchenmonitoren für
 * viele besser; Dunkel ist per Umschalter wählbar (z. B. bei starker Blendung).
 */

export type ThemeMode = 'light' | 'dark'

const KEY = 'kds:theme'

export function getTheme(): ThemeMode {
  return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
}

function anwenden(mode: ThemeMode): void {
  document.documentElement.classList.toggle('dark', mode === 'dark')
}

/** Vor dem ersten Render aufrufen. */
export function initTheme(): void {
  anwenden(getTheme())
}

export function setTheme(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode)
  anwenden(mode)
}

/** Wechselt hell↔dunkel und gibt den neuen Modus zurück. */
export function toggleTheme(): ThemeMode {
  const neu: ThemeMode = getTheme() === 'dark' ? 'light' : 'dark'
  setTheme(neu)
  return neu
}
