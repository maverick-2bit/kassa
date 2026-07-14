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
  TischTabBezahlenInput,
  ZvtConfig,
  ZvtJob,
  ZvtZahlungInput,
} from '@kassa/shared'
import { getToken, clearAuth } from './auth'
import { clearKasseIdentity } from './kasse'

let onUnauthorized: (() => void) | null = null
export function setOnUnauthorized(fn: () => void) { onUnauthorized = fn }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken()
  // Content-Type NUR bei tatsächlichem Body setzen. Sonst wirft Fastify bei
  // body-losen POST/DELETE FST_ERR_CTP_EMPTY_JSON_BODY → HTTP 400.
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
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
  bezahle: (id: string, input: TischTabBezahlenInput) =>
    request<{ tab: TischTabResponse; belegId: string }>('POST', `/api/tisch-tabs/${id}/bezahlen`, input),
}

// ---------------------------------------------------------------------------
// Belegausgabe (digitaler Beleg / Ausweich-Druck)
// ---------------------------------------------------------------------------

export interface DruckerConfig {
  belegModus:    'drucken' | 'digital' | 'beides'
  belegBasisUrl: string | null
}

export const druckerApi = {
  get: (kasseId: string) =>
    request<DruckerConfig>('GET', `/api/kassen/${kasseId}/drucker`),
  /** „Nicht akzeptiert" → Rechnung auf den Kassa-Bondrucker erzwingen */
  druckenAusweich: (belegId: string) =>
    request<{ erfolgreich: boolean }>('POST', `/api/belege/${belegId}/drucken`, { ausweich: true }),
}

/** Öffentliche Beleg-Route (LAN-intern) — Datenquelle für den Foto-Beleg am Handy-Bildschirm */
export interface OeffentlicherBeleg {
  firmenname: string
  uid:        string
  beleg: {
    belegNummer:          number
    positionen:           { bezeichnung: string; menge: number; einzelpreisBreutto: number }[]
    gesamtbetragCent:     number
    maschinenlesbareCode: string
  }
}

export const oeffentlicherBelegApi = {
  get: (belegId: string) =>
    request<OeffentlicherBeleg>('GET', `/api/oeffentlich/beleg/${belegId}`),
}

// ---------------------------------------------------------------------------
// ZVT-Kartenterminal (Spiegel der Haupt-App-zvtApi)
// ---------------------------------------------------------------------------

export const zvtApi = {
  getConfig: (kasseId: string) =>
    request<ZvtConfig>('GET', `/api/kassen/${kasseId}/zvt`),
  starteZahlung: (input: ZvtZahlungInput) =>
    request<{ jobId: string }>('POST', '/api/zvt/zahlung', input),
  getJob: (jobId: string) =>
    request<ZvtJob>('GET', `/api/zvt/zahlung/${jobId}`),
  abbrechen: (jobId: string) =>
    request<ZvtJob>('POST', `/api/zvt/zahlung/${jobId}/abbrechen`),
}

// ---------------------------------------------------------------------------
// Bonierung
// ---------------------------------------------------------------------------

export const bonierApi = {
  bonieren: (input: BonierungInput) =>
    request<BonierungErgebnis>('POST', '/api/bestellung/bonieren', input),
}
