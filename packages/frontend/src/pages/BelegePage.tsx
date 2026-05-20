import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BelegResponse } from '@kassa/shared'
import { belegApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis, formatDatum } from '../lib/format'
import { Modal } from '../components/ui/Modal'
import { Button } from '../components/ui/Button'
import { BonAnzeige } from '../components/BonAnzeige'

export function BelegePage() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()

  const [ausgewaehlt, setAusgewaehlt] = useState<BelegResponse | null>(null)
  const [stornoKandidat, setStornoKandidat] = useState<BelegResponse | null>(null)
  const [aktionsfehler, setAktionsfehler] = useState<string | null>(null)
  const [neuErzeugt, setNeuErzeugt] = useState<BelegResponse | null>(null)

  const liste = useQuery({
    queryKey: ['belege', identity.kasseId],
    queryFn:  () => belegApi.list(identity.kasseId, 200),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['belege', identity.kasseId] })

  // -------------------------------------------------------------------------
  // Mutationen
  // -------------------------------------------------------------------------

  const stornoMutation = useMutation({
    mutationFn: belegApi.storno,
    onSuccess:  (beleg) => {
      setNeuErzeugt(beleg)
      setStornoKandidat(null)
      setAktionsfehler(null)
      invalidate()
    },
    onError: (err) => setAktionsfehler(err instanceof Error ? err.message : String(err)),
  })

  const nullbelegMutation = useMutation({
    mutationFn: () => belegApi.nullbeleg({ kasseId: identity.kasseId }),
    onSuccess:  (beleg) => { setNeuErzeugt(beleg); invalidate() },
    onError: (err) => setAktionsfehler(err instanceof Error ? err.message : String(err)),
  })

  const monatsbelegMutation = useMutation({
    mutationFn: () => belegApi.monatsbeleg({ kasseId: identity.kasseId }),
    onSuccess:  (beleg) => { setNeuErzeugt(beleg); invalidate() },
    onError: (err) => setAktionsfehler(err instanceof Error ? err.message : String(err)),
  })

  const jahresbelegMutation = useMutation({
    mutationFn: () => belegApi.jahresbeleg({ kasseId: identity.kasseId }),
    onSuccess:  (beleg) => { setNeuErzeugt(beleg); invalidate() },
    onError: (err) => setAktionsfehler(err instanceof Error ? err.message : String(err)),
  })

  // -------------------------------------------------------------------------
  // Fälligkeit prüfen
  // -------------------------------------------------------------------------

  const faelligkeit = useMemo(() => berechneFaelligkeit(liste.data ?? []), [liste.data])

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      {/* Kopfzeile */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Belege</h1>
        <p className="mt-1 text-sm text-gray-500">
          Alle Belege dieser Kasse, RKSV-Spezialbelege, Storno
        </p>
      </div>

      {/* Fälligkeits-Banner */}
      {faelligkeit.monatsbelegFaellig && (
        <Banner
          farbe="amber"
          titel="Monatsbeleg fällig"
          beschreibung={`Der letzte Monatsbeleg ist älter als 1 Monat${
            faelligkeit.letzterMonatsbeleg
              ? ` (zuletzt am ${formatDatum(faelligkeit.letzterMonatsbeleg)})`
              : ''
          }. Bitte jetzt erstellen.`}
          aktion={
            <Button onClick={() => monatsbelegMutation.mutate()} loading={monatsbelegMutation.isPending}>
              Monatsbeleg jetzt erstellen
            </Button>
          }
        />
      )}
      {faelligkeit.jahresbelegFaellig && (
        <Banner
          farbe="red"
          titel="Jahresbeleg fällig"
          beschreibung="Das Jahr ist abgelaufen, aber es wurde noch kein Jahresbeleg erstellt. Pflicht nach RKSV § 8."
          aktion={
            <Button onClick={() => jahresbelegMutation.mutate()} loading={jahresbelegMutation.isPending}>
              Jahresbeleg erstellen
            </Button>
          }
        />
      )}

      {/* Spezialbelege */}
      <details className="rounded-lg bg-white shadow-sm border border-gray-200">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50">
          Spezialbelege (Nullbeleg, Monatsbeleg, Jahresbeleg)
        </summary>
        <div className="border-t border-gray-200 px-4 py-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => nullbelegMutation.mutate()} loading={nullbelegMutation.isPending}>
            Nullbeleg erstellen
          </Button>
          <Button variant="secondary" onClick={() => monatsbelegMutation.mutate()} loading={monatsbelegMutation.isPending}>
            Monatsbeleg erstellen
          </Button>
          <Button variant="secondary" onClick={() => jahresbelegMutation.mutate()} loading={jahresbelegMutation.isPending}>
            Jahresbeleg erstellen
          </Button>
        </div>
      </details>

      {aktionsfehler && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {aktionsfehler}
        </div>
      )}

      {/* Tabelle */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        {liste.isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">Wird geladen…</div>
        ) : liste.isError ? (
          <div className="p-8 text-center text-sm text-red-600">
            Fehler: {liste.error instanceof Error ? liste.error.message : 'Unbekannt'}
          </div>
        ) : liste.data && liste.data.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-gray-500">Noch keine Belege.</p>
            <a href="/kasse" className="mt-2 inline-block text-sm text-brand-600 hover:underline">Zur Kasse →</a>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Nr.</th>
                <th className="px-4 py-2 font-semibold">Datum</th>
                <th className="px-4 py-2 font-semibold">Typ</th>
                <th className="px-4 py-2 font-semibold">Positionen</th>
                <th className="px-4 py-2 font-semibold text-right">Bar</th>
                <th className="px-4 py-2 font-semibold text-right">Karte</th>
                <th className="px-4 py-2 font-semibold text-right">Gesamt</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {liste.data?.map((b) => (
                <tr key={b.id} className="hover:bg-brand-50/40">
                  <td className="px-4 py-2 font-mono font-medium text-gray-900 cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    #{b.belegNummer}
                  </td>
                  <td className="px-4 py-2 text-gray-600 cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    {formatDatum(b.belegDatum)}
                  </td>
                  <td className="px-4 py-2 cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    <BelegTypBadge typ={b.belegTyp} />
                  </td>
                  <td className="px-4 py-2 text-gray-600 cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    {b.positionen.length}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-gray-700 cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    {b.summeBarCent !== 0 ? formatPreis(b.summeBarCent) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-gray-700 cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    {b.summeKarteCent !== 0 ? formatPreis(b.summeKarteCent) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-semibold text-gray-900 cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    {formatPreis(b.gesamtbetragCent)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {b.belegTyp === 'Barzahlungsbeleg' && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setStornoKandidat(b); setAktionsfehler(null) }}
                        className="text-xs text-red-600 hover:underline whitespace-nowrap"
                      >
                        Stornieren
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail-Modal */}
      <Modal
        open={!!ausgewaehlt}
        onClose={() => setAusgewaehlt(null)}
        title={`Beleg #${ausgewaehlt?.belegNummer}`}
        size="lg"
      >
        {ausgewaehlt && <BonAnzeige beleg={ausgewaehlt} />}
      </Modal>

      {/* Storno-Bestätigung */}
      <Modal
        open={!!stornoKandidat}
        onClose={() => setStornoKandidat(null)}
        title={`Beleg #${stornoKandidat?.belegNummer} stornieren?`}
      >
        {stornoKandidat && (
          <div className="space-y-4">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Es wird ein <strong>Stornobeleg</strong> mit negierten Beträgen erstellt.
              Diese Aktion kann nicht rückgängig gemacht werden.
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">Original-Beleg</dt><dd className="font-mono">#{stornoKandidat.belegNummer}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Datum</dt><dd>{formatDatum(stornoKandidat.belegDatum)}</dd></div>
              <div className="flex justify-between font-medium"><dt>Betrag</dt><dd className="font-mono">{formatPreis(stornoKandidat.gesamtbetragCent)}</dd></div>
            </dl>
            <div className="flex justify-end gap-2 pt-2 border-t border-gray-200">
              <Button variant="secondary" onClick={() => setStornoKandidat(null)}>Abbrechen</Button>
              <Button
                onClick={() => stornoMutation.mutate({ kasseId: identity.kasseId, verweisBelegId: stornoKandidat.id })}
                loading={stornoMutation.isPending}
              >
                Storno bestätigen
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Erfolgs-Modal für neu erstellte Belege */}
      <Modal
        open={!!neuErzeugt}
        onClose={() => setNeuErzeugt(null)}
        title={`${neuErzeugt?.belegTyp} #${neuErzeugt?.belegNummer} erstellt`}
        size="lg"
      >
        {neuErzeugt && <BonAnzeige beleg={neuErzeugt} />}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hilfs-Komponenten
// ---------------------------------------------------------------------------

function BelegTypBadge({ typ }: { typ: string }) {
  const farbe =
    typ === 'Barzahlungsbeleg' ? 'bg-gray-100 text-gray-700' :
    typ === 'Stornobeleg'      ? 'bg-red-100 text-red-700' :
    typ === 'Nullbeleg'        ? 'bg-blue-50 text-blue-700' :
    typ === 'Monatsbeleg'      ? 'bg-amber-50 text-amber-800' :
    typ === 'Jahresbeleg'      ? 'bg-purple-50 text-purple-700' :
    typ === 'Startbeleg'       ? 'bg-green-50 text-green-700' :
    'bg-gray-100 text-gray-700'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${farbe}`}>
      {typ}
    </span>
  )
}

function Banner({ farbe, titel, beschreibung, aktion }: {
  farbe: 'amber' | 'red'
  titel: string
  beschreibung: string
  aktion?: React.ReactNode
}) {
  const klasse = farbe === 'red'
    ? 'border-red-200 bg-red-50 text-red-900'
    : 'border-amber-200 bg-amber-50 text-amber-900'
  return (
    <div className={`rounded-lg border ${klasse} p-4 flex items-start gap-3 sm:items-center flex-wrap`}>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm">{titel}</p>
        <p className="text-sm mt-0.5">{beschreibung}</p>
      </div>
      {aktion}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fälligkeits-Logik
// ---------------------------------------------------------------------------

interface Faelligkeit {
  monatsbelegFaellig:    boolean
  jahresbelegFaellig:    boolean
  letzterMonatsbeleg?:   string
  letzterJahresbeleg?:   string
}

function berechneFaelligkeit(belege: BelegResponse[]): Faelligkeit {
  const monatsbelege  = belege.filter(b => b.belegTyp === 'Monatsbeleg')
  const jahresbelege  = belege.filter(b => b.belegTyp === 'Jahresbeleg')
  const startbeleg    = belege.find(b => b.belegTyp === 'Startbeleg')

  const letzterMonatsbeleg = monatsbelege[0]?.belegDatum
  const letzterJahresbeleg = jahresbelege[0]?.belegDatum

  const referenzMonat = letzterMonatsbeleg ?? letzterJahresbeleg ?? startbeleg?.belegDatum
  const referenzJahr  = letzterJahresbeleg ?? startbeleg?.belegDatum

  const now = new Date()

  const monatsbelegFaellig = referenzMonat
    ? monateZwischen(new Date(referenzMonat), now) >= 1
    : false

  const jahresbelegFaellig = referenzJahr
    ? new Date(referenzJahr).getFullYear() < now.getFullYear()
    : false

  return {
    monatsbelegFaellig,
    jahresbelegFaellig,
    ...(letzterMonatsbeleg && { letzterMonatsbeleg }),
    ...(letzterJahresbeleg && { letzterJahresbeleg }),
  }
}

function monateZwischen(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
}
