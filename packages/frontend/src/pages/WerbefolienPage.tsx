import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { WerbefolieResponse } from '@kassa/shared'
import { werbefolienApi } from '../lib/api'

export function WerbefolienPage() {
  const qc = useQueryClient()
  const [editTarget, setEditTarget] = useState<WerbefolieResponse | null>(null)
  const [showForm,   setShowForm]   = useState(false)

  const { data: folien = [], isLoading } = useQuery({
    queryKey: ['werbefolien'],
    queryFn:  () => werbefolienApi.list(),
  })

  const loeschen = useMutation({
    mutationFn: (id: string) => werbefolienApi.loeschen(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['werbefolien'] }),
  })

  const toggleAktiv = useMutation({
    mutationFn: ({ id, aktiv }: { id: string; aktiv: boolean }) =>
      werbefolienApi.aktualisieren(id, { aktiv }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['werbefolien'] }),
  })

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">Werbefolien</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Werden als Slideshow auf dem Kundendisplay angezeigt wenn kein Warenkorb aktiv ist.
          </p>
        </div>
        <button
          onClick={() => { setEditTarget(null); setShowForm(true) }}
          className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Folie hinzufügen
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-ink-subtle">Laden…</div>
      ) : folien.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-line rounded-xl">
          <svg className="mx-auto h-12 w-12 text-ink-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="mt-3 text-sm text-ink-muted">Noch keine Werbefolien. Jetzt die erste hinzufügen!</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {folien.map((folie) => (
            <div
              key={folie.id}
              className={`relative rounded-xl border overflow-hidden ${folie.aktiv ? 'border-line' : 'border-line opacity-60'}`}
            >
              <div className="aspect-video bg-panel-2 overflow-hidden">
                <img
                  src={`data:${folie.mimeType};base64,${folie.bildBase64}`}
                  alt={folie.titel || 'Folie'}
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">
                      {folie.titel || <span className="text-ink-subtle italic">Ohne Titel</span>}
                    </p>
                    <p className="text-xs text-ink-muted">{folie.anzeigedauerSek}s · Reihenfolge {folie.reihenfolge}</p>
                  </div>
                  <button
                    onClick={() => toggleAktiv.mutate({ id: folie.id, aktiv: !folie.aktiv })}
                    className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition ${folie.aktiv ? 'bg-brand-600' : 'bg-panel-2'}`}
                    title={folie.aktiv ? 'Deaktivieren' : 'Aktivieren'}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-panel shadow transition ${folie.aktiv ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setEditTarget(folie); setShowForm(true) }}
                    className="flex-1 text-xs text-center py-1.5 rounded-md border border-line hover:bg-panel-2 text-ink"
                  >
                    Bearbeiten
                  </button>
                  <button
                    onClick={() => { if (confirm('Folie wirklich löschen?')) loeschen.mutate(folie.id) }}
                    className="flex-1 text-xs text-center py-1.5 rounded-md border border-red-200 hover:bg-red-50 text-red-600"
                  >
                    Löschen
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <WerbefolieFormModal
          {...(editTarget !== null ? { initial: editTarget } : {})}
          onClose={() => { setShowForm(false); setEditTarget(null) }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['werbefolien'] })
            setShowForm(false)
            setEditTarget(null)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formular-Modal
// ---------------------------------------------------------------------------

interface FormModalProps {
  initial?: WerbefolieResponse
  onClose: () => void
  onSaved: () => void
}

function WerbefolieFormModal({ initial, onClose, onSaved }: FormModalProps) {
  const [titel,          setTitel]          = useState(initial?.titel ?? '')
  const [bildBase64,     setBildBase64]     = useState(initial?.bildBase64 ?? '')
  const [mimeType,       setMimeType]       = useState(initial?.mimeType ?? 'image/jpeg')
  const [reihenfolge,    setReihenfolge]    = useState(initial?.reihenfolge ?? 0)
  const [anzeigedauer,   setAnzeigedauer]   = useState(initial?.anzeigedauerSek ?? 8)
  const [aktiv,          setAktiv]          = useState(initial?.aktiv ?? true)
  const [loading,        setLoading]        = useState(false)
  const [fehler,         setFehler]         = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleDatei = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFehler('')

    // GIFs nicht über Canvas schicken (Animation ginge verloren) — nur Größe prüfen
    if (file.type === 'image/gif') {
      if (file.size > 700_000) {
        setFehler('GIF zu groß (max. 700 KB). Bitte verkleinern oder als JPEG hochladen.')
        return
      }
      const reader = new FileReader()
      reader.onload = (ev) => {
        const result = ev.target?.result as string
        setBildBase64(result.split(',')[1] ?? '')
        setMimeType('image/gif')
      }
      reader.readAsDataURL(file)
      return
    }

    // Bild auf max. 1920px verkleinern und als JPEG kodieren — hält den
    // Upload unter dem Server-Body-Limit, egal wie groß das Original ist
    try {
      const bitmap = await createImageBitmap(file)
      const maxKante = 1920
      const skala  = Math.min(1, maxKante / Math.max(bitmap.width, bitmap.height))
      const breite = Math.round(bitmap.width  * skala)
      const hoehe  = Math.round(bitmap.height * skala)

      const canvas = document.createElement('canvas')
      canvas.width  = breite
      canvas.height = hoehe
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas nicht verfügbar')
      ctx.drawImage(bitmap, 0, 0, breite, hoehe)
      bitmap.close()

      const dataUrl = canvas.toDataURL('image/jpeg', 0.82)
      setBildBase64(dataUrl.split(',')[1] ?? '')
      setMimeType('image/jpeg')
    } catch {
      setFehler('Bild konnte nicht verarbeitet werden. Bitte JPEG, PNG oder WebP verwenden.')
    }
  }

  const handleSpeichern = async () => {
    if (!bildBase64) { setFehler('Bitte ein Bild hochladen'); return }
    setLoading(true)
    setFehler('')
    try {
      if (initial) {
        await werbefolienApi.aktualisieren(initial.id, {
          titel, bildBase64, mimeType, reihenfolge, anzeigedauerSek: anzeigedauer, aktiv,
        })
      } else {
        await werbefolienApi.erstellen({
          titel, bildBase64, mimeType, reihenfolge, anzeigedauerSek: anzeigedauer, aktiv,
        })
      }
      onSaved()
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Fehler beim Speichern')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-panel rounded-xl shadow-xl w-full max-w-md space-y-5 p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold">{initial ? 'Folie bearbeiten' : 'Neue Folie'}</h2>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-ink">Bild</label>
            <div
              className="mt-1 flex flex-col items-center justify-center border-2 border-dashed border-line-strong rounded-lg p-4 cursor-pointer hover:border-brand-400 transition"
              onClick={() => fileRef.current?.click()}
            >
              {bildBase64 ? (
                <img
                  src={`data:${mimeType};base64,${bildBase64}`}
                  alt="Vorschau"
                  className="max-h-32 rounded object-contain"
                />
              ) : (
                <>
                  <svg className="h-8 w-8 text-ink-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                  </svg>
                  <p className="text-sm text-ink-muted mt-1">Bild auswählen (JPEG, PNG, WebP)</p>
                </>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleDatei} />
          </div>

          <div>
            <label className="text-sm font-medium text-ink">Titel (optional)</label>
            <input
              value={titel}
              onChange={e => setTitel(e.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="z.B. Sommerangebot 2026"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-ink">Anzeigedauer (Sek.)</label>
              <input
                type="number"
                min={2}
                max={60}
                value={anzeigedauer}
                onChange={e => setAnzeigedauer(parseInt(e.target.value))}
                className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-ink">Reihenfolge</label>
              <input
                type="number"
                min={0}
                value={reihenfolge}
                onChange={e => setReihenfolge(parseInt(e.target.value))}
                className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={aktiv}
              onChange={e => setAktiv(e.target.checked)}
              className="rounded border-line-strong text-brand-600"
            />
            <span className="text-sm text-ink">Folie aktiviert</span>
          </label>
        </div>

        {fehler && <p className="text-sm text-red-600">{fehler}</p>}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-md border border-line-strong px-4 py-2 text-sm font-medium text-ink hover:bg-panel-2"
          >
            Abbrechen
          </button>
          <button
            onClick={handleSpeichern}
            disabled={loading}
            className="flex-1 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {loading ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  )
}
