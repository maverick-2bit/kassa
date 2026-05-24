import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ALLE_STATIONEN, STATION_LABELS, type Station, type ZvtConfig } from '@kassa/shared'
import { druckerApi, kdsApi, zvtApi, type DruckerConfig, type KdsConfig } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { Field } from '../components/ui/Field'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'
import { KartenzahlungModal } from '../components/KartenzahlungModal'
import { TischplanEditor } from '../components/TischplanEditor'

export function EinstellungenPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Einstellungen</h1>
        <p className="mt-1 text-sm text-gray-500">Drucker, Hardware-Anbindung und Tischplan</p>
      </header>
      <DruckerSektion />
      <KdsSektion />
      <ZvtSektion />
      <TischplanSektion />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tischplan-Sektion
// ---------------------------------------------------------------------------

function TischplanSektion() {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Tischplan</h2>
      <p className="text-sm text-gray-500 mb-4">
        Bereiche anlegen und Tische per Drag &amp; Drop positionieren.
        Der fertige Plan erscheint auf der Tische-Seite als grafische Ansicht.
      </p>
      <TischplanEditor />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Drucker
// ---------------------------------------------------------------------------

function DruckerSektion() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [form, setForm] = useState<DruckerConfig>({
    druckerIp: '', druckerPort: 9100, druckerAktiv: false, druckerBreite: 42,
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
      setMeldung({ typ: 'ok', text: 'Drucker-Einstellungen gespeichert' })
      queryClient.invalidateQueries({ queryKey: ['drucker', identity.kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  const testdruck = useMutation({
    mutationFn: () => druckerApi.test(identity.kasseId),
    onSuccess:  () => setMeldung({ typ: 'ok', text: 'Testdruck gesendet — bitte am Drucker prüfen' }),
    onError:    (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  return (
    <section className="rounded-lg bg-white shadow-sm border border-gray-200 p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Bondrucker (ESC/POS via TCP)</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Netzwerkdrucker (Epson TM-T20, Star TSP100, Bixolon SRP, …)
        </p>
      </div>

      {cfgQuery.isLoading ? (
        <p className="text-sm text-gray-500">Konfiguration wird geladen…</p>
      ) : (
        <>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              className="rounded border-gray-300 text-brand-500 focus:ring-brand-500"
              checked={form.druckerAktiv}
              onChange={(e) => setForm({ ...form, druckerAktiv: e.target.checked })}
            />
            Drucker aktiviert
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <Field label="IP-Adresse" hint="z. B. 192.168.1.100">
                <Input
                  value={form.druckerIp ?? ''}
                  onChange={(e) => setForm({ ...form, druckerIp: e.target.value })}
                  placeholder="192.168.1.100"
                />
              </Field>
            </div>
            <Field label="Port">
              <Input
                type="number"
                value={form.druckerPort}
                onChange={(e) => setForm({ ...form, druckerPort: parseInt(e.target.value || '9100', 10) })}
              />
            </Field>
          </div>

          <Field label="Papierbreite" hint="Zeichen pro Zeile">
            <select
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
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
            }`}>{meldung.text}</div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
            <Button onClick={() => { setMeldung(null); speichern.mutate() }} loading={speichern.isPending}>Speichern</Button>
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
  )
}

// ---------------------------------------------------------------------------
// KDS (Küchen-Display-System)
// ---------------------------------------------------------------------------

function KdsSektion() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [form, setForm] = useState<KdsConfig>({
    kdsAktiv: false, kdsPort: 9100, kdsStationen: {},
  })
  const [meldung, setMeldung] = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  const cfgQuery = useQuery({
    queryKey: ['kds', identity.kasseId],
    queryFn:  () => kdsApi.get(identity.kasseId),
  })

  useEffect(() => {
    if (cfgQuery.data) {
      setForm({
        kdsAktiv:     cfgQuery.data.kdsAktiv,
        kdsPort:      cfgQuery.data.kdsPort,
        kdsStationen: cfgQuery.data.kdsStationen,
      })
    }
  }, [cfgQuery.data])

  const speichern = useMutation({
    mutationFn: () => {
      // Leere Strings entfernen
      const bereinigt: Partial<Record<Station, string>> = {}
      for (const s of ALLE_STATIONEN) {
        const ip = form.kdsStationen[s]?.trim()
        if (ip) bereinigt[s] = ip
      }
      return kdsApi.patch(identity.kasseId, {
        kdsAktiv:     form.kdsAktiv,
        kdsPort:      form.kdsPort,
        kdsStationen: bereinigt,
      })
    },
    onSuccess: () => {
      setMeldung({ typ: 'ok', text: 'KDS-Einstellungen gespeichert' })
      queryClient.invalidateQueries({ queryKey: ['kds', identity.kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  const setStationIp = (s: Station, ip: string): void => {
    setForm({ ...form, kdsStationen: { ...form.kdsStationen, [s]: ip } })
  }

  return (
    <section className="rounded-lg bg-white shadow-sm border border-gray-200 p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Küchen-Display-System (KDS)</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Bonierbons werden an die jeweilige Stations-IP gesendet. Das KDS leitet sie
          an die zugehörigen Küchen-Displays weiter (TCP-Port wie bei den Druckern).
        </p>
      </div>

      {cfgQuery.isLoading ? (
        <p className="text-sm text-gray-500">Konfiguration wird geladen…</p>
      ) : (
        <>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              className="rounded border-gray-300 text-brand-500 focus:ring-brand-500"
              checked={form.kdsAktiv}
              onChange={(e) => setForm({ ...form, kdsAktiv: e.target.checked })}
            />
            KDS aktiviert
          </label>

          <Field label="Port" hint="Standard: 9100 (gleicher Port wie Bondrucker)">
            <Input
              type="number"
              value={form.kdsPort}
              onChange={(e) => setForm({ ...form, kdsPort: parseInt(e.target.value || '9100', 10) })}
            />
          </Field>

          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-700">Stations-IPs</p>
            <p className="text-xs text-gray-500">
              Pro Station eine IP. Leer lassen, wenn die Station nicht verwendet wird.
            </p>
            {ALLE_STATIONEN.map((s) => (
              <div key={s} className="grid grid-cols-[140px_1fr] gap-3 items-center">
                <label className="text-sm font-medium text-gray-700">{STATION_LABELS[s]}</label>
                <Input
                  placeholder="192.168.192.210"
                  value={form.kdsStationen[s] ?? ''}
                  onChange={(e) => setStationIp(s, e.target.value)}
                />
              </div>
            ))}
          </div>

          {meldung && (
            <div className={`rounded-md p-3 text-sm ${
              meldung.typ === 'ok'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}>{meldung.text}</div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
            <Button onClick={() => { setMeldung(null); speichern.mutate() }} loading={speichern.isPending}>
              Speichern
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// ZVT (Kartenterminal)
// ---------------------------------------------------------------------------

function ZvtSektion() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [form, setForm] = useState<ZvtConfig>({
    zvtIp: '', zvtPort: 20007, zvtPasswort: '', zvtAktiv: false,
  })
  const [meldung, setMeldung]   = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)
  const [testOffen, setTestOffen] = useState(false)

  const cfgQuery = useQuery({
    queryKey: ['zvt', identity.kasseId],
    queryFn:  () => zvtApi.getConfig(identity.kasseId),
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
    mutationFn: () => zvtApi.patchConfig(identity.kasseId, {
      zvtIp:       form.zvtIp?.trim() || null,
      zvtPort:     form.zvtPort,
      zvtPasswort: form.zvtPasswort?.trim() || null,
      zvtAktiv:    form.zvtAktiv,
    }),
    onSuccess: () => {
      setMeldung({ typ: 'ok', text: 'ZVT-Einstellungen gespeichert' })
      queryClient.invalidateQueries({ queryKey: ['zvt', identity.kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  return (
    <section className="rounded-lg bg-white shadow-sm border border-gray-200 p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Kartenterminal (ZVT)</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Hobex, Payroc und andere ZVT-kompatible Terminals via TCP.
          Für Tests ohne echtes Terminal: IP <code className="text-xs bg-gray-100 px-1 rounded">stub</code>.
        </p>
      </div>

      {cfgQuery.isLoading ? (
        <p className="text-sm text-gray-500">Konfiguration wird geladen…</p>
      ) : (
        <>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              className="rounded border-gray-300 text-brand-500 focus:ring-brand-500"
              checked={form.zvtAktiv}
              onChange={(e) => setForm({ ...form, zvtAktiv: e.target.checked })}
            />
            Kartenzahlung aktiviert
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
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
              placeholder=""
            />
          </Field>

          {meldung && (
            <div className={`rounded-md p-3 text-sm ${
              meldung.typ === 'ok'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}>{meldung.text}</div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
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
        kasseId={identity.kasseId}
        betragCent={1}
        onErfolg={() => {
          setTestOffen(false)
          setMeldung({ typ: 'ok', text: 'Test-Transaktion erfolgreich' })
        }}
        onAbbruch={() => setTestOffen(false)}
      />
    </section>
  )
}
