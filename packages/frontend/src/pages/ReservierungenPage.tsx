/**
 * ReservierungenPage — Tischreservierungen verwalten.
 *
 * - Wochenansicht: 7 Tage, je eine Spalte mit Reservierungen sortiert nach Uhrzeit
 * - Schnell-Erstellen via Modal
 * - Status-Workflow: Anfrage → Bestätigt → Erschienen / Nicht erschienen / Storniert
 * - Online-Buchungslink konfigurieren (QR-Code + Aktivierungs-Toggle)
 */

import { useState, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReservierungResponse, ReservierungStatus, ReservierungInput, ReservierungUpdate } from '@kassa/shared'
import { RESERVIERUNG_STATUS_LABELS } from '@kassa/shared'
import { reservierungApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { useKasseEvents } from '../lib/sse'

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function heuteISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function addTage(datum: string, tage: number): string {
  const d = new Date(datum)
  d.setDate(d.getDate() + tage)
  return d.toISOString().slice(0, 10)
}

function datumLabel(datum: string): string {
  return new Date(datum + 'T12:00:00').toLocaleDateString('de-AT', {
    weekday: 'short', day: 'numeric', month: 'numeric',
  })
}

const STATUS_FARBE: Record<ReservierungStatus, string> = {
  wartend:          'bg-amber-100 text-amber-800 border-amber-300',
  bestaetigt:       'bg-blue-100  text-blue-800  border-blue-200',
  erschienen:       'bg-green-100 text-green-800 border-green-200',
  nicht_erschienen: 'bg-gray-100  text-gray-500  border-gray-200',
  storniert:        'bg-red-50    text-red-500   border-red-200',
}

const NAECHSTE_STATUS: Partial<Record<ReservierungStatus, ReservierungStatus>> = {
  wartend:    'bestaetigt',
  bestaetigt: 'erschienen',
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export function ReservierungenPage() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [wochenStart, setWochenStart] = useState(heuteISO)
  const [detail,  setDetail]  = useState<ReservierungResponse | null>(null)
  const [formOffen, setFormOffen] = useState(false)
  const [editTarget, setEditTarget] = useState<ReservierungResponse | null>(null)

  const wochenEnde = addTage(wochenStart, 6)

  const { data: reservierungen = [], isLoading, isError } = useQuery({
    queryKey: ['reservierungen', identity.kasseId, wochenStart],
    queryFn:  () => reservierungApi.list({
      kasseId:  identity.kasseId,
      datumVon: wochenStart,
      datumBis: wochenEnde,
    }),
    refetchInterval: 60_000,
  })

  // SSE — neue Online-Reservierung sofort nachladen
  useKasseEvents((event) => {
    if (event.typ === 'neue_reservierung') {
      void queryClient.invalidateQueries({ queryKey: ['reservierungen', identity.kasseId] })
    }
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['reservierungen', identity.kasseId] })

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: ReservierungStatus }) =>
      reservierungApi.aktualisieren(id, { status }),
    onSuccess: () => { setDetail(null); invalidate() },
  })

  const loeschenMut = useMutation({
    mutationFn: (id: string) => reservierungApi.loeschen(id),
    onSuccess:  () => { setDetail(null); invalidate() },
  })

  // Tage der Woche
  const tage = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => addTage(wochenStart, i)),
  [wochenStart])

  const wartendAnzahl = reservierungen.filter(r => r.status === 'wartend').length

  return (
    <div className="flex flex-col h-full px-4 py-6 gap-4">

      {/* Kopfzeile */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            Reservierungen
            {wartendAnzahl > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 rounded-full bg-amber-500 text-white text-xs font-bold px-1.5">
                {wartendAnzahl}
              </span>
            )}
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {datumLabel(wochenStart)} – {datumLabel(wochenEnde)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setWochenStart(d => addTage(d, -7))}>
            ← Woche
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setWochenStart(heuteISO())}>
            Heute
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setWochenStart(d => addTage(d, 7))}>
            Woche →
          </Button>
          <Button size="sm" onClick={() => { setEditTarget(null); setFormOffen(true) }}>
            + Neu
          </Button>
        </div>
      </div>

      {/* Online-Buchungs-Setup */}
      <OnlineBuchungKarte kasseId={identity.kasseId} />

      {/* Wochenkalender */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
          Wird geladen…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Fehler beim Laden der Reservierungen.
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-2 flex-1 min-h-0 overflow-y-auto">
          {tage.map(tag => {
            const tagesRes = reservierungen
              .filter(r => r.datum === tag)
              .filter(r => r.status !== 'storniert')
            const istHeute = tag === heuteISO()
            return (
              <div key={tag} className="flex flex-col min-w-0">
                <div className={`text-center text-xs font-semibold py-1.5 rounded-t border ${
                  istHeute
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'bg-gray-50 text-gray-600 border-gray-200'
                }`}>
                  {datumLabel(tag)}
                </div>
                <div className="flex-1 border border-t-0 border-gray-200 rounded-b bg-white p-1.5 space-y-1.5 min-h-[120px]">
                  {tagesRes.length === 0 ? (
                    <p className="text-xs text-gray-300 text-center pt-3">—</p>
                  ) : (
                    tagesRes.map(r => (
                      <button
                        key={r.id}
                        onClick={() => setDetail(r)}
                        className={`w-full text-left rounded border px-2 py-1.5 text-xs hover:opacity-80 transition ${STATUS_FARBE[r.status]}`}
                      >
                        <p className="font-semibold truncate">{r.zeitVon} – {r.name}</p>
                        <p className="text-[10px] opacity-75">{r.personenAnzahl} Pers.{r.tischLabel ? ` · ${r.tischLabel}` : ''}</p>
                      </button>
                    ))
                  )}
                </div>
                {/* Neu-Button für diesen Tag */}
                <button
                  onClick={() => {
                    setEditTarget(null)
                    setFormOffen(true)
                  }}
                  className="mt-1 text-[10px] text-gray-400 hover:text-brand-600 text-center w-full py-0.5"
                  data-datum={tag}
                >
                  + hinzufügen
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Detail-Modal */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={`${detail?.name} – ${detail?.datum} ${detail?.zeitVon}`}
        size="md"
      >
        {detail && (
          <ReservierungDetail
            reservierung={detail}
            onStatusChange={(s) => statusMut.mutate({ id: detail.id, status: s })}
            onBearbeiten={() => { setEditTarget(detail); setDetail(null); setFormOffen(true) }}
            onLoeschen={() => { if (confirm('Reservierung löschen?')) loeschenMut.mutate(detail.id) }}
            loading={statusMut.isPending || loeschenMut.isPending}
            onClose={() => setDetail(null)}
          />
        )}
      </Modal>

      {/* Erstellen/Bearbeiten-Modal */}
      <Modal
        open={formOffen}
        onClose={() => setFormOffen(false)}
        title={editTarget ? 'Reservierung bearbeiten' : 'Neue Reservierung'}
        size="md"
      >
        <ReservierungForm
          kasseId={identity.kasseId}
          {...(editTarget ? { initial: editTarget } : {})}
          onSuccess={() => { setFormOffen(false); setEditTarget(null); invalidate() }}
          onAbbrechen={() => { setFormOffen(false); setEditTarget(null) }}
        />
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail-Modal
// ---------------------------------------------------------------------------

function ReservierungDetail({
  reservierung: r,
  onStatusChange,
  onBearbeiten,
  onLoeschen,
  loading,
  onClose,
}: {
  reservierung: ReservierungResponse
  onStatusChange: (s: ReservierungStatus) => void
  onBearbeiten: () => void
  onLoeschen: () => void
  loading: boolean
  onClose: () => void
}) {
  const naechster = NAECHSTE_STATUS[r.status]
  const istAktiv = r.status !== 'storniert' && r.status !== 'erschienen' && r.status !== 'nicht_erschienen'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-sm font-semibold px-2.5 py-1 rounded-full border ${STATUS_FARBE[r.status]}`}>
          {RESERVIERUNG_STATUS_LABELS[r.status]}
        </span>
        {r.quelle === 'online' && (
          <span className="text-xs font-medium bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
            Online-Buchung
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div><dt className="text-gray-500 text-xs">Datum</dt><dd className="font-medium">{r.datum}</dd></div>
        <div><dt className="text-gray-500 text-xs">Uhrzeit</dt><dd className="font-medium">{r.zeitVon} ({r.dauer} min)</dd></div>
        <div><dt className="text-gray-500 text-xs">Personen</dt><dd className="font-medium">{r.personenAnzahl}</dd></div>
        {r.tischLabel && <div><dt className="text-gray-500 text-xs">Tisch</dt><dd className="font-medium">{r.tischLabel}</dd></div>}
        {r.telefon    && <div><dt className="text-gray-500 text-xs">Telefon</dt><dd>{r.telefon}</dd></div>}
        {r.email      && <div className="col-span-2"><dt className="text-gray-500 text-xs">E-Mail</dt><dd>{r.email}</dd></div>}
      </dl>

      {r.notiz && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          {r.notiz}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
        {naechster && (
          <Button onClick={() => onStatusChange(naechster)} loading={loading}>
            → {RESERVIERUNG_STATUS_LABELS[naechster]}
          </Button>
        )}
        {istAktiv && (
          <Button variant="danger" onClick={() => onStatusChange('storniert')} loading={loading}>
            Stornieren
          </Button>
        )}
        {r.status === 'bestaetigt' && (
          <Button variant="secondary" onClick={() => onStatusChange('nicht_erschienen')} loading={loading}>
            Nicht erschienen
          </Button>
        )}
        {istAktiv && (
          <Button variant="secondary" onClick={onBearbeiten}>
            Bearbeiten
          </Button>
        )}
        <Button variant="secondary" onClick={onLoeschen} loading={loading} className="ml-auto text-red-600">
          Löschen
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Schließen
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Erstellen/Bearbeiten-Formular
// ---------------------------------------------------------------------------

function ReservierungForm({
  kasseId,
  initial,
  onSuccess,
  onAbbrechen,
}: {
  kasseId: string
  initial?: ReservierungResponse
  onSuccess: () => void
  onAbbrechen: () => void
}) {
  const [datum,          setDatum]          = useState(initial?.datum          ?? heuteISO())
  const [zeitVon,        setZeitVon]        = useState(initial?.zeitVon        ?? '12:00')
  const [dauer,          setDauer]          = useState(String(initial?.dauer   ?? 90))
  const [personenAnzahl, setPersonenAnzahl] = useState(String(initial?.personenAnzahl ?? 2))
  const [name,           setName]           = useState(initial?.name           ?? '')
  const [telefon,        setTelefon]        = useState(initial?.telefon        ?? '')
  const [email,          setEmail]          = useState(initial?.email          ?? '')
  const [notiz,          setNotiz]          = useState(initial?.notiz          ?? '')
  const [tischLabel,     setTischLabel]     = useState(initial?.tischLabel     ?? '')
  const [fehler,         setFehler]         = useState<string | null>(null)

  const speichernMut = useMutation({
    mutationFn: () => {
      const payload = {
        kasseId,
        datum,
        zeitVon,
        dauer:          parseInt(dauer),
        personenAnzahl: parseInt(personenAnzahl),
        name,
        ...(telefon    && { telefon    }),
        ...(email      && { email      }),
        ...(notiz      && { notiz      }),
        ...(tischLabel && { tischLabel }),
      } satisfies ReservierungInput

      if (initial) {
        const update: ReservierungUpdate = {
          datum, zeitVon,
          dauer:          parseInt(dauer),
          personenAnzahl: parseInt(personenAnzahl),
          name,
          ...(telefon    !== undefined && { telefon:    telefon    || undefined }),
          ...(email      !== undefined && { email:      email      || undefined }),
          ...(notiz      !== undefined && { notiz:      notiz      || undefined }),
          ...(tischLabel !== undefined && { tischLabel: tischLabel || undefined }),
        }
        return reservierungApi.aktualisieren(initial.id, update)
      }
      return reservierungApi.erstellen(payload)
    },
    onSuccess,
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); speichernMut.mutate() }}
      className="space-y-4"
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Datum *</label>
          <input type="date" required value={datum} onChange={e => setDatum(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Uhrzeit *</label>
          <input type="time" required value={zeitVon} onChange={e => setZeitVon(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Dauer (Min)</label>
          <select value={dauer} onChange={e => setDauer(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
            {[30, 60, 90, 120, 150, 180, 240].map(m => (
              <option key={m} value={m}>{m} min</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Personen *</label>
          <input type="number" required min={1} max={100} value={personenAnzahl}
            onChange={e => setPersonenAnzahl(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
        <input type="text" required value={name} onChange={e => setName(e.target.value)}
          placeholder="Mustermann"
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Telefon</label>
          <input type="tel" value={telefon} onChange={e => setTelefon(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Tisch</label>
          <input type="text" value={tischLabel} onChange={e => setTischLabel(e.target.value)}
            placeholder="z. B. Tisch 5"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">E-Mail</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Notiz</label>
        <textarea rows={2} value={notiz} onChange={e => setNotiz(e.target.value)}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none" />
      </div>

      {fehler && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{fehler}</div>
      )}

      <div className="flex gap-2 justify-end pt-1 border-t border-gray-100">
        <Button variant="secondary" type="button" onClick={onAbbrechen}>Abbrechen</Button>
        <Button type="submit" loading={speichernMut.isPending}>
          {initial ? 'Speichern' : 'Anlegen'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Online-Buchungs-Karte
// ---------------------------------------------------------------------------

function OnlineBuchungKarte({ kasseId }: { kasseId: string }) {
  const [offen, setOffen] = useState(false)
  const [kopiert, setKopiert] = useState(false)
  const queryClient = useQueryClient()

  const { data } = useQuery({
    queryKey: ['online-buchung', kasseId],
    queryFn:  () => reservierungApi.getOnlineBuchung(kasseId),
    staleTime: Infinity,
  })

  const toggleMut = useMutation({
    mutationFn: (aktiv: boolean) => reservierungApi.setOnlineBuchung(kasseId, aktiv),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['online-buchung', kasseId] }),
  })

  const kopiere = () => {
    if (!data?.buchungUrl) return
    void navigator.clipboard.writeText(data.buchungUrl)
    setKopiert(true)
    setTimeout(() => setKopiert(false), 1500)
  }

  return (
    <details
      className="rounded-lg border border-gray-200 bg-white"
      open={offen}
      onToggle={(e) => setOffen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-lg select-none">
        Online-Buchungslink
        {!offen && (
          <span className="ml-2 text-xs text-gray-400 font-normal">
            — Gäste können direkt online reservieren
          </span>
        )}
      </summary>
      <div className="border-t border-gray-200 px-4 py-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-700">Online-Buchung aktiv</p>
            <p className="text-xs text-gray-400 mt-0.5">
              Gäste können über den Link direkt reservieren
            </p>
          </div>
          <button
            type="button"
            onClick={() => data && toggleMut.mutate(!data.onlineBuchungAktiv)}
            disabled={toggleMut.isPending || !data}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
              data?.onlineBuchungAktiv ? 'bg-brand-600' : 'bg-gray-200'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              data?.onlineBuchungAktiv ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>

        {data?.buchungUrl && (
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">
              Buchungs-URL
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-gray-100 border border-gray-200 px-3 py-2 text-xs font-mono text-gray-700 break-all select-all">
                {data.buchungUrl}
              </code>
              <button
                type="button"
                onClick={kopiere}
                className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-700 border border-brand-300 rounded px-2 py-1.5 hover:bg-brand-50 transition"
              >
                {kopiert ? '✓' : 'Kopieren'}
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Teile diese URL als QR-Code oder Link auf deiner Website / Speisekarte.
            </p>
          </div>
        )}
      </div>
    </details>
  )
}
