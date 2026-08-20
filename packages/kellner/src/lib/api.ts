import type {
  LoginResponse,
  Artikel,
  Kategorie,
  TischTabResponse,
  TischTabErstellenInput,
  TabPosition,
  BonierungInput,
  BonierungErgebnis,
  BonierZielFehler,
  ModifikatorGruppe,
  TischTabBezahlenInput,
  ZvtConfig,
  ZvtJob,
  ZvtZahlungInput,
  KellnerTischwahl,
  KellnerModus,
  TischplanBereich,
} from '@kassa/shared'
import { getToken, clearAuth } from './auth'
import { clearKasseIdentity } from './kasse'

let onUnauthorized: (() => void) | null = null
export function setOnUnauthorized(fn: () => void) { onUnauthorized = fn }

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Maschinenlesbarer Fehlercode, z. B. 'freigabe_erforderlich'. */
    public code?: string,
  ) {
    super(message)
  }
}

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
    let code: string | undefined
    try {
      const body = JSON.parse(text) as { fehler?: string; code?: string }
      msg  = body.fehler ?? msg
      code = body.code
    } catch { /* ignore */ }
    throw new ApiError(res.status, msg, code)
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
  /**
   * Öffentliche Kassen-Auswahl fürs frische Gerät (VOR dem ersten Login).
   * Der alte Weg über GET /kassen war auth-geschützt — ohne Token 401, leere
   * Liste, totes PIN-Feld. (Der frühere getByUrl-Aufruf zeigte auf einen
   * Endpoint, den es im Backend nie gab — entfernt.)
   */
  list: (mandantId: string) =>
    request<{ id: string; bezeichnung: string }[]>('GET', `/api/kassen/auswahl?mandantId=${mandantId}`),
}

// ---------------------------------------------------------------------------
// Kellner-relevante Kassen-Konfiguration + Tischplan
// ---------------------------------------------------------------------------

/** Ausschnitt der pos-config, den die Kellner-App braucht. */
export interface KellnerKonfig {
  kellnerModus:          KellnerModus
  kellnerTischwahl:      KellnerTischwahl
  kellnerFavoritenAktiv: boolean
}

export const kellnerKonfigApi = {
  get: (kasseId: string) =>
    request<KellnerKonfig>('GET', `/api/kassen/${kasseId}/pos-config`),
}

export const tischplanApi = {
  listeBereiche: (kasseId: string) =>
    request<TischplanBereich[]>('GET', `/api/tischplan/bereiche?kasseId=${kasseId}`),
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
  aktualisierePositionen: (id: string, positionen: TabPosition[], freigabePin?: string) =>
    request<TabPositionenAntwort>('PUT', `/api/tisch-tabs/${id}/positionen`,
      { positionen, ...(freigabePin ? { freigabePin } : {}) }),
  bezahle: (id: string, input: TischTabBezahlenInput) =>
    request<{ tab: TischTabResponse; belegId: string }>('POST', `/api/tisch-tabs/${id}/bezahlen`, input),
  /** Gänge-Steuerung: nächsten offenen Gang an die Küche/Schank feuern */
  gangAbrufen: (id: string) =>
    request<{ tab: TischTabResponse; gang: number }>('POST', `/api/tisch-tabs/${id}/gang-abrufen`),
  /** Gänge-Steuerung: eine Position erneut schicken (Re-Print) */
  positionNachschicken: (id: string, positionIndex: number) =>
    request<void>('POST', `/api/tisch-tabs/${id}/position-nachschicken`, { positionIndex }),
}

// ---------------------------------------------------------------------------
// Belegausgabe (digitaler Beleg / Ausweich-Druck)
// ---------------------------------------------------------------------------

export interface DruckerConfig {
  belegModus:    'drucken' | 'digital' | 'beides'
  belegBasisUrl: string | null
}

/**
 * Antwort des Positions-Updates. `stornoBon` steht NUR drin, wenn der
 * Korrekturbon nach einem Storno ein Ziel nicht erreicht hat — dann bereitet die
 * Station sonst weiter zu, ohne es zu wissen.
 */
export interface TabPositionenAntwort extends TischTabResponse {
  stornoBon?: {
    fehler:     BonierZielFehler[]
    positionen: Array<{ artikelId: string; menge: number }>
  }
}

/** Beleg, dessen Bon nicht aus dem Drucker kam (und seither nicht nachgedruckt wurde). */
export interface DruckProblem {
  belegId:         string
  belegNummer:     number
  belegTyp:        string
  summeCent:       number
  fehlerText:      string | null
  druckerIp:       string
  zuletztVersucht: string
}

export const druckerApi = {
  get: (kasseId: string) =>
    request<DruckerConfig>('GET', `/api/kassen/${kasseId}/drucker`),
  /** „Nicht akzeptiert" → Rechnung auf den Kassa-Bondrucker erzwingen */
  druckenAusweich: (belegId: string) =>
    request<{ erfolgreich: boolean }>('POST', `/api/belege/${belegId}/drucken`, { ausweich: true }),
  druckprobleme: (kasseId: string) =>
    request<DruckProblem[]>('GET', `/api/kassen/${kasseId}/druckprobleme`),
  nachdrucken: (belegId: string) =>
    request<{ erfolgreich: boolean }>('POST', `/api/belege/${belegId}/drucken`, {}),
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
// KDS-Nachrichten (Antwort vom Kellner an die Station)
// ---------------------------------------------------------------------------

export const kdsAntwortApi = {
  senden: (text: string, station: string) =>
    request<{ erfolgreich: boolean }>('POST', '/api/kds/antwort', { text, station }),
}

// ---------------------------------------------------------------------------
// Bonierung
// ---------------------------------------------------------------------------

export const bonierApi = {
  bonieren: (input: BonierungInput) =>
    request<BonierungErgebnis>('POST', '/api/bestellung/bonieren', input),
}
