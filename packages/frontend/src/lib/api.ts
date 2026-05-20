import type {
  Artikel,
  ArtikelInput,
  ArtikelUpdate,
  BarzahlungsbelegInput,
  BelegResponse,
  JahresbelegInput,
  MonatsbelegInput,
  NullbelegInput,
  SetupInput,
  SetupResponse,
  StornobelegInput,
} from '@kassa/shared'

// ---------------------------------------------------------------------------
// Generischer Fetcher
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
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
