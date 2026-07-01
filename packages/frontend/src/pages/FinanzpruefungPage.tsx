import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { finanzpruefungApi, type PruefungsTokenRow } from '../lib/api'
import { getAuth } from '../lib/auth'
import { Button } from '../components/ui/Button'

function formatDatum(iso: string): string {
  return new Date(iso).toLocaleString('de-AT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Vienna',
  })
}

function istAbgelaufen(token: PruefungsTokenRow): boolean {
  return new Date(token.gueltigBis) < new Date()
}

function pruefungsUrl(token: string): string {
  return `${window.location.origin}/pruefung/${token}`
}

export function FinanzpruefungPage() {
  const auth   = getAuth()
  const kassen = auth?.kassen ?? []
  const qc     = useQueryClient()

  const [kasseId,  setKasseId]  = useState(kassen[0]?.id ?? '')
  const [tage,     setTage]     = useState(30)
  const [beschreibung, setBeschreibung] = useState('')
  const [kopiertId,    setKopiertId]   = useState<string | null>(null)

  const tokensQuery = useQuery({
    queryKey: ['pruefungs-tokens', kasseId],
    queryFn:  () => finanzpruefungApi.listeTokens(kasseId),
    enabled:  !!kasseId,
  })

  const erstelleMutation = useMutation({
    mutationFn: () => finanzpruefungApi.erstelleToken(kasseId, tage, beschreibung || undefined),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['pruefungs-tokens', kasseId] })
      setBeschreibung('')
    },
  })

  const widerrufMutation = useMutation({
    mutationFn: (id: string) => finanzpruefungApi.widerruf(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['pruefungs-tokens', kasseId] }),
  })

  async function kopieren(token: string, id: string) {
    await navigator.clipboard.writeText(pruefungsUrl(token))
    setKopiertId(id)
    setTimeout(() => setKopiertId(null), 2000)
  }

  const tokens = tokensQuery.data ?? []

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-ink mb-1">Finanzprüfungs-Modus</h1>
      <p className="text-sm text-ink-muted mb-8">
        Erstelle zeitlich begrenzte Prüfer-Links, über die das Finanzamt oder der Steuerberater
        Belege einsehen und DEP7-Dateien herunterladen kann — ohne Admin-Zugang.
      </p>

      {/* Kasse wählen */}
      <section className="bg-panel border border-line rounded-xl p-6 mb-5 space-y-3">
        <h2 className="font-semibold text-ink">Kasse</h2>
        <div className="flex flex-wrap gap-2">
          {kassen.map(k => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKasseId(k.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition ${
                kasseId === k.id
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'bg-panel text-ink border-line-strong hover:border-brand-400'
              }`}
            >
              {k.bezeichnung ?? k.kassenId}
            </button>
          ))}
        </div>
      </section>

      {/* Neuen Token erstellen */}
      <section className="bg-panel border border-line rounded-xl p-6 mb-5 space-y-4">
        <h2 className="font-semibold text-ink">Neuen Prüfer-Link erstellen</h2>

        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">
            Gültigkeitsdauer
          </label>
          <div className="flex gap-2 flex-wrap">
            {[7, 14, 30, 60, 90].map(d => (
              <button
                key={d}
                type="button"
                onClick={() => setTage(d)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium border transition ${
                  tage === d
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'bg-panel text-ink border-line-strong hover:border-brand-400'
                }`}
              >
                {d} Tage
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">
            Beschreibung (optional)
          </label>
          <input
            type="text"
            value={beschreibung}
            onChange={e => setBeschreibung(e.target.value)}
            placeholder="z. B. Jahresprüfung 2025 – Finanzamt Wien"
            maxLength={200}
            className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {erstelleMutation.isError && (
          <p className="text-sm text-red-600">
            {erstelleMutation.error instanceof Error ? erstelleMutation.error.message : 'Fehler beim Erstellen'}
          </p>
        )}

        <Button
          variant="primary"
          disabled={!kasseId || erstelleMutation.isPending}
          loading={erstelleMutation.isPending}
          onClick={() => erstelleMutation.mutate()}
        >
          Prüfer-Link erstellen
        </Button>
      </section>

      {/* Token-Liste */}
      <section className="bg-panel border border-line rounded-xl p-6">
        <h2 className="font-semibold text-ink mb-4">Ausgestellte Links</h2>

        {tokensQuery.isLoading ? (
          <p className="text-sm text-ink-subtle">Lädt…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-ink-subtle">Noch keine Prüfer-Links erstellt.</p>
        ) : (
          <div className="space-y-3">
            {tokens.map(t => {
              const abgelaufen  = istAbgelaufen(t)
              const ungueltig   = t.widerrufen || abgelaufen
              return (
                <div
                  key={t.id}
                  className={`rounded-lg border p-4 space-y-2 ${
                    ungueltig ? 'border-line bg-panel-2 opacity-60' : 'border-line'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      {t.beschreibung && (
                        <p className="text-sm font-medium text-ink">{t.beschreibung}</p>
                      )}
                      <p className="text-xs text-ink-muted">
                        Erstellt: {formatDatum(t.erstelltAm)} · Gültig bis: {formatDatum(t.gueltigBis)}
                      </p>
                      {t.letzteVerwendung && (
                        <p className="text-xs text-ink-subtle">
                          Zuletzt abgerufen: {formatDatum(t.letzteVerwendung)}
                        </p>
                      )}
                    </div>
                    <span className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                      t.widerrufen
                        ? 'bg-red-100 text-red-700'
                        : abgelaufen
                          ? 'bg-panel-2 text-ink-muted'
                          : 'bg-green-100 text-green-700'
                    }`}>
                      {t.widerrufen ? 'Widerrufen' : abgelaufen ? 'Abgelaufen' : 'Aktiv'}
                    </span>
                  </div>

                  {!ungueltig && (
                    <div className="flex gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => kopieren(t.token, t.id)}
                        className="text-xs text-brand-600 hover:text-brand-800 font-medium"
                      >
                        {kopiertId === t.id ? '✓ Kopiert' : 'Link kopieren'}
                      </button>
                      <a
                        href={pruefungsUrl(t.token)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-brand-600 hover:text-brand-800 font-medium"
                      >
                        Öffnen →
                      </a>
                      <button
                        type="button"
                        onClick={() => widerrufMutation.mutate(t.id)}
                        disabled={widerrufMutation.isPending}
                        className="text-xs text-red-500 hover:text-red-700 font-medium"
                      >
                        Widerrufen
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <div className="mt-6 rounded-xl border border-blue-200 bg-blue-50 px-5 py-4 space-y-1">
        <p className="text-xs font-semibold text-blue-800">Hinweis zur Sicherheit</p>
        <p className="text-xs text-blue-700 leading-relaxed">
          Prüfer-Links gewähren Read-only-Zugriff auf alle Belege der Kasse.
          Widerrufe Links sofort nach Abschluss der Prüfung. Teile Links nur über sichere Kanäle.
        </p>
      </div>
    </div>
  )
}
