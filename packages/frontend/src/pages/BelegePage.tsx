import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import type { BelegListeEintrag, BelegResponse, Kunde, KasseListeItem } from '@kassa/shared'
import { belegApi, druckerApi, emailApi, kundeApi, kasseApi, ApiError, type JahresbelegStatus } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { getAuth, hasBerechtigung } from '../lib/auth'
import { formatPreis, formatDatum } from '../lib/format'
import { druckeRechnung } from '../lib/rechnung'
import { merkeZurueckgeholt, positionenAusBeleg } from '../lib/zurueckgeholt'
import { Modal } from '../components/ui/Modal'
import { Button } from '../components/ui/Button'
import { BonAnzeige } from '../components/BonAnzeige'
import { AusgabeDialog } from '../components/AusgabeDialog'

const SEITENGROESSE = 50

/** Storno oder „Zurückholen" (= Storno + Positionen in den Warenkorb dieses Geräts) */
type StornoArt = 'storno' | 'zurueckholen'

interface StornoAuftrag {
  beleg:   BelegListeEintrag
  /** Kasse des Originalbelegs — der Stornobeleg kommt in DEREN RKSV-Kette */
  kasseId: string
  art:     StornoArt
}

function kassenName(k: Pick<KasseListeItem, 'bezeichnung' | 'kassenId'>): string {
  return k.bezeichnung?.trim() || k.kassenId
}

/**
 * Auswertung → Belege: die Belege JE KASSE des Betriebs.
 *
 * Oben wählt man die Kasse (Barkasse, Kellner-Geräte …); vorausgewählt ist die Kasse dieses
 * Geräts. Die Belege bleiben je Kasse getrennt — jede Kasse hat ihre eigene RKSV-Kette und
 * Nummernfolge. Storno, Zurückholen und die Spezialbelege laufen immer auf der gewählten Kasse.
 */
export function BelegePage() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const navigate    = useNavigate()

  const [kasseId, setKasseId] = useState(identity.kasseId)

  const [ausgewaehlt, setAusgewaehlt] = useState<BelegResponse | null>(null)
  const [ausgabeBeleg, setAusgabeBeleg] = useState<BelegResponse | null>(null)
  const [stornoAuftrag, setStornoAuftrag] = useState<StornoAuftrag | null>(null)
  const [stornoGrund, setStornoGrund] = useState('')
  /**
   * Freigabe-PIN. Das Feld erscheint erst, wenn das Backend den Storno mit
   * „freigabe_erforderlich" abgelehnt hat — im Normalfall (Schwelle aus oder
   * Betrag darunter) sieht der Kassier davon nichts.
   */
  const [freigabePin, setFreigabePin] = useState('')
  const [freigabeNoetig, setFreigabeNoetig] = useState(false)
  const [aktionsfehler, setAktionsfehler] = useState<string | null>(null)
  const [neuErzeugt, setNeuErzeugt] = useState<BelegResponse | null>(null)

  // Filter
  const [filterKunde, setFilterKunde] = useState<Pick<Kunde, 'id' | 'bezeichnung'> | null>(null)
  const [von, setVon] = useState('')
  const [bis, setBis] = useState('')
  const [sucheEingabe, setSucheEingabe] = useState('')
  const [suche, setSuche] = useState('')
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    const t = setTimeout(() => setSuche(sucheEingabe.trim()), 300)
    return () => clearTimeout(t)
  }, [sucheEingabe])

  // Neue Kasse oder neuer Filter → wieder bei Seite 1 anfangen
  useEffect(() => { setOffset(0) }, [kasseId, von, bis, suche, filterKunde?.id])

  const filterAktiv = !!(von || bis || suche || filterKunde)
  const filterZuruecksetzen = () => {
    setVon(''); setBis(''); setSucheEingabe(''); setSuche(''); setFilterKunde(null)
  }

  const kassen = useQuery({
    queryKey:  ['kassen-liste'],
    queryFn:   () => kasseApi.liste(),
    staleTime: 1000 * 60,
  })
  const gewaehlteKasse = kassen.data?.find(k => k.id === kasseId)
  const kasseLabel = gewaehlteKasse ? kassenName(gewaehlteKasse) : 'diese Kasse'
  const kasseAusserBetrieb = !!gewaehlteKasse?.ausserBetriebAm

  const kasseStatus = useQuery({
    queryKey: ['kasse-status', kasseId],
    queryFn:  () => kasseApi.getStatus(kasseId),
    staleTime: 1000 * 60 * 10,   // 10 Minuten cachen
  })

  const jahresbelegStatus = useQuery({
    queryKey:  ['jahresbeleg-status', kasseId],
    queryFn:   () => kasseApi.getJahresbelegStatus(kasseId),
    staleTime: 1000 * 60 * 5,
  })

  const liste = useQuery({
    queryKey: ['belege', kasseId, 'seite', { von, bis, suche, kundeId: filterKunde?.id, offset }],
    queryFn:  () => belegApi.seite({
      kasseId,
      ...(von && { von }),
      ...(bis && { bis }),
      ...(suche && { suche }),
      ...(filterKunde && { kundeId: filterKunde.id }),
      limit:  SEITENGROESSE,
      offset,
    }),
    placeholderData: keepPreviousData,
  })

  // Monatsbeleg-Fälligkeit: die letzten Spezialbelege der Kasse, unabhängig von Filter und Seite
  const spezialbelege = useQuery({
    queryKey: ['belege', kasseId, 'spezial'],
    queryFn:  () => belegApi.seite({ kasseId, typen: 'Monatsbeleg,Jahresbeleg,Startbeleg', limit: 20 }),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['belege', kasseId] })

  // -------------------------------------------------------------------------
  // Mutationen
  // -------------------------------------------------------------------------

  const stornoZuruecksetzen = () => {
    setStornoAuftrag(null)
    setStornoGrund('')
    setFreigabePin('')
    setFreigabeNoetig(false)
    setAktionsfehler(null)
  }

  const stornoMutation = useMutation({
    mutationFn: (auftrag: StornoAuftrag) => belegApi.storno({
      kasseId:        auftrag.kasseId,
      verweisBelegId: auftrag.beleg.id,
      ...(stornoGrund.trim() && { grund: stornoGrund.trim() }),
      ...(freigabePin && { freigabePin }),
    }),
    onSuccess:  (storno, auftrag) => {
      void queryClient.invalidateQueries({ queryKey: ['belege', auftrag.kasseId] })
      stornoZuruecksetzen()
      if (auftrag.art === 'zurueckholen') {
        merkeZurueckgeholt({
          belegNummer:      auftrag.beleg.belegNummer,
          kasseBezeichnung: kasseLabel,
          stornoNummer:     storno.belegNummer,
          positionen:       positionenAusBeleg(auftrag.beleg),
          ...(auftrag.beleg.kunde && { kunde: auftrag.beleg.kunde }),
        })
        navigate('/kasse')
        return
      }
      setNeuErzeugt(storno)
    },
    onError: (err) => {
      // Über der Freigabeschwelle: PIN-Feld einblenden statt nur zu meckern.
      if (err instanceof ApiError && err.code === 'freigabe_erforderlich') {
        setFreigabeNoetig(true)
        setFreigabePin('')
      }
      setAktionsfehler(err instanceof Error ? err.message : String(err))
    },
  })

  const nullbelegMutation = useMutation({
    mutationFn: () => belegApi.nullbeleg({ kasseId }),
    onSuccess:  (beleg) => { setNeuErzeugt(beleg); invalidate() },
    onError: (err) => setAktionsfehler(err instanceof Error ? err.message : String(err)),
  })

  const monatsbelegMutation = useMutation({
    mutationFn: () => belegApi.monatsbeleg({ kasseId }),
    onSuccess:  (beleg) => { setNeuErzeugt(beleg); invalidate() },
    onError: (err) => setAktionsfehler(err instanceof Error ? err.message : String(err)),
  })

  const jahresbelegMutation = useMutation({
    mutationFn: () => belegApi.jahresbeleg({ kasseId }),
    onSuccess:  (beleg) => {
      setNeuErzeugt(beleg)
      invalidate()
      // Jahresbeleg-Status sofort neu laden → Banner verschwindet
      void queryClient.invalidateQueries({ queryKey: ['jahresbeleg-status', kasseId] })
    },
    onError: (err) => setAktionsfehler(err instanceof Error ? err.message : String(err)),
  })

  // -------------------------------------------------------------------------
  // Fälligkeit prüfen
  // -------------------------------------------------------------------------

  const faelligkeit = useMemo(() => berechneFaelligkeit(spezialbelege.data?.belege ?? []), [spezialbelege.data])

  const kannStornieren   = hasBerechtigung('belege.stornieren')
  // Zurückholen legt den Beleg in den Warenkorb dieses Geräts → braucht auch die Kasse
  const kannZurueckholen = kannStornieren && hasBerechtigung('kasse')

  const belegeSeite = liste.data?.belege ?? []
  const gesamt      = liste.data?.gesamt ?? 0
  const bisNr       = Math.min(offset + SEITENGROESSE, gesamt)

  const oeffneStorno = (b: BelegListeEintrag, art: StornoArt) => {
    setStornoAuftrag({ beleg: b, kasseId, art })
    setStornoGrund('')
    setFreigabePin('')
    setFreigabeNoetig(false)
    setAktionsfehler(null)
  }

  const stornoBeleg = stornoAuftrag?.beleg

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      {/* Kopfzeile */}
      <div>
        <h1 className="text-2xl font-bold text-ink">Belege</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Belege je Kasse: ansehen, nachdrucken, stornieren, zurückholen. Dazu die RKSV-Spezialbelege.
        </p>
      </div>

      {/* Kassen-Auswahl: jede Kasse für sich (eigene RKSV-Kette) */}
      {kassen.data && kassen.data.length > 1 && (
        <div role="tablist" aria-label="Kasse" className="flex flex-wrap gap-2" data-testid="kassen-auswahl">
          {kassen.data.map(k => {
            const aktiv = k.id === kasseId
            return (
              <button
                key={k.id}
                type="button"
                role="tab"
                aria-selected={aktiv}
                onClick={() => setKasseId(k.id)}
                className={`rounded-lg border px-3 py-2 text-sm text-left transition-colors ${
                  aktiv
                    ? 'border-brand-500 bg-brand-50 text-brand-900 font-semibold'
                    : 'border-line bg-panel text-ink hover:bg-panel-2'
                }`}
              >
                <span className="block">{kassenName(k)}</span>
                <span className="block text-xs font-normal text-ink-muted">
                  {k.id === identity.kasseId ? 'dieses Gerät' : k.kassenId}
                  {k.ausserBetriebAm ? ' · außer Betrieb' : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* SEE-Zertifikats-Banner */}
      {!kasseAusserBetrieb && kasseStatus.data?.seeAbgelaufen && (
        <Banner
          farbe="red"
          titel="SEE-Zertifikat abgelaufen"
          beschreibung={`Das Sicherheitseinrichtungs-Zertifikat von „${kasseLabel}" ist seit dem ${new Date(kasseStatus.data.seeGueltigBis).toLocaleDateString('de-AT')} abgelaufen. Die Kasse kann keine Belege mehr ausstellen. Bitte Kasse neu einrichten.`}
        />
      )}
      {!kasseAusserBetrieb && kasseStatus.data && !kasseStatus.data.seeAbgelaufen && kasseStatus.data.seeRestTage <= 90 && (
        <Banner
          farbe={kasseStatus.data.seeRestTage <= 30 ? 'red' : 'amber'}
          titel={`SEE-Zertifikat läuft in ${kasseStatus.data.seeRestTage} Tagen ab`}
          beschreibung={`Das Sicherheitseinrichtungs-Zertifikat von „${kasseLabel}" ist bis ${new Date(kasseStatus.data.seeGueltigBis).toLocaleDateString('de-AT')} gültig. Bitte rechtzeitig Kasse neu einrichten, um Betriebsunterbrechungen zu vermeiden.`}
        />
      )}

      {/* Fälligkeits-Banner */}
      {!kasseAusserBetrieb && faelligkeit.monatsbelegFaellig && (
        <Banner
          farbe="amber"
          titel={`Monatsbeleg fällig (${kasseLabel})`}
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
      {!kasseAusserBetrieb && jahresbelegStatus.data?.jahresbelegFaellig && (
        <JahresbelegBanner
          status={jahresbelegStatus.data}
          isPending={jahresbelegMutation.isPending}
          onErstellen={() => jahresbelegMutation.mutate()}
        />
      )}

      {/* Spezialbelege */}
      {!kasseAusserBetrieb && (
        <div className="rounded-lg bg-panel shadow-sm border border-line p-4 space-y-4">
          <h2 className="text-sm font-semibold text-ink">RKSV-Spezialbelege — {kasseLabel}</h2>

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
          <div className="flex flex-wrap gap-2 pt-1 border-t border-line">
            <Button variant="secondary" onClick={() => monatsbelegMutation.mutate()} loading={monatsbelegMutation.isPending}>
              Monatsbeleg erstellen
            </Button>
            <Button variant="secondary" onClick={() => jahresbelegMutation.mutate()} loading={jahresbelegMutation.isPending}>
              Jahresbeleg erstellen
            </Button>
          </div>
        </div>
      )}

      {aktionsfehler && !stornoAuftrag && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {aktionsfehler}
        </div>
      )}

      {/* Filter */}
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex-1 min-w-[200px] max-w-xs">
          <span className="block text-xs font-medium text-ink-muted mb-1">Suche</span>
          <input
            type="search"
            value={sucheEingabe}
            onChange={e => setSucheEingabe(e.target.value)}
            placeholder="Belegnummer, Betrag, Kunde …"
            aria-label="Belege durchsuchen"
            className="w-full rounded-md border border-line-strong px-3 py-2 text-sm
                       focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
        </label>
        <label>
          <span className="block text-xs font-medium text-ink-muted mb-1">Von</span>
          <input
            type="date"
            value={von}
            onChange={e => setVon(e.target.value)}
            aria-label="Von Datum"
            className="rounded-md border border-line-strong px-3 py-2 text-sm focus:border-brand-500 outline-none"
          />
        </label>
        <label>
          <span className="block text-xs font-medium text-ink-muted mb-1">Bis</span>
          <input
            type="date"
            value={bis}
            onChange={e => setBis(e.target.value)}
            aria-label="Bis Datum"
            className="rounded-md border border-line-strong px-3 py-2 text-sm focus:border-brand-500 outline-none"
          />
        </label>
        <div className="flex-1 min-w-[220px] max-w-sm">
          <span className="block text-xs font-medium text-ink-muted mb-1">Kunde</span>
          <KundeFilterSuche
            value={filterKunde}
            onChange={setFilterKunde}
          />
        </div>
        {filterAktiv && (
          <Button variant="secondary" onClick={filterZuruecksetzen}>Filter zurücksetzen</Button>
        )}
      </div>

      {/* Tabelle */}
      <div className="rounded-lg bg-panel shadow-sm border border-line overflow-x-auto">
        {liste.isLoading ? (
          <div className="p-8 text-center text-sm text-ink-muted">Wird geladen…</div>
        ) : liste.isError ? (
          <div className="p-8 text-center text-sm text-red-600">
            Fehler: {liste.error instanceof Error ? liste.error.message : 'Unbekannt'}
          </div>
        ) : belegeSeite.length === 0 ? (
          <div className="p-8 text-center">
            {filterAktiv ? (
              <p className="text-sm text-ink-muted">Keine Belege für diese Filter.</p>
            ) : (
              <>
                <p className="text-sm text-ink-muted">Noch keine Belege auf {kasseLabel}.</p>
                {kasseId === identity.kasseId && (
                  <a href="/kasse" className="mt-2 inline-block text-sm text-brand-600 hover:underline">Zur Kasse →</a>
                )}
              </>
            )}
          </div>
        ) : (
          <table className="w-full text-sm" data-testid="belege-tabelle">
            <thead className="bg-panel-2 text-left text-xs uppercase tracking-wide text-ink-muted">
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
            <tbody className="divide-y divide-line">
              {belegeSeite.map((b) => (
                <tr key={b.id} className="hover:bg-brand-50/40" data-testid={`beleg-zeile-${b.belegNummer}`}>
                  <td className="px-4 py-2 font-mono font-medium text-ink cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    #{b.belegNummer}
                  </td>
                  <td className="px-4 py-2 text-ink-muted cursor-pointer whitespace-nowrap" onClick={() => setAusgewaehlt(b)}>
                    {formatDatum(b.belegDatum)}
                  </td>
                  <td className="px-4 py-2 cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    <BelegTypBadge typ={b.belegTyp} />
                  </td>
                  <td className="px-4 py-2 text-ink-muted cursor-pointer max-w-[180px]" onClick={() => setAusgewaehlt(b)}>
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
                      <span className="text-ink-subtle">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-ink-muted cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    {b.positionen.length}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    {b.summeBarCent !== 0 ? formatPreis(b.summeBarCent) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    {b.summeKarteCent !== 0 ? formatPreis(b.summeKarteCent) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-semibold text-ink cursor-pointer" onClick={() => setAusgewaehlt(b)}>
                    {formatPreis(b.gesamtbetragCent)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setAusgabeBeleg(b) }}
                        className="text-xs text-brand-700 hover:underline"
                      >
                        Ausgeben
                      </button>
                      {b.belegTyp === 'Barzahlungsbeleg' && kannStornieren && (
                        b.storniertDurch ? (
                          <span className="text-xs text-ink-subtle italic">storniert (#{b.storniertDurch.belegNummer})</span>
                        ) : (
                          <>
                            {kannZurueckholen && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); oeffneStorno(b, 'zurueckholen') }}
                                className="text-xs text-amber-700 hover:underline"
                                title="Stornieren und die Positionen in den Warenkorb dieses Geräts legen"
                              >
                                Zurückholen
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); oeffneStorno(b, 'storno') }}
                              className="text-xs text-red-600 hover:underline"
                            >
                              Stornieren
                            </button>
                          </>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Paging */}
      {gesamt > 0 && (
        <div className="flex items-center justify-between gap-3 text-sm text-ink-muted" data-testid="belege-paging">
          <span>Belege {offset + 1}–{bisNr} von {gesamt}</span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={offset === 0 || liste.isFetching}
              onClick={() => setOffset(o => Math.max(0, o - SEITENGROESSE))}
            >
              ← Neuere
            </Button>
            <Button
              variant="secondary"
              disabled={bisNr >= gesamt || liste.isFetching}
              onClick={() => setOffset(o => o + SEITENGROESSE)}
            >
              Ältere →
            </Button>
          </div>
        </div>
      )}

      {/* Detail-Modal */}
      <Modal
        open={!!ausgewaehlt}
        onClose={() => setAusgewaehlt(null)}
        title={`Beleg #${ausgewaehlt?.belegNummer} · ${kasseLabel}`}
        size="lg"
      >
        {ausgewaehlt && (
          <div className="space-y-4">
            <BonAnzeige beleg={ausgewaehlt} />
            <div className="flex justify-end pt-2 border-t border-line">
              <Button
                variant="secondary"
                onClick={() => { const b = ausgewaehlt; setAusgewaehlt(null); setAusgabeBeleg(b) }}
              >
                Ausgeben (Bon, Rechnung, E-Mail) …
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Nachdruck / Rechnung / E-Mail — derselbe Ausgabe-Dialog wie an der Kasse */}
      <AusgabeDialog
        open={!!ausgabeBeleg}
        onClose={() => setAusgabeBeleg(null)}
        titel={ausgabeBeleg ? `Beleg #${ausgabeBeleg.belegNummer} ausgeben` : 'Ausgabe wählen'}
        beschreibung={`Nachdruck eines Belegs von ${kasseLabel}. „Bon" druckt am Bondrucker dieser Kasse.`}
        wege={{ ohne: false }}
        {...(ausgabeBeleg?.kunde?.email && { mailVorschlag: ausgabeBeleg.kunde.email })}
        onAusgabe={async (ziel) => {
          const b = ausgabeBeleg
          if (!b) return
          // Fehler (kein Drucker an dieser Kasse …) zeigt der Dialog selbst an und bleibt offen
          switch (ziel.art) {
            case 'bon':     await druckerApi.reprint(b.id); break
            case 'drucker': await druckerApi.reprint(b.id, { druckerId: ziel.druckerId }); break
            case 'mail':    await emailApi.sendBeleg(b.id, ziel.empfaenger); break
            case 'a4': {
              const auth = getAuth()
              if (auth) druckeRechnung(b, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
              break
            }
            case 'keine':   break
          }
        }}
      />

      {/* Storno / Zurückholen */}
      <Modal
        open={!!stornoAuftrag}
        onClose={stornoZuruecksetzen}
        title={stornoAuftrag?.art === 'zurueckholen'
          ? `Beleg #${stornoBeleg?.belegNummer} zurückholen?`
          : `Beleg #${stornoBeleg?.belegNummer} stornieren?`}
      >
        {stornoAuftrag && stornoBeleg && (
          <div className="space-y-4">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Es wird ein <strong>Stornobeleg</strong> mit negierten Beträgen auf <strong>{kasseLabel}</strong> erstellt
              (in deren RKSV-Kette). Diese Aktion kann nicht rückgängig gemacht werden.
              {stornoAuftrag.art === 'zurueckholen' && (
                <> Danach liegen die Positionen im Warenkorb <strong>dieses Geräts</strong> — korrigieren und neu kassieren.</>
              )}
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-ink-muted">Kasse</dt><dd>{kasseLabel}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-muted">Original-Beleg</dt><dd className="font-mono">#{stornoBeleg.belegNummer}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-muted">Datum</dt><dd>{formatDatum(stornoBeleg.belegDatum)}</dd></div>
              <div className="flex justify-between font-medium"><dt>Betrag</dt><dd className="font-mono">{formatPreis(stornoBeleg.gesamtbetragCent)}</dd></div>
            </dl>
            <div>
              <label className="block text-sm font-medium text-ink mb-1">
                Storno-Grund <span className="text-ink-subtle font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={stornoGrund}
                onChange={(e) => setStornoGrund(e.target.value)}
                maxLength={200}
                placeholder="z. B. Falscheingabe, Kundenwunsch …"
                className="w-full rounded-md border border-line-strong px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              />
            </div>
            {freigabeNoetig && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                <label className="block text-sm font-medium text-amber-900">
                  Freigabe erforderlich — PIN eines Berechtigten
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoFocus
                  value={freigabePin}
                  onChange={(e) => setFreigabePin(e.target.value.replace(/\D/g, ''))}
                  maxLength={12}
                  placeholder="••••"
                  className="w-full rounded-md border border-amber-300 px-3 py-2 text-sm tracking-widest
                             focus:border-amber-500 focus:ring-1 focus:ring-amber-500 outline-none"
                />
                <p className="text-xs text-amber-800">
                  Dieser Betrag liegt über der eingestellten Freigabeschwelle. Der PIN muss von
                  jemandem mit Freigabe-Recht kommen — der eigene Kellner-PIN genügt nicht.
                </p>
              </div>
            )}
            {aktionsfehler && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {aktionsfehler}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2 border-t border-line">
              <Button variant="secondary" onClick={stornoZuruecksetzen}>
                Abbrechen
              </Button>
              <Button
                disabled={freigabeNoetig && freigabePin.length < 4}
                onClick={() => stornoMutation.mutate(stornoAuftrag)}
                loading={stornoMutation.isPending}
              >
                {stornoAuftrag.art === 'zurueckholen' ? 'Stornieren und zurückholen' : 'Storno bestätigen'}
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
        <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
        </svg>
        <input
          type="text"
          placeholder="Nach Kunde filtern…"
          value={suche}
          onChange={e => { setSuche(e.target.value); setOffen(true) }}
          onFocus={() => setOffen(true)}
          className="w-full rounded-md border border-line-strong pl-9 pr-3 py-2 text-sm
                     focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
        />
      </div>
      {offen && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-md border border-line bg-panel shadow-lg max-h-48 overflow-y-auto">
          {laedt ? (
            <p className="px-3 py-2 text-xs text-ink-subtle">Suche…</p>
          ) : ergebnisse.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-subtle">Keine Kunden gefunden</p>
          ) : (
            ergebnisse.map(k => (
              <button
                key={k.id}
                type="button"
                onClick={() => { onChange({ id: k.id, bezeichnung: k.bezeichnung }); setOffen(false); setSuche('') }}
                className="w-full text-left px-3 py-2 hover:bg-panel-2 text-sm border-b border-line last:border-0"
              >
                <span className="font-medium text-ink">{k.bezeichnung}</span>
                {k.email && <span className="ml-2 text-xs text-ink-muted">{k.email}</span>}
                <span className="ml-2 text-xs text-ink-subtle">#{k.nummer}</span>
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
    typ === 'Barzahlungsbeleg' ? 'bg-panel-2 text-ink' :
    typ === 'Stornobeleg'      ? 'bg-red-100 text-red-700' :
    typ === 'Nullbeleg'        ? 'bg-blue-50 text-blue-700' :
    typ === 'Monatsbeleg'      ? 'bg-amber-50 text-amber-800' :
    typ === 'Jahresbeleg'      ? 'bg-purple-50 text-purple-700' :
    typ === 'Startbeleg'       ? 'bg-green-50 text-green-700' :
    'bg-panel-2 text-ink'
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

function berechneFaelligkeit(belege: readonly BelegResponse[]): Faelligkeit {
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
