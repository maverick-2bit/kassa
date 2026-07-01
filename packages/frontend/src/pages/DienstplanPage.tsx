import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { DienstplanSchichtResponse, DienstplanStatus } from '@kassa/shared'
import { DIENSTPLAN_STATUS_LABELS } from '@kassa/shared'
import { dienstplanApi, userApi } from '../lib/api'
import { getAuth } from '../lib/auth'

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function wochenBeginn(datum: Date): Date {
  const d = new Date(datum)
  const tag = d.getDay() === 0 ? 6 : d.getDay() - 1 // Montag = 0
  d.setDate(d.getDate() - tag)
  d.setHours(0, 0, 0, 0)
  return d
}

function addTage(datum: Date, tage: number): Date {
  const d = new Date(datum)
  d.setDate(d.getDate() + tage)
  return d
}

function toYMD(datum: Date): string {
  return datum.toISOString().slice(0, 10)
}

function formatZeit(von: string, bis: string) {
  return `${von}–${bis}`
}

const STATUS_FARBE: Record<string, string> = {
  geplant:    'bg-blue-100 text-blue-800 border-blue-200',
  bestaetigt: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  krank:      'bg-red-100 text-red-800 border-red-200',
  abwesend:   'bg-panel-2 text-ink border-line',
}

const WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export function DienstplanPage() {
  const auth    = getAuth()
  const kassen  = auth?.kassen ?? []
  const qc      = useQueryClient()

  const [kasseId,       setKasseId]       = useState(kassen[0]?.id ?? '')
  const [wocheBeginn,   setWocheBeginn]   = useState(wochenBeginn(new Date()))
  const [showForm,      setShowForm]      = useState(false)
  const [editTarget,    setEditTarget]    = useState<DienstplanSchichtResponse | null>(null)
  const [defaultDatum,  setDefaultDatum]  = useState<string | null>(null)

  const datumVon = toYMD(wocheBeginn)
  const datumBis = toYMD(addTage(wocheBeginn, 6))

  const { data: schichten = [] } = useQuery({
    queryKey: ['dienstplan', kasseId, datumVon, datumBis],
    queryFn:  () => dienstplanApi.list({ kasseId, datumVon, datumBis }),
    enabled:  !!kasseId,
  })

  const loeschen = useMutation({
    mutationFn: (id: string) => dienstplanApi.loeschen(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['dienstplan'] }),
  })

  const geheVorwaerts = () => setWocheBeginn(addTage(wocheBeginn, 7))
  const geheZurueck   = () => setWocheBeginn(addTage(wocheBeginn, -7))
  const geheHeute     = () => setWocheBeginn(wochenBeginn(new Date()))

  // Schichten nach Datum gruppieren
  const schichtenNachDatum: Record<string, DienstplanSchichtResponse[]> = {}
  for (let i = 0; i < 7; i++) {
    schichtenNachDatum[toYMD(addTage(wocheBeginn, i))] = []
  }
  for (const s of schichten) {
    schichtenNachDatum[s.datum]?.push(s)
  }

  // Gesamt-Stunden der Woche pro Person
  const stundenProPerson: Record<string, { name: string; minuten: number }> = {}
  for (const s of schichten) {
    if (!stundenProPerson[s.userId]) stundenProPerson[s.userId] = { name: s.userName, minuten: 0 }
    stundenProPerson[s.userId]!.minuten += s.dauerMinuten
  }

  const wocheLabel = wocheBeginn.toLocaleDateString('de-AT', { day: '2-digit', month: 'long', year: 'numeric' })

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-ink">Dienstplan</h1>
        <div className="flex items-center gap-3">
          {kassen.length > 1 && (
            <select
              value={kasseId}
              onChange={e => setKasseId(e.target.value)}
              className="text-sm rounded-md border border-line-strong px-3 py-1.5"
            >
              {kassen.map(k => <option key={k.id} value={k.id}>{k.kassenId}</option>)}
            </select>
          )}
          <button
            onClick={() => { setEditTarget(null); setDefaultDatum(null); setShowForm(true) }}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Schicht eintragen
          </button>
        </div>
      </div>

      {/* Wochen-Navigation */}
      <div className="flex items-center gap-3">
        <button onClick={geheZurueck} className="p-2 rounded-md hover:bg-panel-2 border border-line">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-medium text-ink min-w-[220px] text-center">
          KW {getKW(wocheBeginn)} — {wocheLabel}
        </span>
        <button onClick={geheVorwaerts} className="p-2 rounded-md hover:bg-panel-2 border border-line">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button onClick={geheHeute} className="text-xs px-3 py-1.5 rounded-md border border-line hover:bg-panel-2 text-ink-muted">
          Heute
        </button>
      </div>

      {/* 7-Spalten-Kalender */}
      <div className="grid grid-cols-7 gap-2 min-h-[300px]">
        {Array.from({ length: 7 }, (_, i) => {
          const datum = toYMD(addTage(wocheBeginn, i))
          const schichtenHeute = schichtenNachDatum[datum] ?? []
          const istHeute = datum === toYMD(new Date())
          const d = addTage(wocheBeginn, i)

          return (
            <div key={datum} className={`rounded-xl border p-2 min-h-[150px] ${istHeute ? 'border-brand-400 bg-brand-50/30' : 'border-line bg-panel'}`}>
              <div className="text-center mb-2">
                <p className="text-xs font-semibold text-ink-muted">{WOCHENTAGE[i]}</p>
                <p className={`text-lg font-bold ${istHeute ? 'text-brand-600' : 'text-ink'}`}>
                  {d.getDate()}
                </p>
              </div>
              <div className="space-y-1">
                {schichtenHeute.map(s => (
                  <div
                    key={s.id}
                    className={`rounded-md border px-2 py-1 text-xs cursor-pointer hover:opacity-80 ${STATUS_FARBE[s.status] ?? 'bg-panel-2 text-ink'}`}
                    onClick={() => { setEditTarget(s); setShowForm(true) }}
                  >
                    <p className="font-semibold truncate">{s.userName}</p>
                    <p className="text-[10px] opacity-75">{formatZeit(s.beginnGeplant, s.endeGeplant)}</p>
                  </div>
                ))}
                <button
                  onClick={() => { setEditTarget(null); setDefaultDatum(datum); setShowForm(true) }}
                  className="w-full text-center text-ink-subtle hover:text-brand-500 text-lg leading-none py-0.5"
                  title="Schicht hinzufügen"
                >
                  +
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Wochen-Zusammenfassung */}
      {Object.keys(stundenProPerson).length > 0 && (
        <div className="bg-panel border border-line rounded-xl p-4">
          <h2 className="text-sm font-semibold text-ink mb-3">Wochenstunden</h2>
          <div className="flex flex-wrap gap-3">
            {Object.values(stundenProPerson).map(p => (
              <div key={p.name} className="flex items-center gap-2 bg-panel-2 rounded-lg px-3 py-2">
                <span className="text-sm font-medium text-ink">{p.name}</span>
                <span className="text-sm text-brand-600 font-mono font-semibold">
                  {Math.floor(p.minuten / 60)}h{p.minuten % 60 > 0 ? ` ${p.minuten % 60}m` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showForm && (
        <SchichtFormModal
          kasseId={kasseId}
          {...(editTarget !== null ? { initial: editTarget } : {})}
          {...(defaultDatum !== null ? { defaultDatum } : {})}
          onClose={() => { setShowForm(false); setEditTarget(null); setDefaultDatum(null) }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['dienstplan'] })
            setShowForm(false)
            setEditTarget(null)
            setDefaultDatum(null)
          }}
          {...(editTarget !== null ? { onDelete: () => {
            if (confirm('Schicht löschen?')) {
              loeschen.mutate(editTarget.id, { onSuccess: () => { setShowForm(false); setEditTarget(null) } })
            }
          } } : {})}
        />
      )}
    </div>
  )
}

function getKW(datum: Date): number {
  const d = new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate()))
  const tag = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - tag)
  const jahresAnfang = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - jahresAnfang.getTime()) / 86_400_000) + 1) / 7)
}

// ---------------------------------------------------------------------------
// Schicht-Form-Modal
// ---------------------------------------------------------------------------

interface SchichtFormProps {
  kasseId:       string
  initial?:      DienstplanSchichtResponse
  defaultDatum?: string
  onClose:       () => void
  onSaved:       () => void
  onDelete?:     () => void
}

function SchichtFormModal({ kasseId, initial, defaultDatum, onClose, onSaved, onDelete }: SchichtFormProps) {
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn:  () => userApi.list(),
  })

  const heute = new Date().toISOString().slice(0, 10)
  const [userId,        setUserId]        = useState(initial?.userId ?? users[0]?.id ?? '')
  const [datum,         setDatum]         = useState(initial?.datum ?? defaultDatum ?? heute)
  const [beginnGeplant, setBeginnGeplant] = useState(initial?.beginnGeplant ?? '09:00')
  const [endeGeplant,   setEndeGeplant]   = useState(initial?.endeGeplant   ?? '17:00')
  const [position,      setPosition]      = useState(initial?.position ?? '')
  const [notiz,         setNotiz]         = useState(initial?.notiz ?? '')
  const [status,        setStatus]        = useState<DienstplanStatus>(initial?.status ?? 'geplant')
  const [loading,       setLoading]       = useState(false)
  const [fehler,        setFehler]        = useState('')

  const handleSpeichern = async () => {
    if (!userId || !datum || !beginnGeplant || !endeGeplant) {
      setFehler('Bitte alle Pflichtfelder ausfüllen')
      return
    }
    setLoading(true)
    setFehler('')
    try {
      if (initial) {
        await dienstplanApi.aktualisieren(initial.id, {
          datum, beginnGeplant, endeGeplant,
          ...(position && { position }),
          ...(notiz    && { notiz    }),
          status,
        })
      } else {
        await dienstplanApi.erstellen({
          kasseId, userId, datum, beginnGeplant, endeGeplant,
          ...(position && { position }),
          ...(notiz    && { notiz    }),
        })
      }
      onSaved()
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Fehler beim Speichern')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-panel rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold">{initial ? 'Schicht bearbeiten' : 'Neue Schicht'}</h2>

        {!initial && (
          <div>
            <label className="text-sm font-medium text-ink">Mitarbeiter</label>
            <select
              value={userId}
              onChange={e => setUserId(e.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm"
            >
              {users.filter(u => u.aktiv).map(u => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>
        )}
        {initial && (
          <p className="text-sm font-medium text-ink">Mitarbeiter: <span className="text-ink">{initial.userName}</span></p>
        )}

        <div>
          <label className="text-sm font-medium text-ink">Datum</label>
          <input type="date" value={datum} onChange={e => setDatum(e.target.value)}
            className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium text-ink">Beginn</label>
            <input type="time" value={beginnGeplant} onChange={e => setBeginnGeplant(e.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-sm font-medium text-ink">Ende</label>
            <input type="time" value={endeGeplant} onChange={e => setEndeGeplant(e.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm" />
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Position (optional)</label>
          <input value={position} onChange={e => setPosition(e.target.value)}
            className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm"
            placeholder="z.B. Theke, Service, Küche" />
        </div>

        <div>
          <label className="text-sm font-medium text-ink">Notiz (optional)</label>
          <input value={notiz} onChange={e => setNotiz(e.target.value)}
            className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm" />
        </div>

        {initial && (
          <div>
            <label className="text-sm font-medium text-ink">Status</label>
            <select value={status} onChange={e => setStatus(e.target.value as DienstplanStatus)}
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm">
              {Object.entries(DIENSTPLAN_STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
        )}

        {fehler && <p className="text-sm text-red-600">{fehler}</p>}

        <div className="flex gap-3 pt-2">
          {onDelete && (
            <button onClick={onDelete}
              className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50">
              Löschen
            </button>
          )}
          <button onClick={onClose}
            className="flex-1 rounded-md border border-line-strong px-4 py-2 text-sm text-ink hover:bg-panel-2">
            Abbrechen
          </button>
          <button onClick={handleSpeichern} disabled={loading}
            className="flex-1 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            {loading ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  )
}
