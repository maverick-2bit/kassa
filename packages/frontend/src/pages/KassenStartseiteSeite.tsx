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
        <h1 className="text-2xl font-bold text-ink">Kassen-Startseiten</h1>
        <p className="mt-1 text-sm text-ink-muted">
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
              className="flex items-center gap-4 rounded-xl border border-line bg-panel px-5 py-4 shadow-sm"
            >
              {/* Kassen-Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-ink truncate">
                  {kasse.bezeichnung ?? kasse.kassenId}
                </p>
                <p className="text-xs text-ink-subtle font-mono">{kasse.kassenId}</p>
              </div>

              {/* Startseite-Dropdown */}
              <div className="flex items-center gap-2 shrink-0">
                {saveMut.isPending && saveMut.variables?.kasseId === kasse.id && (
                  <span className="text-xs text-ink-subtle">Speichern…</span>
                )}
                <select
                  disabled={isLoading}
                  value={startseite}
                  onChange={(e) =>
                    saveMut.mutate({ kasseId: kasse.id, startseite: e.target.value as Startseite })
                  }
                  className="rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm font-medium text-ink shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
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
          <div className="rounded-lg border-2 border-dashed border-line p-10 text-center text-sm text-ink-subtle">
            Keine Kassen gefunden.
          </div>
        )}
      </div>

      <p className="text-xs text-ink-subtle">
        Die Einstellung gilt sofort beim nächsten Login an der jeweiligen Kasse.
      </p>
    </div>
  )
}
