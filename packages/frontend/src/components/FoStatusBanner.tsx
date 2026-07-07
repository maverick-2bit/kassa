/**
 * FoStatusBanner — Warnbanner für provisorisch (ohne FinanzOnline) eingerichtete
 * Kassen.
 *
 * Wurde die Kasse ohne FON-Zugangsdaten eingerichtet (z. B. kurzfristig am
 * Event), darf sie provisorisch kassieren, MUSS aber die FinanzOnline-
 * Registrierung zeitnah nachtragen. Der Banner weist app-weit darauf hin und
 * bietet das Nachtragen direkt an (SEE + Kasse registrieren, Startbeleg prüfen).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { belegApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'

export function FoStatusBanner() {
  const identity    = getKasseIdentity()
  const kasseId     = identity?.kasseId ?? ''
  const queryClient = useQueryClient()
  const [offen, setOffen]   = useState(false)
  const [tid, setTid]       = useState('')
  const [benId, setBenId]   = useState('')
  const [pin, setPin]       = useState('')
  const [fehler, setFehler] = useState<string | null>(null)

  const { data: status } = useQuery({
    queryKey: ['fo-status', kasseId],
    queryFn:  () => belegApi.foStatus(kasseId),
    enabled:  !!kasseId,
    refetchInterval: 60_000,
  })

  const registrieren = useMutation({
    mutationFn: () => belegApi.foRegistrieren(kasseId, {
      teilnehmerId: tid.trim(), benutzerkennung: benId.trim(), pin: pin.trim(),
    }),
    onSuccess: () => {
      setFehler(null); setPin(''); setOffen(false)
      queryClient.invalidateQueries({ queryKey: ['fo-status', kasseId] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  if (!status || status.registriert) return null

  const kannRegistrieren = tid.trim() && benId.trim() && pin.trim()

  return (
    <div data-testid="fo-banner" className="sticky top-0 z-40 bg-amber-500 text-amber-950 shadow-md">
      <div className="mx-auto max-w-6xl px-4 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="font-semibold flex items-center gap-1.5">
            <span aria-hidden>⚠</span> FinanzOnline-Registrierung ausstehend
          </span>
          <span className="text-amber-900">
            Provisorische Kasse — Belege werden signiert, aber die FON-Registrierung ist <strong>zeitnah nachzutragen</strong>.
          </span>
          <button
            type="button"
            onClick={() => { setOffen(o => !o); setFehler(null) }}
            className="ml-auto rounded-md bg-amber-950/10 hover:bg-amber-950/20 px-3 py-1 font-medium transition whitespace-nowrap"
          >
            {offen ? 'Schließen' : 'Jetzt nachtragen'}
          </button>
        </div>

        {offen && (
          <div className="mt-2.5 rounded-md bg-amber-50 border border-amber-300 p-3">
            <p className="text-xs text-amber-800 mb-2">
              FinanzOnline-Zugangsdaten eingeben — Kasse und Signatureinrichtung werden registriert
              und der Kassenstatus abgefragt (den Startbeleg prüfst du danach mit der BMF-BelegCheck-App).
              Die Zugangsdaten werden nicht gespeichert.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input value={tid} onChange={e => setTid(e.target.value)} placeholder="Teilnehmer-ID (TID)" autoComplete="off"
                className="rounded border border-amber-300 bg-panel px-2 py-1.5 text-sm text-ink" />
              <input value={benId} onChange={e => setBenId(e.target.value)} placeholder="Benutzerkennung (BenID)" autoComplete="off"
                className="rounded border border-amber-300 bg-panel px-2 py-1.5 text-sm text-ink" />
              <input value={pin} onChange={e => setPin(e.target.value)} placeholder="PIN" type="password" autoComplete="off"
                className="rounded border border-amber-300 bg-panel px-2 py-1.5 text-sm text-ink" />
            </div>
            {fehler && <p className="mt-2 text-xs text-red-700">{fehler}</p>}
            <div className="mt-2.5">
              <button
                type="button"
                disabled={!kannRegistrieren || registrieren.isPending}
                onClick={() => { setFehler(null); registrieren.mutate() }}
                className="rounded-md bg-amber-700 hover:bg-amber-800 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium transition"
              >
                {registrieren.isPending ? 'Registriere bei FinanzOnline…' : 'Bei FinanzOnline registrieren'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
