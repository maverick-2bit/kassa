/**
 * LieferungenPage — Eingehende Lieferbestellungen von Lieferando / Mergeport.
 *
 * Zeigt die Bestellungsqueue mit Status-Management:
 *   neu → bestaetigt → fertig
 * sowie Ablehnen / Stornieren.
 *
 * Neue Bestellungen werden per SSE (NeueBestellungEvent) automatisch
 * nachgeladen ohne Seiten-Reload.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LieferbestellungResponse, LieferbestellungStatus } from '@kassa/shared'
import { LIEFERBESTELLUNG_STATUS_LABELS, LIEFERBESTELLUNG_PROVIDER_LABELS } from '@kassa/shared'
import { lieferApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { useKasseEvents } from '../lib/sse'

// ---------------------------------------------------------------------------
// Farb-Mapping
// ---------------------------------------------------------------------------

const STATUS_FARBE: Record<LieferbestellungStatus, string> = {
  neu:        'bg-amber-100 text-amber-800 border-amber-200',
  bestaetigt: 'bg-blue-100  text-blue-800  border-blue-200',
  fertig:     'bg-green-100 text-green-800 border-green-200',
  abgelehnt:  'bg-red-100   text-red-800   border-red-200',
  storniert:  'bg-gray-100  text-gray-600  border-gray-200',
}

const PROVIDER_FARBE: Record<string, string> = {
  lieferando: 'bg-orange-100 text-orange-800',
  mergeport:  'bg-purple-100 text-purple-800',
  custom:     'bg-gray-100   text-gray-700',
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export function LieferungenPage() {
  const identity    = getKasseIdentity()!
  const queryClient = useQueryClient()
  const [detail, setDetail]   = useState<LieferbestellungResponse | null>(null)
  const [fehler,  setFehler]  = useState<string | null>(null)

  // Abfrage
  const liste = useQuery({
    queryKey: ['lieferbestellungen', identity.kasseId],
    queryFn:  () => lieferApi.list(identity.kasseId, { limit: 200 }),
    refetchInterval: 60_000,   // Fallback-Poll alle 60s
  })

  const webhookUrls = useQuery({
    queryKey: ['webhook-urls', identity.kasseId],
    queryFn:  () => lieferApi.webhookUrls(identity.kasseId),
    staleTime: Infinity,
  })

  // SSE — neue Bestellung sofort nachladen
  useKasseEvents((event) => {
    if (event.typ === 'neue_bestellung') {
      void queryClient.invalidateQueries({ queryKey: ['lieferbestellungen', identity.kasseId] })
    }
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['lieferbestellungen', identity.kasseId] })

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: LieferbestellungStatus }) =>
      lieferApi.updateStatus(id, { status }),
    onSuccess:  () => { setDetail(null); invalidate() },
    onError:    (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  // Neu-Badge-Zähler
  const neuAnzahl = (liste.data ?? []).filter(b => b.status === 'neu').length

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:py-8 space-y-6">

      {/* Kopfzeile */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            Lieferbestellungen
            {neuAnzahl > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 rounded-full bg-amber-500 text-white text-xs font-bold px-1.5">
                {neuAnzahl}
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Eingehende Bestellungen von Lieferando, Mergeport und eigenen Quellen
          </p>
        </div>
      </div>

      {fehler && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {fehler}
        </div>
      )}

      {/* Webhook-Setup */}
      <WebhookSetupKarte {...(webhookUrls.data ? { urls: webhookUrls.data } : {})} />

      {/* Bestellungs-Liste */}
      {liste.isLoading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
          Wird geladen…
        </div>
      ) : liste.isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700 text-center">
          Fehler beim Laden: {liste.error instanceof Error ? liste.error.message : 'Unbekannt'}
        </div>
      ) : !liste.data || liste.data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="text-3xl mb-2">🛵</p>
          <p className="text-gray-500 text-sm">Noch keine Bestellungen eingegangen.</p>
          <p className="text-xs text-gray-400 mt-1">
            Richte den Webhook bei deinem Lieferdienst ein — neue Bestellungen erscheinen hier automatisch.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {liste.data.map((b) => (
            <BestellungKarte
              key={b.id}
              bestellung={b}
              onClick={() => setDetail(b)}
              onStatusChange={(status) => statusMut.mutate({ id: b.id, status })}
              loading={statusMut.isPending && statusMut.variables?.id === b.id}
            />
          ))}
        </div>
      )}

      {/* Detail-Modal */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={`Bestellung #${detail?.externeId}`}
        size="lg"
      >
        {detail && (
          <BestellungDetail
            bestellung={detail}
            onStatusChange={(status) => statusMut.mutate({ id: detail.id, status })}
            loading={statusMut.isPending}
            fehler={fehler}
            onClose={() => setDetail(null)}
          />
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bestellungs-Karte (Listenansicht)
// ---------------------------------------------------------------------------

function BestellungKarte({
  bestellung: b,
  onClick,
  onStatusChange,
  loading,
}: {
  bestellung:   LieferbestellungResponse
  onClick:      () => void
  onStatusChange: (s: LieferbestellungStatus) => void
  loading:      boolean
}) {
  const istAktiv = b.status === 'neu' || b.status === 'bestaetigt'

  return (
    <div
      className={`rounded-lg border bg-white shadow-sm transition
        ${b.status === 'neu' ? 'border-amber-300 shadow-amber-100' : 'border-gray-200'}`}
    >
      <div
        className="px-4 py-3 cursor-pointer hover:bg-gray-50 rounded-t-lg"
        onClick={onClick}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Provider-Badge */}
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${PROVIDER_FARBE[b.provider] ?? 'bg-gray-100 text-gray-700'}`}>
                {LIEFERBESTELLUNG_PROVIDER_LABELS[b.provider] ?? b.provider}
              </span>
              {/* Status-Badge */}
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${STATUS_FARBE[b.status]}`}>
                {LIEFERBESTELLUNG_STATUS_LABELS[b.status]}
              </span>
              <span className="text-xs text-gray-400">#{b.externeId}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-3 flex-wrap text-sm text-gray-600">
              {b.lieferName    && <span className="font-medium text-gray-800">{b.lieferName}</span>}
              {b.lieferTelefon && <span>📞 {b.lieferTelefon}</span>}
              {b.lieferAdresse && <span className="truncate max-w-xs">📍 {b.lieferAdresse}</span>}
            </div>
            <p className="mt-1 text-xs text-gray-400">
              {b.positionen.length} Pos. · {new Date(b.createdAt).toLocaleString('de-AT')}
            </p>
          </div>
          <p className="text-lg font-bold text-gray-900 shrink-0">
            {formatPreis(b.gesamtbetragCent)}
          </p>
        </div>
      </div>

      {/* Schnell-Aktionen */}
      {istAktiv && (
        <div className="px-4 py-2 border-t border-gray-100 flex gap-2 flex-wrap">
          {b.status === 'neu' && (
            <Button
              size="sm"
              onClick={(e) => { e.stopPropagation(); onStatusChange('bestaetigt') }}
              loading={loading}
            >
              ✓ Bestätigen
            </Button>
          )}
          {b.status === 'bestaetigt' && (
            <Button
              size="sm"
              onClick={(e) => { e.stopPropagation(); onStatusChange('fertig') }}
              loading={loading}
            >
              ✓ Fertig
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            onClick={(e) => { e.stopPropagation(); onStatusChange('abgelehnt') }}
            loading={loading}
          >
            ✗ Ablehnen
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail-Modal-Inhalt
// ---------------------------------------------------------------------------

function BestellungDetail({
  bestellung: b,
  onStatusChange,
  loading,
  fehler,
  onClose,
}: {
  bestellung:   LieferbestellungResponse
  onStatusChange: (s: LieferbestellungStatus) => void
  loading:      boolean
  fehler:       string | null
  onClose:      () => void
}) {
  const istAktiv = b.status === 'neu' || b.status === 'bestaetigt'

  const druckenMut = useMutation({
    mutationFn: () => lieferApi.drucken(b.id),
  })

  return (
    <div className="space-y-4">
      {/* Provider + Status */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-sm font-semibold px-2.5 py-1 rounded-full ${PROVIDER_FARBE[b.provider] ?? 'bg-gray-100 text-gray-700'}`}>
          {LIEFERBESTELLUNG_PROVIDER_LABELS[b.provider] ?? b.provider}
        </span>
        <span className={`text-sm font-semibold px-2.5 py-1 rounded-full border ${STATUS_FARBE[b.status]}`}>
          {LIEFERBESTELLUNG_STATUS_LABELS[b.status]}
        </span>
        <span className="text-sm text-gray-400 ml-auto">
          {new Date(b.createdAt).toLocaleString('de-AT')}
        </span>
      </div>

      {/* Kundendaten */}
      {(b.lieferName || b.lieferTelefon || b.lieferAdresse) && (
        <div className="rounded-md bg-gray-50 border border-gray-200 px-4 py-3 space-y-1 text-sm">
          {b.lieferName    && <p><span className="text-gray-500 mr-2">Kunde:</span><strong>{b.lieferName}</strong></p>}
          {b.lieferTelefon && <p><span className="text-gray-500 mr-2">Telefon:</span>{b.lieferTelefon}</p>}
          {b.lieferAdresse && <p><span className="text-gray-500 mr-2">Adresse:</span>{b.lieferAdresse}</p>}
        </div>
      )}

      {/* Positionen */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Bestellpositionen</p>
        <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 overflow-hidden">
          {b.positionen.map((p, i) => (
            <li key={i} className="flex justify-between items-start px-3 py-2.5 text-sm bg-white">
              <div className="flex-1 min-w-0">
                <span className="font-medium text-gray-800">{p.bezeichnung}</span>
                {p.notiz && <p className="text-xs text-gray-400 mt-0.5">{p.notiz}</p>}
              </div>
              <div className="text-right shrink-0 ml-4">
                <span className="text-gray-500 mr-2">×{p.menge}</span>
                <span className="font-mono font-semibold text-gray-900">
                  {formatPreis(p.einzelpreisBreuttoCent * p.menge)}
                </span>
              </div>
            </li>
          ))}
          <li className="flex justify-between px-3 py-2.5 text-sm font-bold bg-gray-50">
            <span>Gesamt</span>
            <span className="font-mono">{formatPreis(b.gesamtbetragCent)}</span>
          </li>
        </ul>
      </div>

      {/* Notiz */}
      {b.notiz && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span className="font-medium">Hinweis: </span>{b.notiz}
        </div>
      )}

      {fehler && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {fehler}
        </div>
      )}

      {/* Aktionen */}
      <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
        {b.status === 'neu' && (
          <Button onClick={() => onStatusChange('bestaetigt')} loading={loading}>
            ✓ Bestätigen
          </Button>
        )}
        {b.status === 'bestaetigt' && (
          <Button onClick={() => onStatusChange('fertig')} loading={loading}>
            ✓ Als fertig markieren
          </Button>
        )}
        {istAktiv && (
          <Button variant="danger" onClick={() => onStatusChange('abgelehnt')} loading={loading}>
            ✗ Ablehnen
          </Button>
        )}
        {(b.status === 'bestaetigt' || b.status === 'fertig') && (
          <Button variant="secondary" onClick={() => onStatusChange('storniert')} loading={loading}>
            Stornieren
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => druckenMut.mutate()}
          loading={druckenMut.isPending}
        >
          🖨️ Drucken
        </Button>
        <Button variant="secondary" onClick={onClose} className="ml-auto">
          Schließen
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Webhook-Setup-Karte
// ---------------------------------------------------------------------------

function WebhookSetupKarte({
  urls,
}: {
  urls?: { webhookSecret: string; urls: { lieferando: string; mergeport: string; custom: string } }
}) {
  const [offen, setOffen] = useState(false)
  const [kopiert, setKopiert] = useState<string | null>(null)

  const kopiere = (text: string, key: string) => {
    void navigator.clipboard.writeText(text)
    setKopiert(key)
    setTimeout(() => setKopiert(null), 1500)
  }

  return (
    <details className="rounded-lg border border-gray-200 bg-white" open={offen} onToggle={(e) => setOffen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-lg select-none">
        🔗 Webhook-URLs einrichten
        {!offen && <span className="ml-2 text-xs text-gray-400 font-normal">— Lieferando, Mergeport, eigene Integration</span>}
      </summary>
      <div className="border-t border-gray-200 px-4 py-4 space-y-4">
        <p className="text-sm text-gray-500">
          Trage diese URLs als Webhook-Ziel in deinen Lieferdienst ein.
          Das Secret ist bereits in der URL enthalten — bitte vertraulich behandeln.
        </p>
        {urls ? (
          <div className="space-y-3">
            {(Object.entries(urls.urls) as [keyof typeof urls.urls, string][]).map(([provider, url]) => (
              <div key={provider}>
                <p className="text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wide">
                  {LIEFERBESTELLUNG_PROVIDER_LABELS[provider] ?? provider}
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-gray-100 border border-gray-200 px-3 py-2 text-xs font-mono text-gray-700 break-all select-all">
                    {url}
                  </code>
                  <button
                    type="button"
                    onClick={() => kopiere(url, provider)}
                    className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-700 border border-brand-300 rounded px-2 py-1.5 hover:bg-brand-50 transition"
                  >
                    {kopiert === provider ? '✓' : 'Kopieren'}
                  </button>
                </div>
              </div>
            ))}
            <p className="text-xs text-gray-400">
              Das Secret lautet: <code className="bg-gray-100 px-1 rounded">{urls.webhookSecret}</code>
            </p>
          </div>
        ) : (
          <p className="text-sm text-gray-400">Wird geladen…</p>
        )}
      </div>
    </details>
  )
}
