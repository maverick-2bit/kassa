/**
 * SeeStatusBanner — auffälliger Warnbanner bei SEE-Ausfall.
 *
 * Solange die Signaturerstellungseinheit als ausgefallen gemeldet ist, werden
 * Belege NICHT signiert (sie tragen nur den RKSV-Ausfallmarker). Das muss am
 * Kassenplatz sofort sichtbar sein. Der Banner pollt den Status und bietet die
 * Wiederinbetriebnahme an (erzeugt serverseitig einen signierten Sammelbeleg).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { belegApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'

/** Minuten → „3 Std 12 Min" / „45 Min". */
export function formatAusfallDauer(min: number): string {
  if (min < 60) return `${min} Min`
  const std = Math.floor(min / 60)
  const rest = min % 60
  return rest === 0 ? `${std} Std` : `${std} Std ${rest} Min`
}

export function SeeStatusBanner() {
  const identity    = getKasseIdentity()
  const kasseId     = identity?.kasseId ?? ''
  const queryClient = useQueryClient()
  const [fehler, setFehler] = useState<string | null>(null)

  const { data: status } = useQuery({
    queryKey: ['see-status', kasseId],
    queryFn:  () => belegApi.seeStatus(kasseId),
    enabled:  !!kasseId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })

  const wiederherstellen = useMutation({
    mutationFn: () => belegApi.seeWiederherstellen(kasseId),
    onSuccess: () => {
      setFehler(null)
      queryClient.invalidateQueries({ queryKey: ['see-status', kasseId] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  if (!status?.ausgefallen) return null

  const dauer = status.dauerMinuten != null ? formatAusfallDauer(status.dauerMinuten) : null

  return (
    <div data-testid="see-banner" className="sticky top-0 z-40 bg-red-600 text-white shadow-md">
      <div className="mx-auto max-w-6xl px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        <span className="font-semibold flex items-center gap-1.5">
          <span aria-hidden>⚠</span> Sicherheitseinrichtung ausgefallen
        </span>
        <span className="text-red-100">
          Belege werden derzeit <strong>nicht signiert</strong>
          {dauer && <> · seit {dauer}</>}
          {status.fonMeldungNoetig && <> · <strong>FinanzOnline-Meldung nötig (&gt;48 h)</strong></>}
        </span>
        {fehler && <span className="text-red-100 italic">— {fehler}</span>}
        <button
          type="button"
          onClick={() => {
            if (confirm('Signatureinrichtung wieder in Betrieb nehmen? Es wird ein signierter Sammelbeleg erstellt.')) {
              wiederherstellen.mutate()
            }
          }}
          disabled={wiederherstellen.isPending}
          className="ml-auto rounded-md bg-white/15 hover:bg-white/25 disabled:opacity-60
                     px-3 py-1 font-medium transition whitespace-nowrap"
        >
          {wiederherstellen.isPending ? 'Wird wiederhergestellt…' : 'Wieder in Betrieb nehmen'}
        </button>
      </div>
    </div>
  )
}
