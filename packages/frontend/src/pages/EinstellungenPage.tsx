import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { druckerApi, type DruckerConfig } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { Field } from '../components/ui/Field'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'

export function EinstellungenPage() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()

  const [form, setForm] = useState<DruckerConfig>({
    druckerIp:     '',
    druckerPort:   9100,
    druckerAktiv:  false,
    druckerBreite: 42,
  })
  const [meldung, setMeldung] = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  const cfgQuery = useQuery({
    queryKey: ['drucker', identity.kasseId],
    queryFn:  () => druckerApi.get(identity.kasseId),
  })

  useEffect(() => {
    if (cfgQuery.data) {
      setForm({
        druckerIp:     cfgQuery.data.druckerIp ?? '',
        druckerPort:   cfgQuery.data.druckerPort,
        druckerAktiv:  cfgQuery.data.druckerAktiv,
        druckerBreite: cfgQuery.data.druckerBreite,
      })
    }
  }, [cfgQuery.data])

  const speichern = useMutation({
    mutationFn: () => druckerApi.patch(identity.kasseId, {
      druckerIp:     form.druckerIp?.trim() || null,
      druckerPort:   form.druckerPort,
      druckerAktiv:  form.druckerAktiv,
      druckerBreite: form.druckerBreite,
    }),
    onSuccess: () => {
      setMeldung({ typ: 'ok', text: 'Einstellungen gespeichert' })
      queryClient.invalidateQueries({ queryKey: ['drucker', identity.kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  const testdruck = useMutation({
    mutationFn: () => druckerApi.test(identity.kasseId),
    onSuccess: () => setMeldung({ typ: 'ok', text: 'Testdruck gesendet — bitte am Drucker prüfen' }),
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Einstellungen</h1>
        <p className="mt-1 text-sm text-gray-500">Drucker und Hardware-Anbindung</p>
      </header>

      <section className="rounded-lg bg-white shadow-sm border border-gray-200 p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Bondrucker (ESC/POS via TCP)</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Netzwerkdrucker (Epson TM-T20, Star TSP100, Bixolon SRP, …). Verbindung erfolgt direkt über
            das lokale Netzwerk auf den eingestellten Port (Standard: 9100).
          </p>
        </div>

        {cfgQuery.isLoading ? (
          <p className="text-sm text-gray-500">Konfiguration wird geladen…</p>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 text-brand-500 focus:ring-brand-500"
                  checked={form.druckerAktiv}
                  onChange={(e) => setForm({ ...form, druckerAktiv: e.target.checked })}
                />
                Drucker aktiviert
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <Field label="IP-Adresse" htmlFor="ip" hint="z. B. 192.168.1.100">
                  <Input
                    id="ip"
                    value={form.druckerIp ?? ''}
                    onChange={(e) => setForm({ ...form, druckerIp: e.target.value })}
                    placeholder="192.168.1.100"
                  />
                </Field>
              </div>
              <Field label="Port" htmlFor="port">
                <Input
                  id="port"
                  type="number"
                  value={form.druckerPort}
                  onChange={(e) => setForm({ ...form, druckerPort: parseInt(e.target.value || '9100', 10) })}
                />
              </Field>
            </div>

            <Field label="Papierbreite" htmlFor="breite" hint="Zeichen pro Zeile — 32 für 58mm, 42 für 80mm (Standard)">
              <select
                id="breite"
                className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
                value={form.druckerBreite}
                onChange={(e) => setForm({ ...form, druckerBreite: parseInt(e.target.value, 10) })}
              >
                <option value={32}>58mm (32 Zeichen)</option>
                <option value={42}>80mm Standard (42 Zeichen)</option>
                <option value={48}>80mm Kompakt (48 Zeichen)</option>
              </select>
            </Field>

            {meldung && (
              <div className={`rounded-md p-3 text-sm ${
                meldung.typ === 'ok'
                  ? 'bg-green-50 border border-green-200 text-green-700'
                  : 'bg-red-50 border border-red-200 text-red-700'
              }`}>
                {meldung.text}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
              <Button onClick={() => { setMeldung(null); speichern.mutate() }} loading={speichern.isPending}>
                Speichern
              </Button>
              <Button
                variant="secondary"
                onClick={() => { setMeldung(null); testdruck.mutate() }}
                loading={testdruck.isPending}
                disabled={!form.druckerAktiv || !form.druckerIp}
              >
                Testdruck
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
