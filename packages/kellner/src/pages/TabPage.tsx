import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import type { TabPosition } from '@kassa/shared'
import { tischTabApi, bonierApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'

export function TabPage() {
  const { tabId }   = useParams<{ tabId: string }>()
  const navigate    = useNavigate()
  const qc          = useQueryClient()
  const identity    = getKasseIdentity()!
  const auth        = getAuth()!
  const [bonierFehler, setBonierFehler] = useState<string | null>(null)
  const [bonierErfolg, setBonierErfolg] = useState(false)

  const tabQuery = useQuery({
    queryKey:        ['tisch-tab', tabId],
    queryFn:         () => tischTabApi.get(tabId!),
    refetchInterval: 10_000,
    enabled:         !!tabId,
  })

  const bonierMutation = useMutation({
    mutationFn: () => {
      const tab = tabQuery.data!
      return bonierApi.bonieren({
        kasseId:    identity.kasseId,
        tabId:      tab.id,
        tisch:      tab.tischNummer,
        kellner:    auth.user.name,
        positionen: tab.positionen.map(p => ({
          artikelId: p.artikelId,
          menge:     p.menge,
        })),
      })
    },
    onSuccess: () => {
      setBonierErfolg(true)
      qc.invalidateQueries({ queryKey: ['tisch-tab', tabId] })
      setTimeout(() => setBonierErfolg(false), 3000)
    },
    onError: (err) => setBonierFehler(err instanceof Error ? err.message : 'Fehler beim Bonieren'),
  })

  function positionEntfernen(idx: number) {
    const tab = tabQuery.data!
    const neuePositionen = tab.positionen.filter((_, i) => i !== idx)
    tischTabApi.aktualisierePositionen(tab.id, neuePositionen)
      .then(() => qc.invalidateQueries({ queryKey: ['tisch-tab', tabId] }))
      .catch(() => {/* ignore */})
  }

  if (tabQuery.isLoading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!tabQuery.data) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="text-center space-y-3">
        <p className="text-4xl">⚠️</p>
        <p className="text-gray-600">Tab nicht gefunden.</p>
        <button onClick={() => navigate('/')} className="text-green-600 font-bold text-sm">
          Zurück zur Übersicht
        </button>
      </div>
    </div>
  )

  const tab = tabQuery.data

  // Positionen gruppiert anzeigen (gleicher Artikel zusammenfassen)
  interface GruppiertePos {
    key:             string
    artikelId:       string
    bezeichnung:     string
    preisBruttoCent: number
    menge:           number
    modifikatoren:   TabPosition['modifikatoren']
    indices:         number[]
  }
  const gruppen = tab.positionen.reduce<GruppiertePos[]>((acc, pos, idx) => {
    const modKey = JSON.stringify(pos.modifikatoren ?? [])
    const key    = `${pos.artikelId}__${modKey}`
    const existing = acc.find(g => g.key === key)
    if (existing) {
      existing.menge += pos.menge
      existing.indices.push(idx)
    } else {
      acc.push({
        key,
        artikelId:       pos.artikelId,
        bezeichnung:     pos.bezeichnung,
        preisBruttoCent: pos.preisBruttoCent,
        menge:           pos.menge,
        modifikatoren:   pos.modifikatoren,
        indices:         [idx],
      })
    }
    return acc
  }, [])

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/')} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">
            ‹
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-black text-gray-900 text-lg leading-tight truncate">{tab.tischNummer}</h1>
            <p className="text-xs text-gray-500">{tab.kellner}</p>
          </div>
          <button
            onClick={() => navigate(`/tab/${tabId}/artikel`)}
            className="bg-green-600 text-white px-4 py-2 rounded-xl font-bold text-sm active:scale-95 transition shrink-0"
          >
            + Artikel
          </button>
        </div>
      </div>

      {/* Positionen */}
      <div className="flex-1 p-4 space-y-2 pb-36">
        {gruppen.length === 0 ? (
          <div className="text-center py-16 space-y-2">
            <p className="text-4xl">🍽</p>
            <p className="text-gray-500 text-sm">Noch keine Artikel</p>
            <button
              onClick={() => navigate(`/tab/${tabId}/artikel`)}
              className="text-green-600 font-bold text-sm"
            >
              Artikel hinzufügen
            </button>
          </div>
        ) : (
          gruppen.map(g => (
            <div key={g.key} className="bg-white rounded-2xl border border-gray-200 px-4 py-3 flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center text-green-700 font-black text-sm shrink-0 mt-0.5">
                {g.menge}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-gray-900 text-sm leading-tight">{g.bezeichnung}</p>
                {(g.modifikatoren?.length ?? 0) > 0 && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    {g.modifikatoren!.map(m => m.name).join(', ')}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="font-mono text-sm font-semibold text-gray-900">
                  {formatPreis(g.preisBruttoCent * g.menge)}
                </p>
                <button
                  onClick={() => positionEntfernen(g.indices[g.indices.length - 1]!)}
                  className="text-xs text-red-400 hover:text-red-600 mt-1"
                >
                  −1
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer: Summe + Bonieren */}
      {gruppen.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 max-w-lg mx-auto bg-white border-t border-gray-200 p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-gray-700">Gesamt</span>
            <span className="font-black text-xl font-mono text-gray-900">{formatPreis(tab.summeGesamtCent)}</span>
          </div>

          {bonierFehler && (
            <p className="text-red-500 text-sm text-center">{bonierFehler}</p>
          )}
          {bonierErfolg && (
            <p className="text-green-600 text-sm text-center font-bold">✓ Bon wurde gesendet</p>
          )}

          <button
            onClick={() => { setBonierFehler(null); bonierMutation.mutate() }}
            disabled={bonierMutation.isPending}
            className="w-full py-4 rounded-2xl bg-green-600 text-white font-black text-lg active:scale-95 transition disabled:opacity-50"
          >
            {bonierMutation.isPending ? '⏳ Wird gesendet…' : '🍳 Bonieren'}
          </button>

          <p className="text-center text-xs text-gray-400">
            Bezahlung an der Hauptkasse
          </p>
        </div>
      )}
    </div>
  )
}
