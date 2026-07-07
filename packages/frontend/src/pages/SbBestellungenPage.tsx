/**
 * SB-Bestellungen — Verwaltung der Terminal-Bestellungen an der zentralen Kassa.
 *
 * Tagesliste mit tickender Wartezeit. Aktionen:
 *  „Zur Abholung bereit" (Spaltenwechsel am Abholmonitor) und „Abgeholt"
 *  (Fallback zur KDS-Quittierung — verschwindet vom Monitor).
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SbBestellung, SbBestellungStatus } from '@kassa/shared'
import { SB_STATUS_LABELS, formatSbNummer } from '@kassa/shared'
import { sbBestellungApi } from '../lib/api'
import { useKasseEvents } from '../lib/sse'
import { formatPreis } from '../lib/format'
import { Button } from '../components/ui/Button'

const STATUS_BADGE: Record<SbBestellungStatus, string> = {
  zahlung:     'bg-panel-2 text-ink-muted',
  offen:       'bg-amber-100 text-amber-800',
  bereit:      'bg-green-100 text-green-800',
  abgeholt:    'bg-panel-2 text-ink-muted',
  abgebrochen: 'bg-red-100 text-red-700',
}

export function SbBestellungenPage() {
  const queryClient = useQueryClient()
  const [jetzt, setJetzt] = useState(() => Date.now())

  const liste = useQuery({
    queryKey: ['sb-bestellungen'],
    queryFn:  () => sbBestellungApi.liste(),
    refetchInterval: 30_000,
  })

  // Wartezeit-Ticker (Minutengenauigkeit reicht, 10s-Takt hält die Anzeige frisch)
  useEffect(() => {
    const t = setInterval(() => setJetzt(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [])

  // Neue Bestellungen / Statuswechsel sofort anzeigen
  useKasseEvents((event) => {
    if (event.typ === 'neue_sb_bestellung') {
      void queryClient.invalidateQueries({ queryKey: ['sb-bestellungen'] })
    }
  })

  const bereitMutation = useMutation({
    mutationFn: sbBestellungApi.bereit,
    onSuccess:  () => queryClient.invalidateQueries({ queryKey: ['sb-bestellungen'] }),
  })
  const abgeholtMutation = useMutation({
    mutationFn: sbBestellungApi.abgeholt,
    onSuccess:  () => queryClient.invalidateQueries({ queryKey: ['sb-bestellungen'] }),
  })

  const bestellungen = (liste.data ?? []).filter(b => b.status !== 'zahlung')
  const aktive       = bestellungen.filter(b => b.status === 'offen' || b.status === 'bereit')
  const erledigte    = bestellungen.filter(b => b.status === 'abgeholt' || b.status === 'abgebrochen')

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:py-8 space-y-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">SB-Bestellungen</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Heutige Bestellungen vom Selbstbedienungs-Terminal — quittiere „bereit",
            sobald die Bestellung an der Ausgabe steht.
          </p>
        </div>
        <span className="text-sm text-ink-muted">{aktive.length} aktiv</span>
      </header>

      {liste.isLoading ? (
        <p className="text-sm text-ink-muted">Lade Bestellungen…</p>
      ) : aktive.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel p-10 text-center text-sm text-ink-muted">
          Keine aktiven SB-Bestellungen — neue Bestellungen erscheinen hier automatisch.
        </div>
      ) : (
        <div className="space-y-3">
          {aktive.map(b => (
            <BestellungKarte
              key={b.id}
              bestellung={b}
              jetzt={jetzt}
              onBereit={() => bereitMutation.mutate(b.id)}
              onAbgeholt={() => abgeholtMutation.mutate(b.id)}
              speichert={bereitMutation.isPending || abgeholtMutation.isPending}
            />
          ))}
        </div>
      )}

      {erledigte.length > 0 && (
        <details className="rounded-xl border border-line bg-panel">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-muted">
            Erledigt heute ({erledigte.length})
          </summary>
          <div className="border-t border-line divide-y divide-line">
            {erledigte.map(b => (
              <div key={b.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="font-mono font-semibold text-ink">{formatSbNummer(b.bestellNummer)}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[b.status]}`}>
                  {SB_STATUS_LABELS[b.status]}
                </span>
                <span className="flex-1 truncate text-ink-muted">
                  {b.positionen.map(p => `${p.menge}× ${p.bezeichnung}`).join(', ')}
                </span>
                <span className="font-mono text-ink-muted">{formatPreis(b.summeCent)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function BestellungKarte({
  bestellung: b,
  jetzt,
  onBereit,
  onAbgeholt,
  speichert,
}: {
  bestellung: SbBestellung
  jetzt:      number
  onBereit:   () => void
  onAbgeholt: () => void
  speichert:  boolean
}) {
  const wartezeitMin = Math.max(0, Math.floor((jetzt - new Date(b.erstelltAt).getTime()) / 60_000))
  const wartezeitFarbe =
    wartezeitMin >= 15 ? 'text-red-600' :
    wartezeitMin >= 8  ? 'text-amber-600' : 'text-ink-muted'

  return (
    <div className="rounded-xl border border-line bg-panel p-4 flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-3">
        <span className="rounded-lg bg-brand-600 px-3 py-2 font-mono text-xl font-bold text-white">
          {formatSbNummer(b.bestellNummer)}
        </span>
        <div>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[b.status]}`}>
            {SB_STATUS_LABELS[b.status]}
          </span>
          <p className={`mt-1 text-xs font-medium ${wartezeitFarbe}`}>
            {b.status === 'bereit' && b.bereitAt
              ? `bereit seit ${Math.max(0, Math.floor((jetzt - new Date(b.bereitAt).getTime()) / 60_000))} min`
              : `wartet seit ${wartezeitMin} min`}
            {' · '}{new Date(b.erstelltAt).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink">
          {b.positionen.map(p => `${p.menge}× ${p.bezeichnung}`).join(', ')}
        </p>
        <p className="text-xs text-ink-muted">{formatPreis(b.summeCent)} · Karte bezahlt</p>
      </div>

      <div className="flex gap-2">
        {b.status === 'offen' && (
          <Button onClick={onBereit} disabled={speichert}>
            Zur Abholung bereit
          </Button>
        )}
        <Button variant="secondary" onClick={onAbgeholt} disabled={speichert}>
          Abgeholt
        </Button>
      </div>
    </div>
  )
}
