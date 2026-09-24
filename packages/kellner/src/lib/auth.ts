import type { Berechtigung, LoginResponse, PinLaenge } from '@kassa/shared'

const KEY_TOKEN = 'kellner:token'
const KEY_AUTH  = 'kellner:auth'
/**
 * Geräte-Merkmal der PIN-Bremse: bleibt beim Abmelden bewusst liegen — es
 * belegt „auf diesem Handy war schon jemand angemeldet", damit ein Fremder es
 * nicht per falscher PINs aussperren kann. Kein Anmelde-Token.
 */
const KEY_GERAET     = 'kellner:geraet'
/** PIN-Länge des Betriebs — das PIN-Feld braucht sie schon vor dem Login */
const KEY_PIN_LAENGE = 'kellner:pinLaenge'

export interface AuthState {
  token:   string
  user:    LoginResponse['user']
  mandant: LoginResponse['mandant']
  kassen:  LoginResponse['kassen']
}

export function getAuth(): AuthState | null {
  const raw   = localStorage.getItem(KEY_AUTH)
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
  if (login.geraetToken) localStorage.setItem(KEY_GERAET, login.geraetToken)
  if (login.mandant.pinLaenge) merkePinLaenge(login.mandant.pinLaenge)
}

/** Geräte-Merkmal fürs Mitschicken beim PIN-Login (undefined = fremdes Gerät). */
export function getGeraetToken(): string | undefined {
  return localStorage.getItem(KEY_GERAET) ?? undefined
}

/** Zuletzt bekannte PIN-Länge des Betriebs (4, solange nichts anderes bekannt ist). */
export function gemerktePinLaenge(): PinLaenge {
  return localStorage.getItem(KEY_PIN_LAENGE) === '6' ? 6 : 4
}

export function merkePinLaenge(laenge: number): void {
  localStorage.setItem(KEY_PIN_LAENGE, laenge === 6 ? '6' : '4')
}

export function clearAuth(): void {
  localStorage.removeItem(KEY_TOKEN)
  localStorage.removeItem(KEY_AUTH)
}

export function getToken(): string | null {
  return localStorage.getItem(KEY_TOKEN)
}

export function hasBerechtigung(b: Berechtigung): boolean {
  const auth = getAuth()
  if (!auth) return false
  if (auth.user.rolle === 'admin') return true
  return auth.user.berechtigungen.includes(b)
}

/** Gänge-Steuerung aktiv? (ältere LocalStorage-Auths ohne Feld → aus) */
export function gaengeAktiv(): boolean {
  return getAuth()?.mandant.modulGaengeAktiv ?? false
}

/** Anzahl wählbarer Gänge (1..9); Fallback 3 für ältere LocalStorage-Auths. */
export function gaengeAnzahl(): number {
  return getAuth()?.mandant.gaengeAnzahl ?? 3
}
