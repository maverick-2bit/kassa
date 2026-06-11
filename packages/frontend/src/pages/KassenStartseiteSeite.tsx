import { useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Startseite } from '@kassa/shared'
import { posConfigApi } from '../lib/api'
import { getAuth } from '../lib/auth'

const STARTSEITEN: { value: Startseite; label: string }[] = [
  { value: 'tische',          label: 'Tische (Gastro)' },
  { value: 'kasse',           label: 'Kasse – Artikel' },
  { value: 'kasse_favoriten', label: 'Kasse – Favoriten' },
  { value: 'dashboard',       label: 'Dashboard' },
]

export function KassenStartseiteSeite() {
  const qc      = useQueryClient()
  const kassen  = getAuth()?.kassen ?? []

  const queries = useQueries({
    queries: kassen.map(k => ({
      queryKey: ['pos-config', k.id],
      queryFn:  () => posConfigApi.get(k.id),
      staleTime: 30_000,
    })),
  })

  const saveMut = useMutation({
    mutationFn: ({ kasseId, startseite }: { kasseId: string; startseite: Startseite }) =>
      posConfigApi.update(kasseId, { startseite }),
    onSuccess: (_d, { kasseId }) =>
      qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Kassen-Startseiten</h1>
        <p className="mt-1 text-sm text-gray-500">
          Welche Seite öffnet sich nach dem Login an jeder Kasse?
        </p>
      </div>

      <div className="space-y-3">
        {kassen.map((kasse, i) => {
          const query      = queries[i]
          const startseite = query?.data?.startseite ?? 'tische'
          const isLoading  = query?.isLoading ?? false

          return (
            <div
              key={kasse.id}
              className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm"
            >
              {/* Kassen-Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">
                  {kasse.bezeichnung ?? kasse.kassenId}
                </p>
                <p className="text-xs text-gray-400 font-mono">{kasse.kassenId}</p>
              </div>

              {/* Startseite-Dropdown */}
              <div className="flex items-center gap-2 shrink-0">
                {saveMut.isPending && saveMut.variables?.kasseId === kasse.id && (
                  <span className="text-xs text-gray-400">Speichern…</span>
                )}
                <select
                  disabled={isLoading}
                  value={startseite}
                  onChange={(e) =>
                    saveMut.mutate({ kasseId: kasse.id, startseite: e.target.value as Startseite })
                  }
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
                >
                  {STARTSEITEN.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )
        })}

        {kassen.length === 0 && (
          <div className="rounded-lg border-2 border-dashed border-gray-200 p-10 text-center text-sm text-gray-400">
            Keine Kassen gefunden.
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400">
        Die Einstellung gilt sofort beim nächsten Login an der jeweiligen Kasse.
      </p>
    </div>
  )
}
