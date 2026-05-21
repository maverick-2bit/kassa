import type {
  Artikel,
  ArtikelInput,
  ArtikelUpdate,
  BarzahlungsbelegInput,
  BelegResponse,
  BonierungErgebnis,
  BonierungInput,
  JahresbelegInput,
  LoginInput,
  LoginResponse,
  MonatsbelegInput,
  NullbelegInput,
  SetupInput,
  SetupResponse,
  Station,
  StornobelegInput,
} from '@kassa/shared'
import { getToken, handleUnauthorized } from './auth.js'

// ---------------------------------------------------------------------------
// Generischer Fetcher
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(path, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })

  if (res.status === 401) {
    handleUnauthorized()
  }

  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : null

  if (!res.ok) {
    const fehler = (data as { fehler?: unknown })?.fehler
    const message = typeof fehler === 'string'
      ? fehler
      : Array.isArray(fehler) ? JSON.stringify(fehler) : `HTTP ${res.status}`
    throw new ApiError(res.status, message)
  }
  return data as T
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export async function postSetup(input: SetupInput): Promise<SetupResponse> {
  const res = await fetch('/api/setup', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(input),
  })
  return (await res.json()) as SetupResponse
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const authApi = {
  login: (input: LoginInput) =>
    request<LoginResponse>('POST', '/api/auth/login', input),
  me:    () =>
    request<{ user: LoginResponse['user']; mandant: LoginResponse['mandant']; kassen: LoginResponse['kassen'] }>(
      'GET', '/api/auth/me'),
}

// ---------------------------------------------------------------------------
// Artikel
// ---------------------------------------------------------------------------

export const artikelApi = {
  list:   (mandantId: string, nurAktive = true) =>
    request<Artikel[]>('GET', `/api/artikel?mandantId=${mandantId}&nurAktive=${nurAktive}`),
  create: (input: ArtikelInput) => request<Artikel>('POST', '/api/artikel', input),
  update: (id: string, input: ArtikelUpdate) => request<Artikel>('PUT', `/api/artikel/${id}`, input),
  deaktiviere: (id: string) => request<Artikel>('DELETE', `/api/artikel/${id}`),
}

// ---------------------------------------------------------------------------
// Belege
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Drucker
// ---------------------------------------------------------------------------

export interface DruckerConfig {
  druckerIp:     string | null
  druckerPort:   number
  druckerAktiv:  boolean
  druckerBreite: number
}

export const druckerApi = {
  get:        (kasseId: string) =>
    request<DruckerConfig>('GET', `/api/kassen/${kasseId}/drucker`),
  patch:      (kasseId: string, config: Partial<DruckerConfig>) =>
    request<DruckerConfig>('PATCH', `/api/kassen/${kasseId}/drucker`, config),
  test:       (kasseId: string) =>
    request<{ erfolgreich: boolean }>('POST', `/api/kassen/${kasseId}/drucker/test`),
  reprint:    (belegId: string) =>
    request<{ erfolgreich: boolean }>('POST', `/api/belege/${belegId}/drucken`),
}

// ---------------------------------------------------------------------------
// KDS
// ---------------------------------------------------------------------------

export interface KdsConfig {
  kdsAktiv:     boolean
  kdsPort:      number
  kdsStationen: Partial<Record<Station, string>>
}

export const kdsApi = {
  get:   (kasseId: string) =>
    request<KdsConfig>('GET', `/api/kassen/${kasseId}/kds`),
  patch: (kasseId: string, config: Partial<KdsConfig>) =>
    request<KdsConfig>('PATCH', `/api/kassen/${kasseId}/kds`, config),
}

export const bonierApi = {
  bonieren: (input: BonierungInput) =>
    request<BonierungErgebnis>('POST', '/api/bestellung/bonieren', input),
}

export const belegApi = {
  list:       (kasseId: string, limit = 50) =>
    request<BelegResponse[]>('GET', `/api/belege?kasseId=${kasseId}&limit=${limit}`),
  barzahlung: (input: BarzahlungsbelegInput) =>
    request<BelegResponse>('POST', '/api/belege/barzahlung', input),
  storno:     (input: StornobelegInput) =>
    request<BelegResponse>('POST', '/api/belege/storno', input),
  nullbeleg:  (input: NullbelegInput) =>
    request<BelegResponse>('POST', '/api/belege/nullbeleg', input),
  monatsbeleg:(input: MonatsbelegInput) =>
    request<BelegResponse>('POST', '/api/belege/monatsbeleg', input),
  jahresbeleg:(input: JahresbelegInput) =>
    request<BelegResponse>('POST', '/api/belege/jahresbeleg', input),
}

export { ApiError }
