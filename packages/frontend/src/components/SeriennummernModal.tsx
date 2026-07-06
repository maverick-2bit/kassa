/**
 * SeriennummernModal — Pool eines Artikels verwalten: erfassen (Wareneingang),
 * ansehen (verfügbar/verkauft), verfügbare entfernen.
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { seriennummerApi } from '../lib/api'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

function parseSerials(text: string): string[] {
  return [...new Set(text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean))]
}

export function SeriennummernModal({
  artikelId,
  artikelName,
  open,
  onClose,
}: {
  artikelId:   string
  artikelName: string
  open:        boolean
  onClose:     () => void
}) {
  const qc = useQueryClient()
  const [text, setText]   = useState('')
  const [fehler, setFehler] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['seriennummern', artikelId],
    queryFn:  () => seriennummerApi.list({ artikelId }),
    enabled:  open,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['seriennummern', artikelId] })
    qc.invalidateQueries({ queryKey: ['artikel'] })
  }

  const erfassen = useMutation({
    mutationFn: (sns: string[]) => seriennummerApi.erfassen(artikelId, sns),
    onSuccess:  () => { invalidate(); setText(''); setFehler(null) },
    onError:    (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const entfernen = useMutation({
    mutationFn: (id: string) => seriennummerApi.remove(id),
    onSuccess:  () => { invalidate(); setFehler(null) },
    onError:    (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const serials    = query.data ?? []
  const verfuegbar = serials.filter(s => s.status === 'verfuegbar')
  const verkauft   = serials.filter(s => s.status === 'verkauft')
  const neue       = parseSerials(text)

  return (
    <Modal open={open} onClose={onClose} title={`Seriennummern — ${artikelName}`} size="lg">
      <div className="space-y-4">
        <div className="text-sm text-ink-muted">
          Verfügbar: <strong className="text-green-700">{verfuegbar.length}</strong>
          {' · '}Verkauft: <span className="text-ink">{verkauft.length}</span>
        </div>

        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">Neue Seriennummern (eine pro Zeile)</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder={'SN-0001\nSN-0002\n…'}
            className="w-full rounded-md border border-line-strong px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-xs text-ink-subtle">{neue.length} erkannt</span>
            <Button size="sm" disabled={neue.length === 0} loading={erfassen.isPending} onClick={() => erfassen.mutate(neue)}>
              + Erfassen
            </Button>
          </div>
        </div>

        {fehler && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>}

        <div>
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-1">Pool</p>
          {serials.length === 0 ? (
            <p className="text-xs text-ink-subtle py-2">Noch keine Seriennummern erfasst.</p>
          ) : (
            <div className="max-h-60 overflow-y-auto border border-line rounded-md divide-y divide-line">
              {serials.map(s => (
                <div key={s.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                  <span className="font-mono text-ink">{s.seriennummer}</span>
                  <span className="flex items-center gap-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${s.status === 'verfuegbar' ? 'bg-green-100 text-green-800' : 'bg-panel-2 text-ink-muted'}`}>
                      {s.status === 'verfuegbar' ? 'verfügbar' : 'verkauft'}
                    </span>
                    {s.status === 'verfuegbar' && (
                      <button
                        type="button"
                        onClick={() => entfernen.mutate(s.id)}
                        className="text-ink-subtle hover:text-red-500 px-1"
                        title="Entfernen"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end pt-1 border-t border-line">
          <Button variant="secondary" onClick={onClose}>Schließen</Button>
        </div>
      </div>
    </Modal>
  )
}
