import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { downloadDepExport, depSicherungApi, type DepSicherungRow } from '../lib/api'
import { getAuth } from '../lib/auth'
import { Button } from '../components/ui/Button'

function heute(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
}

function formatDatum(iso: string): string {
  return new Date(iso).toLocaleString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Vienna',
  })
}

function tageSeitSicherung(sicherungen: DepSicherungRow[]): number | null {
  if (sicherungen.length === 0) return null
  const letzte = new Date(sicherungen[0]!.erstelltAm)
  return Math.floor((Date.now() - letzte.getTime()) / 86_400_000)
}

export function DepExportPage() {
  const auth   = getAuth()
  const kassen = auth?.kassen ?? []
  const qc     = useQueryClient()

  const [kasseId,  setKasseId]  = useState(kassen[0]?.id ?? '')
  const [vonDatum, setVonDatum] = useState('')
  const [bisDatum, setBisDatum] = useState('')
  const [loading,  setLoading]  = useState<'dep7' | 'dep131' | null>(null)
  const [ergebnis, setErgebnis] = useState<{ format: string; anzahl: number } | null>(null)
  const [fehler,   setFehler]   = useState<string | null>(null)

  const sicherungenQuery = useQuery({
    queryKey: ['dep-sicherungen', kasseId],
    queryFn:  () => depSicherungApi.liste(kasseId),
    enabled:  !!kasseId,
    staleTime: 30_000,
  })

  const sicherungErstellen = useMutation({
    mutationFn: () => depSicherungApi.erstellen(kasseId),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['dep-sicherungen', kasseId] }),
  })

  async function exportieren(format: 'dep7' | 'dep131') {
    if (!kasseId) return
    setLoading(format)
    setErgebnis(null)
    setFehler(null)
    try {
      const { anzahl } = await downloadDepExport({
        kasseId,
        format,
        ...(vonDatum ? { vonDatum } : {}),
        ...(bisDatum ? { bisDatum } : {}),
      })
      setErgebnis({ format: format === 'dep7' ? 'DEP7' : 'DEP131', anzahl })
    } catch (err) {
      setFehler(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(null)
    }
  }

  const ausgewaehlt = kassen.find(k => k.id === kasseId)
  const sicherungen = sicherungenQuery.data ?? []
  const tage        = tageSeitSicherung(sicherungen)
  const ueberfaellig = tage === null || tage > 30

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-ink mb-1">DEP-Export</h1>
      <p className="text-sm text-ink-muted mb-8">
        Datenerfassungsprotokoll gemäß RKSV — gesetzlich 7 Jahre aufzubewahren und bei Finanzprüfungen vorzulegen.
      </p>

      {/* Sicherungs-Status-Banner */}
      {kasseId && (
        <div className={`flex items-center gap-3 rounded-xl border px-5 py-3 mb-5 ${
          ueberfaellig
            ? 'bg-amber-50 border-amber-200'
            : 'bg-green-50 border-green-200'
        }`}>
          <span className={`text-lg ${ueberfaellig ? 'text-amber-500' : 'text-green-500'}`}>
            {ueberfaellig ? '⚠' : '✓'}
          </span>
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-medium ${ueberfaellig ? 'text-amber-800' : 'text-green-800'}`}>
              {tage === null
                ? 'Noch keine automatische Sicherung vorhanden'
                : tage === 0
                  ? 'Heute gesichert'
                  : `Letzte Sicherung vor ${tage} Tag${tage === 1 ? '' : 'en'}`}
            </p>
            <p className={`text-xs ${ueberfaellig ? 'text-amber-600' : 'text-green-600'}`}>
              {ueberfaellig
                ? 'Empfehlung: Jetzt manuell sichern'
                : 'Automatische Sicherung aktiv (täglich geprüft)'}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={sicherungErstellen.isPending}
            disabled={sicherungErstellen.isPending}
            onClick={() => sicherungErstellen.mutate()}
          >
            Jetzt sichern
          </Button>
        </div>
      )}

      {/* Kasse wählen */}
      <section className="bg-panel border border-line rounded-xl p-6 mb-5 space-y-4">
        <h2 className="font-semibold text-ink">Kasse</h2>
        <div>
          {kassen.length === 0 ? (
            <p className="text-sm text-ink-muted">Keine Kasse verfügbar.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {kassen.map(k => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => { setKasseId(k.id); setErgebnis(null); setFehler(null) }}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition ${
                    kasseId === k.id
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'bg-panel text-ink border-line-strong hover:border-brand-400'
                  }`}
                >
                  {k.bezeichnung ?? k.kassenId}
                  {k.umgebung !== 'produktion' && (
                    <span className="ml-1.5 text-[10px] opacity-70 uppercase tracking-wide">{k.umgebung}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {ausgewaehlt && (
            <p className="mt-2 text-xs text-ink-subtle">Kassen-ID: {ausgewaehlt.kassenId}</p>
          )}
        </div>
      </section>

      {/* Zeitraum */}
      <section className="bg-panel border border-line rounded-xl p-6 mb-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-ink">Zeitraum (optional)</h2>
          {(vonDatum || bisDatum) && (
            <button
              type="button"
              className="text-xs text-ink-subtle hover:text-ink-muted"
              onClick={() => { setVonDatum(''); setBisDatum('') }}
            >
              Zurücksetzen
            </button>
          )}
        </div>
        <p className="text-xs text-ink-muted">Ohne Angabe werden alle Belege der Kasse exportiert.</p>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-xs font-medium text-ink-muted mb-1">Von</span>
            <input
              type="date"
              value={vonDatum}
              max={bisDatum || heute()}
              onChange={e => setVonDatum(e.target.value)}
              className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-ink-muted mb-1">Bis</span>
            <input
              type="date"
              value={bisDatum}
              min={vonDatum || undefined}
              max={heute()}
              onChange={e => setBisDatum(e.target.value)}
              className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
        </div>
      </section>

      {/* Export-Buttons */}
      <section className="bg-panel border border-line rounded-xl p-6 mb-5">
        <h2 className="font-semibold text-ink mb-4">Format herunterladen</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="border border-line rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-md bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">DEP7</span>
              <span className="text-sm font-medium text-ink">Maschinenlesbar</span>
            </div>
            <p className="text-xs text-ink-muted leading-relaxed">
              Signierte QR-Code-Belegcodes im BMF-Format. Pflicht für die Finanzprüfung (§ 131b BAO).
            </p>
            <Button
              variant="primary"
              disabled={!kasseId || loading !== null}
              onClick={() => exportieren('dep7')}
              className="w-full mt-1"
            >
              {loading === 'dep7' ? 'Wird exportiert…' : 'DEP7 herunterladen'}
            </Button>
          </div>
          <div className="border border-line rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-md bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-700">DEP131</span>
              <span className="text-sm font-medium text-ink">Lesbar + strukturiert</span>
            </div>
            <p className="text-xs text-ink-muted leading-relaxed">
              Vollständige Belegdaten mit Positionen, Beträgen und Zahlung (§ 131 BAO).
            </p>
            <Button
              variant="secondary"
              disabled={!kasseId || loading !== null}
              onClick={() => exportieren('dep131')}
              className="w-full mt-1"
            >
              {loading === 'dep131' ? 'Wird exportiert…' : 'DEP131 herunterladen'}
            </Button>
          </div>
        </div>
      </section>

      {/* Feedback */}
      {ergebnis && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-5 py-4 mb-5">
          <p className="text-sm font-medium text-green-800">
            {ergebnis.format}-Export heruntergeladen — {ergebnis.anzahl} {ergebnis.anzahl === 1 ? 'Beleg' : 'Belege'}.
          </p>
        </div>
      )}
      {fehler && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 mb-5">
          <p className="text-sm font-medium text-red-800">{fehler}</p>
        </div>
      )}
      {sicherungErstellen.isSuccess && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-5 py-4 mb-5">
          <p className="text-sm font-medium text-green-800">
            Sicherung erstellt: {sicherungErstellen.data.dateiname}
          </p>
        </div>
      )}
      {sicherungErstellen.isError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 mb-5">
          <p className="text-sm font-medium text-red-800">
            Sicherung fehlgeschlagen: {sicherungErstellen.error instanceof Error ? sicherungErstellen.error.message : 'Unbekannter Fehler'}
          </p>
        </div>
      )}

      {/* Sicherungsverlauf */}
      {kasseId && (
        <section className="bg-panel border border-line rounded-xl p-6 mb-5">
          <h2 className="font-semibold text-ink mb-4">Sicherungsverlauf</h2>
          {sicherungenQuery.isLoading ? (
            <p className="text-sm text-ink-subtle">Lädt…</p>
          ) : sicherungen.length === 0 ? (
            <p className="text-sm text-ink-subtle">Noch keine Sicherungen vorhanden.</p>
          ) : (
            <div className="divide-y divide-line">
              {sicherungen.map(s => (
                <div key={s.id} className="flex items-center gap-3 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{s.dateiname}</p>
                    <p className="text-xs text-ink-muted">
                      {formatDatum(s.erstelltAm)} · {s.anzahlBelege} Belege ·{' '}
                      <span className={s.automatisch ? 'text-ink-subtle' : 'text-blue-600'}>
                        {s.automatisch ? 'automatisch' : 'manuell'}
                      </span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => depSicherungApi.download(s.id, s.dateiname)}
                    className="text-xs text-brand-600 hover:text-brand-800 font-medium shrink-0"
                  >
                    Herunterladen
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Info-Box */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 space-y-1">
        <p className="text-xs font-semibold text-amber-800">Aufbewahrungspflicht</p>
        <p className="text-xs text-amber-700 leading-relaxed">
          DEP-Dateien sind gemäß § 132 BAO und RKSV 7 Jahre aufzubewahren.
          Der Server sichert automatisch, wenn die letzte Sicherung älter als 30 Tage ist.
          Zusätzlich solltest du die Dateien extern (NAS, Cloud) aufbewahren.
        </p>
      </div>
    </div>
  )
}
