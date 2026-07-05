import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { tischTabApi } from '../lib/api'
import { getAuth, clearAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'

export function TischePage() {
  const navigate    = useNavigate()
  const qc          = useQueryClient()
  const identity    = getKasseIdentity()!
  const auth        = getAuth()!
  const [neuerTisch, setNeuerTisch] = useState(false)
  const [tischNummer, setTischNummer] = useState('')
  const [fehler, setFehler]           = useState<string | null>(null)

  const tabsQuery = useQuery({
    queryKey:        ['tisch-tabs', identity.kasseId],
    queryFn:         () => tischTabApi.list(identity.kasseId),
    refetchInterval: 8_000,
  })

  const erstelleMutation = useMutation({
    mutationFn: () => tischTabApi.erstelle({
      kasseId:     identity.kasseId,
      tischNummer: tischNummer.trim(),
      kellner:     auth.user.name,
    }),
    onSuccess: (tab) => {
      qc.invalidateQueries({ queryKey: ['tisch-tabs'] })
      navigate(`/tab/${tab.id}`)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : 'Fehler'),
  })

  function abmelden() {
    clearAuth()
    navigate('/login', { replace: true })
  }

  const tabs = tabsQuery.data ?? []

  return (
    <div className="min-h-screen bg-surface flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <div className="bg-panel border-b border-line px-4 py-4 sticky top-0 z-10 flex items-center justify-between">
        <div>
          <h1 className="font-black text-ink text-lg">Tische</h1>
          <p className="text-xs text-ink-subtle">{auth.user.name} · {tabs.length} offen</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setNeuerTisch(true); setTischNummer(''); setFehler(null) }}
            className="bg-brand-600 text-white px-4 py-2 rounded-xl font-bold text-sm active:scale-95 transition"
          >
            + Tisch
          </button>
          <button
            onClick={abmelden}
            className="text-ink-subtle hover:text-ink-muted p-2 rounded-xl hover:bg-panel-2 transition text-sm"
            title="Abmelden"
          >
            ⏏
          </button>
        </div>
      </div>

      {/* Inhalt */}
      <div className="flex-1 p-4 space-y-3">
        {tabsQuery.isLoading && (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!tabsQuery.isLoading && tabs.length === 0 && (
          <div className="text-center py-16 space-y-2">
            <p className="text-4xl">🪑</p>
            <p className="text-ink-subtle text-sm">Keine offenen Tische</p>
          </div>
        )}

        {tabs.map(tab => {
          const minuten = Math.floor((Date.now() - new Date(tab.geoffnetAm).getTime()) / 60_000)
          const dauerText = minuten < 60
            ? `${minuten} min`
            : `${Math.floor(minuten / 60)}h ${minuten % 60}m`

          return (
            <button
              key={tab.id}
              onClick={() => navigate(`/tab/${tab.id}`)}
              className="w-full bg-panel rounded-2xl border border-line px-4 py-4 flex items-center justify-between gap-4 active:scale-98 transition text-left hover:border-brand-300 hover:shadow-sm"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center text-brand-700 font-black text-sm shrink-0">
                  {tab.tischNummer.slice(0, 3)}
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-ink truncate">{tab.tischNummer}</p>
                  <p className="text-xs text-ink-subtle">{tab.kellner} · {dauerText}</p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="font-black text-ink font-mono">{formatPreis(tab.summeGesamtCent)}</p>
                <p className="text-xs text-ink-subtle">{tab.positionen.length} Pos.</p>
              </div>
            </button>
          )
        })}
      </div>

      {/* Modal: Neuer Tisch */}
      {neuerTisch && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end justify-center p-4">
          <div className="bg-panel rounded-3xl w-full max-w-sm p-6 space-y-4">
            <h2 className="font-black text-ink text-lg">Neuer Tisch</h2>

            <input
              type="text"
              value={tischNummer}
              onChange={e => setTischNummer(e.target.value)}
              placeholder="z. B. Tisch 3 oder Bar"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && tischNummer.trim() && erstelleMutation.mutate()}
              className="w-full border-2 border-line rounded-xl px-4 py-3 text-base font-medium focus:outline-none focus:border-brand-500"
            />

            {fehler && <p className="text-red-500 text-sm">{fehler}</p>}

            <div className="flex gap-3">
              <button
                onClick={() => setNeuerTisch(false)}
                className="flex-1 py-3 rounded-xl border-2 border-line text-ink-muted font-bold text-sm hover:bg-surface transition"
              >
                Abbrechen
              </button>
              <button
                onClick={() => erstelleMutation.mutate()}
                disabled={!tischNummer.trim() || erstelleMutation.isPending}
                className="flex-1 py-3 rounded-xl bg-brand-600 text-white font-bold text-sm disabled:opacity-50 active:scale-95 transition"
              >
                {erstelleMutation.isPending ? '…' : 'Öffnen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
