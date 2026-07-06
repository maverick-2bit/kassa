/**
 * PreisregelnPage — Verwaltung der Happy-Hour- / Zeitpreis-Regeln.
 * Eine Regel senkt den Preis um X % in einem Zeitfenster an bestimmten
 * Wochentagen, optional nur für bestimmte Warengruppen. Die Anwendung passiert
 * automatisch an der Kasse (siehe lib happyHourPreisCent).
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Preisregel, PreisregelInput, Kategorie } from '@kassa/shared'
import { WOCHENTAG_LABELS } from '@kassa/shared'
import { preisregelApi, kategorieApi } from '../lib/api'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'

const WOCHENTAGE = [1, 2, 3, 4, 5, 6, 7]

export function PreisregelnPage() {
  const qc = useQueryClient()
  const [formOffen, setFormOffen]   = useState(false)
  const [editTarget, setEditTarget] = useState<Preisregel | null>(null)

  const regelnQuery = useQuery({ queryKey: ['preisregeln'], queryFn: preisregelApi.list })
  const katQuery    = useQuery({ queryKey: ['kategorien'],  queryFn: () => kategorieApi.list(true) })

  const loeschen = useMutation({
    mutationFn: (id: string) => preisregelApi.remove(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['preisregeln'] }),
  })

  const regeln     = regelnQuery.data ?? []
  const kategorien = katQuery.data ?? []
  const katName = (id: string) => kategorien.find(k => k.id === id)?.name ?? '—'

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 space-y-5">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-ink">Happy Hour / Zeitpreise</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Zeitgesteuerte Rabatte, die beim Kassieren und Bonieren automatisch greifen.
          </p>
        </div>
        <Button onClick={() => { setEditTarget(null); setFormOffen(true) }}>+ Neue Regel</Button>
      </header>

      {regeln.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong p-10 text-center text-sm text-ink-subtle">
          Noch keine Preisregeln. Lege eine an, z. B. „Happy Hour Mo–Fr 17–19 Uhr, −20 % auf Getränke".
        </div>
      ) : (
        <div className="space-y-3">
          {regeln.map(r => (
            <div
              key={r.id}
              className={`rounded-lg border p-4 ${r.aktiv ? 'border-brand-200 bg-panel' : 'border-line bg-panel-2 opacity-70'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-ink">{r.name}</p>
                    <span className="text-xs font-bold text-brand-700 bg-brand-50 rounded px-1.5 py-0.5">
                      −{r.rabattProzent}%
                    </span>
                    {!r.aktiv && <span className="text-xs text-ink-subtle">inaktiv</span>}
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">
                    {r.wochentage.map(w => WOCHENTAG_LABELS[w]).join(', ')} · {r.vonZeit}–{r.bisZeit} Uhr
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {r.kategorieIds.length === 0 ? 'Alle Artikel' : r.kategorieIds.map(katName).join(', ')}
                  </p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button size="sm" variant="secondary" onClick={() => { setEditTarget(r); setFormOffen(true) }}>
                    Bearbeiten
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="text-red-600"
                    onClick={() => { if (confirm('Regel löschen?')) loeschen.mutate(r.id) }}
                  >
                    Löschen
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={formOffen}
        onClose={() => { setFormOffen(false); setEditTarget(null) }}
        title={editTarget ? 'Regel bearbeiten' : 'Neue Preisregel'}
      >
        <PreisregelForm
          {...(editTarget ? { initial: editTarget } : {})}
          kategorien={kategorien}
          onGespeichert={() => { setFormOffen(false); setEditTarget(null); qc.invalidateQueries({ queryKey: ['preisregeln'] }) }}
          onAbbrechen={() => { setFormOffen(false); setEditTarget(null) }}
        />
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formular
// ---------------------------------------------------------------------------

function PreisregelForm({
  initial,
  kategorien,
  onGespeichert,
  onAbbrechen,
}: {
  initial?:      Preisregel
  kategorien:    Kategorie[]
  onGespeichert: () => void
  onAbbrechen:   () => void
}) {
  const [name,         setName]         = useState(initial?.name ?? '')
  const [aktiv,        setAktiv]        = useState(initial?.aktiv ?? true)
  const [wochentage,   setWochentage]   = useState<number[]>(initial?.wochentage ?? [1, 2, 3, 4, 5])
  const [vonZeit,      setVonZeit]      = useState(initial?.vonZeit ?? '17:00')
  const [bisZeit,      setBisZeit]      = useState(initial?.bisZeit ?? '19:00')
  const [rabatt,       setRabatt]       = useState(String(initial?.rabattProzent ?? 20))
  const [kategorieIds, setKategorieIds] = useState<string[]>(initial?.kategorieIds ?? [])
  const [fehler,       setFehler]       = useState<string | null>(null)

  const rabattZahl = parseInt(rabatt) || 0
  const kannSpeichern = name.trim().length > 0 && wochentage.length > 0 && rabattZahl >= 1 && rabattZahl <= 100

  const speichern = useMutation({
    mutationFn: () => {
      const input: PreisregelInput = {
        name:          name.trim(),
        aktiv,
        wochentage:    [...wochentage].sort((a, b) => a - b),
        vonZeit,
        bisZeit,
        rabattProzent: rabattZahl,
        kategorieIds,
      }
      return initial ? preisregelApi.update(initial.id, input) : preisregelApi.create(input)
    },
    onSuccess: onGespeichert,
    onError:   (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const toggleTag = (t: number) => setWochentage(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  const toggleKat = (id: string) => setKategorieIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); setFehler(null); if (kannSpeichern) speichern.mutate() }}
      className="space-y-4"
    >
      <div>
        <label className="block text-xs font-medium text-ink-muted mb-1">Name *</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Happy Hour" autoFocus />
      </div>

      <div>
        <label className="block text-xs font-medium text-ink-muted mb-1">Wochentage *</label>
        <div className="flex flex-wrap gap-1.5">
          {WOCHENTAGE.map(t => (
            <button
              key={t}
              type="button"
              onClick={() => toggleTag(t)}
              className={`px-3 py-1.5 rounded-md border text-sm font-medium transition ${
                wochentage.includes(t) ? 'bg-brand-600 border-brand-600 text-white' : 'border-line-strong text-ink hover:border-brand-400'
              }`}
            >
              {WOCHENTAG_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">Von *</label>
          <Input type="time" value={vonZeit} onChange={(e) => setVonZeit(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">Bis *</label>
          <Input type="time" value={bisZeit} onChange={(e) => setBisZeit(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">Rabatt (%) *</label>
          <Input type="number" min={1} max={100} value={rabatt} onChange={(e) => setRabatt(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-ink-muted mb-1">Warengruppen (leer = alle Artikel)</label>
        {kategorien.length === 0 ? (
          <p className="text-xs text-ink-subtle">Keine Warengruppen vorhanden — die Regel gilt für alle Artikel.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
            {kategorien.map(k => (
              <button
                key={k.id}
                type="button"
                onClick={() => toggleKat(k.id)}
                className={`px-2.5 py-1 rounded-md border text-xs font-medium transition ${
                  kategorieIds.includes(k.id) ? 'bg-brand-600 border-brand-600 text-white' : 'border-line-strong text-ink hover:border-brand-400'
                }`}
              >
                {k.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={aktiv} onChange={(e) => setAktiv(e.target.checked)} className="accent-brand-600" />
        <span className="text-ink">Regel aktiv</span>
      </label>

      {fehler && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>}

      <div className="flex gap-2 justify-end pt-1 border-t border-line">
        <Button variant="secondary" type="button" onClick={onAbbrechen}>Abbrechen</Button>
        <Button type="submit" loading={speichern.isPending} disabled={!kannSpeichern}>
          {initial ? 'Speichern' : 'Anlegen'}
        </Button>
      </div>
    </form>
  )
}
