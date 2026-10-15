/**
 * ZvtKarte — Kartenterminal (ZVT) EINER Kasse: Hobex, Payroc und andere ZVT-kompatible Terminals via TCP.
 * Früher ein Abschnitt unter Einstellungen → Hardware, der nur die aktive Kasse kannte; jetzt je Kasse
 * in den Details der Einrichtungs-Übersicht.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ZvtConfig } from '@kassa/shared'
import { zvtApi } from '../../lib/api'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { KartenzahlungModal } from '../KartenzahlungModal'

export function ZvtKarte({ kasseId }: { kasseId: string }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<ZvtConfig>({ zvtIp: '', zvtPort: 20007, zvtPasswort: '', zvtAktiv: false })
  const [meldung, setMeldung]     = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)
  const [testOffen, setTestOffen] = useState(false)

  const cfgQuery = useQuery({
    queryKey: ['zvt', kasseId],
    queryFn:  () => zvtApi.getConfig(kasseId),
  })

  useEffect(() => {
    if (cfgQuery.data) {
      setForm({
        zvtIp:       cfgQuery.data.zvtIp       ?? '',
        zvtPort:     cfgQuery.data.zvtPort,
        zvtPasswort: cfgQuery.data.zvtPasswort ?? '',
        zvtAktiv:    cfgQuery.data.zvtAktiv,
      })
    }
  }, [cfgQuery.data])

  const speichern = useMutation({
    mutationFn: () => zvtApi.patchConfig(kasseId, {
      zvtIp:       form.zvtIp?.trim() || null,
      zvtPort:     form.zvtPort,
      zvtPasswort: form.zvtPasswort?.trim() || null,
      zvtAktiv:    form.zvtAktiv,
    }),
    onSuccess: () => {
      setMeldung({ typ: 'ok', text: 'ZVT-Einstellungen gespeichert' })
      queryClient.invalidateQueries({ queryKey: ['zvt', kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-ink">Kartenterminal (ZVT)</h4>
        <p className="text-xs text-ink-muted mt-0.5">
          Hobex, Payroc und andere ZVT-kompatible Terminals via TCP.
          Für Tests ohne echtes Terminal: IP <code className="text-xs bg-panel-2 px-1 rounded">stub</code>.
        </p>
      </div>

      {cfgQuery.isLoading ? (
        <p className="text-xs text-ink-muted">Konfiguration wird geladen…</p>
      ) : (
        <>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-ink">
            <input
              type="checkbox"
              className="rounded border-line-strong text-brand-500 focus:ring-brand-500"
              checked={form.zvtAktiv}
              onChange={(e) => setForm({ ...form, zvtAktiv: e.target.checked })}
            />
            Kartenzahlung aktiviert
          </label>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Terminal-IP" hint="z. B. 192.168.1.50 oder 'stub' für Tests">
                <Input
                  value={form.zvtIp ?? ''}
                  onChange={(e) => setForm({ ...form, zvtIp: e.target.value })}
                  placeholder="192.168.1.50"
                />
              </Field>
            </div>
            <Field label="Port" hint="Hobex/Payroc: 20007">
              <Input
                type="number"
                value={form.zvtPort}
                onChange={(e) => setForm({ ...form, zvtPort: parseInt(e.target.value || '20007', 10) })}
              />
            </Field>
          </div>

          <Field label="Terminal-Passwort" hint="Optional (6-stellig, falls vom Gerät verlangt)">
            <Input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={form.zvtPasswort ?? ''}
              onChange={(e) => setForm({ ...form, zvtPasswort: e.target.value.replace(/\D/g, '') })}
            />
          </Field>

          {meldung && (
            <div className={`rounded-md p-3 text-sm ${
              meldung.typ === 'ok'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}>{meldung.text}</div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => { setMeldung(null); speichern.mutate() }} loading={speichern.isPending}>
              Speichern
            </Button>
            <Button
              variant="secondary"
              onClick={() => setTestOffen(true)}
              disabled={!form.zvtAktiv || !form.zvtIp}
            >
              Test 1 Cent
            </Button>
          </div>
        </>
      )}

      {/* Test-Zahlung: nur Verbindungs- und Protokoll-Check, KEIN Beleg */}
      <KartenzahlungModal
        open={testOffen}
        kasseId={kasseId}
        betragCent={1}
        onErfolg={() => {
          setTestOffen(false)
          setMeldung({ typ: 'ok', text: 'Test-Transaktion erfolgreich' })
        }}
        onAbbruch={() => setTestOffen(false)}
      />
    </div>
  )
}
