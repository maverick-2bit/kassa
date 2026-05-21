/**
 * Auth-State im LocalStorage (Token + User-Info).
 * Wird vom fetch-Wrapper gelesen, um den Authorization-Header zu setzen.
 */

import type { LoginResponse } from '@kassa/shared'

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
