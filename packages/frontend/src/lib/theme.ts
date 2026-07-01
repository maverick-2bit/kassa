/**
 * Theme-Verwaltung (hell/dunkel).
 *
 * Der Modus wird über die Klasse `dark` am <html>-Element gesteuert (siehe
 * index.css) und in localStorage persistiert. `initTheme()` muss vor dem ersten
 * Render laufen, damit kein Hell-Blitz entsteht; ohne gespeicherte Wahl folgt
 * der Modus der Systemeinstellung.
 */

export type ThemeMode = 'light' | 'dark'

const KEY = 'kassa:theme'

/**
 * Gespeicherte Wahl oder — ohne Wahl — hell.
 *
 * Standard ist bewusst hell (nicht die Systemeinstellung), solange noch nicht
 * alle Seiten auf Tokens umgestellt sind: Dunkel ist Opt-in über den Umschalter.
 * Sobald der Rollout abgeschlossen ist, kann hier die Systemeinstellung folgen.
 */
export function getTheme(): ThemeMode {
  const gespeichert = localStorage.getItem(KEY)
  return gespeichert === 'dark' ? 'dark' : 'light'
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
