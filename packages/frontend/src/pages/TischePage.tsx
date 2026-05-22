import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TischTabErstellenInput, TischTabResponse } from '@kassa/shared'
import { tischTabApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'

// ---------------------------------------------------------------------------
// Haupt-Seite
// ---------------------------------------------------------------------------

export function TischePage() {
  const identity   = getKasseIdentity()!
  const navigate   = useNavigate()
  const qc         = useQueryClient()
  const [neuerTischOffen, setNeuerTischOffen] = useState(false)
  const [fehler, setFehler]                   = useState<string | null>(null)

  const tabsQuery = useQuery({
    queryKey:  ['tisch-tabs', identity.kasseId],
    queryFn:   () => tischTabApi.list(identity.kasseId),
    refetchInterval: 5_000,
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

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Tische</h1>
          <p className="text-sm text-gray-500">
            {tabsQuery.data?.length ?? 0} offene Tische
          </p>
        </div>
        <Button onClick={() => { setFehler(null); setNeuerTischOffen(true) }}>
          + Neuer Tisch
        </Button>
      </div>

      {tabsQuery.isLoading && (
        <p className="text-sm text-gray-500">Wird geladen…</p>
      )}
      {tabsQuery.isError && (
        <p className="text-sm text-red-600">Fehler beim Laden der Tische.</p>
      )}

      {tabsQuery.data && tabsQuery.data.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-500">Keine offenen Tische.</p>
          <p className="mt-1 text-sm text-gray-400">Klicke auf «+ Neuer Tisch» um einen zu öffnen.</p>
        </div>
      )}

      {tabsQuery.data && tabsQuery.data.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {tabsQuery.data.map((tab) => (
            <TischKarte key={tab.id} tab={tab} onClick={() => navigate(`/tische/${tab.id}`)} />
          ))}
        </div>
      )}

      <Modal
        open={neuerTischOffen}
        onClose={() => setNeuerTischOffen(false)}
        title="Neuen Tisch öffnen"
      >
        <NeuerTischForm
          kasseId={identity.kasseId}
          loading={erstelleMutation.isPending}
          fehler={fehler}
          onSubmit={(input) => { setFehler(null); erstelleMutation.mutate(input) }}
          onAbbrechen={() => setNeuerTischOffen(false)}
        />
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tisch-Karte
// ---------------------------------------------------------------------------

function TischKarte({ tab, onClick }: { tab: TischTabResponse; onClick: () => void }) {
  const minOffen = Math.floor(
    (Date.now() - new Date(tab.geoffnetAm).getTime()) / 60_000,
  )
  const dauerText = minOffen < 60
    ? `${minOffen} Min.`
    : `${Math.floor(minOffen / 60)}h ${minOffen % 60}m`

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative rounded-xl border-2 border-orange-300 bg-orange-50 p-4 text-left transition hover:border-orange-500 hover:bg-orange-100 hover:shadow-md"
    >
      <p className="text-2xl font-bold text-orange-700">{tab.tischNummer}</p>
      <p className="mt-0.5 text-xs font-medium text-orange-600 truncate">{tab.kellner}</p>
      <p className="mt-2 text-sm font-semibold text-gray-900">
        {formatPreis(tab.summeGesamtCent)}
      </p>
      <p className="text-xs text-gray-500">
        {tab.positionen.reduce((n, p) => n + p.menge, 0)} Pos. · {dauerText}
      </p>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Formular: Neuer Tisch
// ---------------------------------------------------------------------------

interface NeuerTischFormProps {
  kasseId:     string
  loading:     boolean
  fehler:      string | null
  onSubmit:    (input: TischTabErstellenInput) => void
  onAbbrechen: () => void
}

function NeuerTischForm({ kasseId, loading, fehler, onSubmit, onAbbrechen }: NeuerTischFormProps) {
  const [tischNummer, setTischNummer] = useState('')
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
