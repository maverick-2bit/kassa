/**
 * BonierdruckerPage
 *
 * Mandantenweite Verwaltung der ESC/POS-Bonierdrucker.
 * Drucker werden einmal zentral angelegt und automatisch an alle Kassen weitergegeben.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Bonierdrucker, BonierdruckerInput } from '@kassa/shared'
import { bonierdruckerApi } from '../lib/api'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Field } from '../components/ui/Field'
import { Input } from '../components/ui/Input'
import { useForm } from 'react-hook-form'

// ---------------------------------------------------------------------------
// Formular
// ---------------------------------------------------------------------------

type FormValues = {
  name:      string
  ip:        string
  port:      string
  istBackup: boolean
}

function BonierdruckerFormular({
  initial,
  onSubmit,
  onCancel,
  loading,
  fehler,
}: {
  initial?: Bonierdrucker | null
  onSubmit: (input: BonierdruckerInput) => void
  onCancel: () => void
  loading?: boolean
  fehler?: string | undefined
}) {
  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: {
      name:      initial?.name      ?? '',
      ip:        initial?.ip        ?? '',
      port:      String(initial?.port ?? 9100),
      istBackup: initial?.istBackup ?? false,
    },
  })

  const submit = handleSubmit((v) => {
    onSubmit({
      name:       v.name.trim(),
      ip:         v.ip.trim(),
      port:       parseInt(v.port, 10) || 9100,
      istBackup:  v.istBackup,
      fallbackId: null,
    })
  })

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Name" required hint='z.B. "Küchendrucker" oder "Schankdrucker"'>
        <Input autoFocus placeholder="Küchendrucker" {...register('name', { required: true })} />
      </Field>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Field label="IP-Adresse" required>
            <Input placeholder="192.168.1.100" {...register('ip', { required: true })} />
          </Field>
        </div>
        <Field label="Port">
          <Input type="number" placeholder="9100" {...register('port')} />
        </Field>
      </div>

      <label className="flex items-center gap-3 cursor-pointer rounded-lg border border-amber-200 bg-amber-50 p-3">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-gray-300 text-amber-500 focus:ring-amber-400"
          {...register('istBackup')}
        />
        <div>
          <p className="text-sm font-medium text-amber-900">Backup-Drucker</p>
          <p className="text-xs text-amber-700">
            Empfängt automatisch eine Kopie <em>jedes</em> Bonierbons — unabhängig von der Artikelzuweisung
          </p>
        </div>
      </label>

      {fehler && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{fehler}</div>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-gray-200">
        <Button variant="secondary" type="button" onClick={onCancel}>Abbrechen</Button>
        <Button type="submit" loading={loading}>{initial ? 'Speichern' : 'Anlegen'}</Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

export function BonierdruckerPage() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]     = useState<Bonierdrucker | null>(null)
  const [fehler, setFehler]       = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'loading' | 'ok' | 'err'>>({})

  const query = useQuery({
    queryKey: ['bonierdrucker'],
    queryFn:  bonierdruckerApi.list,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['bonierdrucker'] })

  const create = useMutation({
    mutationFn: bonierdruckerApi.create,
    onSuccess: () => { invalidate(); setModalOpen(false); setFehler(null) },
    onError:   (e) => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: BonierdruckerInput }) =>
      bonierdruckerApi.update(id, input),
    onSuccess: () => { invalidate(); setModalOpen(false); setEditing(null); setFehler(null) },
    onError:   (e) => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  const del = useMutation({
    mutationFn: bonierdruckerApi.delete,
    onSuccess: invalidate,
  })

  const handleSubmit = (input: BonierdruckerInput) => {
    if (editing) update.mutate({ id: editing.id, input })
    else         create.mutate(input)
  }

  const handleTest = async (drucker: Bonierdrucker) => {
    setTestStatus(s => ({ ...s, [drucker.id]: 'loading' }))
    try {
      const res = await bonierdruckerApi.test(drucker.id)
      setTestStatus(s => ({ ...s, [drucker.id]: res.erfolgreich ? 'ok' : 'err' }))
    } catch {
      setTestStatus(s => ({ ...s, [drucker.id]: 'err' }))
    }
    setTimeout(() => setTestStatus(s => ({ ...s, [drucker.id]: 'idle' })), 4000)
  }

  const liste = query.data ?? []

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bonierdrucker</h1>
          <p className="mt-1 text-sm text-gray-500">
            Zentral konfigurierte ESC/POS-Drucker für Bonierzettel. Werden automatisch an alle Kassen weitergegeben.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setFehler(null); setModalOpen(true) }}>
          + Drucker anlegen
        </Button>
      </div>

      {query.isLoading && (
        <div className="text-sm text-gray-400">Laden…</div>
      )}

      {liste.length === 0 && !query.isLoading && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center">
          <p className="text-sm text-gray-400">Noch keine Bonierdrucker angelegt.</p>
          <p className="mt-1 text-xs text-gray-300">Lege mindestens einen Backup-Drucker an, der alle Bons empfängt.</p>
        </div>
      )}

      <div className="space-y-3">
        {liste.map(d => {
          const status = testStatus[d.id] ?? 'idle'
          return (
            <div
              key={d.id}
              className={`flex items-center gap-4 rounded-xl border px-4 py-3 bg-white shadow-sm ${
                !d.aktiv ? 'opacity-50' : ''
              }`}
            >
              {/* Icon */}
              <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${
                d.istBackup ? 'bg-amber-100' : 'bg-gray-100'
              }`}>
                <svg className={`h-5 w-5 ${d.istBackup ? 'text-amber-600' : 'text-gray-500'}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5Zm-3 0h.008v.008H15V10.5Z" />
                </svg>
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-900">{d.name}</span>
                  {d.istBackup && (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                      Backup
                    </span>
                  )}
                  {!d.aktiv && (
                    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                      Inaktiv
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-400 font-mono">{d.ip}:{d.port}</p>
              </div>

              {/* Aktionen */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => handleTest(d)}
                  disabled={status === 'loading'}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                    status === 'ok'  ? 'bg-green-50 border-green-200 text-green-700' :
                    status === 'err' ? 'bg-red-50 border-red-200 text-red-700' :
                    'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {status === 'loading' ? '…' :
                   status === 'ok'      ? '✓ OK' :
                   status === 'err'     ? '✗ Fehler' :
                   'Testdruck'}
                </button>
                <button
                  onClick={() => { setEditing(d); setFehler(null); setModalOpen(true) }}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                  title="Bearbeiten"
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M2.695 14.763l-1.262 3.154a.5.5 0 0 0 .65.65l3.155-1.262a4 4 0 0 0 1.343-.885L17.5 5.5a2.121 2.121 0 0 0-3-3L3.58 13.42a4 4 0 0 0-.885 1.343Z" />
                  </svg>
                </button>
                <button
                  onClick={() => { if (confirm(`"${d.name}" wirklich löschen?`)) del.mutate(d.id) }}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
                  title="Löschen"
                >
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null) }}
        title={editing ? 'Drucker bearbeiten' : 'Neuer Bonierdrucker'}
      >
        <BonierdruckerFormular
          initial={editing}
          onSubmit={handleSubmit}
          onCancel={() => { setModalOpen(false); setEditing(null) }}
          loading={create.isPending || update.isPending}
          fehler={fehler ?? undefined}
        />
      </Modal>
    </div>
  )
}
