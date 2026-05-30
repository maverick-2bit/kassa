import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TischTabErstellenInput, TischTabResponse } from '@kassa/shared'
import { tischTabApi, tischplanApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { TischplanAnsicht } from '../components/TischplanAnsicht'

// ---------------------------------------------------------------------------
// Haupt-Seite
// ---------------------------------------------------------------------------

type Ansicht = 'liste' | 'plan'

export function TischePage() {
  const identity   = getKasseIdentity()!
  const navigate   = useNavigate()
  const qc         = useQueryClient()
  const [ansicht, setAnsicht]                 = useState<Ansicht>('liste')
  const [neuerTischOffen, setNeuerTischOffen] = useState(false)
  const [vorbelegterTisch, setVorbelegterTisch] = useState<string>('')
  const [fehler, setFehler]                   = useState<string | null>(null)

  const tabsQuery = useQuery({
    queryKey:        ['tisch-tabs', identity.kasseId],
    queryFn:         () => tischTabApi.list(identity.kasseId),
    refetchInterval: 5_000,
  })

  const bereicheQuery = useQuery({
    queryKey: ['tischplan', identity.kasseId],
    queryFn:  () => tischplanApi.listeBereiche(identity.kasseId),
  })

  const erstelleMutation = useMutation({
    mutationFn: (input: TischTabErstellenInput) => tischTabApi.erstelle(input),
    onSuccess: (tab) => {
      qc.invalidateQueries({ queryKey: ['tisch-tabs'] })
      setNeuerTischOffen(false)
      navigate(`/tische/${tab.id}`)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  const hatPlan = (bereicheQuery.data?.length ?? 0) > 0

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-5 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Tische</h1>
          <p className="text-sm text-gray-500">
            {tabsQuery.data?.length ?? 0} offene Tische
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Ansicht-Toggle — nur anzeigen wenn Tischplan vorhanden */}
          {hatPlan && (
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => setAnsicht('liste')}
                className={`px-3 py-1.5 font-medium transition ${
                  ansicht === 'liste' ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                ☰ Liste
              </button>
              <button
                type="button"
                onClick={() => setAnsicht('plan')}
                className={`px-3 py-1.5 font-medium transition border-l border-gray-300 ${
                  ansicht === 'plan' ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                ⊞ Plan
              </button>
            </div>
          )}
          <Button onClick={() => { setFehler(null); setNeuerTischOffen(true) }}>
            + Neuer Tisch
          </Button>
        </div>
      </div>

      {tabsQuery.isLoading && <p className="text-sm text-gray-500">Wird geladen…</p>}
      {tabsQuery.isError  && <p className="text-sm text-red-600">Fehler beim Laden der Tische.</p>}

      {/* ---- Plan-Ansicht ---- */}
      {ansicht === 'plan' && hatPlan && (
        <TischplanAnsicht
          bereiche={bereicheQuery.data ?? []}
          tabs={tabsQuery.data ?? []}
        />
      )}

      {/* ---- Listen-Ansicht ---- */}
      {(ansicht === 'liste' || !hatPlan) && (
        <>
          {tabsQuery.data && tabsQuery.data.length === 0 && (
            <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
              <p className="text-gray-500">Keine offenen Tische.</p>
              <p className="mt-1 text-sm text-gray-400">Klicke auf «+ Neuer Tisch» um einen zu öffnen.</p>
            </div>
          )}
          {tabsQuery.data && tabsQuery.data.length > 0 && (
            <TischListeGruppiert
              tabs={tabsQuery.data}
              onTabClick={(id) => navigate(`/tische/${id}`)}
              onNeueGruppe={(tischNummer) => {
                // Tischnummer vorbelegen: Tab öffnen und Tischnummer übernehmen
                setFehler(null)
                setNeuerTischOffen(true)
                setVorbelegterTisch(tischNummer)
              }}
            />
          )}
        </>
      )}

      <Modal
        open={neuerTischOffen}
        onClose={() => setNeuerTischOffen(false)}
        title={vorbelegterTisch ? `Neue Gruppe — Tisch ${vorbelegterTisch}` : 'Neuen Tisch öffnen'}
      >
        <NeuerTischForm
          kasseId={identity.kasseId}
          vorbelegterTisch={vorbelegterTisch}
          loading={erstelleMutation.isPending}
          fehler={fehler}
          onSubmit={(input) => { setFehler(null); erstelleMutation.mutate(input) }}
          onAbbrechen={() => { setNeuerTischOffen(false); setVorbelegterTisch('') }}
        />
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tisch-Karte
// ---------------------------------------------------------------------------

/** Minuten-Ticker: zwingt neu-Render jede Minute für Live-Zeitanzeigen */
function useMinutenticker() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])
}

function minOffen(geoffnetAm: string): number {
  return Math.floor((Date.now() - new Date(geoffnetAm).getTime()) / 60_000)
}

function dauerText(min: number): string {
  return min < 60 ? `${min} Min.` : `${Math.floor(min / 60)}h ${min % 60}m`
}

function tischFarbe(min: number): { border: string; bg: string; tischText: string; kellnerText: string; badgeBg: string; badgeText: string } {
  if (min < 30) return {
    border:      'border-green-300',
    bg:          'bg-green-50 hover:bg-green-100 hover:border-green-500',
    tischText:   'text-green-700',
    kellnerText: 'text-green-600',
    badgeBg:     'bg-green-200',
    badgeText:   'text-green-800',
  }
  if (min < 60) return {
    border:      'border-orange-300',
    bg:          'bg-orange-50 hover:bg-orange-100 hover:border-orange-500',
    tischText:   'text-orange-700',
    kellnerText: 'text-orange-600',
    badgeBg:     'bg-orange-200',
    badgeText:   'text-orange-800',
  }
  return {
    border:      'border-red-400',
    bg:          'bg-red-50 hover:bg-red-100 hover:border-red-600',
    tischText:   'text-red-700',
    kellnerText: 'text-red-600',
    badgeBg:     'bg-red-200',
    badgeText:   'text-red-800',
  }
}

function TischKarte({
  tab,
  gruppeNr,
  onClick,
}: {
  tab:      TischTabResponse
  gruppeNr: number | undefined
  onClick:  () => void
}) {
  useMinutenticker()
  const min   = minOffen(tab.geoffnetAm)
  const farbe = tischFarbe(min)

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative rounded-xl border-2 p-4 text-left transition hover:shadow-md ${farbe.border} ${farbe.bg}`}
    >
      {gruppeNr !== undefined && (
        <span className={`absolute top-2 right-2 text-[10px] font-bold rounded-full px-1.5 py-0.5 leading-none ${farbe.badgeBg} ${farbe.badgeText}`}>
          G{gruppeNr}
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <p className={`text-2xl font-bold ${farbe.tischText}`}>{tab.tischNummer}</p>
        <span className={`shrink-0 text-xs font-semibold px-1.5 py-0.5 rounded-md ${farbe.badgeBg} ${farbe.badgeText}`}>
          {dauerText(min)}
        </span>
      </div>
      <p className={`mt-0.5 text-xs font-medium truncate ${farbe.kellnerText}`}>{tab.kellner}</p>
      <p className="mt-2 text-sm font-semibold text-gray-900">
        {formatPreis(tab.summeGesamtCent)}
      </p>
      <p className="text-xs text-gray-500">
        {tab.positionen.reduce((n, p) => n + p.menge, 0)} Pos.
      </p>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Formular: Neuer Tisch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gruppierte Listenansicht
// ---------------------------------------------------------------------------

function TischListeGruppiert({
  tabs,
  onTabClick,
  onNeueGruppe,
}: {
  tabs:         TischTabResponse[]
  onTabClick:   (id: string) => void
  onNeueGruppe: (tischNummer: string) => void
}) {
  // Tabs nach tischNummer gruppieren (Reihenfolge: erste Öffnungszeit)
  const gruppen = new Map<string, TischTabResponse[]>()
  for (const tab of tabs) {
    const liste = gruppen.get(tab.tischNummer) ?? []
    liste.push(tab)
    gruppen.set(tab.tischNummer, liste)
  }

  return (
    <div className="space-y-4">
      {[...gruppen.entries()].map(([tischNummer, gruppe]) => (
        <div key={tischNummer}>
          {/* Tisch-Header wenn mehrere Gruppen */}
          {gruppe.length > 1 && (
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-semibold text-gray-700">Tisch {tischNummer}</span>
              <span className="text-xs text-gray-400">{gruppe.length} Gruppen</span>
              <span className="flex-1 h-px bg-gray-200" />
              <button
                type="button"
                onClick={() => onNeueGruppe(tischNummer)}
                className="text-xs text-brand-600 hover:underline font-medium"
              >
                + Neue Gruppe
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {gruppe.map((tab, i) => (
              <TischKarte
                key={tab.id}
                tab={tab}
                gruppeNr={gruppe.length > 1 ? i + 1 : undefined}
                onClick={() => onTabClick(tab.id)}
              />
            ))}
            {/* „+ Neue Gruppe" als Ghost-Karte wenn mehrere Gruppen vorhanden */}
            {gruppe.length > 1 && (
              <button
                type="button"
                onClick={() => onNeueGruppe(tischNummer)}
                className="rounded-xl border-2 border-dashed border-orange-300 p-4 text-center
                           text-orange-500 hover:border-orange-500 hover:bg-orange-50 transition
                           flex flex-col items-center justify-center gap-1 min-h-[100px]"
              >
                <span className="text-2xl">+</span>
                <span className="text-xs font-medium">Neue Gruppe</span>
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Neuer-Tisch-Formular
// ---------------------------------------------------------------------------

interface NeuerTischFormProps {
  kasseId:          string
  vorbelegterTisch: string
  loading:          boolean
  fehler:           string | null
  onSubmit:         (input: TischTabErstellenInput) => void
  onAbbrechen:      () => void
}

function NeuerTischForm({ kasseId, vorbelegterTisch, loading, fehler, onSubmit, onAbbrechen }: NeuerTischFormProps) {
  const [tischNummer, setTischNummer] = useState(vorbelegterTisch)
  const [kellner, setKellner]         = useState('Service')

  const submit = () => {
    if (!tischNummer.trim()) return
    onSubmit({ kasseId, tischNummer: tischNummer.trim(), kellner: kellner.trim() || 'Service' })
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Tischnummer / -bezeichnung</span>
        <Input
          autoFocus
          value={tischNummer}
          onChange={(e) => setTischNummer(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="z. B. 1, Terrasse 3, Bar …"
          className="mt-1"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Kellner</span>
        <Input
          value={kellner}
          onChange={(e) => setKellner(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="mt-1"
        />
      </label>
      {fehler && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>
      )}
      <div className="flex gap-2 pt-1">
        <Button variant="secondary" onClick={onAbbrechen} className="flex-1">Abbrechen</Button>
        <Button onClick={submit} loading={loading} className="flex-1" disabled={!tischNummer.trim()}>
          Tisch öffnen
        </Button>
      </div>
    </div>
  )
}
