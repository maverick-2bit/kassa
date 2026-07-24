/**
 * Auth-State im LocalStorage (Token + User-Info).
 * Wird vom fetch-Wrapper gelesen, um den Authorization-Header zu setzen.
 */

import type { Berechtigung, LoginResponse, MandantModul } from '@kassa/shared'

const KEY_TOKEN = 'kassa:token'
const KEY_AUTH  = 'kassa:auth'

export interface AuthState {
  token:   string
  user:    LoginResponse['user']
  mandant: LoginResponse['mandant']
  kassen:  LoginResponse['kassen']
}

export function getAuth(): AuthState | null {
  const raw = localStorage.getItem(KEY_AUTH)
  const token = localStorage.getItem(KEY_TOKEN)
  if (!raw || !token) return null
  try {
    const parsed = JSON.parse(raw) as Omit<AuthState, 'token'>
    return { token, ...parsed }
  } catch {
    return null
  }
}

export function setAuth(login: LoginResponse): void {
  localStorage.setItem(KEY_TOKEN, login.token)
  localStorage.setItem(KEY_AUTH, JSON.stringify({
    user:    login.user,
    mandant: login.mandant,
    kassen:  login.kassen,
  }))
}

export function clearAuth(): void {
  localStorage.removeItem(KEY_TOKEN)
  localStorage.removeItem(KEY_AUTH)
}

export function getToken(): string | null {
  return localStorage.getItem(KEY_TOKEN)
}

export function hasBerechtigung(berechtigung: Berechtigung): boolean {
  const auth = getAuth()
  if (!auth) return false
  if (auth.user.rolle === 'admin') return true
  return auth.user.berechtigungen.includes(berechtigung)
}

export function hasModul(modul: MandantModul): boolean {
  const auth = getAuth()
  if (!auth) return false
  if (modul === 'gastro')         return auth.mandant.modulGastroAktiv
  if (modul === 'angebote')       return auth.mandant.modulAngeboteAktiv
  if (modul === 'mergeport')      return auth.mandant.modulMergeportAktiv
  if (modul === 'reservierungen') return auth.mandant.modulReservierungenAktiv
  if (modul === 'zeiterfassung')  return auth.mandant.modulZeiterfassungAktiv
  if (modul === 'sbTerminal')     return auth.mandant.modulSbTerminalAktiv
  // Ältere LocalStorage-Auths (vor v0.7.106) haben das Feld nicht → false = Modul aus
  if (modul === 'gaenge')         return auth.mandant.modulGaengeAktiv ?? false
  return false
}

/** Anzahl wählbarer Gänge (1..9); Fallback 3 für ältere LocalStorage-Auths. */
export function gaengeAnzahl(): number {
  const auth = getAuth()
  return auth?.mandant.gaengeAnzahl ?? 3
}

/** Aktualisiert die Modul-Flags im LocalStorage ohne Re-Login. */
export function updateMandantModule(
  updates: Partial<{ modulGastroAktiv: boolean; modulAngeboteAktiv: boolean; modulMergeportAktiv: boolean; modulReservierungenAktiv: boolean; modulZeiterfassungAktiv: boolean; modulSbTerminalAktiv: boolean; modulGaengeAktiv: boolean; gaengeAnzahl: number }>,
): void {
  const auth = getAuth()
  if (!auth) return
  localStorage.setItem(KEY_AUTH, JSON.stringify({
    user:    auth.user,
    mandant: { ...auth.mandant, ...updates },
    kassen:  auth.kassen,
  }))
}

/** Aktualisiert die Kassenbezeichnung im LocalStorage ohne Re-Login. */
export function updateKasseBezeichnung(kasseId: string, bezeichnung: string): void {
  const auth = getAuth()
  if (!auth) return
  localStorage.setItem(KEY_AUTH, JSON.stringify({
    user:    auth.user,
    mandant: auth.mandant,
    kassen:  auth.kassen.map(k => k.id === kasseId ? { ...k, bezeichnung } : k),
  }))
}

/** Hängt eine neu angelegte Kasse an die Kassenliste im LocalStorage (ohne Re-Login). */
export function addKasse(kasse: AuthState['kassen'][number]): void {
  const auth = getAuth()
  if (!auth) return
  if (auth.kassen.some(k => k.id === kasse.id)) return
  localStorage.setItem(KEY_AUTH, JSON.stringify({
    user:    auth.user,
    mandant: auth.mandant,
    kassen:  [...auth.kassen, kasse],
  }))
}

/** Entfernt eine (z. B. außer Betrieb genommene) Kasse aus der Liste im LocalStorage. */
export function removeKasse(kasseId: string): void {
  const auth = getAuth()
  if (!auth) return
  localStorage.setItem(KEY_AUTH, JSON.stringify({
    user:    auth.user,
    mandant: auth.mandant,
    kassen:  auth.kassen.filter(k => k.id !== kasseId),
  }))
}

/** Triggert beim 401 — z. B. um zur Login-Seite zu redirecten */
export type UnauthorizedHandler = () => void
let onUnauthorized: UnauthorizedHandler | null = null
export function setOnUnauthorized(fn: UnauthorizedHandler): void {
  onUnauthorized = fn
}
export function handleUnauthorized(): void {
  clearAuth()
  if (onUnauthorized) onUnauthorized()
}
