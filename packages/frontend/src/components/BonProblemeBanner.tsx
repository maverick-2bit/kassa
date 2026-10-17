/**
 * Meldungen zu Bons, die der SERVER selbst ausgelöst hat: Direktverkauf-Beleg mit Küchenartikeln,
 * Gast-Bestellung, SB-Terminal.
 *
 * Dort wartet an der Kasse niemand auf die Antwort der Bonierung — und bezahlt ist längst. Ein toter Küchendrucker
 * oder ein Bon am Backup-Drucker blieb bisher völlig stumm. Der Server merkt sich den Stand je Kasse; diese Leiste
 * fragt ihn beim Öffnen und alle 30 s ab (ein SSE-Ereignis stößt das Neuladen früher an — war die Kasse zu, geht
 * deshalb nichts verloren).
 *
 *  - rot, „Bon NICHT angekommen“: mindestens ein Ziel hat den Bon nicht → „Nochmal senden“ (selbe Bestell-ID: dort,
 *    wo der Bon schon liegt, druckt nichts ein zweites Mal) oder „Verstanden“
 *  - bernsteinfarben: der Bon liegt am Backup-Drucker statt am vorgesehenen Drucker → „Verstanden“
 *
 * Bleibt stehen, bis das Personal es bestätigt — wie die Leisten an den Stellen, an denen die Oberfläche selbst boniert.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BonProblem } from '@kassa/shared'
import { bonProblemeApi } from '../lib/api'
import { Button } from './ui/Button'

export function BonProblemeBanner({ kasseId }: { kasseId: string }) {
  const qc = useQueryClient()
  const probleme = useQuery({
    queryKey:             ['bon-probleme', kasseId],
    queryFn:              () => bonProblemeApi.liste(kasseId),
    refetchInterval:      30_000,
    refetchOnWindowFocus: true,
  })

  const liste = probleme.data ?? []
  if (liste.length === 0) return null

  const aktualisiere = () => qc.invalidateQueries({ queryKey: ['bon-probleme', kasseId] })
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
        className="rounded border-2 border-amber-300 bg-amber-50 p-3 space-y-2"
      >
        <p className="text-xs font-bold text-amber-900">⚠ Bon an anderem Drucker ausgegeben — {problem.titel}</p>
        <ul className="space-y-1 text-xs text-amber-900">
          {problem.umleitungen.map((u, i) => <li key={`${u.von}-${u.an}-${i}`}>{u.hinweis}</li>)}
        </ul>
        <div className="flex justify-end">
          <Button variant="secondary" className="text-xs" loading={verstanden.isPending} onClick={() => verstanden.mutate()}>
            Verstanden
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="bon-problem-fehler" className="rounded border-2 border-red-400 bg-red-50 p-3 space-y-2">
      <p className="text-xs font-bold text-red-800">⚠ Bon NICHT angekommen — bitte prüfen</p>
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
        <ul className="space-y-1 text-xs text-amber-900">
          {problem.umleitungen.map((u, i) => <li key={`${u.von}-${u.an}-${i}`}>{u.hinweis}</li>)}
        </ul>
      )}
      <p className="text-xs text-red-700">
        Die Bestellung ist bezahlt. Nachsenden oder in der Küche Bescheid geben.
      </p>
      {nochmal.isError && (
        <p className="text-xs font-semibold text-red-700">
          Nachsenden fehlgeschlagen: {nochmal.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1 text-xs" loading={nochmal.isPending} onClick={() => nochmal.mutate()}>
          Nochmal senden
        </Button>
        <Button variant="secondary" className="text-xs" loading={verstanden.isPending} onClick={() => verstanden.mutate()}>
          Verstanden
        </Button>
      </div>
    </div>
  )
}
