import type { Berechtigung, LoginResponse } from '@kassa/shared'

const KEY_TOKEN = 'kellner:token'
const KEY_AUTH  = 'kellner:auth'

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
