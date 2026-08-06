/**
 * Warnleiste: Belege, deren Bon nicht aus dem Drucker kam.
 *
 * Der Autodruck läuft fire-and-forget mit Retry (2 s, 10 s, 30 s) — das ist
 * richtig so, ein Papierstau darf den Verkauf nicht blockieren. Scheitern aber
 * alle Versuche, hat der Gast keinen Beleg (RKSV-Belegerteilungspflicht) und
 * bisher hat es niemand erfahren: die Kassa meldete Erfolg, der Fehler stand nur
 * im Druck-Log. Bei leerem Papier wiederholt sich das bei JEDEM Verkauf.
 *
 * Deshalb: zyklisch nachfragen, deutlich anzeigen, direkt nachdrucken können.
 * Die Leiste verschwindet von selbst, sobald der Nachdruck geklappt hat.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { druckerApi } from '../lib/api'
import { formatPreis } from '../lib/format'
import { Button } from './ui/Button'

export function DruckproblemeBanner({ kasseId }: { kasseId: string }) {
  const qc = useQueryClient()

  const probleme = useQuery({
    queryKey:        ['druckprobleme', kasseId],
    queryFn:         () => druckerApi.druckprobleme(kasseId),
    // Der Retry braucht bis zu ~42 s; in dem Takt nachfragen reicht und hält die
    // Kasse ruhig. Auch beim Zurückwechseln auf den Tab prüfen.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })

  const nachdrucken = useMutation({
    mutationFn: (belegId: string) => druckerApi.reprint(belegId),
    onSettled:  () => qc.invalidateQueries({ queryKey: ['druckprobleme', kasseId] }),
  })

  const liste = probleme.data ?? []
  if (liste.length === 0) return null

  return (
    <div className="rounded-lg border-2 border-red-400 bg-red-50 p-3 space-y-2">
      <p className="text-sm font-bold text-red-800">
        ⚠ {liste.length === 1 ? 'Ein Beleg wurde' : `${liste.length} Belege wurden`} nicht gedruckt
      </p>
      <ul className="space-y-2">
        {liste.map(p => (
          <li key={p.belegId} className="flex items-center justify-between gap-3 text-xs text-red-700">
            <span>
              <span className="font-semibold">Beleg Nr. {p.belegNummer}</span>
              {' · '}{formatPreis(p.summeCent)}
              <span className="block text-red-600">
                {p.fehlerText ?? 'Grund unbekannt'} ({p.druckerIp})
              </span>
            </span>
            <Button
              variant="secondary"
              className="shrink-0 text-xs"
              loading={nachdrucken.isPending && nachdrucken.variables === p.belegId}
              onClick={() => nachdrucken.mutate(p.belegId)}
            >
              Nachdrucken
            </Button>
          </li>
        ))}
      </ul>
      {nachdrucken.isError && (
        <p className="text-xs font-semibold text-red-700">
          Nachdruck fehlgeschlagen — Drucker prüfen (Papier, Netz, Strom).
        </p>
      )}
      <p className="text-xs text-red-700">
        Der Beleg ist gültig gebucht; nur der Ausdruck fehlt. Der Gast hat Anspruch darauf.
      </p>
    </div>
  )
}
