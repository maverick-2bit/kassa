/**
 * BonierdruckerBibliothek — mandantenweite Verwaltung der ESC/POS-Bonierdrucker
 * (anlegen / bearbeiten / löschen / Testdruck). Wiederverwendet auf der
 * Hardware-Einstellungsseite UND (als Wrapper) unter /bonierdrucker.
 * Zentral angelegt, per Kassen-Zuordnung den Kassen zugewiesen.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import type { Bonierdrucker, BonierdruckerInput } from '@kassa/shared'
import { bonierdruckerApi } from '../lib/api'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
import { Field } from './ui/Field'
import { Input } from './ui/Input'

type FormValues = { name: string; ip: string; port: string; istBackup: boolean }

function BonierdruckerFormular({ initial, onSubmit, onCancel, loading, fehler }: {
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
        <input type="checkbox" className="h-4 w-4 rounded border-line-strong text-amber-500 focus:ring-amber-400" {...register('istBackup')} />
        <div>
          <p className="text-sm font-medium text-amber-900">Backup-Drucker</p>
          <p className="text-xs text-amber-700">
            Empfängt automatisch eine Kopie <em>jedes</em> Bonierbons — unabhängig von der Artikelzuweisung
          </p>
        </div>
      </label>

      {fehler && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{fehler}</div>}

      <div className="flex justify-end gap-2 pt-2 border-t border-line">
        <Button variant="secondary" type="button" onClick={onCancel}>Abbrechen</Button>
        <Button type="submit" loading={loading}>{initial ? 'Speichern' : 'Anlegen'}</Button>
      </div>
    </form>
  )
}

export function BonierdruckerBibliothek() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing]     = useState<Bonierdrucker | null>(null)
  const [fehler, setFehler]       = useState<string | null>(null)
  const [testStatus, setTestStatus] = useState<Record<string, 'idle' | 'loading' | 'ok' | 'err'>>({})

  const query = useQuery({ queryKey: ['bonierdrucker'], queryFn: bonierdruckerApi.list })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['bonierdrucker'] })

  const create = useMutation({
    mutationFn: bonierdruckerApi.create,
    onSuccess: () => { invalidate(); setModalOpen(false); setFehler(null) },
    onError:   (e) => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: BonierdruckerInput }) => bonierdruckerApi.update(id, input),
    onSuccess: () => { invalidate(); setModalOpen(false); setEditing(null); setFehler(null) },
    onError:   (e) => setFehler(e instanceof Error ? e.message : 'Fehler'),
  })
  const del = useMutation({ mutationFn: bonierdruckerApi.delete, onSuccess: invalidate })

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
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">Bonierdrucker-Bibliothek</h3>
          <p className="text-xs text-ink-muted">Küchen-/Schankdrucker für Bonierzettel. Unten je Kasse zuordnen.</p>
        </div>
        <Button variant="secondary" onClick={() => { setEditing(null); setFehler(null); setModalOpen(true) }}>
          + weiteren Bonierdrucker einrichten
        </Button>
      </div>

      {query.isLoading ? (
        <p className="text-xs text-ink-subtle">Laden…</p>
      ) : liste.length === 0 ? (
        <p className="text-xs text-ink-subtle">Noch kein Bonierdrucker angelegt.</p>
      ) : (
        <div className="divide-y divide-line rounded-lg border border-line">
          {liste.map(d => {
            const status = testStatus[d.id] ?? 'idle'
            return (
              <div key={d.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 ${!d.aktiv ? 'opacity-60' : ''}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">
                    {d.name}
                    {d.istBackup && <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Backup</span>}
                    {!d.aktiv && <span className="ml-2 text-xs text-ink-subtle">(inaktiv)</span>}
                  </p>
                  <p className="text-xs text-ink-muted font-mono">{d.ip}:{d.port}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => handleTest(d)} disabled={status === 'loading'}
                    className={`text-xs px-2 py-1 rounded border transition ${
                      status === 'ok' ? 'bg-green-50 border-green-200 text-green-700' :
                      status === 'err' ? 'bg-red-50 border-red-200 text-red-700' :
                      'border-line-strong text-ink hover:border-brand-400'}`}>
                    {status === 'loading' ? '…' : status === 'ok' ? '✓ OK' : status === 'err' ? '✗ Fehler' : 'Testdruck'}
                  </button>
                  <button onClick={() => { setEditing(d); setFehler(null); setModalOpen(true) }}
                    className="text-xs px-2 py-1 rounded border border-line-strong text-ink hover:border-brand-400">Bearbeiten</button>
                  <button onClick={() => { if (confirm(`Bonierdrucker „${d.name}" löschen?`)) del.mutate(d.id) }}
                    className="text-xs px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50">Löschen</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => { setModalOpen(false); setEditing(null) }}
        title={editing ? 'Bonierdrucker bearbeiten' : 'Neuen Bonierdrucker einrichten'}>
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
