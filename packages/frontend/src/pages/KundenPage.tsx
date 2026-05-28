import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Kunde, KundeBelegVorschau, KundeInput, KundeUpdate, LiferscheinResponse, LiferscheinStatus, OffenerPostenResponse, OffenerPostenStatus } from '@kassa/shared'
import { LIEFERSCHEIN_STATUS_LABELS, OFFENER_POSTEN_STATUS_LABELS } from '@kassa/shared'
import { kundeApi, lieferscheinApi, offenerPostenApi, sammelrechnungApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { formatPreis, formatDatum } from '../lib/format'
import { druckeLiferschein, druckeSammelrechnung } from '../lib/rechnung'

// ---------------------------------------------------------------------------
// Hauptseite
// ---------------------------------------------------------------------------

export function KundenPage() {
  const [suche,     setSuche]     = useState('')
  const [nurAktive, setNurAktive] = useState(true)
  const [profilKunde, setProfilKunde] = useState<Kunde | null>(null)
  const [neuerOffen,  setNeuerOffen]  = useState(false)
  const [fehler,      setFehler]      = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: kunden = [], isLoading } = useQuery({
    queryKey: ['kunden', suche, nurAktive],
    queryFn:  () => kundeApi.list({ ...(suche ? { suche } : {}), nurAktive }),
  })

  const erstelleMutation = useMutation({
    mutationFn: kundeApi.create,
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['kunden'] }); setNeuerOffen(false) },
    onError:    (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:py-8 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Kunden</h1>
          <p className="mt-1 text-sm text-gray-500">Kundenstammdaten (CRM)</p>
        </div>
        <Button onClick={() => { setFehler(null); setNeuerOffen(true) }}>
          + Neuer Kunde
        </Button>
      </div>

      {/* Suche + Filter */}
      <div className="flex flex-wrap gap-3 items-center">
        <Input
          placeholder="Suchen (Name, Firma, E-Mail, Nummer…)"
          value={suche}
          onChange={e => setSuche(e.target.value)}
          className="flex-1 min-w-[240px]"
        />
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={nurAktive}
            onChange={e => setNurAktive(e.target.checked)}
            className="rounded"
          />
          <span className="text-gray-700">Nur aktive</span>
        </label>
      </div>

      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{fehler}</div>
      )}

      {/* Tabelle */}
      <div className="rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
        {isLoading ? (
          <p className="text-sm text-gray-400 text-center py-10">Lade…</p>
        ) : kunden.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-10">
            {suche ? 'Keine Kunden gefunden.' : 'Noch keine Kunden angelegt.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-2 font-semibold">#</th>
                  <th className="px-4 py-2 font-semibold">Name / Firma</th>
                  <th className="px-4 py-2 font-semibold">E-Mail</th>
                  <th className="px-4 py-2 font-semibold">Telefon</th>
                  <th className="px-4 py-2 font-semibold">Ort</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {kunden.map(k => (
                  <tr key={k.id} className={`hover:bg-gray-50 ${!k.aktiv ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-2 font-mono text-gray-400 text-xs">{k.nummer}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-gray-900">{k.bezeichnung}</p>
                        {k.kreditAktiv && (
                          <span className="inline-flex items-center rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700 border border-orange-200">
                            Kredit
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-gray-600">{k.email ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-600">{k.telefon ?? '—'}</td>
                    <td className="px-4 py-2 text-gray-600">
                      {[k.plz, k.ort].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        k.aktiv ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {k.aktiv ? 'Aktiv' : 'Inaktiv'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setProfilKunde(k)}
                        className="text-xs font-semibold text-brand-600 hover:text-brand-800 hover:underline"
                      >
                        Profil →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Neuer Kunde */}
      <Modal open={neuerOffen} onClose={() => setNeuerOffen(false)} title="Neuer Kunde">
        <KundeFormular
          onSubmit={(input) => erstelleMutation.mutate(input as KundeInput)}
          onAbbrechen={() => setNeuerOffen(false)}
          loading={erstelleMutation.isPending}
          fehler={fehler}
        />
      </Modal>

      {/* Kundenprofil-Modal */}
      {profilKunde && (
        <KundenProfilModal
          kunde={profilKunde}
          onKundeChange={(updated) => setProfilKunde(updated)}
          onClose={() => setProfilKunde(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kundenprofil-Modal mit Tabs
// ---------------------------------------------------------------------------

type ProfilTab = 'stammdaten' | 'verlauf' | 'lieferscheine' | 'offene-posten'

const TABS: Array<{ id: ProfilTab; label: string }> = [
  { id: 'stammdaten',    label: 'Stammdaten'    },
  { id: 'verlauf',       label: 'Verlauf'       },
  { id: 'lieferscheine', label: 'Lieferscheine' },
  { id: 'offene-posten', label: 'Offene Posten' },
]

interface KundenProfilModalProps {
  kunde:         Kunde
  onKundeChange: (k: Kunde) => void
  onClose:       () => void
}

function KundenProfilModal({ kunde, onKundeChange, onClose }: KundenProfilModalProps) {
  const [aktiveTab, setAktiveTab] = useState<ProfilTab>('stammdaten')
  const qc = useQueryClient()

  // KPI-Daten für den Header
  const { data: belege = [] } = useQuery({
    queryKey: ['kunden-belege', kunde.id],
    queryFn:  () => kundeApi.belege(kunde.id),
    staleTime: 60_000,
  })

  const gesamtUmsatz = belege
    .filter(b => b.belegTyp === 'Barzahlungsbeleg')
    .reduce((s, b) => s + b.gesamtbetragCent, 0)

  const letzterKauf = belege[0]?.belegDatum ?? null

  const aktualisiereMutation = useMutation({
    mutationFn: (input: KundeUpdate) => kundeApi.update(kunde.id, input),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['kunden'] })
      onKundeChange(updated)
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: () => kundeApi.deactivate(kunde.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kunden'] })
      onKundeChange({ ...kunde, aktiv: false })
    },
  })

  const reactivateMutation = useMutation({
    mutationFn: () => kundeApi.reactivate(kunde.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kunden'] })
      onKundeChange({ ...kunde, aktiv: true })
    },
  })

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Kunde #${kunde.nummer} – ${kunde.bezeichnung}`}
      size="xl"
    >
      <div className="space-y-4">
        {/* KPI-Header */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-brand-50 border border-brand-200 px-3 py-2.5">
            <p className="text-xs text-brand-600">Gesamtumsatz</p>
            <p className="text-lg font-bold text-brand-800 mt-0.5 font-mono">
              {belege.length > 0 ? formatPreis(gesamtUmsatz) : '—'}
            </p>
          </div>
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5">
            <p className="text-xs text-gray-500">Belege</p>
            <p className="text-lg font-bold text-gray-900 mt-0.5">{belege.length}</p>
          </div>
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5">
            <p className="text-xs text-gray-500">Letzter Kauf</p>
            <p className="text-sm font-semibold text-gray-900 mt-0.5">
              {letzterKauf ? formatDatum(letzterKauf) : '—'}
            </p>
          </div>
        </div>

        {/* Tab-Leiste */}
        <div className="flex border-b border-gray-200 -mx-1">
          {TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setAktiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                aktiveTab === tab.id
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab-Inhalt */}
        {aktiveTab === 'stammdaten' && (
          <StammdatenTab
            kunde={kunde}
            aktualisiereMutation={aktualisiereMutation}
            deactivateMutation={deactivateMutation}
            reactivateMutation={reactivateMutation}
          />
        )}
        {aktiveTab === 'verlauf' && (
          <VerlaufTab belege={belege} />
        )}
        {aktiveTab === 'lieferscheine' && (
          <LiferscheineTab kunde={kunde} />
        )}
        {aktiveTab === 'offene-posten' && (
          <OffenePostenTab kunde={kunde} />
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Tab 1: Stammdaten
// ---------------------------------------------------------------------------

interface StammdatenTabProps {
  kunde:               Kunde
  aktualisiereMutation: ReturnType<typeof useMutation<Kunde, Error, KundeUpdate>>
  deactivateMutation:   ReturnType<typeof useMutation<Kunde, Error, void>>
  reactivateMutation:   ReturnType<typeof useMutation<Kunde, Error, void>>
}

function StammdatenTab({ kunde, aktualisiereMutation, deactivateMutation, reactivateMutation }: StammdatenTabProps) {
  const [bearbeitenModus, setBearbeitenModus] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)

  if (bearbeitenModus) {
    return (
      <KundeFormular
        initial={kunde}
        onSubmit={(input) => {
          setFehler(null)
          aktualisiereMutation.mutate(input as KundeUpdate, {
            onSuccess: () => setBearbeitenModus(false),
            onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
          })
        }}
        onAbbrechen={() => { setBearbeitenModus(false); setFehler(null) }}
        loading={aktualisiereMutation.isPending}
        fehler={fehler}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Info-Gitter */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        {kunde.firma && (
          <InfoZeile label="Firma" wert={kunde.firma} wide />
        )}
        {(kunde.vorname || kunde.nachname) && (
          <InfoZeile label="Name" wert={[kunde.vorname, kunde.nachname].filter(Boolean).join(' ')} wide={!kunde.firma} />
        )}
        {kunde.email && <InfoZeile label="E-Mail" wert={kunde.email} />}
        {kunde.telefon && <InfoZeile label="Telefon" wert={kunde.telefon} />}
        {kunde.strasse && <InfoZeile label="Straße" wert={kunde.strasse} wide />}
        {(kunde.plz || kunde.ort) && (
          <InfoZeile label="Ort" wert={[kunde.plz, kunde.ort].filter(Boolean).join(' ')} />
        )}
        <InfoZeile label="Land" wert={kunde.land} />
        {kunde.uid && <InfoZeile label="UID" wert={kunde.uid} mono />}
        <InfoZeile
          label="Kredit"
          wert={kunde.kreditAktiv ? 'Kreditkauf erlaubt' : 'Kein Kreditkauf'}
          highlight={kunde.kreditAktiv}
        />
        <InfoZeile label="Status" wert={kunde.aktiv ? 'Aktiv' : 'Inaktiv'} />
      </div>

      {/* Notizen */}
      {kunde.notizen && (
        <div className="rounded-lg bg-yellow-50 border border-yellow-200 px-4 py-3">
          <p className="text-xs font-semibold text-yellow-700 mb-1">Notizen</p>
          <p className="text-sm text-yellow-900 whitespace-pre-wrap">{kunde.notizen}</p>
        </div>
      )}

      {/* Aktionen */}
      <div className="flex gap-2 pt-2 border-t border-gray-100">
        <Button onClick={() => setBearbeitenModus(true)} className="flex-1">
          Bearbeiten
        </Button>
        {kunde.aktiv ? (
          <Button
            variant="secondary"
            onClick={() => deactivateMutation.mutate()}
            loading={deactivateMutation.isPending}
            className="text-red-600 border-red-200 hover:bg-red-50"
          >
            Deaktivieren
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => reactivateMutation.mutate()}
            loading={reactivateMutation.isPending}
            className="text-green-700 border-green-200 hover:bg-green-50"
          >
            Reaktivieren
          </Button>
        )}
      </div>
    </div>
  )
}

function InfoZeile({ label, wert, wide = false, mono = false, highlight = false }: {
  label:     string
  wert:      string
  wide?:     boolean
  mono?:     boolean
  highlight?: boolean
}) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-0.5 ${mono ? 'font-mono text-xs' : ''} ${highlight ? 'font-semibold text-orange-700' : 'text-gray-900'}`}>
        {wert}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 2: Verlauf
// ---------------------------------------------------------------------------

function VerlaufTab({ belege }: { belege: KundeBelegVorschau[] }) {
  const gesamtUmsatz = belege
    .filter(b => b.belegTyp === 'Barzahlungsbeleg')
    .reduce((s, b) => s + b.gesamtbetragCent, 0)

  if (belege.length === 0) {
    return (
      <p className="text-sm text-gray-400 text-center py-8">
        Noch keine Rechnungen vorhanden.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {/* Kennzahlen */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500">Belege gesamt</p>
          <p className="text-xl font-bold text-gray-900 mt-0.5">{belege.length}</p>
        </div>
        <div className="rounded-lg bg-brand-50 border border-brand-200 px-4 py-3">
          <p className="text-xs text-brand-600">Gesamtumsatz</p>
          <p className="text-xl font-bold text-brand-800 mt-0.5 font-mono">{formatPreis(gesamtUmsatz)}</p>
        </div>
      </div>

      {/* Tabelle */}
      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200 sticky top-0">
              <tr>
                <th className="px-3 py-2 font-semibold">Nr.</th>
                <th className="px-3 py-2 font-semibold">Datum</th>
                <th className="px-3 py-2 font-semibold">Typ</th>
                <th className="px-3 py-2 font-semibold text-right">Betrag</th>
                <th className="px-3 py-2 font-semibold text-right">Zahlung</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {belege.map(b => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-gray-400 text-xs">#{b.belegNummer}</td>
                  <td className="px-3 py-2 text-gray-600">{formatDatum(b.belegDatum)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      b.belegTyp === 'Barzahlungsbeleg'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-500'
                    }`}>
                      {b.belegTyp}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-medium text-gray-900">
                    {formatPreis(b.gesamtbetragCent)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-gray-500">
                    {b.summeBarCent > 0 && b.summeKarteCent > 0
                      ? `Bar ${formatPreis(b.summeBarCent)} / Karte ${formatPreis(b.summeKarteCent)}`
                      : b.summeKarteCent > 0 ? 'Karte' : 'Bar'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 3: Lieferscheine + Sammelrechnung
// ---------------------------------------------------------------------------

const STATUS_FILTER_LS: Array<{ label: string; value: LiferscheinStatus | 'alle' }> = [
  { label: 'Alle',          value: 'alle' },
  { label: 'Offen',         value: 'offen' },
  { label: 'Abgeschlossen', value: 'abgeschlossen' },
]

const LS_STATUS_FARBE: Record<LiferscheinStatus, string> = {
  offen:         'bg-blue-100 text-blue-800 border-blue-200',
  abgeschlossen: 'bg-gray-100 text-gray-600 border-gray-200',
}

function LiferscheineTab({ kunde }: { kunde: Kunde }) {
  const qc = useQueryClient()
  const auth = getAuth()
  const [statusFilter, setStatusFilter] = useState<LiferscheinStatus | 'alle'>('alle')
  const [ausgewaehlt,  setAusgewaehlt]  = useState<Set<string>>(new Set())
  const [srFehler,     setSrFehler]     = useState<string | null>(null)

  const { data: lieferscheine = [], isLoading } = useQuery({
    queryKey: ['lieferscheine', kunde.id, statusFilter],
    queryFn:  () => lieferscheinApi.list({
      kundeId: kunde.id,
      ...(statusFilter !== 'alle' ? { status: statusFilter } : {}),
    }),
  })

  const sammelrechnungMutation = useMutation({
    mutationFn: () => sammelrechnungApi.create({ lieferscheinIds: [...ausgewaehlt] }),
    onSuccess: (sr) => {
      qc.invalidateQueries({ queryKey: ['lieferscheine', kunde.id] })
      setAusgewaehlt(new Set())
      setSrFehler(null)
      if (auth) druckeSammelrechnung(sr, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
    },
    onError: (err) => setSrFehler(err instanceof Error ? err.message : String(err)),
  })

  const toggleAuswahl = (id: string) =>
    setAusgewaehlt(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const offeneLs = lieferscheine.filter(ls => ls.status === 'offen')
  const alleSelektiert = ausgewaehlt.size > 0 && offeneLs.every(ls => ausgewaehlt.has(ls.id))

  const alleToggle = () => {
    const offeneIds = offeneLs.map(ls => ls.id)
    if (alleSelektiert) {
      setAusgewaehlt(new Set())
    } else {
      setAusgewaehlt(new Set(offeneIds))
    }
  }

  const handleLsDrucken = (ls: LiferscheinResponse) => {
    if (!auth) return
    druckeLiferschein(ls, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
  }

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-2">
          {STATUS_FILTER_LS.map(f => (
            <button
              key={f.value}
              type="button"
              onClick={() => { setStatusFilter(f.value); setAusgewaehlt(new Set()) }}
              className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                statusFilter === f.value
                  ? 'bg-brand-600 border-brand-600 text-white'
                  : 'bg-white border-gray-300 text-gray-600 hover:border-brand-400'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {ausgewaehlt.size > 0 && (
          <span className="text-sm text-blue-700 font-medium">
            {ausgewaehlt.size} ausgewählt
          </span>
        )}
      </div>

      {/* Liste */}
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        {isLoading ? (
          <p className="text-sm text-gray-400 text-center py-10">Lade…</p>
        ) : lieferscheine.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-10">Keine Lieferscheine vorhanden.</p>
        ) : (
          <div className="overflow-y-auto max-h-[45vh]">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2 w-8">
                    {offeneLs.length > 0 && (
                      <input
                        type="checkbox"
                        checked={alleSelektiert}
                        onChange={alleToggle}
                        className="rounded"
                        title="Alle offenen auswählen"
                      />
                    )}
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Nr.</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Datum</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Angebot</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Betrag</th>
                  <th className="px-3 py-2 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lieferscheine.map(ls => {
                  const summe     = ls.positionen.reduce((s, p) => s + Math.round(p.einzelpreisBreutto * p.menge), 0)
                  const isOffen   = ls.status === 'offen'
                  const isChecked = ausgewaehlt.has(ls.id)
                  return (
                    <tr key={ls.id} className={`hover:bg-gray-50 transition ${isChecked ? 'bg-blue-50' : ''}`}>
                      <td className="px-3 py-2.5 text-center">
                        {isOffen ? (
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleAuswahl(ls.id)}
                            className="rounded"
                          />
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono font-medium text-gray-800">
                        L-{String(ls.nummer).padStart(4, '0')}
                      </td>
                      <td className="px-3 py-2.5 text-gray-600">
                        {new Date(ls.datum).toLocaleDateString('de-AT')}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500 font-mono text-xs">
                        A-{String(ls.angebotNummer).padStart(4, '0')}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${LS_STATUS_FARBE[ls.status as LiferscheinStatus]}`}>
                          {LIEFERSCHEIN_STATUS_LABELS[ls.status as LiferscheinStatus]}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono font-semibold text-gray-800">
                        {formatPreis(summe)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => handleLsDrucken(ls)}
                          className="text-xs text-brand-600 hover:underline"
                          title="Lieferschein drucken"
                        >
                          Drucken
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Sammelrechnung */}
      {srFehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{srFehler}</div>
      )}

      <div className="pt-1 border-t border-gray-200">
        <Button
          onClick={() => sammelrechnungMutation.mutate()}
          loading={sammelrechnungMutation.isPending}
          disabled={ausgewaehlt.size === 0}
          className="w-full"
        >
          {ausgewaehlt.size === 0
            ? 'Sammelrechnung (Lieferscheine auswählen)'
            : `Sammelrechnung aus ${ausgewaehlt.size} Lieferschein${ausgewaehlt.size !== 1 ? 'en' : ''}`}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 4: Offene Posten
// ---------------------------------------------------------------------------

const OP_STATUS_FARBE: Record<OffenerPostenStatus, string> = {
  offen:       'bg-red-100 text-red-800 border-red-200',
  teilbezahlt: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  bezahlt:     'bg-green-100 text-green-800 border-green-200',
}

function OffenePostenTab({ kunde }: { kunde: Kunde }) {
  const qc = useQueryClient()
  const [zahlungModal, setZahlungModal] = useState<OffenerPostenResponse | null>(null)
  const [zahlungEuro,  setZahlungEuro]  = useState('')
  const [fehler,       setFehler]       = useState<string | null>(null)

  const { data: posten = [], isLoading } = useQuery({
    queryKey: ['offene-posten', 'kunde', kunde.id],
    queryFn:  () => offenerPostenApi.list({ kundeId: kunde.id }),
  })

  const zahlungMutation = useMutation({
    mutationFn: ({ id, zahlungCent }: { id: string; zahlungCent: number }) =>
      offenerPostenApi.zahlung(id, { zahlungCent }),
    onSuccess: () => {
      setZahlungModal(null)
      setZahlungEuro('')
      setFehler(null)
      void qc.invalidateQueries({ queryKey: ['offene-posten'] })
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const gesamtRest = posten
    .filter(p => p.status !== 'bezahlt')
    .reduce((s, p) => s + p.restCent, 0)

  return (
    <div className="space-y-4">
      {/* Zusammenfassung */}
      {gesamtRest > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 flex justify-between items-center">
          <span className="text-sm font-medium text-orange-800">Offener Gesamtbetrag</span>
          <span className="font-mono font-bold text-orange-900">{formatPreis(gesamtRest)}</span>
        </div>
      )}

      {/* Tabelle */}
      {isLoading ? (
        <p className="text-sm text-gray-400">Lade…</p>
      ) : posten.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">Keine Offenen Posten vorhanden.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-3 py-2 text-left">Nr.</th>
                <th className="px-3 py-2 text-left">Datum</th>
                <th className="px-3 py-2 text-right">Beleg</th>
                <th className="px-3 py-2 text-right">Betrag</th>
                <th className="px-3 py-2 text-right">Bezahlt</th>
                <th className="px-3 py-2 text-right">Rest</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {posten.map((op, idx) => (
                <tr key={op.id} className={`border-b border-gray-100 last:border-0 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}>
                  <td className="px-3 py-2.5 font-mono text-gray-500 text-xs">
                    OP-{String(op.nummer).padStart(4, '0')}
                  </td>
                  <td className="px-3 py-2.5 text-gray-600">
                    {new Date(op.datum).toLocaleDateString('de-AT')}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-gray-500 text-xs">
                    {op.belegNummer ? `#${op.belegNummer}` : '–'}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">{formatPreis(op.betragCent)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-green-700">
                    {op.bezahltCent > 0 ? formatPreis(op.bezahltCent) : '–'}
                  </td>
                  <td className={`px-3 py-2.5 text-right font-mono font-semibold ${op.restCent > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                    {op.restCent > 0 ? formatPreis(op.restCent) : '–'}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${OP_STATUS_FARBE[op.status]}`}>
                      {OFFENER_POSTEN_STATUS_LABELS[op.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {op.status !== 'bezahlt' && (
                      <button
                        type="button"
                        onClick={() => {
                          setZahlungModal(op)
                          setZahlungEuro((op.restCent / 100).toFixed(2).replace('.', ','))
                          setFehler(null)
                        }}
                        className="text-xs text-brand-600 hover:underline font-medium"
                      >
                        Zahlung
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Zahlungs-Modal */}
      {zahlungModal && (
        <Modal
          open={true}
          onClose={() => { setZahlungModal(null); setZahlungEuro(''); setFehler(null) }}
          title={`Zahlung – OP-${String(zahlungModal.nummer).padStart(4, '0')}`}
        >
          <div className="space-y-4">
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-4 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Ursprungsbetrag</span>
                <span className="font-mono">{formatPreis(zahlungModal.betragCent)}</span>
              </div>
              {zahlungModal.bezahltCent > 0 && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Bereits bezahlt</span>
                  <span className="font-mono text-green-700">{formatPreis(zahlungModal.bezahltCent)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-gray-200 pt-1.5 font-semibold">
                <span>Restbetrag</span>
                <span className="font-mono text-red-700">{formatPreis(zahlungModal.restCent)}</span>
              </div>
            </div>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Zahlung (€)</span>
              <Input
                autoFocus
                inputMode="decimal"
                value={zahlungEuro}
                onChange={e => setZahlungEuro(e.target.value.replace(/[^0-9.,]/g, ''))}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const cents = Math.round(parseFloat(zahlungEuro.replace(',', '.')) * 100)
                    if (!isNaN(cents) && cents > 0) zahlungMutation.mutate({ id: zahlungModal.id, zahlungCent: cents })
                  }
                }}
                className="mt-1"
              />
            </label>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setZahlungEuro((zahlungModal.restCent / 100).toFixed(2).replace('.', ','))}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition"
              >
                Vollständig ({formatPreis(zahlungModal.restCent)})
              </button>
            </div>

            {fehler && (
              <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                variant="secondary"
                onClick={() => { setZahlungModal(null); setZahlungEuro(''); setFehler(null) }}
                className="flex-1"
              >
                Abbrechen
              </Button>
              <Button
                onClick={() => {
                  const cents = Math.round(parseFloat(zahlungEuro.replace(',', '.')) * 100)
                  if (isNaN(cents) || cents <= 0) return
                  zahlungMutation.mutate({ id: zahlungModal.id, zahlungCent: cents })
                }}
                loading={zahlungMutation.isPending}
                className="flex-1"
                disabled={!zahlungEuro.trim()}
              >
                Zahlung erfassen
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formular (Erstellen + Bearbeiten) — mit Notizen-Feld
// ---------------------------------------------------------------------------

interface KundeFormularProps {
  initial?:    Kunde
  onSubmit:    (input: KundeInput | KundeUpdate) => void
  onAbbrechen: () => void
  loading:     boolean
  fehler:      string | null
}

function KundeFormular({ initial, onSubmit, onAbbrechen, loading, fehler }: KundeFormularProps) {
  const [firma,    setFirma]    = useState(initial?.firma    ?? '')
  const [vorname,  setVorname]  = useState(initial?.vorname  ?? '')
  const [nachname, setNachname] = useState(initial?.nachname ?? '')
  const [email,    setEmail]    = useState(initial?.email    ?? '')
  const [telefon,  setTelefon]  = useState(initial?.telefon  ?? '')
  const [strasse,  setStrasse]  = useState(initial?.strasse  ?? '')
  const [plz,      setPlz]      = useState(initial?.plz      ?? '')
  const [ort,      setOrt]      = useState(initial?.ort      ?? '')
  const [land,        setLand]        = useState(initial?.land        ?? 'AT')
  const [uid,         setUid]         = useState(initial?.uid         ?? '')
  const [kreditAktiv, setKreditAktiv] = useState(initial?.kreditAktiv ?? false)
  const [notizen,     setNotizen]     = useState(initial?.notizen     ?? '')
  const [lokal,       setLokal]       = useState<string | null>(null)

  const submit = () => {
    if (!firma.trim() && !nachname.trim()) {
      setLokal('Firma oder Nachname ist erforderlich')
      return
    }
    setLokal(null)
    onSubmit({
      ...(firma.trim()    && { firma:    firma.trim()    }),
      ...(vorname.trim()  && { vorname:  vorname.trim()  }),
      ...(nachname.trim() && { nachname: nachname.trim() }),
      ...(email.trim()    && { email:    email.trim()    }),
      ...(telefon.trim()  && { telefon:  telefon.trim()  }),
      ...(strasse.trim()  && { strasse:  strasse.trim()  }),
      ...(plz.trim()      && { plz:      plz.trim()      }),
      ...(ort.trim()      && { ort:      ort.trim()      }),
      land: land.trim() || 'AT',
      ...(uid.trim()      && { uid:      uid.trim()      }),
      kreditAktiv,
      notizen: notizen.trim() || null,
    })
  }

  const anzeigeFehler = lokal ?? fehler

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="block col-span-2">
          <span className="text-xs font-medium text-gray-700">Firma</span>
          <Input autoFocus value={firma} onChange={e => setFirma(e.target.value)} placeholder="Muster GmbH" className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Vorname</span>
          <Input value={vorname} onChange={e => setVorname(e.target.value)} className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Nachname</span>
          <Input value={nachname} onChange={e => setNachname(e.target.value)} className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">E-Mail</span>
          <Input type="email" value={email} onChange={e => setEmail(e.target.value)} className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Telefon</span>
          <Input value={telefon} onChange={e => setTelefon(e.target.value)} className="mt-0.5" />
        </label>
        <label className="block col-span-2">
          <span className="text-xs font-medium text-gray-700">Straße</span>
          <Input value={strasse} onChange={e => setStrasse(e.target.value)} className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">PLZ</span>
          <Input value={plz} onChange={e => setPlz(e.target.value)} className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Ort</span>
          <Input value={ort} onChange={e => setOrt(e.target.value)} className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">Land (ISO 2)</span>
          <Input value={land} onChange={e => setLand(e.target.value.toUpperCase().slice(0, 2))} maxLength={2} className="mt-0.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-700">UID (USt-ID)</span>
          <Input value={uid} onChange={e => setUid(e.target.value)} placeholder="ATU12345678" className="mt-0.5" />
        </label>
      </div>

      {/* Kredit-Freigabe */}
      <div className={`flex items-start gap-3 rounded-lg border p-3 ${kreditAktiv ? 'border-orange-200 bg-orange-50' : 'border-gray-200 bg-gray-50'}`}>
        <input
          type="checkbox"
          id="kreditAktiv"
          checked={kreditAktiv}
          onChange={e => setKreditAktiv(e.target.checked)}
          className="mt-0.5 rounded"
        />
        <label htmlFor="kreditAktiv" className="cursor-pointer select-none">
          <span className={`text-sm font-semibold ${kreditAktiv ? 'text-orange-800' : 'text-gray-700'}`}>
            Kreditkauf erlaubt
          </span>
          <p className="text-xs text-gray-500 mt-0.5">
            Erlaubt das Buchen auf Kredit (Offene Posten) an der Kasse — nur für Benutzer mit Berechtigung „Kreditverkauf".
          </p>
        </label>
      </div>

      {/* Notizen */}
      <label className="block">
        <span className="text-xs font-medium text-gray-700">Notizen (intern)</span>
        <textarea
          value={notizen ?? ''}
          onChange={e => setNotizen(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="Interne Anmerkungen zum Kunden…"
          className="mt-0.5 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-y"
        />
        <p className="mt-0.5 text-right text-xs text-gray-400">{(notizen ?? '').length}/2000</p>
      </label>

      {anzeigeFehler && (
        <p className="text-xs text-red-600">{anzeigeFehler}</p>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onAbbrechen} className="flex-1">Abbrechen</Button>
        <Button onClick={submit} loading={loading} className="flex-1">
          {initial ? 'Speichern' : 'Anlegen'}
        </Button>
      </div>
    </div>
  )
}
