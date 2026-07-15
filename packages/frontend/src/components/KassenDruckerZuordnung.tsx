/**
 * KassenDruckerZuordnung — zentrale Zuordnung an der Hauptkassa.
 * Eine Karte pro Kasse: Belegausgabe + Bondrucker (1, Dropdown) + Bonierdrucker
 * (mehrere, Häkchen). Ändert die Konfiguration JEDER Kasse ohne Kassenwechsel —
 * alle Endpunkte nehmen die kasseId entgegen.
 */

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DruckerPool, Bonierdrucker } from '@kassa/shared'
import { druckerApi, druckerPoolApi, bonierdruckerApi, posConfigApi, type DruckerConfig } from '../lib/api'
import { getAuth, hasModul } from '../lib/auth'

export function KassenDruckerZuordnung() {
  const auth      = getAuth()!
  const istGastro = hasModul('gastro')

  const poolQuery   = useQuery({ queryKey: ['drucker-pool'], queryFn: () => druckerPoolApi.list() })
  const bonierQuery = useQuery({ queryKey: ['bonierdrucker'], queryFn: bonierdruckerApi.list, enabled: istGastro })

  const pool   = poolQuery.data ?? []
  const bonier = bonierQuery.data ?? []

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">Kassen-Zuordnung</h3>
        <p className="text-xs text-ink-muted">
          Welche Drucker nutzt jede Kasse? Hier zentral zuordnen — kein Kassenwechsel nötig.
        </p>
      </div>

      <div className="space-y-3">
        {auth.kassen.map(k => (
          <KasseKarte
            key={k.id}
            kasseId={k.id}
            titel={k.bezeichnung || k.kassenId}
            untertitel={k.bezeichnung ? k.kassenId : undefined}
            pool={pool}
            bonier={bonier}
            istGastro={istGastro}
          />
        ))}
      </div>
    </div>
  )
}

function KasseKarte({ kasseId, titel, untertitel, pool, bonier, istGastro }: {
  kasseId:    string
  titel:      string
  untertitel: string | undefined
  pool:       DruckerPool[]
  bonier:     Bonierdrucker[]
  istGastro:  boolean
}) {
  const qc = useQueryClient()

  const cfgQuery = useQuery({ queryKey: ['drucker', kasseId], queryFn: () => druckerApi.get(kasseId) })
  const posQuery = useQuery({ queryKey: ['pos-config', kasseId], queryFn: () => posConfigApi.get(kasseId), enabled: istGastro })

  // Lokaler Häkchen-Zustand (optimistisch), synchronisiert mit der geladenen Konfig.
  // Ref als synchrone Quelle der Wahrheit → zwei schnelle Klicks hintereinander
  // (noch vor dem Re-Render) akkumulieren korrekt statt sich zu überschreiben.
  const [sichtbar, setSichtbar] = useState<Set<string>>(new Set())
  const sichtbarRef = useRef<Set<string>>(sichtbar)
  useEffect(() => {
    if (posQuery.data) {
      const s = new Set(posQuery.data.sichtbareBonierdruckerIds)
      sichtbarRef.current = s
      setSichtbar(s)
    }
  }, [posQuery.data])

  const cfg = cfgQuery.data

  const patchDrucker = useMutation({
    mutationFn: (patch: Partial<DruckerConfig>) => druckerApi.patch(kasseId, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drucker', kasseId] }),
  })

  const setBonier = useMutation({
    mutationFn: (ids: string[]) => posConfigApi.update(kasseId, { sichtbareBonierdruckerIds: ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })

  const toggleBonier = (id: string) => {
    const next = new Set(sichtbarRef.current)
    if (next.has(id)) next.delete(id); else next.add(id)
    sichtbarRef.current = next
    setSichtbar(next)
    setBonier.mutate([...next])
  }

  return (
    <div className="rounded-xl border border-line bg-panel-2 p-4 space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-ink">{titel}</span>
        {untertitel && <span className="text-xs text-ink-subtle font-mono">{untertitel}</span>}
      </div>

      {cfgQuery.isLoading ? (
        <p className="text-xs text-ink-subtle">Konfiguration wird geladen…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Belegausgabe */}
          <label className="block">
            <span className="text-xs font-medium text-ink-muted">Belegausgabe</span>
            <select
              className="mt-1 block w-full rounded-md border border-line-strong px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              value={cfg?.belegModus ?? 'drucken'}
              disabled={patchDrucker.isPending}
              onChange={(e) => patchDrucker.mutate({ belegModus: e.target.value as DruckerConfig['belegModus'] })}
            >
              <option value="drucken">Nur drucken (Papier-Bon)</option>
              <option value="digital">Nur digital (Bildschirm + E-Mail)</option>
              <option value="beides">Beides</option>
            </select>
          </label>

          {/* Bondrucker (1) */}
          <label className="block">
            <span className="text-xs font-medium text-ink-muted">
              {cfg?.belegModus === 'digital' ? 'Ausweich-Bondrucker' : 'Bondrucker (Rechnung)'}
            </span>
            <select
              className="mt-1 block w-full rounded-md border border-line-strong px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              value={cfg?.druckerId ?? ''}
              disabled={patchDrucker.isPending}
              onChange={(e) => patchDrucker.mutate({ druckerId: e.target.value || null })}
            >
              <option value="">— ohne Druck fortfahren —</option>
              {pool.map(d => (
                <option key={d.id} value={d.id}>{d.name} ({d.ip}){d.aktiv ? '' : ' — deaktiviert'}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Bonierdrucker (mehrere) — nur Gastro */}
      {istGastro && (
        <div>
          <span className="text-xs font-medium text-ink-muted">Bonierdrucker (Küche/Schank)</span>
          {bonier.length === 0 ? (
            <p className="mt-1 text-xs text-ink-subtle">Noch kein Bonierdrucker in der Bibliothek angelegt.</p>
          ) : (
            <>
              <div className="mt-1 flex flex-wrap gap-2">
                {bonier.map(b => {
                  const an = sichtbar.has(b.id)
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => toggleBonier(b.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                        an ? 'bg-brand-600 border-brand-600 text-white' : 'bg-panel border-line-strong text-ink hover:border-brand-400'
                      }`}
                    >
                      <span>{an ? '✓' : '+'}</span>{b.name}
                    </button>
                  )
                })}
              </div>
              {sichtbar.size === 0 && (
                <p className="mt-1.5 text-xs text-ink-subtle">Nichts gewählt = <strong>alle</strong> Bonierdrucker aktiv.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
