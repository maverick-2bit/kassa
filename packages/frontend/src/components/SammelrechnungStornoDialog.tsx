import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { SammelrechnungResponse } from '@kassa/shared'
import { sammelrechnungApi } from '../lib/api'
import { Modal } from './ui/Modal'

/**
 * Rechnung stornieren. Die Rechnung bleibt mit ihrer Nummer als „storniert" erhalten, die Lieferscheine werden wieder
 * offen. Ging die Rechnung per Mail raus, bekommt der Kunde automatisch die Stornorechnung.
 */
export function SammelrechnungStornoDialog({ rechnung, onClose, onFertig }: {
  rechnung: SammelrechnungResponse | null
  onClose:  () => void
  onFertig?: (sr: SammelrechnungResponse) => void
}) {
  const qc = useQueryClient()
  const [grund, setGrund] = useState('')
  useEffect(() => { setGrund('') }, [rechnung?.id])

  const stornieren = useMutation({
    mutationFn: () => sammelrechnungApi.stornieren(rechnung!.id, grund.trim() || undefined),
    onSuccess: (sr) => {
      void qc.invalidateQueries({ queryKey: ['archiv-rechnungen'] })
      void qc.invalidateQueries({ queryKey: ['archiv-lieferscheine'] })
      void qc.invalidateQueries({ queryKey: ['wartungsvertraege'] })
      void qc.invalidateQueries({ queryKey: ['lieferscheine'] })
      onFertig?.(sr)
      onClose()
    },
  })

  const warPerMail = !!rechnung?.emailVersandtAm

  return (
    <Modal
      open={rechnung !== null}
      onClose={onClose}
      title={rechnung ? `SR-${String(rechnung.nummer).padStart(4, '0')} stornieren` : ''}
    >
      {rechnung && (
        <div className="space-y-3">
          <p className="text-sm text-ink">
            Die Rechnung bleibt mit ihrer Nummer als <strong>storniert</strong> erhalten und bekommt eine Stornorechnung.
            Ihre {rechnung.lieferscheine.length} Lieferschein{rechnung.lieferscheine.length === 1 ? '' : 'e'} werden wieder{' '}
            <strong>offen</strong> und können neu verrechnet werden. Ein dazugehöriger offener Posten entfällt.
          </p>
          {warPerMail && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Die Rechnung wurde per Mail an <strong>{rechnung.emailEmpfaenger}</strong> verschickt. Der Kunde bekommt jetzt
              automatisch ein Mail mit der Stornorechnung. Die korrigierte Rechnung geht danach — nach deiner Freigabe — in
              einem eigenen Mail raus.
            </p>
          )}
          <label className="block">
            <span className="text-xs font-medium text-ink">Grund (intern, steht nicht im Mail)</span>
            <textarea
              value={grund}
              onChange={e => setGrund(e.target.value)}
              maxLength={500}
              rows={2}
              className="mt-0.5 w-full rounded-md border border-line-strong px-3 py-2 text-sm"
            />
          </label>
          {stornieren.isError && (
            <p className="text-sm text-red-600" role="alert">
              {stornieren.error instanceof Error ? stornieren.error.message : String(stornieren.error)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink hover:bg-panel-2"
            >
              Abbrechen
            </button>
            <button
              type="button"
              disabled={stornieren.isPending}
              onClick={() => stornieren.mutate()}
              className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
            >
              {stornieren.isPending ? 'Wird storniert…' : 'Jetzt stornieren'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
