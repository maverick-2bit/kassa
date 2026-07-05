import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { KassenbuchResponse } from '@kassa/shared'
import { KASSENBUCH_TYP_LABELS } from '@kassa/shared'
import { tagesabschlussApi, kassenbuchApi, mandantApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { getAuth, hasBerechtigung } from '../lib/auth'
import { formatPreis } from '../lib/format'
import { downloadZBonPdf } from '../lib/pdf'
import { Button } from '../components/ui/Button'

/** YYYY-MM-DD für heute in Wiener Lokalzeit */
function heuteLokal(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
}

export function TagesabschlussPage() {
  const identity   = getKasseIdentity()!
  const auth       = getAuth()!
  const [datum, setDatum] = useState<string>(heuteLokal())
  const [druckfehler, setDruckfehler]   = useState<string | null>(null)
  const [druckErfolg, setDruckErfolg]   = useState(false)
  const [pdfLaedt, setPdfLaedt]         = useState(false)
  const [pdfFehler, setPdfFehler]       = useState<string | null>(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tagesabschluss', identity.kasseId, datum],
    queryFn:  () => tagesabschlussApi.get(identity.kasseId, datum),
    enabled:  !!datum,
  })

  const kassenbuchQuery = useQuery({
    queryKey: ['kassenbuch-tag', identity.kasseId, datum],
    queryFn:  () => kassenbuchApi.liste(identity.kasseId, datum, datum),
    enabled:  !!datum,
  })

  const stammdatenQuery = useQuery({
    queryKey: ['mandant-stammdaten'],
    queryFn:  mandantApi.getStammdaten,
    staleTime: 10 * 60_000,
  })

  const druckenMutation = useMutation({
    mutationFn: () => tagesabschlussApi.drucken(identity.kasseId, datum),
    onSuccess:  () => { setDruckErfolg(true); setDruckfehler(null) },
    onError:    (err) => {
      setDruckfehler(err instanceof Error ? err.message : String(err))
      setDruckErfolg(false)
    },
  })

  async function pdfHerunterladen() {
    if (!data) return
    setPdfLaedt(true)
    setPdfFehler(null)
    try {
      // Kassenbezeichnung aus den im JWT gespeicherten Kassen-Infos holen
      const kasseInfo  = auth.kassen.find(k => k.id === identity.kasseId)
      const bezeichnung = kasseInfo?.bezeichnung ?? kasseInfo?.kassenId ?? identity.kasseId
      await downloadZBonPdf(
        data,
        auth.mandant.firmenname,
        bezeichnung,
        kassenbuchQuery.data,
        stammdatenQuery.data?.belegFusstext,
      )
    } catch (err) {
      setPdfFehler(err instanceof Error ? err.message : 'PDF-Erstellung fehlgeschlagen')
    } finally {
      setPdfLaedt(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8 space-y-6">
      {/* Kopfzeile */}
      <div>
        <h1 className="text-2xl font-bold text-ink">Tagesabschluss (Z-Bon)</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Umsatzauswertung nach Zahlungsart und Steuersatz für einen Kassentag
        </p>
      </div>

      {/* Datumsauswahl */}
      <div className="rounded-lg bg-panel shadow-sm border border-line p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-medium text-ink mb-1">
              Datum
            </label>
            <input
              type="date"
              value={datum}
              max={heuteLokal()}
              onChange={(e) => {
                setDatum(e.target.value)
                setDruckErfolg(false)
                setDruckfehler(null)
              }}
              className="rounded-md border border-line-strong px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
            />
          </div>
          <Button variant="secondary" onClick={() => void refetch()} loading={isLoading}>
            Aktualisieren
          </Button>
        </div>
      </div>

      {/* Fehler / Laden */}
      {isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error instanceof Error ? error.message : 'Fehler beim Laden'}
        </div>
      )}

      {/* Ergebnis */}
      {data && (
        <div className="space-y-4">
          {/* Zusammenfassung */}
          <div className="rounded-lg bg-panel shadow-sm border border-line overflow-hidden">
            <div className="px-4 py-3 bg-panel-2 border-b border-line">
              <h2 className="text-sm font-semibold text-ink uppercase tracking-wide">
                Übersicht — {formatDatumAnzeige(datum)}
              </h2>
            </div>

            {data.anzahlBarzahlungsbelege === 0 && data.anzahlStornobelege === 0 ? (
              <div className="p-6 text-center text-sm text-ink-muted">
                Keine Belege an diesem Tag.
              </div>
            ) : (
              <div className="divide-y divide-line">
                {/* Belegzahlen */}
                <div className="px-4 py-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Kennzahl label="Barzahlungsbelege" wert={String(data.anzahlBarzahlungsbelege)} />
                  {data.anzahlStornobelege > 0 && (
                    <Kennzahl label="Stornobelege" wert={String(data.anzahlStornobelege)} rot />
                  )}
                  <Kennzahl
                    label="Netto-Umsatz"
                    wert={formatPreis(data.nettoUmsatzCent)}
                    gross
                    rot={data.nettoUmsatzCent < 0}
                  />
                </div>

                {/* Zahlungsarten */}
                <div className="px-4 py-3">
                  <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
                    Zahlungsarten
                  </h3>
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-line">
                      {data.barCent !== 0 && (
                        <ZeileZweiSpaltig
                          label="Bar"
                          wert={formatPreis(data.barCent)}
                          negativ={data.barCent < 0}
                        />
                      )}
                      {data.karteCent !== 0 && (
                        <ZeileZweiSpaltig
                          label="Karte"
                          wert={formatPreis(data.karteCent)}
                          negativ={data.karteCent < 0}
                        />
                      )}
                      {data.sonstigCent !== 0 && (
                        <ZeileZweiSpaltig
                          label="Sonstige"
                          wert={formatPreis(data.sonstigCent)}
                          negativ={data.sonstigCent < 0}
                        />
                      )}
                      <tr className="font-semibold border-t border-line">
                        <td className="py-2 text-ink">Gesamt</td>
                        <td className={`py-2 text-right font-mono ${data.nettoUmsatzCent < 0 ? 'text-red-700' : 'text-ink'}`}>
                          {formatPreis(data.nettoUmsatzCent)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* MwSt-Aufteilung */}
                {data.mwst.length > 0 && (
                  <div className="px-4 py-3">
                    <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
                      USt-Aufteilung
                    </h3>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-ink-subtle">
                          <th className="text-left pb-1 font-normal">Steuersatz</th>
                          <th className="text-right pb-1 font-normal">Brutto</th>
                          <th className="text-right pb-1 font-normal">Netto</th>
                          <th className="text-right pb-1 font-normal">USt</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {data.mwst.map((z) => (
                          <tr key={z.satzKey}>
                            <td className="py-1.5 text-ink">{z.label}</td>
                            <td className="py-1.5 text-right font-mono text-ink">
                              {formatPreis(z.bruttoCent)}
                            </td>
                            <td className="py-1.5 text-right font-mono text-ink-muted">
                              {formatPreis(z.nettoCent)}
                            </td>
                            <td className="py-1.5 text-right font-mono text-ink-muted">
                              {formatPreis(z.ustCent)}
                            </td>
                          </tr>
                        ))}
                        {data.mwst.length > 1 && (
                          <tr className="font-semibold border-t border-line">
                            <td className="py-1.5 text-ink">Gesamt</td>
                            <td className="py-1.5 text-right font-mono text-ink">
                              {formatPreis(data.mwst.reduce((s, z) => s + z.bruttoCent, 0))}
                            </td>
                            <td className="py-1.5 text-right font-mono text-ink">
                              {formatPreis(data.mwst.reduce((s, z) => s + z.nettoCent, 0))}
                            </td>
                            <td className="py-1.5 text-right font-mono text-ink">
                              {formatPreis(data.mwst.reduce((s, z) => s + z.ustCent, 0))}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Kassenbuch für diesen Tag */}
          {kassenbuchQuery.data && kassenbuchQuery.data.buchungen.length > 0 && (
            <KassenbuchAbschnitt kb={kassenbuchQuery.data} />
          )}

          {/* Aktionen */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* PDF herunterladen — immer sichtbar wenn Daten vorhanden */}
            <Button
              variant="secondary"
              onClick={() => void pdfHerunterladen()}
              loading={pdfLaedt}
              disabled={data.anzahlBarzahlungsbelege === 0 && data.anzahlStornobelege === 0}
            >
              <svg className="h-4 w-4 mr-1.5 inline-block" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
              PDF herunterladen
            </Button>

            {/* Z-Bon drucken — nur mit Einstellungs-Berechtigung (Drucker nötig) */}
            {hasBerechtigung('einstellungen') && (
              <Button
                onClick={() => {
                  setDruckErfolg(false)
                  setDruckfehler(null)
                  druckenMutation.mutate()
                }}
                loading={druckenMutation.isPending}
                disabled={data.anzahlBarzahlungsbelege === 0 && data.anzahlStornobelege === 0}
              >
                Z-Bon drucken
              </Button>
            )}

            {druckErfolg && <span className="text-sm text-green-700">✓ Z-Bon gedruckt</span>}
            {druckfehler && <span className="text-sm text-red-700">{druckfehler}</span>}
            {pdfFehler   && <span className="text-sm text-red-700">{pdfFehler}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hilfs-Komponenten
// ---------------------------------------------------------------------------

function Kennzahl({ label, wert, gross, rot }: {
  label: string
  wert:  string
  gross?: boolean
  rot?:   boolean
}) {
  return (
    <div>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`font-mono font-semibold ${gross ? 'text-xl' : 'text-base'} ${rot ? 'text-red-700' : 'text-ink'}`}>
        {wert}
      </p>
    </div>
  )
}

function ZeileZweiSpaltig({ label, wert, negativ }: {
  label:   string
  wert:    string
  negativ?: boolean
}) {
  return (
    <tr>
      <td className="py-1.5 text-ink">{label}</td>
      <td className={`py-1.5 text-right font-mono ${negativ ? 'text-red-700' : 'text-ink'}`}>
        {wert}
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Kassenbuch-Abschnitt für den gewählten Tag
// ---------------------------------------------------------------------------

function KassenbuchAbschnitt({ kb }: { kb: KassenbuchResponse }) {
  return (
    <div className="rounded-lg bg-panel shadow-sm border border-line overflow-hidden">
      <div className="px-4 py-3 bg-panel-2 border-b border-line flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink uppercase tracking-wide">
          Kassenbuch
        </h2>
        <div className="flex gap-4 text-xs">
          {kb.einlagenCent > 0 && (
            <span className="text-green-700">
              Einlagen: +{formatPreis(kb.einlagenCent)}
            </span>
          )}
          {kb.entnahmenCent > 0 && (
            <span className="text-red-700">
              Entnahmen: −{formatPreis(kb.entnahmenCent)}
            </span>
          )}
          <span className={`font-semibold ${kb.saldoCent >= 0 ? 'text-ink' : 'text-red-700'}`}>
            Saldo: {kb.saldoCent >= 0 ? '+' : ''}{formatPreis(kb.saldoCent)}
          </span>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-panel-2 border-b border-line">
          <tr className="text-xs text-ink-muted">
            <th className="px-4 py-2 text-left font-semibold">Art</th>
            <th className="px-4 py-2 text-left font-semibold">Grund</th>
            <th className="px-4 py-2 text-left font-semibold">Benutzer</th>
            <th className="px-4 py-2 text-right font-semibold">Betrag</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {kb.buchungen.map(b => (
            <tr key={b.id} className="hover:bg-panel-2">
              <td className="px-4 py-2">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                  b.typ === 'einlage'
                    ? 'bg-green-100 text-green-800'
                    : 'bg-red-100 text-red-800'
                }`}>
                  {KASSENBUCH_TYP_LABELS[b.typ]}
                </span>
              </td>
              <td className="px-4 py-2 text-ink">{b.grund ?? <span className="text-ink-subtle">—</span>}</td>
              <td className="px-4 py-2 text-ink-muted text-xs">{b.userName ?? '—'}</td>
              <td className={`px-4 py-2 text-right font-mono font-semibold ${
                b.typ === 'einlage' ? 'text-green-700' : 'text-red-700'
              }`}>
                {b.typ === 'einlage' ? '+' : '−'}{formatPreis(b.betragCent)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatDatumAnzeige(datum: string): string {
  // datum = YYYY-MM-DD
  const [y, m, d] = datum.split('-')
  return `${d}.${m}.${y}`
}
