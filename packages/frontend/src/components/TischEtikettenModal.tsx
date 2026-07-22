/**
 * TischEtikettenModal — Tischnummern-Etiketten aus der Kassa auf den Bondrucker
 * drucken, je Tisch optional mit Gast-Bestell-QR.
 *
 * Tischquelle: aus dem Tischplan gewählte Tische (Chips) UND/ODER freie Eingabe
 * (Liste/Bereich, z. B. „1-20, Bar, Terrasse 3").
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { druckerApi, tischplanApi } from '../lib/api'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

/** Parst freie Eingabe („1-20", „Bar, Terrasse 3") in eine Tischliste. */
export function parseTischEingabe(text: string): string[] {
  const out: string[] = []
  for (const teil of text.split(',')) {
    const t = teil.trim()
    if (!t) continue
    const m = t.match(/^(\d+)\s*-\s*(\d+)$/)
    if (m) {
      let a = parseInt(m[1]!, 10)
      let b = parseInt(m[2]!, 10)
      if (a > b) [a, b] = [b, a]
      if (b - a <= 200) for (let i = a; i <= b; i++) out.push(String(i))
    } else {
      out.push(t)
    }
  }
  return out
}

export function TischEtikettenModal({
  kasseId,
  open,
  onClose,
}: {
  kasseId: string
  open:    boolean
  onClose: () => void
}) {
  const elementeQuery = useQuery({
    queryKey: ['tischplan-elemente', kasseId],
    queryFn:  () => tischplanApi.listeElemente(kasseId),
    enabled:  open,
  })
  const cfgQuery = useQuery({
    queryKey: ['drucker', kasseId],
    queryFn:  () => druckerApi.get(kasseId),
    enabled:  open,
  })

  const [gewaehlt, setGewaehlt] = useState<Set<string>>(new Set())
  const [manuell,  setManuell]  = useState('')
  const [mitQr,    setMitQr]    = useState(false)
  const [erfolg,   setErfolg]   = useState<string | null>(null)
  const [fehler,   setFehler]   = useState<string | null>(null)

  const planTische = useMemo(
    () => [...new Set((elementeQuery.data ?? []).map(e => e.bezeichnung.trim()).filter(Boolean))],
    [elementeQuery.data],
  )
  const gastUrlGesetzt = !!cfgQuery.data?.gastBasisUrl

  // Ergebnis-Tischliste: gewählte Plan-Tische + geparste manuelle Eingabe, dedupliziert.
  const alleTische = useMemo(() => {
    const s = new Set<string>(gewaehlt)
    for (const t of parseTischEingabe(manuell)) s.add(t)
    return [...s]
  }, [gewaehlt, manuell])

  const druckMutation = useMutation({
    mutationFn: () => druckerApi.druckeTischEtiketten(kasseId, { tische: alleTische, mitQr: mitQr && gastUrlGesetzt }),
    onSuccess: (r) => { setErfolg(`${r.anzahl} Etikett(en) gedruckt`); setFehler(null) },
    onError:   (e) => { setFehler(e instanceof Error ? e.message : String(e)); setErfolg(null) },
  })

  const toggle = (t: string) =>
    setGewaehlt(prev => {
      const s = new Set(prev)
      if (s.has(t)) s.delete(t); else s.add(t)
      return s
    })

  return (
    <Modal open={open} onClose={onClose} title="Tischnummern drucken">
      <div className="space-y-4">
        {/* Tischplan-Chips */}
        {planTische.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-ink">Aus dem Tischplan</span>
              <button
                type="button"
                className="text-xs text-brand-600 hover:underline"
                onClick={() => setGewaehlt(new Set(gewaehlt.size === planTische.length ? [] : planTische))}
              >
                {gewaehlt.size === planTische.length ? 'Keine' : 'Alle'}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {planTische.map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggle(t)}
                  className={`px-3 py-1.5 rounded-full text-sm border transition ${
                    gewaehlt.has(t)
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'bg-panel border-line text-ink hover:bg-panel-2'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Manuelle Eingabe */}
        <label className="block">
          <span className="text-sm font-medium text-ink">Oder Nummern eingeben</span>
          <Input
            value={manuell}
            onChange={(e) => setManuell(e.target.value)}
            placeholder="z. B. 1-20, Bar, Terrasse 3"
            className="mt-1"
          />
          <span className="mt-1 block text-[11px] text-ink-subtle">Bereiche mit „-", mehrere mit Komma trennen.</span>
        </label>

        {/* QR-Schalter */}
        <label className={`flex items-center gap-3 ${gastUrlGesetzt ? 'cursor-pointer' : 'opacity-60'}`}>
          <input
            type="checkbox"
            disabled={!gastUrlGesetzt}
            checked={mitQr && gastUrlGesetzt}
            onChange={(e) => setMitQr(e.target.checked)}
            className="h-4 w-4 rounded border-line-strong text-brand-600 focus:ring-brand-500"
          />
          <div>
            <p className="text-sm font-medium text-ink">QR-Code mitdrucken</p>
            <p className="text-xs text-ink-subtle">
              {gastUrlGesetzt
                ? 'Gast scannt zum Bestellen (tischindividuelle URL).'
                : 'Zuerst die Gast-Bestell-Basis-URL in Einstellungen → Hardware setzen.'}
            </p>
          </div>
        </label>

        {erfolg && <p className="text-sm text-green-600 font-medium">✓ {erfolg}</p>}
        {fehler && <p className="text-sm text-red-600">{fehler}</p>}

        <div className="flex items-center justify-between pt-2 border-t border-line">
          <span className="text-xs text-ink-subtle">{alleTische.length} Etikett(en)</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Schließen</Button>
            <Button
              onClick={() => druckMutation.mutate()}
              loading={druckMutation.isPending}
              disabled={alleTische.length === 0}
            >
              Drucken
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
