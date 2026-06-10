import type {
  AngebotInput,
  AngebotResponse,
  AngebotStatus,
  AngebotUpdate,
  LiferscheinInput,
  LiferscheinResponse,
  LiferscheinStatus,
  LiferscheinUpdate,
  SammelrechnungInput,
  GutscheinInput,
  GutscheinResponse,
  GutscheinStatus,
  GutscheinEinloesen,
  GutscheinBuchungResponse,
  GutscheinEinloesungResult,
  OffenerPostenInput,
  OffenerPostenResponse,
  OffenerPostenStatus,
  OffenerPostenZahlung,
  SammelrechnungResponse,
  Kunde,
  KundeBelegVorschau,
  KundeInput,
  KundeUpdate,
  Bonierdrucker,
  BonierdruckerInput,
  BonierdruckerUpdate,
  PosKonfig,
  PosKonfigUpdate,
  ReihenfolgeUpdate,
  FavoritenReihenfolgeUpdate,
  LagerstandBulkInput,
  TischplanBereich,
  TischplanBereichErstellen,
  TischplanBereichAktualisieren,
  TischplanElementErstellen,
  TischplanElementAktualisieren,
  TischplanElement,
  TabEreignis,
  Artikel,
  ArtikelInput,
  ArtikelUpdate,
  ArtikelGruppenZuweisung,
  ArtikelBerichtResponse,
  WarengruppeBerichtResponse,
  StundenBerichtResponse,
  KellnerBerichtResponse,
  KassenVergleichResponse,
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
  Modifikator,
  ModifikatorGruppe,
  ModifikatorGruppeErstellen,
  ModifikatorGruppeAktualisieren,
  ModifikatorErstellen,
  ModifikatorAktualisieren,
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
  TischTabSplittenInput,
  TischTabResponse,
  User,
  UserCreateInput,
  UserUpdateInput,
  ZvtConfig,
  ZvtConfigUpdate,
  ZvtJob,
  ZvtZahlungInput,
  LieferbestellungResponse,
  LieferbestellungUpdate,
  MandantModule,
  MandantModuleUpdate,
  MandantStammdaten,
  MandantStammdatenUpdate,
  KasseBezeichnungUpdate,
  KassenbuchBuchung,
  KassenbuchBuchungInput,
  KassenbuchResponse,
  Lieferant,
  LieferantInput,
  LieferantUpdate,
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
// DEP-Export (Datei-Download)
// ---------------------------------------------------------------------------

export interface DepExportOptions {
  kasseId:  string
  format:   'dep7' | 'dep131'
  vonDatum?: string  // YYYY-MM-DD
  bisDatum?: string  // YYYY-MM-DD
}

export async function downloadDepExport(opts: DepExportOptions): Promise<{ anzahl: number }> {
  const params = new URLSearchParams({ kasseId: opts.kasseId })
  if (opts.vonDatum) params.set('vonDatum', opts.vonDatum)
  if (opts.bisDatum) params.set('bisDatum', opts.bisDatum)

  const token = getToken()
  const res = await fetch(`/api/belege/${opts.format}?${params}`, {
    headers: { Authorization: token ? `Bearer ${token}` : '' },
  })

  if (res.status === 401) { handleUnauthorized(); throw new ApiError(401, 'Nicht angemeldet') }
  if (!res.ok) {
    const text = await res.text()
    const fehler = text ? (JSON.parse(text) as { fehler?: string })?.fehler ?? `HTTP ${res.status}` : `HTTP ${res.status}`
    throw new ApiError(res.status, fehler)
  }

  const anzahl = parseInt(res.headers.get('X-Anzahl-Belege') ?? '0', 10)
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `${opts.format}.json`

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)

  return { anzahl }
}

// ---------------------------------------------------------------------------
// DEP-Sicherungen
// ---------------------------------------------------------------------------

export interface DepSicherungRow {
  id:           string
  mandantId:    string
  kasseId:      string
  erstelltAm:  string
  format:       string
  anzahlBelege: number
  dateiname:    string
  dateipfad:    string
  automatisch:  boolean
}

export const depSicherungApi = {
  liste: (kasseId: string) =>
    request<DepSicherungRow[]>('GET', `/api/dep-sicherungen?kasseId=${kasseId}`),
  erstellen: (kasseId: string) =>
    request<DepSicherungRow>('POST', '/api/dep-sicherungen', { kasseId }),
  download: async (id: string, dateiname: string): Promise<void> => {
    const token = getToken()
    const res = await fetch(`/api/dep-sicherungen/${id}/download`, {
      headers: { Authorization: token ? `Bearer ${token}` : '' },
    })
    if (res.status === 401) { handleUnauthorized(); return }
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
    const blob = await res.blob()
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download  = dateiname
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  },
}

// ---------------------------------------------------------------------------
// DB-Backups
// ---------------------------------------------------------------------------

export interface DbSicherungRow {
  id:           string
  erstelltAm:   string
  dateiname:    string
  dateigroesse: number
  automatisch:  boolean
  erfolgreich:  boolean
  fehler:       string | null
}

export const dbBackupApi = {
  liste: () =>
    request<DbSicherungRow[]>('GET', '/api/db-sicherungen'),
  erstellen: () =>
    request<DbSicherungRow>('POST', '/api/db-sicherungen'),
  download: async (id: string, dateiname: string): Promise<void> => {
    const token = getToken()
    const res = await fetch(`/api/db-sicherungen/${id}/download`, {
      headers: { Authorization: token ? `Bearer ${token}` : '' },
    })
    if (res.status === 401) { handleUnauthorized(); return }
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
    const blob = await res.blob()
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download  = dateiname
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  },
}

// ---------------------------------------------------------------------------
// Finanzprüfungs-Tokens
// ---------------------------------------------------------------------------

export interface PruefungsTokenRow {
  id:                 string
  mandantId:          string
  kasseId:            string
  token:              string
  erstelltAm:        string
  gueltigBis:         string
  erstelltVonUserId:  string | null
  beschreibung:       string | null
  widerrufen:         boolean
  letzteVerwendung:   string | null
}

export const finanzpruefungApi = {
  erstelleToken: (kasseId: string, gueltigkeitsTage: number, beschreibung?: string) =>
    request<PruefungsTokenRow>('POST', '/api/finanzpruefung/tokens', { kasseId, gueltigkeitsTage, beschreibung }),
  listeTokens: (kasseId: string) =>
    request<PruefungsTokenRow[]>('GET', `/api/finanzpruefung/tokens?kasseId=${kasseId}`),
  widerruf: (id: string) =>
    request<void>('DELETE', `/api/finanzpruefung/tokens/${id}`),
}

// ---------------------------------------------------------------------------
// Öffentliche Prüfer-API (kein Auth-Header)
// ---------------------------------------------------------------------------

export interface PruefungsDaten {
  kassenId:         string
  kasseBezeichnung: string | null
  token:            PruefungsTokenRow
  belege:           BelegResponse[]
}

export async function ladePruefungsDaten(token: string): Promise<PruefungsDaten> {
  const res = await fetch(`/api/pruefung/${token}`)
  if (!res.ok) {
    const text  = await res.text()
    const fehler = text ? (JSON.parse(text) as { fehler?: string })?.fehler : undefined
    throw new ApiError(res.status, fehler ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<PruefungsDaten>
}

export async function downloadPruefungDep7(token: string): Promise<void> {
  const res = await fetch(`/api/pruefung/${token}/dep7`)
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const filename    = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'dep7.json'
  const blob = await res.blob()
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download  = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
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
  bulkImport: (rows: Omit<ArtikelInput, 'mandantId'>[]) =>
    request<{ erstellt: number; fehlgeschlagen: number; fehlzeilen: { index: number; fehler: string }[] }>(
      'POST', '/api/artikel/bulk', rows,
    ),
  updateReihenfolge: (eintraege: ReihenfolgeUpdate['eintraege']) =>
    request<void>('PATCH', '/api/artikel/reihenfolge', { eintraege }),
  updateFavoritenReihenfolge: (eintraege: FavoritenReihenfolgeUpdate['eintraege']) =>
    request<void>('PATCH', '/api/artikel/favoriten-reihenfolge', { eintraege }),
  lagerAktivieren: (kategorieId: string | null) =>
    request<{ aktiviert: number }>('POST', '/api/artikel/lager-aktivieren', { kategorieId }),
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
  updateReihenfolge: (eintraege: ReihenfolgeUpdate['eintraege']) =>
    request<void>('PATCH', '/api/kategorien/reihenfolge', { eintraege }),
}

// ---------------------------------------------------------------------------
// Lieferanten
// ---------------------------------------------------------------------------

export const lieferantApi = {
  list:       () =>
    request<Lieferant[]>('GET', '/api/lieferanten'),
  create:     (input: LieferantInput) =>
    request<Lieferant>('POST', '/api/lieferanten', input),
  update:     (id: string, input: LieferantUpdate) =>
    request<Lieferant>('PUT', `/api/lieferanten/${id}`, input),
  deaktiviere:(id: string) =>
    request<void>('DELETE', `/api/lieferanten/${id}`),
}

// ---------------------------------------------------------------------------
// Bonierdrucker
// ---------------------------------------------------------------------------

export const bonierdruckerApi = {
  list:   () =>
    request<Bonierdrucker[]>('GET', '/api/bonierdrucker'),
  create: (input: BonierdruckerInput) =>
    request<Bonierdrucker>('POST', '/api/bonierdrucker', input),
  update: (id: string, input: BonierdruckerUpdate) =>
    request<Bonierdrucker>('PATCH', `/api/bonierdrucker/${id}`, input),
  delete: (id: string) =>
    request<void>('DELETE', `/api/bonierdrucker/${id}`),
  test:   (id: string) =>
    request<{ erfolgreich: boolean; fehler?: string }>('POST', `/api/bonierdrucker/${id}/test`),
}

// ---------------------------------------------------------------------------
// POS-Konfiguration
// ---------------------------------------------------------------------------

export const posConfigApi = {
  get:    (kasseId: string) =>
    request<PosKonfig>('GET', `/api/kassen/${kasseId}/pos-config`),
  update: (kasseId: string, input: PosKonfigUpdate) =>
    request<void>('PUT', `/api/kassen/${kasseId}/pos-config`, input),
}

// ---------------------------------------------------------------------------
// Belege
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Drucker
// ---------------------------------------------------------------------------

export interface DruckerConfig {
  druckerIp:         string | null
  druckerPort:       number
  druckerAktiv:      boolean
  druckerBreite:     number
  druckerTimeoutSek: number
}

export interface DruckerStatus {
  online:    boolean | null
  geprüftAm?: string
  grund?:     string
}

export interface DruckLogEintrag {
  id:         string
  druckerIp:  string
  druckerTyp: string
  belegId:    string | null
  erfolg:     boolean
  fehlerText: string | null
  erstelltAt: string
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
  status:     (kasseId: string) =>
    request<DruckerStatus>('GET', `/api/kassen/${kasseId}/drucker/status`),
  log:        (kasseId: string) =>
    request<DruckLogEintrag[]>('GET', `/api/kassen/${kasseId}/drucker/log`),
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
  uebersicht: () =>
    request<{ total: number; perStation: Record<string, number> }>('GET', '/api/kds/uebersicht'),
  antwort: (text: string, station: string) =>
    request<{ erfolgreich: boolean }>('POST', '/api/kds/antwort', { text, station }),
}

export const bonierApi = {
  bonieren: (input: BonierungInput) =>
    request<BonierungErgebnis>('POST', '/api/bestellung/bonieren', input),
}

export const belegApi = {
  list:       (kasseId: string, limit = 50, kundeId?: string) => {
    const p = new URLSearchParams({ kasseId, limit: String(limit) })
    if (kundeId) p.set('kundeId', kundeId)
    return request<BelegResponse[]>('GET', `/api/belege?${p.toString()}`)
  },
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
  artikel: (filter: { von: string; bis: string; kasseIds?: string[]; limit?: number }): Promise<ArtikelBerichtResponse> => {
    const p = new URLSearchParams()
    p.set('von', filter.von)
    p.set('bis', filter.bis)
    if (filter.limit) p.set('limit', String(filter.limit))
    for (const id of filter.kasseIds ?? []) p.append('kasseIds', id)
    return request<ArtikelBerichtResponse>('GET', `/api/berichte/artikel?${p.toString()}`)
  },
  warengruppe: (filter: { von: string; bis: string; kasseIds?: string[] }): Promise<WarengruppeBerichtResponse> => {
    const p = new URLSearchParams()
    p.set('von', filter.von)
    p.set('bis', filter.bis)
    for (const id of filter.kasseIds ?? []) p.append('kasseIds', id)
    return request<WarengruppeBerichtResponse>('GET', `/api/berichte/warengruppe?${p.toString()}`)
  },
  stunden: (filter: { von: string; bis: string; kasseIds?: string[] }): Promise<StundenBerichtResponse> => {
    const p = new URLSearchParams()
    p.set('von', filter.von)
    p.set('bis', filter.bis)
    for (const id of filter.kasseIds ?? []) p.append('kasseIds', id)
    return request<StundenBerichtResponse>('GET', `/api/berichte/stunden?${p.toString()}`)
  },
  kellner: (filter: { von: string; bis: string; kasseIds?: string[] }): Promise<KellnerBerichtResponse> => {
    const p = new URLSearchParams()
    p.set('von', filter.von)
    p.set('bis', filter.bis)
    for (const id of filter.kasseIds ?? []) p.append('kasseIds', id)
    return request<KellnerBerichtResponse>('GET', `/api/berichte/kellner?${p.toString()}`)
  },
  kassenVergleich: (filter: { von: string; bis: string }): Promise<KassenVergleichResponse> => {
    const p = new URLSearchParams()
    p.set('von', filter.von)
    p.set('bis', filter.bis)
    return request<KassenVergleichResponse>('GET', `/api/berichte/kassen-vergleich?${p.toString()}`)
  },
  buchungsjournalDownload: async (filter: { von: string; bis: string; kasseIds?: string[] }): Promise<void> => {
    const p = new URLSearchParams()
    p.set('von', filter.von)
    p.set('bis', filter.bis)
    for (const id of filter.kasseIds ?? []) p.append('kasseIds', id)
    const token = getToken()
    const res = await fetch(`/api/berichte/buchungsjournal?${p.toString()}`, {
      headers: { Authorization: token ? `Bearer ${token}` : '' },
    })
    if (res.status === 401) { handleUnauthorized(); return }
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
    const disposition = res.headers.get('Content-Disposition') ?? ''
    const filename    = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'buchungsjournal.csv'
    const blob = await res.blob()
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download  = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  },
}

export const tagesabschlussApi = {
  get:    (kasseId: string, datum: string) =>
    request<Tagesabschluss>('GET', `/api/belege/tagesabschluss?kasseId=${kasseId}&datum=${datum}`),
  drucken:(kasseId: string, datum: string) =>
    request<{ erfolgreich: boolean }>('POST', '/api/belege/tagesabschluss/drucken', { kasseId, datum }),
}

export interface KassensturzDruckInput {
  kasseId:       string
  datum:         string
  istCent:       number
  sollCent:      number
  differenzCent: number
  startgeldCent: number
  stueck:        { label: string; anzahl: number; summeCent: number }[]
}

export const kassensturzApi = {
  drucken: (input: KassensturzDruckInput) =>
    request<{ erfolgreich: boolean }>('POST', '/api/kassensturz/drucken', input),
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
  umbennene: (id: string, kellner: string) =>
    request<TischTabResponse>('PATCH', `/api/tisch-tabs/${id}/kellner`, { kellner }),
  umbucheTisch: (id: string, tischNummer: string) =>
    request<TischTabResponse>('PATCH', `/api/tisch-tabs/${id}/tisch`, { tischNummer }),
  splitteUndBezahle: (id: string, input: TischTabSplittenInput) =>
    request<{ tab: TischTabResponse; belegIds: string[] }>('POST', `/api/tisch-tabs/${id}/splitten`, input),
  getVerlauf: (id: string) =>
    request<TabEreignis[]>('GET', `/api/tisch-tabs/${id}/verlauf`),
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

// ---------------------------------------------------------------------------
// Tischplan
// ---------------------------------------------------------------------------

export const tischplanApi = {
  listeBereiche: (kasseId: string) =>
    request<TischplanBereich[]>('GET', `/api/tischplan/bereiche?kasseId=${kasseId}`),
  listeElemente: (kasseId: string) =>
    request<TischplanElement[]>('GET', `/api/tischplan/elemente?kasseId=${kasseId}`),

  erstelleBereich: (input: TischplanBereichErstellen) =>
    request<TischplanBereich>('POST', '/api/tischplan/bereiche', input),
  aktualisiereBereich: (id: string, input: TischplanBereichAktualisieren) =>
    request<void>('PATCH', `/api/tischplan/bereiche/${id}`, input),
  loescheBereich: (id: string) =>
    request<void>('DELETE', `/api/tischplan/bereiche/${id}`),

  erstelleElement: (input: TischplanElementErstellen) =>
    request<TischplanElement>('POST', '/api/tischplan/elemente', input),
  aktualisiereElement: (id: string, input: TischplanElementAktualisieren) =>
    request<void>('PATCH', `/api/tischplan/elemente/${id}`, input),
  loescheElement: (id: string) =>
    request<void>('DELETE', `/api/tischplan/elemente/${id}`),
}

// ---------------------------------------------------------------------------
// Modifikatoren
// ---------------------------------------------------------------------------

export const modifikatorApi = {
  listeGruppen: () =>
    request<ModifikatorGruppe[]>('GET', '/api/modifikator-gruppen'),
  listeArtikelZuweisungen: () =>
    request<{ artikelId: string; gruppeId: string; reihenfolge: number }[]>(
      'GET', '/api/artikel-modifikator-gruppen',
    ),
  erstelleGruppe: (input: ModifikatorGruppeErstellen) =>
    request<ModifikatorGruppe>('POST', '/api/modifikator-gruppen', input),
  aktualisiereGruppe: (id: string, input: ModifikatorGruppeAktualisieren) =>
    request<ModifikatorGruppe>('PATCH', `/api/modifikator-gruppen/${id}`, input),
  loescheGruppe: (id: string) =>
    request<void>('DELETE', `/api/modifikator-gruppen/${id}`),
  erstelleModifikator: (gruppeId: string, input: ModifikatorErstellen) =>
    request<ModifikatorGruppe>('POST', `/api/modifikator-gruppen/${gruppeId}/modifikatoren`, input),
  aktualisiereModifikator: (id: string, input: ModifikatorAktualisieren) =>
    request<ModifikatorGruppe>('PATCH', `/api/modifikatoren/${id}`, input),
  loescheModifikator: (id: string) =>
    request<void>('DELETE', `/api/modifikatoren/${id}`),
  getGruppenFuerArtikel: (artikelId: string) =>
    request<ModifikatorGruppe[]>('GET', `/api/artikel/${artikelId}/modifikator-gruppen`),
  setzeGruppenFuerArtikel: (artikelId: string, input: ArtikelGruppenZuweisung) =>
    request<ModifikatorGruppe[]>('PUT', `/api/artikel/${artikelId}/modifikator-gruppen`, input),
}

export type { Modifikator, ModifikatorGruppe }

export const lagerstandApi = {
  bulk: (input: LagerstandBulkInput) =>
    request<void>('POST', '/api/lagerstand/bulk', input),
}

// ---------------------------------------------------------------------------
// Kunden (CRM)
// ---------------------------------------------------------------------------

export const kundeApi = {
  list: (opts: { suche?: string; nurAktive?: boolean; limit?: number } = {}): Promise<Kunde[]> => {
    const p = new URLSearchParams()
    if (opts.suche)               p.set('suche',     opts.suche)
    if (opts.nurAktive === false)  p.set('nurAktive', 'false')
    if (opts.limit)                p.set('limit',     String(opts.limit))
    return request<Kunde[]>('GET', `/api/kunden?${p.toString()}`)
  },
  get: (id: string): Promise<Kunde> =>
    request<Kunde>('GET', `/api/kunden/${id}`),
  create: (input: KundeInput): Promise<Kunde> =>
    request<Kunde>('POST', '/api/kunden', input),
  update: (id: string, input: KundeUpdate): Promise<Kunde> =>
    request<Kunde>('PUT', `/api/kunden/${id}`, input),
  deactivate: (id: string): Promise<Kunde> =>
    request<Kunde>('DELETE', `/api/kunden/${id}`),
  reactivate: (id: string): Promise<Kunde> =>
    request<Kunde>('PUT', `/api/kunden/${id}`, { aktiv: true }),
  belege: (id: string): Promise<KundeBelegVorschau[]> =>
    request<KundeBelegVorschau[]>('GET', `/api/kunden/${id}/belege`),
}

// ---------------------------------------------------------------------------
// Angebote
// ---------------------------------------------------------------------------

export const lieferscheinApi = {
  list: (opts: { kundeId?: string; angebotId?: string; status?: LiferscheinStatus; limit?: number } = {}): Promise<LiferscheinResponse[]> => {
    const p = new URLSearchParams()
    if (opts.kundeId)   p.set('kundeId',   opts.kundeId)
    if (opts.angebotId) p.set('angebotId', opts.angebotId)
    if (opts.status)    p.set('status',    opts.status)
    if (opts.limit)     p.set('limit',     String(opts.limit))
    return request<LiferscheinResponse[]>('GET', `/api/lieferscheine?${p.toString()}`)
  },
  get: (id: string): Promise<LiferscheinResponse> =>
    request<LiferscheinResponse>('GET', `/api/lieferscheine/${id}`),
  create: (input: LiferscheinInput): Promise<LiferscheinResponse> =>
    request<LiferscheinResponse>('POST', '/api/lieferscheine', input),
  update: (id: string, input: LiferscheinUpdate): Promise<LiferscheinResponse> =>
    request<LiferscheinResponse>('PATCH', `/api/lieferscheine/${id}`, input),
}

export const sammelrechnungApi = {
  create: (input: SammelrechnungInput): Promise<SammelrechnungResponse> =>
    request<SammelrechnungResponse>('POST', '/api/sammelrechnungen', input),
}

export const gutscheinApi = {
  list: (opts: { status?: GutscheinStatus; kundeId?: string } = {}): Promise<GutscheinResponse[]> => {
    const p = new URLSearchParams()
    if (opts.status)  p.set('status',  opts.status)
    if (opts.kundeId) p.set('kundeId', opts.kundeId)
    return request<GutscheinResponse[]>('GET', `/api/gutscheine?${p}`)
  },
  get:        (id: string): Promise<GutscheinResponse> =>
    request<GutscheinResponse>('GET', `/api/gutscheine/${id}`),
  getByCode:  (code: string): Promise<GutscheinResponse> =>
    request<GutscheinResponse>('GET', `/api/gutscheine/code/${encodeURIComponent(code)}`),
  create:     (input: GutscheinInput): Promise<GutscheinResponse> =>
    request<GutscheinResponse>('POST', '/api/gutscheine', input),
  einloesen:  (id: string, input: GutscheinEinloesen): Promise<GutscheinEinloesungResult> =>
    request<GutscheinEinloesungResult>('POST', `/api/gutscheine/${id}/einloesen`, input),
  stornieren: (id: string): Promise<GutscheinResponse> =>
    request<GutscheinResponse>('POST', `/api/gutscheine/${id}/stornieren`),
  buchungen:  (id: string): Promise<GutscheinBuchungResponse[]> =>
    request<GutscheinBuchungResponse[]>('GET', `/api/gutscheine/${id}/buchungen`),
}

export const offenerPostenApi = {
  list: (opts: { kundeId?: string; status?: OffenerPostenStatus; limit?: number } = {}): Promise<OffenerPostenResponse[]> => {
    const p = new URLSearchParams()
    if (opts.kundeId) p.set('kundeId', opts.kundeId)
    if (opts.status)  p.set('status',  opts.status)
    if (opts.limit)   p.set('limit',   String(opts.limit))
    return request<OffenerPostenResponse[]>('GET', `/api/offene-posten?${p}`)
  },
  get: (id: string): Promise<OffenerPostenResponse> =>
    request<OffenerPostenResponse>('GET', `/api/offene-posten/${id}`),
  create: (input: OffenerPostenInput): Promise<OffenerPostenResponse> =>
    request<OffenerPostenResponse>('POST', '/api/offene-posten', input),
  zahlung: (id: string, input: OffenerPostenZahlung): Promise<OffenerPostenResponse> =>
    request<OffenerPostenResponse>('POST', `/api/offene-posten/${id}/zahlung`, input),
  statistik: (): Promise<{ anzahl: number; gesamtRestCent: number }> =>
    request<{ anzahl: number; gesamtRestCent: number }>('GET', '/api/offene-posten/statistik'),
}

export const angebotApi = {
  list: (opts: { status?: AngebotStatus; limit?: number } = {}): Promise<AngebotResponse[]> => {
    const p = new URLSearchParams()
    if (opts.status) p.set('status', opts.status)
    if (opts.limit)  p.set('limit',  String(opts.limit))
    return request<AngebotResponse[]>('GET', `/api/angebote?${p.toString()}`)
  },
  get: (id: string): Promise<AngebotResponse> =>
    request<AngebotResponse>('GET', `/api/angebote/${id}`),
  create: (input: AngebotInput): Promise<AngebotResponse> =>
    request<AngebotResponse>('POST', '/api/angebote', input),
  update: (id: string, input: AngebotUpdate): Promise<AngebotResponse> =>
    request<AngebotResponse>('PATCH', `/api/angebote/${id}`, input),
}

// ---------------------------------------------------------------------------
// Lieferbestellungen (Lieferando / Mergeport)
// ---------------------------------------------------------------------------

export const lieferApi = {
  list: (kasseId: string, opts: { nurNeu?: boolean; limit?: number } = {}): Promise<LieferbestellungResponse[]> => {
    const p = new URLSearchParams({ kasseId })
    if (opts.nurNeu) p.set('nurNeu', 'true')
    if (opts.limit)  p.set('limit',  String(opts.limit))
    return request<LieferbestellungResponse[]>('GET', `/api/lieferbestellungen?${p.toString()}`)
  },
  updateStatus: (id: string, input: LieferbestellungUpdate): Promise<LieferbestellungResponse> =>
    request<LieferbestellungResponse>('PATCH', `/api/lieferbestellungen/${id}`, input),
  drucken: (id: string): Promise<{ erfolgreich: boolean }> =>
    request<{ erfolgreich: boolean }>('POST', `/api/lieferbestellungen/${id}/drucken`),
  webhookUrls: (kasseId: string): Promise<{ webhookSecret: string; urls: { lieferando: string; mergeport: string; custom: string } }> =>
    request('GET', `/api/kassen/${kasseId}/webhook-url`),
}

export const mandantApi = {
  getModule: (): Promise<MandantModule> =>
    request<MandantModule>('GET', '/api/mandanten/module'),
  patchModule: (input: MandantModuleUpdate): Promise<MandantModule> =>
    request<MandantModule>('PATCH', '/api/mandanten/module', input),
  getStammdaten: (): Promise<MandantStammdaten> =>
    request<MandantStammdaten>('GET', '/api/mandanten/stammdaten'),
  patchStammdaten: (input: MandantStammdatenUpdate): Promise<MandantStammdaten> =>
    request<MandantStammdaten>('PATCH', '/api/mandanten/stammdaten', input),
}

// ---------------------------------------------------------------------------
// Kassen-Status (Zertifikats-Ablauf)
// ---------------------------------------------------------------------------

export interface KasseStatus {
  kasseId:       string
  bezeichnung:   string | null
  status:        string
  seeGueltigBis: string   // ISO-Datum
  seeRestTage:   number
  seeAbgelaufen: boolean
}

export interface JahresbelegStatus {
  jahr:                  number
  jahresbelegFaellig:    boolean
  jahresbelegErstelltAm: string | null   // ISO-Datum oder null
}

export const kasseApi = {
  getStatus: (kasseId: string): Promise<KasseStatus> =>
    request<KasseStatus>('GET', `/api/kassen/${kasseId}/status`),

  getJahresbelegStatus: (kasseId: string): Promise<JahresbelegStatus> =>
    request<JahresbelegStatus>('GET', `/api/kassen/${kasseId}/jahresbeleg-status`),

  updateBezeichnung: (kasseId: string, input: KasseBezeichnungUpdate): Promise<{ id: string; bezeichnung: string }> =>
    request<{ id: string; bezeichnung: string }>('PATCH', `/api/kassen/${kasseId}/bezeichnung`, input),
}

// ---------------------------------------------------------------------------
// Health-Check (Systeminfo)
// ---------------------------------------------------------------------------

export interface HealthStatus {
  status:     'ok' | 'degraded'
  version:    string
  uptimeSek:  number
  timestamp:  string
  checks: {
    db: 'ok' | 'unreachable'
  }
}

export const healthApi = {
  get: (): Promise<HealthStatus> =>
    request<HealthStatus>('GET', '/api/health'),
}

// ---------------------------------------------------------------------------
// Monitoring (admin)
// ---------------------------------------------------------------------------

export interface MonitoringStatus {
  timestamp:   string
  uptimeSek:   number
  version:     string
  nodeVersion: string
  platform:    string
  db: {
    ok:       boolean
    latenzMs: number | null
  }
  memory: {
    heapUsedMb:  number
    heapTotalMb: number
    rssMb:       number
    externalMb:  number
  }
  cpu: {
    userMs:   number
    systemMs: number
  }
  system: {
    loadAvg1:   number
    loadAvg5:   number
    freeMemMb:  number
    totalMemMb: number
  }
}

export const monitoringApi = {
  get: (): Promise<MonitoringStatus> =>
    request<MonitoringStatus>('GET', '/api/admin/monitoring'),
}

// ---------------------------------------------------------------------------
// Kassenbuch
// ---------------------------------------------------------------------------

export const kassenbuchApi = {
  liste: (kasseId: string, von: string, bis: string): Promise<KassenbuchResponse> =>
    request<KassenbuchResponse>('GET', `/api/kassenbuch?kasseId=${kasseId}&von=${von}&bis=${bis}`),

  erstelle: (input: KassenbuchBuchungInput): Promise<KassenbuchBuchung> =>
    request<KassenbuchBuchung>('POST', '/api/kassenbuch', input),

  drucken: (kasseId: string, von: string, bis: string): Promise<{ erfolgreich: boolean }> =>
    request<{ erfolgreich: boolean }>('POST', '/api/kassenbuch/drucken', { kasseId, von, bis }),
}

// ---------------------------------------------------------------------------
// Kundendisplay
// ---------------------------------------------------------------------------

export interface DisplayPosition {
  bezeichnung: string
  menge:       number
  preisCent:   number
}

export type DisplayEventPayload =
  | { typ: 'warenkorb'; positionen: DisplayPosition[]; summeCent: number }
  | { typ: 'beleg_erstellt'; belegNummer: number; summeCent: number }
  | { typ: 'leer' }

export const displayApi = {
  push: (kasseId: string, event: DisplayEventPayload) =>
    request<{ ok: boolean }>('POST', '/api/display', { kasseId, event }),
}

// ---------------------------------------------------------------------------
// E-Mail-Versand
// ---------------------------------------------------------------------------

export const emailApi = {
  sendBeleg: (belegId: string, empfaenger: string) =>
    request<{ erfolgreich: boolean }>('POST', `/api/belege/${belegId}/email`, { empfaenger }),
}

export { ApiError }
