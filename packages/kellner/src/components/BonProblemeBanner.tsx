/**
 * Meldungen zu Bons, die der SERVER selbst ausgelöst hat (Gast-Bestellung, SB-Terminal, Direktverkauf-Beleg).
 *
 * Der Gast hat schon bezahlt, und niemand wartete auf die Antwort der Bonierung: ein toter Küchendrucker bzw. ein
 * Bon am Backup-Drucker blieb stumm. Der Server merkt sich den Stand je Kasse; das Handy fragt beim Öffnen und alle
 * 30 s nach (ein SSE-Ereignis stößt das Neuladen früher an).
 *
 *  - rot „Bon NICHT angekommen“ → „Nochmal senden“ (selbe Bestell-ID: nichts wird doppelt gedruckt) oder „Verstanden“
 *  - bernsteinfarben (Bon liegt am Backup-Drucker) → „Verstanden“
 *
 * Bewusst dieselbe Datenquelle wie die Kasse (Komponente gleichen Namens im Haupt-POS).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BonProblem } from '@kassa/shared'
import { bonProblemeApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'

export function BonProblemeBanner() {
  const identity = getKasseIdentity()
  const qc = useQueryClient()
  const probleme = useQuery({
    queryKey:             ['bon-probleme', identity?.kasseId],
    queryFn:              () => bonProblemeApi.liste(identity!.kasseId),
    enabled:              !!identity?.kasseId,
    refetchInterval:      30_000,
    refetchOnWindowFocus: true,
  })

  const liste = probleme.data ?? []
  if (liste.length === 0) return null

  const aktualisiere = () => qc.invalidateQueries({ queryKey: ['bon-probleme', identity?.kasseId] })
  return (
    <div className="space-y-3" data-testid="bon-probleme">
      {liste.map(p => <BonProblemKarte key={p.id} problem={p} onGeaendert={aktualisiere} />)}
    </div>
  )
}

function BonProblemKarte({ problem, onGeaendert }: { problem: BonProblem; onGeaendert: () => void }) {
  const nochmal = useMutation({
    mutationFn: () => bonProblemeApi.nochmal(problem.id),
    onSettled:  onGeaendert,
  })
  const verstanden = useMutation({
    mutationFn: () => bonProblemeApi.verstanden(problem.id),
    onSettled:  onGeaendert,
  })

  if (problem.fehler.length === 0) {
    return (
      <div
        role="status"
        data-testid="bon-problem-umleitung"
        className="flex items-center gap-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-3"
      >
        <div className="flex-1 space-y-1">
          <p className="text-xs font-bold text-amber-900">{problem.titel}</p>
          <ul className="space-y-1 text-xs font-semibold text-amber-900">
            {problem.umleitungen.map((u, i) => <li key={`${u.von}-${u.an}-${i}`}>⚠ {u.hinweis}</li>)}
          </ul>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-lg border border-amber-500 px-3 py-3 text-sm font-bold text-amber-800 active:bg-amber-100 disabled:opacity-50"
          disabled={verstanden.isPending}
          onClick={() => verstanden.mutate()}
        >
          Verstanden
        </button>
      </div>
    )
  }

  return (
    <div data-testid="bon-problem-fehler" className="rounded-lg border-2 border-red-500 bg-red-50 p-3 space-y-2">
      <p className="text-sm font-bold text-red-800">⚠ Bon NICHT angekommen</p>
      <p className="text-xs font-semibold text-red-800">{problem.titel}</p>
      <ul className="space-y-1 text-xs text-red-700">
        {problem.fehler.map((z, i) => (
          <li key={`${z.ziel}-${i}`}>
            <span className="font-semibold">{z.ziel}</span>
            {z.istBackup && ' (Zweitdrucker)'}
            {z.ip && ` · ${z.ip}`}
            <span className="block text-red-600">{z.fehler}</span>
          </li>
        ))}
      </ul>
      {problem.umleitungen.length > 0 && (
        <ul className="space-y-1 text-xs font-semibold text-amber-900">
          {problem.umleitungen.map((u, i) => <li key={`${u.von}-${u.an}-${i}`}>⚠ {u.hinweis}</li>)}
        </ul>
      )}
      <p className="text-xs text-red-700">Die Bestellung ist bezahlt. Nachsenden oder in der Küche Bescheid geben.</p>
      {nochmal.isError && (
        <p className="text-xs font-semibold text-red-700">Nachsenden fehlgeschlagen: {nochmal.error.message}</p>
      )}
      <button
        type="button"
        className="w-full rounded-lg bg-red-600 py-3 text-sm font-bold text-white active:bg-red-700 disabled:opacity-50"
        disabled={nochmal.isPending}
        onClick={() => nochmal.mutate()}
      >
        {nochmal.isPending ? 'Sende …' : 'Nochmal senden'}
      </button>
      <button
        type="button"
        className="w-full rounded-lg border border-red-400 py-3 text-sm font-bold text-red-800 active:bg-red-100 disabled:opacity-50"
        disabled={verstanden.isPending}
        onClick={() => verstanden.mutate()}
      >
        Verstanden
      </button>
    </div>
  )
}
