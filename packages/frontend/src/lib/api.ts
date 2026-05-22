import type {
  Artikel,
  ArtikelInput,
  ArtikelUpdate,
  BarzahlungsbelegInput,
  BerichtFilter,
  BerichtResponse,
  BelegResponse,
  BonierungErgebnis,
  BonierungInput,
  JahresbelegInput,
  Kategorie,
  KategorieInput,
  KategorieUpdate,
  LoginInput,
  LoginResponse,
  MonatsbelegInput,
  NullbelegInput,
  PinLoginInput,
  SetupInput,
  SetupResponse,
  Station,
  StornobelegInput,
  Tagesabschluss,
  TabPosition,
  TischTabBezahlenInput,
  TischTabErstellenInput,
  TischTabResponse,
  User,
  UserCreateInput,
  UserUpdateInput,
  ZvtConfig,
  ZvtConfigUpdate,
  ZvtJob,
  ZvtZahlungInput,
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
  login:    (input: LoginInput) =>
    request<LoginResponse>('POST', '/api/auth/login', input),
  pinLogin: (input: PinLoginInput) =>
    request<LoginResponse>('POST', '/api/auth/pin-login', input),
  me:       () =>
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
// Kategorien
// ---------------------------------------------------------------------------

export const kategorieApi = {
  list:       (nurAktive = false) =>
    request<Kategorie[]>('GET', `/api/kategorien?nurAktive=${nurAktive}`),
  create:     (input: KategorieInput) =>
    request<Kategorie>('POST', '/api/kategorien', input),
  update:     (id: string, input: KategorieUpdate) =>
    request<Kategorie>('PUT', `/api/kategorien/${id}`, input),
  deaktiviere:(id: string) =>
    request<Kategorie>('DELETE', `/api/kategorien/${id}`),
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

export const berichtApi = {
  umsatz: (filter: Omit<BerichtFilter, 'kasseIds'> & { kasseIds?: string[] }): Promise<BerichtResponse> => {
    const p = new URLSearchParams()
    p.set('von', filter.von)
    p.set('bis', filter.bis)
    p.set('gruppierung', filter.gruppierung ?? 'tag')
    if (filter.nurZielrechnungen) p.set('nurZielrechnungen', 'true')
    for (const id of filter.kasseIds ?? []) p.append('kasseIds', id)
    return request<BerichtResponse>('GET', `/api/berichte/umsatz?${p.toString()}`)
  },
}

export const tagesabschlussApi = {
  get:    (kasseId: string, datum: string) =>
    request<Tagesabschluss>('GET', `/api/belege/tagesabschluss?kasseId=${kasseId}&datum=${datum}`),
  drucken:(kasseId: string, datum: string) =>
    request<{ erfolgreich: boolean }>('POST', '/api/belege/tagesabschluss/drucken', { kasseId, datum }),
}

// ---------------------------------------------------------------------------
// User-Verwaltung
// ---------------------------------------------------------------------------

export const userApi = {
  list:       () =>
    request<User[]>('GET', '/api/users'),
  create:     (input: UserCreateInput) =>
    request<User>('POST', '/api/users', input),
  update:     (id: string, input: UserUpdateInput) =>
    request<User>('PUT', `/api/users/${id}`, input),
  deactivate: (id: string) =>
    request<User>('DELETE', `/api/users/${id}`),
}

// ---------------------------------------------------------------------------
// Tisch-Tabs
// ---------------------------------------------------------------------------

export const tischTabApi = {
  list: (kasseId: string) =>
    request<TischTabResponse[]>('GET', `/api/tisch-tabs?kasseId=${kasseId}`),
  erstelle: (input: TischTabErstellenInput) =>
    request<TischTabResponse>('POST', '/api/tisch-tabs', input),
  get: (id: string) =>
    request<TischTabResponse>('GET', `/api/tisch-tabs/${id}`),
  aktualisierePositionen: (id: string, positionen: TabPosition[]) =>
    request<TischTabResponse>('PUT', `/api/tisch-tabs/${id}/positionen`, { positionen }),
  bezahle: (id: string, input: TischTabBezahlenInput) =>
    request<{ tab: TischTabResponse; belegId: string }>('POST', `/api/tisch-tabs/${id}/bezahlen`, input),
}

// ---------------------------------------------------------------------------
// ZVT-Kartenterminal
// ---------------------------------------------------------------------------

export const zvtApi = {
  getConfig:   (kasseId: string) =>
    request<ZvtConfig>('GET', `/api/kassen/${kasseId}/zvt`),
  patchConfig: (kasseId: string, config: ZvtConfigUpdate) =>
    request<ZvtConfig>('PATCH', `/api/kassen/${kasseId}/zvt`, config),

  starteZahlung: (input: ZvtZahlungInput) =>
    request<{ jobId: string }>('POST', '/api/zvt/zahlung', input),
  getJob:        (jobId: string) =>
    request<ZvtJob>('GET', `/api/zvt/zahlung/${jobId}`),
  abbrechen:     (jobId: string) =>
    request<ZvtJob>('POST', `/api/zvt/zahlung/${jobId}/abbrechen`),
}

export { ApiError }
