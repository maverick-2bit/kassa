import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BelegResponse } from '@kassa/shared'
import { belegApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis, formatDatum } from '../lib/format'
import { Modal } from '../components/ui/Modal'
import { BonAnzeige } from '../components/BonAnzeige'

export function BelegePage() {
  const identity = getKasseIdentity()!
  const [ausgewaehlt, setAusgewaehlt] = useState<BelegResponse | null>(null)

  const liste = useQuery({
    queryKey: ['belege', identity.kasseId],
    queryFn:  () => belegApi.list(identity.kasseId, 100),
  })

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Belege</h1>
        <p className="mt-1 text-sm text-gray-500">
          Alle erstellten Belege dieser Kasse — sortiert nach Belegnummer (neueste oben)
        </p>
      </div>

      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        {liste.isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">Wird geladen…</div>
        ) : liste.isError ? (
          <div className="p-8 text-center text-sm text-red-600">
            Fehler: {liste.error instanceof Error ? liste.error.message : 'Unbekannt'}
          </div>
        ) : liste.data && liste.data.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-gray-500">Noch keine Belege erstellt.</p>
            <a href="/kasse" className="mt-2 inline-block text-sm text-brand-600 hover:underline">
              Zur Kasse →
            </a>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Nr.</th>
                <th className="px-4 py-2 font-semibold">Datum</th>
                <th className="px-4 py-2 font-semibold">Typ</th>
                <th className="px-4 py-2 font-semibold">Positionen</th>
                <th className="px-4 py-2 font-semibold text-right">Bar</th>
                <th className="px-4 py-2 font-semibold text-right">Karte</th>
                <th className="px-4 py-2 font-semibold text-right">Gesamt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {liste.data?.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => setAusgewaehlt(b)}
                  className="cursor-pointer hover:bg-brand-50/40"
                >
                  <td className="px-4 py-2 font-mono font-medium text-gray-900">#{b.belegNummer}</td>
                  <td className="px-4 py-2 text-gray-600">{formatDatum(b.belegDatum)}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                      {b.belegTyp}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{b.positionen.length}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-700">
                    {b.summeBarCent > 0 ? formatPreis(b.summeBarCent) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-gray-700">
                    {b.summeKarteCent > 0 ? formatPreis(b.summeKarteCent) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-semibold text-gray-900">
                    {formatPreis(b.gesamtbetragCent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={!!ausgewaehlt}
        onClose={() => setAusgewaehlt(null)}
        title={`Beleg #${ausgewaehlt?.belegNummer}`}
        size="lg"
      >
        {ausgewaehlt && <BonAnzeige beleg={ausgewaehlt} />}
      </Modal>
    </div>
  )
}
