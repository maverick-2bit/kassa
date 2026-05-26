import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BelegResponse, Kunde } from '@kassa/shared'
import { belegApi, druckerApi, kundeApi, kasseApi, type JahresbelegStatus } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { hasBerechtigung } from '../lib/auth'
import { formatPreis, formatDatum } from '../lib/format'
import { Modal } from '../components/ui/Modal'
import { Button } from '../components/ui/Button'
import { BonAnzeige } from '../components/BonAnzeige'

export function BelegePage() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()

  const [ausgewaehlt, setAusgewaehlt] = useState<BelegResponse | null>(null)
  const [stornoKandidat, setStornoKandidat] = useState<BelegResponse | null>(null)
  const [stornoGrund, setStornoGrund] = useState('')
  const [aktionsfehler, setAktionsfehler] = useState<string | null>(null)
  const [neuErzeugt, setNeuErzeugt] = useState<BelegResponse | null>(null)

  // Kunden-Filter
  const [filterKunde, setFilterKunde] = useState<Pick<Kunde, 'id' | 'bezeichnung'> | null>(null)

  const kasseStatus = useQuery({
    queryKey: ['kasse-status', identity.kasseId],
    queryFn:  () => kasseApi.getStatus(identity.kasseId),
    staleTime: 1000 * 60 * 10,   // 10 Minuten cachen
  })

  const jahresbelegStatus = useQuery({
    queryKey:  ['jahresbeleg-status', identity.kasseId],
    queryFn:   () => kasseApi.getJahresbelegStatus(identity.kasseId),
    staleTime: 1000 * 60 * 5,
  })

  const liste = useQuery({
    queryKey: ['belege', identity.kasseId, filterKunde?.id],
    queryFn:  () => belegApi.list(identity.kasseId, 200, filterKunde?.id),
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
      setStornoGrund('')
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
    onSuccess:  (beleg) => {
      setNeuErzeugt(beleg)
      invalidate()
      // Jahresbeleg-Status sofort neu laden → Banner verschwindet
      void queryClient.invalidateQueries({ queryKey: ['jahresbeleg-status', identity.kasseId] })
    },
    onError: (err) => setAktionsfehler(err instanceof Error ? err.message : String(err)),
  })

  // -------------------------------------------------------------------------
  // Fälligkeit prüfen
  // -------------------------------------------------------------------------

  const faelligkeit = useMemo(() => berechneFaelligkeit(liste.data ?? []), [liste.data])

  // IDs aller Barzahlungsbelege die bereits einen Stornobeleg haben
  const bereitsStornoiert = useMemo(() => {
    const ids = new Set<string>()
    for (const b of liste.data ?? []) {
      if (b.belegTyp === 'Stornobeleg' && b.verweisBelegId) {
        ids.add(b.verweisBelegId)
      }
    }
    return ids
  }, [liste.data])

  const kannStornieren = hasBerechtigung('belege.stornieren')

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      {/* Kopfzeile */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Belege</h1>
        <p className="mt-1 text-sm text-gray-500">
          Alle Belege dieser Kasse, RKSV-Spezialbelege, Storno
        </p>
      </div>

      {/* SEE-Zertifikats-Banner */}
      {kasseStatus.data?.seeAbgelaufen && (
        <Banner
          farbe="red"
          titel="SEE-Zertifikat abgelaufen"
          beschreibung={`Das Sicherheitseinrichtungs-Zertifikat ist seit dem ${new Date(kasseStatus.data.seeGueltigBis).toLocaleDateString('de-AT')} abgelaufen. Die Kasse kann keine Belege mehr ausstellen. Bitte Kasse neu einrichten.`}
        />
      )}
      {kasseStatus.data && !kasseStatus.data.seeAbgelaufen && kasseStatus.data.seeRestTage <= 90 && (
        <Banner
          farbe={kasseStatus.data.seeRestTage <= 30 ? 'red' : 'amber'}
          titel={`SEE-Zertifikat läuft in ${kasseStatus.data.seeRestTage} Tagen ab`}
          beschreibung={`Das Sicherheitseinrichtungs-Zertifikat ist bis ${new Date(kasseStatus.data.seeGueltigBis).toLocaleDateString('de-AT')} gültig. Bitte rechtzeitig Kasse neu einrichten, um Betriebsunterbrechungen zu vermeiden.`}
        />
      )}

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
      {jahresbelegStatus.data?.jahresbelegFaellig && (
        <JahresbelegBanner
          status={jahresbelegStatus.data}
          isPending={jahresbelegMutation.isPending}
          onErstellen={() => jahresbelegMutation.mutate()}
        />
      )}

      {/* Spezialbelege */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 p-4 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">RKSV-Spezialbelege</h2>

        {/* Kontrollbeleg — primäre Aktion */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-blue-900">Kontrollbeleg (Nullbeleg)</p>
            <p className="text-xs text-blue-700 mt-0.5">
              Nullbeleg gem. RKSV § 8 — wird signiert, gedruckt und in die Signaturkette eingereiht.
              Bei Behördenkontrolle auf Verlangen sofort erstellen.
            </p>
          </div>
          <Button onClick={() => nullbelegMutation.mutate()} loading={nullbelegMutation.isPending}>
            Kontrollbeleg erstellen
          </Button>
        </div>

        {/* Monats- und Jahresbeleg — sekundär */}
        <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-100">
          <Button variant="secondary" onClick={() => monatsbelegMutation.mutate()} loading={monatsbelegMutation.isPending}>
            Monatsbeleg erstellen
          </Button>
          <Button variant="secondary" onClick={() => jahresbelegMutation.mutate()} loading={jahresbelegMutation.isPending}>
            Jahresbeleg erstellen
          </Button>
        </div>
      </div>

      {aktionsfehler && !stornoKandidat && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {aktionsfehler}
        </div>
      )}

      {/* Kunden-Filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[220px] max-w-sm">
          <KundeFilterSuche
            value={filterKunde}
            onChange={setFilterKunde}
          />
        </div>
        {filterKunde && (
          <p className="text-sm text-gray-500">
            Belege für <strong className="text-gray-900">{filterKunde.bezeichnung}</strong>
          </p>
        )}
      </div>

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
                <th className="px-4 py-2 font-semibold">Kunde</th>
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
                  <td className="px-4 py-2 text-gray-600 cursor-pointer max-w-[180px]" onClick={() => setAusgewaehlt(b)}>
                    {b.kunde ? (
                      <button
                        type="button"
                        className="text-left"
                        onClick={(e) => {
                          e.stopPropagation()
                          setFilterKunde({ id: b.kunde!.id, bezeichnung: b.kunde!.bezeichnung })
                        }}
                        title={`Nach ${b.kunde.bezeichnung} filtern`}
                      >
                        <span className="text-xs font-medium text-brand-700 hover:text-brand-900 hover:underline truncate block max-w-[160px]">
                          {b.kunde.bezeichnung}
                        </span>
                      </button>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
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
                    {b.belegTyp === 'Barzahlungsbeleg' && kannStornieren && (
                      bereitsStornoiert.has(b.id) ? (
                        <span className="text-xs text-gray-400 italic whitespace-nowrap">storniert</span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setStornoKandidat(b); setStornoGrund(''); setAktionsfehler(null) }}
                          className="text-xs text-red-600 hover:underline whitespace-nowrap"
                        >
                          Stornieren
                        </button>
                      )
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
        onClose={() => { setStornoKandidat(null); setStornoGrund('') }}
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
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Storno-Grund <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={stornoGrund}
                onChange={(e) => setStornoGrund(e.target.value)}
                maxLength={200}
                placeholder="z. B. Falscheingabe, Kundenwunsch …"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              />
            </div>
            {aktionsfehler && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {aktionsfehler}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2 border-t border-gray-200">
              <Button variant="secondary" onClick={() => { setStornoKandidat(null); setStornoGrund('') }}>
                Abbrechen
              </Button>
              <Button
                onClick={() => stornoMutation.mutate({
                  kasseId:        identity.kasseId,
                  verweisBelegId: stornoKandidat.id,
                  ...(stornoGrund.trim() && { grund: stornoGrund.trim() }),
                })}
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
        {neuErzeugt && (
          <div className="space-y-4">
            {neuErzeugt.belegTyp === 'Jahresbeleg' && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2">
                <div className="flex items-start gap-2">
                  <svg className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
                  </svg>
                  <div>
                    <p className="text-sm font-semibold text-amber-800">
                      Jahresbeleg — Prüfung gesetzlich erforderlich (RKSV § 8)
                    </p>
                    <p className="text-sm text-amber-700 mt-1">
                      Dieser Jahresbeleg muss mit der <strong>FinanzOnline App der BMF</strong> geprüft werden.
                      Bitte den ausgedruckten QR-Code mit der App scannen und die Prüfung durchführen.
                    </p>
                    <ol className="mt-2 text-xs text-amber-700 space-y-1 list-decimal list-inside">
                      <li>BMF FinanzOnline App öffnen (Android / iOS)</li>
                      <li>„Belegcheck" wählen</li>
                      <li>QR-Code auf dem ausgedruckten Jahresbeleg scannen</li>
                      <li>Prüfergebnis auf „OK" bestätigen</li>
                    </ol>
                  </div>
                </div>
              </div>
            )}
            <BonAnzeige beleg={neuErzeugt} codeAufgeklappt={neuErzeugt.belegTyp === 'Jahresbeleg'} />
          </div>
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hilfs-Komponenten
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Kunden-Filter-Picker (inline, ohne "Neu anlegen")
// ---------------------------------------------------------------------------

function KundeFilterSuche({
  value,
  onChange,
}: {
  value:    Pick<Kunde, 'id' | 'bezeichnung'> | null
  onChange: (k: Pick<Kunde, 'id' | 'bezeichnung'> | null) => void
}) {
  const [suche,      setSuche]      = useState('')
  const [ergebnisse, setErgebnisse] = useState<Kunde[]>([])
  const [offen,      setOffen]      = useState(false)
  const [laedt,      setLaedt]      = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOffen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  useEffect(() => {
    if (!offen) return
    const t = setTimeout(async () => {
      setLaedt(true)
      try {
        const res = await kundeApi.list({ ...(suche ? { suche } : {}), limit: 10 })
        setErgebnisse(res)
      } finally {
        setLaedt(false)
      }
    }, 200)
    return () => clearTimeout(t)
  }, [suche, offen])

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
        <svg className="h-4 w-4 text-brand-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-5.477-3.718M9 20H4v-2a4 4 0 015.477-3.718m0 0A5.002 5.002 0 0112 15a5.002 5.002 0 012.523.282m-5.046 0A5.002 5.002 0 0112 10a5 5 0 015 5" />
        </svg>
        <span className="font-medium text-brand-800 flex-1 truncate">{value.bezeichnung}</span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-brand-400 hover:text-red-500 text-lg leading-none px-0.5 shrink-0"
          title="Filter zurücksetzen"
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
        </svg>
        <input
          type="text"
          placeholder="Nach Kunde filtern…"
          value={suche}
          onChange={e => { setSuche(e.target.value); setOffen(true) }}
          onFocus={() => setOffen(true)}
          className="w-full rounded-md border border-gray-300 pl-9 pr-3 py-2 text-sm
                     focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
        />
      </div>
      {offen && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-md border border-gray-200 bg-white shadow-lg max-h-48 overflow-y-auto">
          {laedt ? (
            <p className="px-3 py-2 text-xs text-gray-400">Suche…</p>
          ) : ergebnisse.length === 0 ? (
            <p className="px-3 py-2 text-xs text-gray-400">Keine Kunden gefunden</p>
          ) : (
            ergebnisse.map(k => (
              <button
                key={k.id}
                type="button"
                onClick={() => { onChange({ id: k.id, bezeichnung: k.bezeichnung }); setOffen(false); setSuche('') }}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm border-b border-gray-100 last:border-0"
              >
                <span className="font-medium text-gray-900">{k.bezeichnung}</span>
                {k.email && <span className="ml-2 text-xs text-gray-500">{k.email}</span>}
                <span className="ml-2 text-xs text-gray-400">#{k.nummer}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

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
// Jahresbeleg-Banner (Backend-gestützt, zuverlässig)
// ---------------------------------------------------------------------------

function JahresbelegBanner({
  status,
  isPending,
  onErstellen,
}: {
  status:      JahresbelegStatus
  isPending:   boolean
  onErstellen: () => void
}) {
  // Wie viele Tage sind seit dem 1. Januar vergangen?
  const startDesJahres = new Date(status.jahr, 0, 1)
  const tageSeitJahresbeginn = Math.floor(
    (Date.now() - startDesJahres.getTime()) / (1000 * 60 * 60 * 24)
  )
  // Erste Woche: amber (Erinnerung), danach: rot (kritisch)
  const kritisch = tageSeitJahresbeginn > 7

  return (
    <Banner
      farbe={kritisch ? 'red' : 'amber'}
      titel={
        kritisch
          ? `Jahresbeleg ${status.jahr} überfällig`
          : `Jahresbeleg ${status.jahr} fällig`
      }
      beschreibung={
        kritisch
          ? `Der Jahresbeleg für ${status.jahr} wurde noch nicht erstellt (${tageSeitJahresbeginn} Tage seit Jahresbeginn). Pflicht gemäß RKSV § 8 Abs. 3 — bitte sofort nachholen.`
          : `Bitte erstelle den Jahresbeleg für ${status.jahr}. Er muss zu Jahresbeginn erstellt und mit der BMF FinanzOnline App geprüft werden (QR-Code scannen).`
      }
      aktion={
        <Button onClick={onErstellen} loading={isPending}>
          Jahresbeleg {status.jahr} erstellen
        </Button>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Fälligkeits-Logik (Monatsbeleg — bleibt frontend-seitig aus der Belegeliste)
// ---------------------------------------------------------------------------

interface Faelligkeit {
  monatsbelegFaellig:    boolean
  letzterMonatsbeleg?:   string
}

function berechneFaelligkeit(belege: BelegResponse[]): Faelligkeit {
  const monatsbelege  = belege.filter(b => b.belegTyp === 'Monatsbeleg')
  const jahresbelege  = belege.filter(b => b.belegTyp === 'Jahresbeleg')
  const startbeleg    = belege.find(b => b.belegTyp === 'Startbeleg')

  const letzterMonatsbeleg = monatsbelege[0]?.belegDatum
  const referenzMonat      = letzterMonatsbeleg
    ?? jahresbelege[0]?.belegDatum
    ?? startbeleg?.belegDatum

  const monatsbelegFaellig = referenzMonat
    ? monateZwischen(new Date(referenzMonat), new Date()) >= 1
    : false

  return {
    monatsbelegFaellig,
    ...(letzterMonatsbeleg && { letzterMonatsbeleg }),
  }
}

function monateZwischen(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
}
