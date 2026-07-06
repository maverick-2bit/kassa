/**
 * Geteilte Formulare für Tisch-Aktionen (Umbuchen, Gruppen zusammenführen).
 * Werden sowohl von der Listen-Ansicht (TischePage) als auch der grafischen
 * Tischplan-Ansicht (TischplanAnsicht) genutzt.
 */

import { useState } from 'react'
import type { TischTabResponse } from '@kassa/shared'
import { formatPreis } from '../lib/format'
import { Input } from './ui/Input'
import { Button } from './ui/Button'

// ---------------------------------------------------------------------------
// Umbuchen — einen Tab auf eine andere Tischnummer verschieben
// ---------------------------------------------------------------------------

export function UmbuchenForm({
  aktuellerTisch,
  loading,
  fehler,
  onSubmit,
  onAbbrechen,
}: {
  aktuellerTisch: string
  loading:        boolean
  fehler:         string | null
  onSubmit:       (tischNummer: string) => void
  onAbbrechen:    () => void
}) {
  const [neuerTisch, setNeuerTisch] = useState(aktuellerTisch)
  const kannUmbuchen = neuerTisch.trim().length > 0 && neuerTisch.trim() !== aktuellerTisch

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">
        Aktueller Tisch: <strong>{aktuellerTisch}</strong>
      </p>
      <label className="block">
        <span className="text-sm font-medium text-ink">Neuer Tisch</span>
        <Input
          autoFocus
          value={neuerTisch}
          onChange={(e) => setNeuerTisch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && kannUmbuchen) onSubmit(neuerTisch.trim()) }}
          placeholder="z. B. 5, Terrasse 2 …"
          className="mt-1"
        />
      </label>
      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onAbbrechen} className="flex-1">Abbrechen</Button>
        <Button
          onClick={() => kannUmbuchen && onSubmit(neuerTisch.trim())}
          loading={loading}
          disabled={!kannUmbuchen}
          className="flex-1"
        >
          Umbuchen
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Zusammenführen — mehrere Gruppen an einem Tisch verschmelzen
// ---------------------------------------------------------------------------

export function ZusammenfuehrenForm({
  gruppe,
  loading,
  fehler,
  onSubmit,
  onAbbrechen,
}: {
  gruppe:      TischTabResponse[]
  loading:     boolean
  fehler:      string | null
  onSubmit:    (zielId: string, quellTabIds: string[]) => void
  onAbbrechen: () => void
}) {
  const [zielId, setZielId] = useState(gruppe[0]?.id ?? '')
  const quellTabIds = gruppe.filter(t => t.id !== zielId).map(t => t.id)
  const kann = zielId.length > 0 && quellTabIds.length > 0

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">
        Alle Gruppen an Tisch <strong>{gruppe[0]?.tischNummer}</strong> in eine zusammenführen.
        Wähle die Gruppe, die bestehen bleibt — die übrigen werden hineingebucht.
      </p>
      <div className="space-y-2">
        {gruppe.map((t, i) => (
          <label
            key={t.id}
            className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition ${
              zielId === t.id ? 'border-brand-400 bg-brand-50' : 'border-line hover:border-line-strong'
            }`}
          >
            <input
              type="radio"
              name="ziel-gruppe"
              checked={zielId === t.id}
              onChange={() => setZielId(t.id)}
              className="accent-brand-600"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-ink">Gruppe {i + 1} · {t.kellner}</p>
              <p className="text-xs text-ink-muted">
                {t.positionen.reduce((n, p) => n + p.menge, 0)} Pos. · {formatPreis(t.summeGesamtCent)}
              </p>
            </div>
            {zielId === t.id && <span className="shrink-0 text-xs font-medium text-brand-700">bleibt</span>}
          </label>
        ))}
      </div>
      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onAbbrechen} className="flex-1">Abbrechen</Button>
        <Button
          onClick={() => kann && onSubmit(zielId, quellTabIds)}
          loading={loading}
          disabled={!kann}
          className="flex-1"
        >
          Zusammenführen
        </Button>
      </div>
    </div>
  )
}
