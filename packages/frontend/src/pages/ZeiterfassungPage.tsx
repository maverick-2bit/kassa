/**
 * ZeiterfassungPage — Personalzeiterfassung.
 *
 * Tab "Stempeln":  PIN-Numpad, Live-Anzeige wer eingestempelt ist.
 * Tab "Übersicht": Tages-/Wochen-/Monatssicht mit Stunden pro Mitarbeiter.
 * Tab "Einträge":  Admin-CRUD für manuelle Korrekturen + Löschen.
 */

import { useState, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ArbeitszeitResponse, ArbeitszeitInput, ArbeitszeitUpdate } from '@kassa/shared'
import { zeiterfassungApi, userApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function heuteISO() { return new Date().toISOString().slice(0, 10) }

function formatDauer(minuten: number | null): string {
  if (minuten === null) return '—'
  const h = Math.floor(minuten / 60)
  const m = minuten % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function formatZeit(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })
}

function formatDatum(iso: string): string {
  return new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function wocheISO(datum: string, offset: number): string {
  const d = new Date(datum)
  d.setDate(d.getDate() + offset * 7)
  return d.toISOString().slice(0, 10)
}

function montagDerWoche(datum: string): string {
  const d = new Date(datum + 'T12:00:00')
  const tag = d.getDay() || 7
  d.setDate(d.getDate() - (tag - 1))
  return d.toISOString().slice(0, 10)
}

function addTage(datum: string, n: number): string {
  const d = new Date(datum)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

type Tab = 'stempeln' | 'uebersicht' | 'eintraege'

export function ZeiterfassungPage() {
  const [tab, setTab] = useState<Tab>('stempeln')

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Zeiterfassung</h1>
      </div>

      {/* Tab-Leiste */}
      <div className="flex gap-1 border-b border-gray-200">
        {([
          ['stempeln',  'Stempeln'],
          ['uebersicht','Übersicht'],
          ['eintraege', 'Einträge'],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === key
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'stempeln'  && <StempelTab />}
      {tab === 'uebersicht'&& <UebersichtTab />}
      {tab === 'eintraege' && <EintraegeTab />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab: Stempeln
// ---------------------------------------------------------------------------

function StempelTab() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [pin, setPin]         = useState('')
  const [meldung, setMeldung] = useState<{ text: string; art: 'erfolg' | 'fehler' } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { data: aktuell = [] } = useQuery({
    queryKey: ['ze-aktuell'],
    queryFn:  () => zeiterfassungApi.aktuell(),
    refetchInterval: 30_000,
  })

  const stempelMut = useMutation({
    mutationFn: () => zeiterfassungApi.stempeln({ kasseId: identity.kasseId, pin }),
    onSuccess: (data) => {
      const text = data.aktion === 'eingestempelt'
        ? `✓ ${data.userName} — Eingestempelt`
        : `✓ ${data.userName} — Ausgestempelt (${formatDauer(data.dauerMinuten ?? null)})`
      setMeldung({ text, art: 'erfolg' })
      setPin('')
      void queryClient.invalidateQueries({ queryKey: ['ze-aktuell'] })
    },
    onError: (err) => {
      setMeldung({ text: err instanceof Error ? err.message : 'Fehler', art: 'fehler' })
      setPin('')
    },
    onSettled: () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setMeldung(null), 4000)
    },
  })

  const drucke = (taste: string) => {
    if (taste === '⌫') {
      setPin(p => p.slice(0, -1))
    } else if (taste === '✓') {
      if (pin.length >= 3) stempelMut.mutate()
    } else if (pin.length < 8) {
      setPin(p => p + taste)
    }
  }

  const tasten = ['1','2','3','4','5','6','7','8','9','⌫','0','✓']

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

      {/* PIN-Numpad */}
      <div className="flex flex-col items-center gap-4">
        {/* PIN-Anzeige */}
        <div className="w-full max-w-xs bg-gray-50 border border-gray-200 rounded-xl px-6 py-4 text-center">
          <p className="text-xs text-gray-400 mb-1">PIN eingeben</p>
          <div className="flex justify-center gap-3 mt-1">
            {Array.from({ length: Math.max(pin.length, 4) }, (_, i) => (
              <div
                key={i}
                className={`w-4 h-4 rounded-full border-2 transition ${
                  i < pin.length ? 'bg-brand-600 border-brand-600' : 'border-gray-300'
                }`}
              />
            ))}
          </div>
        </div>

        {/* Numpad */}
        <div className="grid grid-cols-3 gap-3 w-full max-w-xs">
          {tasten.map(t => (
            <button
              key={t}
              onClick={() => drucke(t)}
              disabled={stempelMut.isPending}
              className={`
                h-14 rounded-xl text-xl font-semibold transition select-none
                ${t === '✓'
                  ? 'bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50'
                  : t === '⌫'
                  ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  : 'bg-white border border-gray-200 text-gray-800 hover:bg-gray-50 shadow-sm'}
              `}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Meldung */}
        {meldung && (
          <div className={`w-full max-w-xs rounded-lg border px-4 py-3 text-sm font-medium text-center ${
            meldung.art === 'erfolg'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}>
            {meldung.text}
          </div>
        )}
      </div>

      {/* Aktuell eingestempelt */}
      <div>
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide mb-3">
          Aktuell eingestempelt
        </h2>
        {aktuell.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-400">
            Niemand ist derzeit eingestempelt.
          </div>
        ) : (
          <div className="space-y-2">
            {aktuell.map(az => {
              const seitMin = Math.floor((Date.now() - new Date(az.beginn).getTime()) / 60_000)
              return (
                <div key={az.id} className="flex items-center justify-between bg-white rounded-lg border border-gray-200 px-4 py-3">
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">{az.userName}</p>
                    <p className="text-xs text-gray-400">seit {formatZeit(az.beginn)}</p>
                  </div>
                  <span className="text-sm font-mono font-semibold text-green-700 bg-green-50 px-2 py-1 rounded-full">
                    {formatDauer(seitMin)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab: Übersicht (Wochenansicht + Summen)
// ---------------------------------------------------------------------------

function UebersichtTab() {
  const identity = getKasseIdentity()!
  const [wochenstart, setWochenstart] = useState(() => montagDerWoche(heuteISO()))

  const wochenende = addTage(wochenstart, 6)

  const { data: eintraege = [], isLoading } = useQuery({
    queryKey: ['ze-liste', wochenstart],
    queryFn:  () => zeiterfassungApi.list({
      kasseId:  identity.kasseId,
      datumVon: wochenstart,
      datumBis: wochenende,
    }),
  })

  // Gruppierung nach userName
  const perPerson = eintraege.reduce<Record<string, { eintraege: ArbeitszeitResponse[]; nettoMin: number }>>((acc, az) => {
    if (!acc[az.userName]) acc[az.userName] = { eintraege: [], nettoMin: 0 }
    acc[az.userName]!.eintraege.push(az)
    acc[az.userName]!.nettoMin += az.nettoMinuten ?? 0
    return acc
  }, {})

  return (
    <div className="space-y-4">
      {/* Wochen-Navigation */}
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setWochenstart(d => wocheISO(d, -1))}>← Woche</Button>
        <Button variant="secondary" size="sm" onClick={() => setWochenstart(montagDerWoche(heuteISO()))}>Heute</Button>
        <Button variant="secondary" size="sm" onClick={() => setWochenstart(d => wocheISO(d, 1))}>Woche →</Button>
        <span className="text-sm text-gray-500 ml-2">
          {formatDatum(wochenstart)} – {formatDatum(wochenende)}
        </span>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400">Wird geladen…</p>
      ) : Object.keys(perPerson).length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-400">
          Keine Einträge für diese Woche.
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(perPerson).map(([name, { eintraege: azen, nettoMin }]) => (
            <div key={name} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                <span className="font-semibold text-gray-800">{name}</span>
                <span className="text-sm font-mono font-bold text-brand-700">
                  Gesamt: {formatDauer(nettoMin)}
                </span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-400 uppercase tracking-wide">
                    <th className="px-4 py-2 text-left">Datum</th>
                    <th className="px-4 py-2 text-left">Beginn</th>
                    <th className="px-4 py-2 text-left">Ende</th>
                    <th className="px-4 py-2 text-left">Pause</th>
                    <th className="px-4 py-2 text-right">Netto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {azen.map(az => (
                    <tr key={az.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-600">{formatDatum(az.beginn)}</td>
                      <td className="px-4 py-2 font-mono">{formatZeit(az.beginn)}</td>
                      <td className="px-4 py-2 font-mono">{az.ende ? formatZeit(az.ende) : <span className="text-green-600 font-semibold">aktiv</span>}</td>
                      <td className="px-4 py-2 text-gray-500">{az.pauseMinuten > 0 ? `${az.pauseMinuten}m` : '—'}</td>
                      <td className="px-4 py-2 text-right font-mono font-semibold">{formatDauer(az.nettoMinuten)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab: Einträge (Admin-CRUD)
// ---------------------------------------------------------------------------

function EintraegeTab() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [datumVon, setDatumVon] = useState(montagDerWoche(heuteISO()))
  const [datumBis, setDatumBis] = useState(addTage(montagDerWoche(heuteISO()), 6))
  const [formOffen, setFormOffen]   = useState(false)
  const [editTarget, setEditTarget] = useState<ArbeitszeitResponse | null>(null)

  const { data: eintraege = [], isLoading } = useQuery({
    queryKey: ['ze-eintraege', datumVon, datumBis, identity.kasseId],
    queryFn:  () => zeiterfassungApi.list({ kasseId: identity.kasseId, datumVon, datumBis }),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['ze-eintraege'] })

  const loeschenMut = useMutation({
    mutationFn: (id: string) => zeiterfassungApi.loeschen(id),
    onSuccess:  invalidate,
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-gray-600">Von</label>
          <input type="date" value={datumVon} onChange={e => setDatumVon(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-gray-600">Bis</label>
          <input type="date" value={datumBis} onChange={e => setDatumBis(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <Button size="sm" onClick={() => { setEditTarget(null); setFormOffen(true) }} className="ml-auto">
          + Manuell anlegen
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400">Wird geladen…</p>
      ) : eintraege.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-400">
          Keine Einträge im gewählten Zeitraum.
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-2 text-left">Mitarbeiter</th>
                <th className="px-4 py-2 text-left">Datum</th>
                <th className="px-4 py-2 text-left">Beginn</th>
                <th className="px-4 py-2 text-left">Ende</th>
                <th className="px-4 py-2 text-left">Netto</th>
                <th className="px-4 py-2 text-left">Quelle</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {eintraege.map(az => (
                <tr key={az.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium">{az.userName}</td>
                  <td className="px-4 py-2 text-gray-600">{formatDatum(az.beginn)}</td>
                  <td className="px-4 py-2 font-mono">{formatZeit(az.beginn)}</td>
                  <td className="px-4 py-2 font-mono">
                    {az.ende ? formatZeit(az.ende) : <span className="text-green-600 font-semibold text-xs">aktiv</span>}
                  </td>
                  <td className="px-4 py-2 font-mono font-semibold">{formatDauer(az.nettoMinuten)}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      az.quelle === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {az.quelle === 'admin' ? 'Admin' : 'PIN'}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => { setEditTarget(az); setFormOffen(true) }}
                        className="text-xs text-gray-400 hover:text-brand-600 px-2 py-1 rounded hover:bg-brand-50">
                        Bearbeiten
                      </button>
                      <button
                        onClick={() => { if (confirm('Eintrag löschen?')) loeschenMut.mutate(az.id) }}
                        className="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50">
                        Löschen
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={formOffen}
        onClose={() => setFormOffen(false)}
        title={editTarget ? 'Eintrag bearbeiten' : 'Eintrag anlegen'}
        size="md"
      >
        <ArbeitszeitForm
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
// Formular für manuelle Einträge
// ---------------------------------------------------------------------------

function ArbeitszeitForm({
  kasseId,
  initial,
  onSuccess,
  onAbbrechen,
}: {
  kasseId: string
  initial?: ArbeitszeitResponse
  onSuccess: () => void
  onAbbrechen: () => void
}) {
  const identity = getKasseIdentity()!
  const { data: userListe = [] } = useQuery({
    queryKey: ['users'],
    queryFn:  () => userApi.list(),
  })

  const toLocalDT = (iso: string) => {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const jetzt = toLocalDT(new Date().toISOString())

  const [userId,       setUserId]       = useState(initial?.userId      ?? '')
  const [beginn,       setBeginn]       = useState(initial ? toLocalDT(initial.beginn) : jetzt)
  const [ende,         setEnde]         = useState(initial?.ende ? toLocalDT(initial.ende) : '')
  const [pauseMin,     setPauseMin]     = useState(String(initial?.pauseMinuten ?? 0))
  const [notiz,        setNotiz]        = useState(initial?.notiz ?? '')
  const [fehler,       setFehler]       = useState<string | null>(null)

  const speichernMut = useMutation({
    mutationFn: () => {
      if (initial) {
        const update: ArbeitszeitUpdate = {
          beginn:        new Date(beginn).toISOString(),
          pauseMinuten:  parseInt(pauseMin),
          ...(ende  && { ende: new Date(ende).toISOString()  }),
          ...(notiz && { notiz }),
        }
        return zeiterfassungApi.aktualisieren(initial.id, update)
      }
      const input: ArbeitszeitInput = {
        kasseId:       identity.kasseId,
        userId,
        beginn:        new Date(beginn).toISOString(),
        pauseMinuten:  parseInt(pauseMin),
        ...(ende  && { ende: new Date(ende).toISOString() }),
        ...(notiz && { notiz }),
      }
      return zeiterfassungApi.erstellen(input)
    },
    onSuccess,
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  return (
    <form onSubmit={e => { e.preventDefault(); setFehler(null); speichernMut.mutate() }} className="space-y-4">
      {!initial && (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Mitarbeiter *</label>
          <select required value={userId} onChange={e => setUserId(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
            <option value="">— auswählen —</option>
            {userListe.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Beginn *</label>
          <input type="datetime-local" required value={beginn} onChange={e => setBeginn(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Ende</label>
          <input type="datetime-local" value={ende} onChange={e => setEnde(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Pause (Minuten)</label>
        <input type="number" min={0} max={480} value={pauseMin} onChange={e => setPauseMin(e.target.value)}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Notiz</label>
        <input type="text" value={notiz} onChange={e => setNotiz(e.target.value)}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
      </div>

      {fehler && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{fehler}</div>
      )}

      <div className="flex gap-2 justify-end pt-1 border-t border-gray-100">
        <Button variant="secondary" type="button" onClick={onAbbrechen}>Abbrechen</Button>
        <Button type="submit" loading={speichernMut.isPending}>{initial ? 'Speichern' : 'Anlegen'}</Button>
      </div>
    </form>
  )
}
