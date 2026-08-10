/**
 * Warnleiste: Belege, deren Bon nicht aus dem Drucker kam.
 *
 * Der Kellner rechnet am Tisch ab — der Autodruck läuft danach fire-and-forget
 * mit Retry. Scheitert er endgültig, steht der Kellner beim Gast und weiß
 * nichts davon: die Meldung erschien bisher nur am Haupt-POS. Genau dort, wo
 * der Gast auf seinen Beleg wartet, fehlte sie.
 *
 * Bewusst dieselbe Datenquelle und dieselbe Auflösung wie an der Kasse: sobald
 * ein Retry oder ein Nachdruck geklappt hat, verschwindet der Eintrag von
 * selbst.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { druckerApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'

export function DruckproblemeBanner() {
  const identity = getKasseIdentity()
  const qc = useQueryClient()

  const probleme = useQuery({
    queryKey:             ['druckprobleme', identity?.kasseId],
    queryFn:              () => druckerApi.druckprobleme(identity!.kasseId),
    enabled:              !!identity?.kasseId,
    // Der Retry an der Kasse braucht bis zu ~42 s — in dem Takt nachfragen
    // reicht und hält das Handy ruhig.
    refetchInterval:      30_000,
    refetchOnWindowFocus: true,
  })

  const nachdrucken = useMutation({
    mutationFn: (belegId: string) => druckerApi.nachdrucken(belegId),
    onSettled:  () => qc.invalidateQueries({ queryKey: ['druckprobleme', identity?.kasseId] }),
  })

  const liste = probleme.data ?? []
  if (liste.length === 0) return null

  return (
    <div className="rounded-lg border-2 border-red-500 bg-red-50 p-3 space-y-2">
      <p className="text-sm font-bold text-red-800">
        ⚠ {liste.length === 1 ? 'Ein Beleg wurde' : `${liste.length} Belege wurden`} nicht gedruckt
      </p>
      <ul className="space-y-2">
        {liste.map(p => (
          <li key={p.belegId} className="space-y-1">
            <p className="text-xs text-red-700">
              <span className="font-semibold">Beleg Nr. {p.belegNummer}</span>
              {' · '}{formatPreis(p.summeCent)}
              <span className="block text-red-600">{p.fehlerText ?? 'Grund unbekannt'}</span>
            </p>
            <button
              type="button"
              className="w-full rounded-lg bg-red-600 py-3 text-sm font-bold text-white active:bg-red-700 disabled:opacity-50"
              disabled={nachdrucken.isPending}
              onClick={() => nachdrucken.mutate(p.belegId)}
            >
              {nachdrucken.isPending && nachdrucken.variables === p.belegId ? 'Drucke …' : 'Nachdrucken'}
            </button>
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
