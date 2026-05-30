import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Lieferant, LieferantInput } from '@kassa/shared'
import { lieferantApi } from '../lib/api'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Field } from '../components/ui/Field'
import { Modal } from '../components/ui/Modal'

function LieferantFormular({
  initial,
  loading,
  fehler,
  onSubmit,
  onCancel,
}: {
  initial?:  Lieferant | null
  loading?:  boolean
  fehler?:   string | null
  onSubmit:  (input: LieferantInput) => void
  onCancel:  () => void
}) {
  const [name,    setName]    = useState(initial?.name    ?? '')
  const [kontakt, setKontakt] = useState(initial?.kontakt ?? '')
  const [email,   setEmail]   = useState(initial?.email   ?? '')
  const [telefon, setTelefon] = useState(initial?.telefon ?? '')
  const [notiz,   setNotiz]   = useState(initial?.notiz   ?? '')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onSubmit({
      name:    name.trim(),
      kontakt: kontakt.trim() || null,
      email:   email.trim()   || null,
      telefon: telefon.trim() || null,
      notiz:   notiz.trim()   || null,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="Name *">
        <Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="z. B. Großhandel Müller GmbH" />
      </Field>
      <Field label="Ansprechpartner">
        <Input value={kontakt} onChange={e => setKontakt(e.target.value)} placeholder="z. B. Hans Müller" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="E-Mail">
          <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="bestellung@lieferant.at" />
        </Field>
        <Field label="Telefon">
          <Input value={telefon} onChange={e => setTelefon(e.target.value)} placeholder="+43 1 234 5678" />
        </Field>
      </div>
      <Field label="Notiz">
        <textarea
          value={notiz}
          onChange={e => setNotiz(e.target.value)}
          rows={3}
          placeholder="Lieferkonditionen, Mindestbestellwert, …"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
        />
      </Field>
      {fehler && (
        <p className="text-sm text-red-600">{fehler}</p>
      )}
      <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
        <Button variant="secondary" type="button" onClick={onCancel}>Abbrechen</Button>
        <Button type="submit" loading={loading} disabled={!name.trim()}>
          {initial ? 'Speichern' : 'Anlegen'}
        </Button>
      </div>
    </form>
  )
}

export function LieferantenPage() {
  const qc = useQueryClient()
  const [modalOffen,     setModalOffen]     = useState(false)
  const [bearbeiteter,   setBearbeiteter]   = useState<Lieferant | null>(null)
  const [loeschKandidat, setLoeschKandidat] = useState<Lieferant | null>(null)
  const [fehler,         setFehler]         = useState<string | null>(null)

  const { data: liste = [], isLoading } = useQuery({
    queryKey: ['lieferanten'],
    queryFn:  lieferantApi.list,
  })

  const erstelleMutation = useMutation({
    mutationFn: lieferantApi.create,
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['lieferanten'] }); setModalOffen(false); setFehler(null) },
    onError:    (err) => setFehler(err instanceof Error ? err.message : 'Fehler'),
  })

  const aktualisiereMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof lieferantApi.update>[1] }) =>
      lieferantApi.update(id, input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['lieferanten'] }); setBearbeiteter(null); setFehler(null) },
    onError:   (err) => setFehler(err instanceof Error ? err.message : 'Fehler'),
  })

  const loescheMutation = useMutation({
    mutationFn: (id: string) => lieferantApi.deaktiviere(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['lieferanten'] }); setLoeschKandidat(null) },
  })

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Lieferanten</h1>
          <p className="text-sm text-gray-500 mt-0.5">Kontaktdaten für Bestellungen und Einkauf</p>
        </div>
        <Button onClick={() => { setModalOffen(true); setFehler(null) }}>+ Lieferant anlegen</Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Lädt…</p>
      ) : liste.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 py-16 text-center">
          <p className="text-gray-500">Noch keine Lieferanten angelegt.</p>
          <p className="text-sm text-gray-400 mt-1">Klicke auf «+ Lieferant anlegen».</p>
        </div>
      ) : (
        <div className="space-y-3">
          {liste.map(l => (
            <div key={l.id} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900">{l.name}</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
                    {l.kontakt && <span>{l.kontakt}</span>}
                    {l.email   && <a href={`mailto:${l.email}`} className="text-brand-600 hover:underline">{l.email}</a>}
                    {l.telefon && <a href={`tel:${l.telefon}`}  className="text-brand-600 hover:underline">{l.telefon}</a>}
                  </div>
                  {l.notiz && <p className="mt-1.5 text-xs text-gray-400 line-clamp-2">{l.notiz}</p>}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button type="button" onClick={() => { setBearbeiteter(l); setFehler(null) }}
                    className="text-xs text-brand-600 hover:text-brand-800 font-medium">
                    Bearbeiten
                  </button>
                  <button type="button" onClick={() => setLoeschKandidat(l)}
                    className="text-xs text-red-500 hover:text-red-700 font-medium">
                    Löschen
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Neu anlegen */}
      <Modal open={modalOffen} onClose={() => setModalOffen(false)} title="Lieferant anlegen">
        <LieferantFormular
          loading={erstelleMutation.isPending}
          fehler={fehler}
          onSubmit={input => erstelleMutation.mutate(input)}
          onCancel={() => setModalOffen(false)}
        />
      </Modal>

      {/* Bearbeiten */}
      <Modal open={!!bearbeiteter} onClose={() => setBearbeiteter(null)} title="Lieferant bearbeiten">
        {bearbeiteter && (
          <LieferantFormular
            initial={bearbeiteter}
            loading={aktualisiereMutation.isPending}
            fehler={fehler}
            onSubmit={input => aktualisiereMutation.mutate({ id: bearbeiteter.id, input })}
            onCancel={() => setBearbeiteter(null)}
          />
        )}
      </Modal>

      {/* Löschen bestätigen */}
      <Modal open={!!loeschKandidat} onClose={() => setLoeschKandidat(null)} title="Lieferant löschen">
        {loeschKandidat && (
          <div className="space-y-4">
            <p className="text-sm text-gray-700">
              Soll <strong>{loeschKandidat.name}</strong> wirklich gelöscht werden?
              Artikel mit diesem Lieferanten bleiben erhalten.
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setLoeschKandidat(null)}>Abbrechen</Button>
              <Button variant="danger" loading={loescheMutation.isPending}
                onClick={() => loescheMutation.mutate(loeschKandidat.id)}>
                Löschen
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
