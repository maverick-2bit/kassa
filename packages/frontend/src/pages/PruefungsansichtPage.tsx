import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ladePruefungsDaten, downloadPruefungDep7 } from '../lib/api'
import type { BelegResponse } from '@kassa/shared'
import { formatPreis, formatDatum } from '../lib/format'

const BELEGTYP_FARBE: Record<string, string> = {
  Barzahlungsbeleg: 'bg-green-100 text-green-700',
  Stornobeleg:      'bg-red-100 text-red-700',
  Startbeleg:       'bg-blue-100 text-blue-700',
  Nullbeleg:        'bg-panel-2 text-ink-muted',
  Monatsbeleg:      'bg-amber-100 text-amber-700',
  Jahresbeleg:      'bg-violet-100 text-violet-700',
}

function BelegTypBadge({ typ }: { typ: string }) {
  const farbe = BELEGTYP_FARBE[typ] ?? 'bg-panel-2 text-ink-muted'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${farbe}`}>
      {typ}
    </span>
  )
}

function BelegZeile({ beleg, onClick }: { beleg: BelegResponse; onClick: () => void }) {
  const gesamt = beleg.summeBarCent + beleg.summeKarteCent + beleg.summeSonstigeCent
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-panel-2 transition"
    >
      <span className="text-xs text-ink-subtle w-12 shrink-0 text-right">#{beleg.belegNummer}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <BelegTypBadge typ={beleg.belegTyp} />
          <span className="text-xs text-ink-muted">{formatDatum(beleg.belegDatum)}</span>
        </div>
      </div>
      <span className="text-sm font-medium text-ink shrink-0">
        {formatPreis(gesamt)}
      </span>
    </button>
  )
}

function BelegDetail({ beleg, onClose }: { beleg: BelegResponse; onClose: () => void }) {
  const positionen = (beleg.positionen ?? []) as Array<{
    bezeichnung: string; menge: number; einzelpreisBreutto: number; mwstSatz: string
  }>
  const gesamt = beleg.summeBarCent + beleg.summeKarteCent + beleg.summeSonstigeCent

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
      <div className="bg-panel rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="sticky top-0 bg-panel border-b border-line px-5 py-4 flex items-center justify-between">
          <div>
            <p className="font-semibold text-ink">Beleg #{beleg.belegNummer}</p>
            <p className="text-xs text-ink-muted">{formatDatum(beleg.belegDatum)}</p>
          </div>
          <button type="button" onClick={onClose} className="text-ink-subtle hover:text-ink-muted text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <BelegTypBadge typ={beleg.belegTyp} />

          {positionen.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Positionen</p>
              <div className="space-y-1">
                {positionen.map((p, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-ink">
                      {p.menge}× {p.bezeichnung}
                    </span>
                    <span className="text-ink font-medium">
                      {formatPreis(p.menge * p.einzelpreisBreutto)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-line pt-3 space-y-1">
            <div className="flex justify-between text-sm font-semibold">
              <span>Gesamt</span>
              <span>{formatPreis(gesamt)}</span>
            </div>
            {beleg.summeBarCent > 0 && (
              <div className="flex justify-between text-xs text-ink-muted">
                <span>Bar</span><span>{formatPreis(beleg.summeBarCent)}</span>
              </div>
            )}
            {beleg.summeKarteCent > 0 && (
              <div className="flex justify-between text-xs text-ink-muted">
                <span>Karte</span><span>{formatPreis(beleg.summeKarteCent)}</span>
              </div>
            )}
            {beleg.summeSonstigeCent > 0 && (
              <div className="flex justify-between text-xs text-ink-muted">
                <span>Sonstige</span><span>{formatPreis(beleg.summeSonstigeCent)}</span>
              </div>
            )}
          </div>

          <div className="border-t border-line pt-3 space-y-1">
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">RKSV-Signatur</p>
            <p className="text-xs text-ink-subtle font-mono break-all leading-relaxed">
              {beleg.maschinenlesbareCode}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function PruefungsansichtPage() {
  const { token } = useParams<{ token: string }>()
  const [ausgewaehlt, setAusgewaehlt] = useState<BelegResponse | null>(null)
  const [downloadLaeuft, setDownloadLaeuft] = useState(false)

  const query = useQuery({
    queryKey: ['pruefung', token],
    queryFn:  () => ladePruefungsDaten(token!),
    enabled:  !!token,
    retry:    false,
  })

  async function dep7Herunterladen() {
    if (!token) return
    setDownloadLaeuft(true)
    try {
      await downloadPruefungDep7(token)
    } catch {
      // Fehler stille ignorieren, UI zeigt keinen Spinner mehr
    } finally {
      setDownloadLaeuft(false)
    }
  }

  if (query.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-ink-muted">Prüfungsdaten werden geladen…</p>
      </div>
    )
  }

  if (query.isError) {
    const msg = query.error instanceof Error ? query.error.message : 'Unbekannter Fehler'
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-sm text-center space-y-3">
          <p className="text-4xl">🔒</p>
          <p className="text-lg font-semibold text-ink">Zugriff nicht möglich</p>
          <p className="text-sm text-ink-muted">{msg}</p>
        </div>
      </div>
    )
  }

  const daten = query.data!
  const gueltigBis = new Date(daten.token.gueltigBis)

  return (
    <div className="min-h-screen bg-panel-2">
      {/* Header */}
      <header className="bg-panel border-b border-line px-4 py-4">
        <div className="mx-auto max-w-3xl flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="font-semibold text-ink">
              Finanzprüfung — {daten.kasseBezeichnung ?? daten.kassenId}
            </p>
            <p className="text-xs text-ink-muted">
              Kassen-ID: {daten.kassenId} · Read-only · Gültig bis:{' '}
              {gueltigBis.toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' })}
            </p>
          </div>
          <button
            type="button"
            disabled={downloadLaeuft}
            onClick={dep7Herunterladen}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition"
          >
            {downloadLaeuft ? 'Lädt…' : 'DEP7 herunterladen'}
          </button>
        </div>
      </header>

      {/* Beleg-Liste */}
      <main className="mx-auto max-w-3xl px-4 py-6">
        <div className="bg-panel border border-line rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-line flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">
              {daten.belege.length} {daten.belege.length === 1 ? 'Beleg' : 'Belege'}
            </p>
            <p className="text-xs text-ink-subtle">Klick für Details</p>
          </div>
          {daten.belege.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-ink-subtle">
              Keine Belege vorhanden.
            </div>
          ) : (
            <div className="divide-y divide-line">
              {daten.belege.map(b => (
                <BelegZeile key={b.id} beleg={b} onClick={() => setAusgewaehlt(b)} />
              ))}
            </div>
          )}
        </div>
      </main>

      {ausgewaehlt && (
        <BelegDetail beleg={ausgewaehlt} onClose={() => setAusgewaehlt(null)} />
      )}
    </div>
  )
}
