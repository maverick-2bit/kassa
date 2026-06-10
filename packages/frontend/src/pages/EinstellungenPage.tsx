import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { ALLE_STATIONEN, STATION_LABELS, type Station, type ZvtConfig } from '@kassa/shared'
import { druckerApi, kdsApi, zvtApi, downloadDepExport, healthApi, mandantApi, kasseApi, tischplanApi, type DruckerConfig, type KdsConfig } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { getAuth, hasModul, updateKasseBezeichnung } from '../lib/auth'
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
        <p className="mt-1 text-sm text-gray-500">Drucker, Hardware-Anbindung, Belegtext und Tischplan</p>
      </header>
      <KasseBezeichnungSektion />
      <StammdatenSektion />
      <DruckerSektion />
      <KdsSektion />
      <ZvtSektion />
      <RksvExportSektion />
      {hasModul('gastro') && <TischplanSektion />}
      <GastQrCodeSektion />
      <SystemInfoSektion />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kassenbezeichnung
// ---------------------------------------------------------------------------

function KasseBezeichnungSektion() {
  const identity    = getKasseIdentity()!
  const auth        = getAuth()!
  const queryClient = useQueryClient()
  const kasseInfo   = auth.kassen.find(k => k.id === identity.kasseId)
  const [wert, setWert]       = useState(kasseInfo?.bezeichnung ?? kasseInfo?.kassenId ?? '')
  const [meldung, setMeldung] = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  const speichern = useMutation({
    mutationFn: () => kasseApi.updateBezeichnung(identity.kasseId, { bezeichnung: wert.trim() }),
    onSuccess: (data) => {
      updateKasseBezeichnung(identity.kasseId, data.bezeichnung ?? '')
      queryClient.invalidateQueries({ queryKey: ['kasse-status', identity.kasseId] })
      setMeldung({ typ: 'ok', text: 'Kassenbezeichnung gespeichert' })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  return (
    <section className="rounded-lg bg-white shadow-sm border border-gray-200 p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Kassenbezeichnung</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Anzeigename dieser Kasse (erscheint in PDFs, Berichten und der Navigation).
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Bezeichnung" hint={`Interne ID: ${kasseInfo?.kassenId ?? identity.kasseId}`}>
          <Input
            value={wert}
            onChange={e => { setWert(e.target.value); setMeldung(null) }}
            placeholder={kasseInfo?.kassenId ?? ''}
            maxLength={100}
          />
        </Field>
      </div>

      {meldung && (
        <div className={`rounded-md p-3 text-sm ${
          meldung.typ === 'ok'
            ? 'bg-green-50 border border-green-200 text-green-700'
            : 'bg-red-50 border border-red-200 text-red-700'
        }`}>{meldung.text}</div>
      )}

      <div className="pt-2 border-t border-gray-200">
        <Button
          onClick={() => { setMeldung(null); speichern.mutate() }}
          loading={speichern.isPending}
          disabled={!wert.trim() || wert.trim() === (kasseInfo?.bezeichnung ?? kasseInfo?.kassenId ?? '')}
        >
          Speichern
        </Button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Mandanten-Stammdaten (Firmeninfo + Belegfußtext)
// ---------------------------------------------------------------------------

function StammdatenSektion() {
  const queryClient = useQueryClient()
  const [fusstext, setFusstext] = useState('')
  const [meldung, setMeldung]   = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  const stammdatenQuery = useQuery({
    queryKey: ['mandant-stammdaten'],
    queryFn:  mandantApi.getStammdaten,
  })

  useEffect(() => {
    if (stammdatenQuery.data) {
      setFusstext(stammdatenQuery.data.belegFusstext ?? '')
    }
  }, [stammdatenQuery.data])

  const speichern = useMutation({
    mutationFn: () => mandantApi.patchStammdaten({
      belegFusstext: fusstext.trim() || null,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mandant-stammdaten'] })
      setMeldung({ typ: 'ok', text: 'Einstellungen gespeichert' })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  const d = stammdatenQuery.data

  return (
    <section className="rounded-lg bg-white shadow-sm border border-gray-200 p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Unternehmensdaten &amp; Belegtext</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Firmenname und UID sind RKSV-seitig festgelegt. Der Belegfußtext erscheint auf
          allen ausgedruckten Belegen und PDFs.
        </p>
      </div>

      {stammdatenQuery.isLoading ? (
        <p className="text-sm text-gray-500">Wird geladen…</p>
      ) : d ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Firmenname</p>
              <p className="text-sm font-medium text-gray-800 bg-gray-50 rounded-md px-3 py-2 border border-gray-200">
                {d.firmenname}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">UID-Nummer</p>
              <p className="text-sm font-mono text-gray-800 bg-gray-50 rounded-md px-3 py-2 border border-gray-200">
                {d.uid}
              </p>
            </div>
          </div>

          <Field
            label="Belegfußtext"
            hint="Z. B. Adresse, Telefon, Website, Dankestext — erscheint am Ende jedes Belegs / PDFs"
          >
            <textarea
              value={fusstext}
              onChange={e => { setFusstext(e.target.value); setMeldung(null) }}
              rows={3}
              maxLength={500}
              placeholder="z. B. Musterstraße 1, 1010 Wien • Tel: +43 1 234567 • www.beispiel.at"
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm
                         placeholder-gray-400 shadow-sm resize-y
                         focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
            />
            <p className="text-xs text-gray-400 mt-1 text-right">{fusstext.length}/500</p>
          </Field>

          {meldung && (
            <div className={`rounded-md p-3 text-sm ${
              meldung.typ === 'ok'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}>{meldung.text}</div>
          )}

          <div className="pt-2 border-t border-gray-200">
            <Button
              onClick={() => { setMeldung(null); speichern.mutate() }}
              loading={speichern.isPending}
              disabled={fusstext.trim() === (d.belegFusstext ?? '')}
            >
              Belegtext speichern
            </Button>
          </div>
        </>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// RKSV-Export-Sektion (DEP7 + DEP131)
// ---------------------------------------------------------------------------

function RksvExportSektion() {
  const identity = getKasseIdentity()!
  const [vonDatum, setVonDatum] = useState('')
  const [bisDatum, setBisDatum] = useState('')
  const [meldung, setMeldung]   = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)

  const exportieren = async (format: 'dep7' | 'dep131') => {
    setMeldung(null)
    try {
      const { anzahl } = await downloadDepExport({
        kasseId:  identity.kasseId,
        format,
        ...(vonDatum && { vonDatum }),
        ...(bisDatum && { bisDatum }),
      })
      setMeldung({ typ: 'ok', text: `${anzahl} Belege exportiert` })
    } catch (err) {
      setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : 'Export fehlgeschlagen' })
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-gray-900 mb-1">RKSV-Datenexport</h2>
      <p className="text-sm text-gray-500 mb-4">
        DEP7 enthält die maschinenlesbaren Codes (Signaturkette). DEP131 enthält alle
        Belege mit Positionen und Beträgen. Ohne Datumsangabe wird der gesamte Bestand exportiert.
      </p>

      <div className="flex flex-wrap gap-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Von (Datum)</label>
          <input
            type="date"
            value={vonDatum}
            onChange={e => setVonDatum(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Bis (Datum)</label>
          <input
            type="date"
            value={bisDatum}
            onChange={e => setBisDatum(e.target.value)}
            min={vonDatum || undefined}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => exportieren('dep7')} variant="secondary">
          DEP7 exportieren
        </Button>
        <Button onClick={() => exportieren('dep131')} variant="secondary">
          DEP131 exportieren
        </Button>
      </div>

      {meldung && (
        <p className={`mt-3 text-sm ${meldung.typ === 'ok' ? 'text-green-700' : 'text-red-600'}`}>
          {meldung.text}
        </p>
      )}
    </section>
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
// Gast-QR-Code-Generator
// ---------------------------------------------------------------------------

function GastQrCodeSektion() {
  const auth       = getAuth()!
  const kassen     = auth.kassen

  // Standard-Basis-URL: selber Host, Port 8082 (Produktion) oder 5177 (Dev)
  const defaultBase = window.location.hostname === 'localhost'
    ? `${window.location.protocol}//${window.location.hostname}:5177`
    : `${window.location.protocol}//${window.location.hostname}:8082`

  const [basisUrl, setBasisUrl]       = useState(defaultBase)
  const [kasseId, setKasseId]         = useState(kassen[0]?.id ?? '')
  const [tisch, setTisch]             = useState('')
  const [manuellerTisch, setManuell]  = useState('')
  const svgRef                        = useRef<HTMLDivElement>(null)

  // Tischplan laden wenn Kasse gewählt
  const { data: bereiche } = useQuery({
    queryKey: ['tischplan-bereiche-qr', kasseId],
    queryFn:  () => tischplanApi.listeBereiche(kasseId),
    enabled:  !!kasseId,
  })

  const alleTische = bereiche?.flatMap(b =>
    b.elemente.map(e => ({ bezeichnung: e.bezeichnung, bereich: b.name }))
  ) ?? []

  const aktiverTisch = tisch || manuellerTisch
  const gastUrl = aktiverTisch && kasseId
    ? `${basisUrl}/gast?kasseId=${encodeURIComponent(kasseId)}&tisch=${encodeURIComponent(aktiverTisch)}`
    : ''

  function svgHerunterladen() {
    if (!svgRef.current) return
    const svg = svgRef.current.querySelector('svg')
    if (!svg) return
    const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `qr-${aktiverTisch.replace(/\s+/g, '-').toLowerCase()}.svg`
    a.click()
    URL.revokeObjectURL(url)
  }

  function allesDrucken() {
    window.print()
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Gast-Bestellsystem QR-Codes</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          QR-Codes für Tische generieren — Gäste scannen und bestellen direkt.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Konfiguration */}
        <div className="space-y-4">
          {/* Basis-URL */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              Gast-App URL
            </label>
            <input
              type="url"
              value={basisUrl}
              onChange={e => setBasisUrl(e.target.value)}
              placeholder="http://192.168.1.100:8082"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none font-mono"
            />
            <p className="text-xs text-gray-400 mt-1">
              Produktiv: IP des Servers + Port 8082 · Dev: Port 5177
            </p>
          </div>

          {/* Kasse */}
          {kassen.length > 1 && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                Kasse
              </label>
              <select
                value={kasseId}
                onChange={e => { setKasseId(e.target.value); setTisch('') }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 outline-none"
              >
                {kassen.map(k => (
                  <option key={k.id} value={k.id}>{k.bezeichnung ?? k.kassenId}</option>
                ))}
              </select>
            </div>
          )}

          {/* Tisch aus Tischplan */}
          {alleTische.length > 0 ? (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                Tisch
              </label>
              <select
                value={tisch}
                onChange={e => { setTisch(e.target.value); setManuell('') }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 outline-none"
              >
                <option value="">— Tisch wählen —</option>
                {bereiche?.map(b => (
                  <optgroup key={b.id} label={b.name}>
                    {b.elemente.map(e => (
                      <option key={e.id} value={e.bezeichnung}>{e.bezeichnung}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">oder manuell eingeben:</p>
              <input
                type="text"
                value={manuellerTisch}
                onChange={e => { setManuell(e.target.value); setTisch('') }}
                placeholder="z. B. Tisch 7"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 outline-none"
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                Tischbezeichnung
              </label>
              <input
                type="text"
                value={manuellerTisch}
                onChange={e => setManuell(e.target.value)}
                placeholder="z. B. Tisch 7, Bar, Terrasse"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 outline-none"
              />
            </div>
          )}
        </div>

        {/* QR-Code Vorschau */}
        <div className="flex flex-col items-center justify-center gap-4 bg-gray-50 rounded-xl border border-gray-200 p-6">
          {aktiverTisch && gastUrl ? (
            <>
              <div ref={svgRef} className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                <QRCodeSVG
                  value={gastUrl}
                  size={180}
                  level="M"
                  includeMargin={false}
                />
              </div>
              <p className="text-sm font-bold text-gray-900 text-center">{aktiverTisch}</p>
              <p className="text-xs text-gray-400 text-center break-all font-mono leading-relaxed max-w-full">
                {gastUrl}
              </p>
              <div className="flex gap-2 w-full">
                <button
                  onClick={() => navigator.clipboard.writeText(gastUrl)}
                  className="flex-1 py-2 rounded-lg border border-gray-300 text-gray-700 text-xs font-medium hover:bg-gray-100 transition"
                >
                  📋 URL kopieren
                </button>
                <button
                  onClick={svgHerunterladen}
                  className="flex-1 py-2 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 transition"
                >
                  ⬇ SVG laden
                </button>
              </div>
            </>
          ) : (
            <div className="text-center text-gray-400 space-y-2">
              <div className="text-5xl opacity-30">▦</div>
              <p className="text-sm">Tisch wählen um QR-Code zu generieren</p>
            </div>
          )}
        </div>
      </div>

      {/* Alle Tische auf einmal drucken */}
      {alleTische.length > 0 && basisUrl && kasseId && (
        <div className="border-t border-gray-100 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">Alle Tische drucken</p>
              <p className="text-xs text-gray-500 mt-0.5">{alleTische.length} Tische — öffnet Druckansicht mit allen QR-Codes</p>
            </div>
            <button
              onClick={() => {
                const html = `<!doctype html><html><head><meta charset="utf-8"><title>Tisch QR-Codes</title>
                <style>
                  body{font-family:sans-serif;margin:0}
                  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:16px}
                  .karte{border:1px solid #e5e7eb;border-radius:12px;padding:16px;text-align:center;break-inside:avoid}
                  .name{font-size:14px;font-weight:700;margin-top:8px;color:#111}
                  .url{font-size:9px;color:#9ca3af;word-break:break-all;margin-top:4px}
                  @media print{@page{margin:12mm}}
                </style></head><body>
                <div class="grid">
                ${alleTische.map(t => {
                  const url = `${basisUrl}/gast?kasseId=${encodeURIComponent(kasseId)}&tisch=${encodeURIComponent(t.bezeichnung)}`
                  // Simple QR-Link via Google Charts API als Fallback (oder canvas in Prod)
                  return `<div class="karte">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(url)}" width="150" height="150" />
                    <div class="name">${t.bezeichnung}</div>
                    <div class="url">${t.bereich}</div>
                  </div>`
                }).join('')}
                </div></body></html>`
                const win = window.open('', '_blank')
                win?.document.write(html)
                win?.document.close()
                win?.print()
              }}
              className="px-4 py-2 rounded-lg bg-gray-800 text-white text-sm font-medium hover:bg-gray-700 transition"
            >
              🖨 Alle drucken
            </button>
          </div>
        </div>
      )}
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
    druckerIp: '', druckerPort: 9100, druckerAktiv: false, druckerBreite: 42, druckerTimeoutSek: 5,
  })
  const [meldung, setMeldung]   = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)
  const [logOffen, setLogOffen] = useState(false)

  const cfgQuery = useQuery({
    queryKey: ['drucker', identity.kasseId],
    queryFn:  () => druckerApi.get(identity.kasseId),
  })

  const statusQuery = useQuery({
    queryKey:        ['drucker-status', identity.kasseId],
    queryFn:         () => druckerApi.status(identity.kasseId),
    refetchInterval: 30_000,
    enabled:         !!cfgQuery.data?.druckerAktiv && !!cfgQuery.data?.druckerIp,
  })

  const logQuery = useQuery({
    queryKey: ['drucker-log', identity.kasseId],
    queryFn:  () => druckerApi.log(identity.kasseId),
    enabled:  logOffen,
  })

  useEffect(() => {
    if (cfgQuery.data) {
      setForm({
        druckerIp:         cfgQuery.data.druckerIp ?? '',
        druckerPort:       cfgQuery.data.druckerPort,
        druckerAktiv:      cfgQuery.data.druckerAktiv,
        druckerBreite:     cfgQuery.data.druckerBreite,
        druckerTimeoutSek: cfgQuery.data.druckerTimeoutSek ?? 5,
      })
    }
  }, [cfgQuery.data])

  const speichern = useMutation({
    mutationFn: () => druckerApi.patch(identity.kasseId, {
      druckerIp:         form.druckerIp?.trim() || null,
      druckerPort:       form.druckerPort,
      druckerAktiv:      form.druckerAktiv,
      druckerBreite:     form.druckerBreite,
      druckerTimeoutSek: form.druckerTimeoutSek,
    }),
    onSuccess: () => {
      setMeldung({ typ: 'ok', text: 'Drucker-Einstellungen gespeichert' })
      queryClient.invalidateQueries({ queryKey: ['drucker', identity.kasseId] })
      queryClient.invalidateQueries({ queryKey: ['drucker-status', identity.kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  const testdruck = useMutation({
    mutationFn: () => druckerApi.test(identity.kasseId),
    onSuccess:  () => {
      setMeldung({ typ: 'ok', text: 'Testdruck gesendet — bitte am Drucker prüfen' })
      queryClient.invalidateQueries({ queryKey: ['drucker-log', identity.kasseId] })
      queryClient.invalidateQueries({ queryKey: ['drucker-status', identity.kasseId] })
    },
    onError: (err) => setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : String(err) }),
  })

  // Status-Dot
  const status = statusQuery.data
  const statusDot = !cfgQuery.data?.druckerAktiv || !cfgQuery.data?.druckerIp ? null
    : statusQuery.isLoading ? '⬜'
    : status?.online === true  ? '🟢'
    : status?.online === false ? '🔴'
    : '⬜'

  return (
    <section className="rounded-lg bg-white shadow-sm border border-gray-200 p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Bondrucker (ESC/POS via TCP)</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Netzwerkdrucker (Epson TM-T20, Star TSP100, Bixolon SRP, …)
          </p>
        </div>
        {statusDot && (
          <div className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
            <span>{statusDot}</span>
            <span>{status?.online === true ? 'Online' : status?.online === false ? 'Offline' : 'Unbekannt'}</span>
          </div>
        )}
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
            <Field label="Timeout" hint="Sekunden bis Verbindungsabbruch (1–30)">
              <Input
                type="number"
                min={1}
                max={30}
                value={form.druckerTimeoutSek}
                onChange={(e) => setForm({ ...form, druckerTimeoutSek: Math.min(30, Math.max(1, parseInt(e.target.value || '5', 10))) })}
              />
            </Field>
          </div>

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
            <button
              type="button"
              onClick={() => setLogOffen(v => !v)}
              className="ml-auto text-xs text-gray-400 hover:text-brand-700 underline underline-offset-2"
            >
              {logOffen ? 'Verlauf ausblenden' : 'Druckverlauf anzeigen'}
            </button>
          </div>

          {/* Druckhistorie */}
          {logOffen && (
            <div className="border-t border-gray-100 pt-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Druckverlauf (letzte 50)</h3>
              {logQuery.isLoading ? (
                <p className="text-xs text-gray-400">Wird geladen…</p>
              ) : !logQuery.data?.length ? (
                <p className="text-xs text-gray-400">Noch keine Druckversuche protokolliert.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
                      <tr>
                        <th className="px-3 py-2 text-left">Zeit</th>
                        <th className="px-3 py-2 text-left">Typ</th>
                        <th className="px-3 py-2 text-left">Status</th>
                        <th className="px-3 py-2 text-left">Fehler</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {logQuery.data.map(e => (
                        <tr key={e.id} className={`${e.erfolg ? '' : 'bg-red-50'}`}>
                          <td className="px-3 py-1.5 font-mono text-gray-600 whitespace-nowrap">
                            {new Date(e.erstelltAt).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'medium' })}
                          </td>
                          <td className="px-3 py-1.5 capitalize text-gray-700">{e.druckerTyp}</td>
                          <td className="px-3 py-1.5">
                            {e.erfolg
                              ? <span className="text-green-700 font-medium">✓ OK</span>
                              : <span className="text-red-700 font-medium">✗ Fehler</span>
                            }
                          </td>
                          <td className="px-3 py-1.5 text-gray-500 max-w-xs truncate">{e.fehlerText ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
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

// ---------------------------------------------------------------------------
// Systeminfo-Sektion
// ---------------------------------------------------------------------------

function SystemInfoSektion() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn:  healthApi.get,
    refetchInterval: 60_000,   // jede Minute neu prüfen
    retry: false,
  })

  const dbOk     = health.data?.checks.db === 'ok'
  const statusOk = health.data?.status === 'ok'

  const formatUptime = (sek: number) => {
    if (sek < 60)   return `${sek}s`
    if (sek < 3600) return `${Math.floor(sek / 60)}min`
    const h = Math.floor(sek / 3600)
    const m = Math.floor((sek % 3600) / 60)
    return `${h}h ${m}min`
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 space-y-4">
      <h2 className="text-lg font-semibold text-gray-900">Systeminfo</h2>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 text-sm">
        {/* Frontend-Version */}
        <div>
          <dt className="text-gray-500">Frontend-Version</dt>
          <dd className="mt-0.5 font-mono font-medium text-gray-900">
            v{__APP_VERSION__}
          </dd>
        </div>

        {/* Backend-Version */}
        <div>
          <dt className="text-gray-500">Backend-Version</dt>
          <dd className="mt-0.5 font-mono font-medium text-gray-900">
            {health.isLoading ? (
              <span className="text-gray-400">…</span>
            ) : health.data ? (
              `v${health.data.version}`
            ) : (
              <span className="text-red-500">nicht erreichbar</span>
            )}
          </dd>
        </div>

        {/* Datenbank-Status */}
        <div>
          <dt className="text-gray-500">Datenbank</dt>
          <dd className="mt-0.5 flex items-center gap-1.5">
            {health.isLoading ? (
              <span className="text-gray-400 text-sm">…</span>
            ) : (
              <>
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    dbOk ? 'bg-green-500' : 'bg-red-500'
                  }`}
                />
                <span className={`font-medium ${dbOk ? 'text-green-700' : 'text-red-600'}`}>
                  {dbOk ? 'verbunden' : 'nicht erreichbar'}
                </span>
              </>
            )}
          </dd>
        </div>

        {/* Server-Status */}
        <div>
          <dt className="text-gray-500">Server-Status</dt>
          <dd className="mt-0.5 flex items-center gap-1.5">
            {health.isLoading ? (
              <span className="text-gray-400 text-sm">…</span>
            ) : health.data ? (
              <>
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    statusOk ? 'bg-green-500' : 'bg-amber-500'
                  }`}
                />
                <span className={`font-medium ${statusOk ? 'text-green-700' : 'text-amber-700'}`}>
                  {statusOk ? 'ok' : 'eingeschränkt'}
                </span>
              </>
            ) : (
              <>
                <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
                <span className="font-medium text-red-600">offline</span>
              </>
            )}
          </dd>
        </div>

        {/* Uptime */}
        {health.data && (
          <div>
            <dt className="text-gray-500">Server-Laufzeit</dt>
            <dd className="mt-0.5 font-medium text-gray-900">
              {formatUptime(health.data.uptimeSek)}
            </dd>
          </div>
        )}

        {/* Letzter Check */}
        {health.data && (
          <div>
            <dt className="text-gray-500">Letzter Check</dt>
            <dd className="mt-0.5 text-gray-600">
              {new Date(health.data.timestamp).toLocaleTimeString('de-AT')}
            </dd>
          </div>
        )}
      </dl>

      {/* Manueller Refresh */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() => void health.refetch()}
          disabled={health.isFetching}
          className="text-xs text-brand-600 hover:text-brand-700 disabled:text-gray-400"
        >
          {health.isFetching ? 'Prüfe…' : '↻ Jetzt prüfen'}
        </button>
      </div>
    </section>
  )
}
