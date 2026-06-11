import type {
  LoginResponse,
  Artikel,
  Kategorie,
  TischTabResponse,
  TischTabErstellenInput,
  TabPosition,
  BonierungInput,
  BonierungErgebnis,
  ModifikatorGruppe,
} from '@kassa/shared'
import { getToken, clearAuth } from './auth'
import { clearKasseIdentity } from './kasse'

let onUnauthorized: (() => void) | null = null
export function setOnUnauthorized(fn: () => void) { onUnauthorized = fn }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  if (res.status === 401) {
    clearAuth()
    clearKasseIdentity()
    onUnauthorized?.()
    throw new Error('Sitzung abgelaufen')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = `HTTP ${res.status}`
    try { msg = (JSON.parse(text) as { fehler?: string }).fehler ?? msg } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const authApi = {
  pinLogin: (input: { kasseId: string; pin: string }) =>
    request<LoginResponse>('POST', '/api/auth/pin-login', input),
}

// ---------------------------------------------------------------------------
// Kasse / Setup
// ---------------------------------------------------------------------------

export const kasseApi = {
  list: (mandantId: string) =>
    request<{ id: string; bezeichnung: string }[]>('GET', `/api/kassen?mandantId=${mandantId}`),
  getByUrl: () =>
    request<{ mandantId: string; kasseId: string; bezeichnung: string }>('GET', '/api/kassen/by-url'),
}

// ---------------------------------------------------------------------------
// Artikel & Kategorien
// ---------------------------------------------------------------------------

export const artikelApi = {
  list: (mandantId: string) =>
    request<Artikel[]>('GET', `/api/artikel?mandantId=${mandantId}&nurAktive=true`),
}

export const kategorieApi = {
  list: (nurAktive = true) =>
    request<Kategorie[]>('GET', `/api/kategorien?nurAktive=${nurAktive}`),
}

export const modifikatorApi = {
  getGruppenFuerArtikel: (artikelId: string) =>
    request<ModifikatorGruppe[]>('GET', `/api/artikel/${artikelId}/modifikator-gruppen`),
}

// ---------------------------------------------------------------------------
// Tisch-Tabs
// ---------------------------------------------------------------------------

export const tischTabApi = {
  list: (kasseId: string) =>
    request<TischTabResponse[]>('GET', `/api/tisch-tabs?kasseId=${kasseId}`),
  get: (id: string) =>
    request<TischTabResponse>('GET', `/api/tisch-tabs/${id}`),
  erstelle: (input: TischTabErstellenInput) =>
    request<TischTabResponse>('POST', '/api/tisch-tabs', input),
  aktualisierePositionen: (id: string, positionen: TabPosition[]) =>
    request<TischTabResponse>('PUT', `/api/tisch-tabs/${id}/positionen`, { positionen }),
}

// ---------------------------------------------------------------------------
// Bonierung
// ---------------------------------------------------------------------------

export const bonierApi = {
  bonieren: (input: BonierungInput) =>
    request<BonierungErgebnis>('POST', '/api/bestellung/bonieren', input),
}
