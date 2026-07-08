import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import type { TabPosition } from '@kassa/shared'
import { tischTabApi, bonierApi, druckerApi, type DruckerConfig } from '../lib/api'
import { getAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'

/** URL zur öffentlichen Beleg-Ansicht (Ziel des QR); null bei reinem Druck-Modus. */
function digitalerBelegUrl(cfg: DruckerConfig | undefined, belegId: string): string | null {
  if (!cfg || cfg.belegModus === 'drucken') return null
  const basis = (cfg.belegBasisUrl?.trim() || window.location.origin).replace(/\/+$/, '')
  return `${basis}/beleg/${belegId}`
}

export function TabPage() {
  const { tabId }   = useParams<{ tabId: string }>()
  const navigate    = useNavigate()
  const qc          = useQueryClient()
  const identity    = getKasseIdentity()!
  const auth        = getAuth()!
  const [bonierFehler, setBonierFehler] = useState<string | null>(null)
  const [bonierErfolg, setBonierErfolg] = useState(false)

  const tabQuery = useQuery({
    queryKey:        ['tisch-tab', tabId],
    queryFn:         () => tischTabApi.get(tabId!),
    refetchInterval: 10_000,
    enabled:         !!tabId,
  })

  const bonierMutation = useMutation({
    mutationFn: () => {
      const tab = tabQuery.data!
      return bonierApi.bonieren({
        kasseId:    identity.kasseId,
        tabId:      tab.id,
        tisch:      tab.tischNummer,
        kellner:    auth.user.name,
        positionen: tab.positionen.map(p => ({
          artikelId: p.artikelId,
          menge:     p.menge,
        })),
      })
    },
    onSuccess: () => {
      setBonierErfolg(true)
      qc.invalidateQueries({ queryKey: ['tisch-tab', tabId] })
      setTimeout(() => setBonierErfolg(false), 3000)
    },
    onError: (err) => setBonierFehler(err instanceof Error ? err.message : 'Fehler beim Bonieren'),
  })

  // ---- Kassieren (Bar) + digitaler Beleg ----
  const [bezahltBeleg, setBezahltBeleg]   = useState<{ belegId: string; betragCent: number } | null>(null)
  const [ausweichFehler, setAusweichFehler] = useState<string | null>(null)

  const fertig = () => {
    setBezahltBeleg(null)
    setAusweichFehler(null)
    qc.invalidateQueries({ queryKey: ['tisch-tab', tabId] })
    navigate('/')
  }

  const druckerCfg = useQuery({
    queryKey: ['drucker', tabQuery.data?.kasseId],
    queryFn:  () => druckerApi.get(tabQuery.data!.kasseId),
    enabled:  !!tabQuery.data?.kasseId,
  })

  const bezahleMutation = useMutation({
    mutationFn: () => {
      const t = tabQuery.data!
      return tischTabApi.bezahle(t.id, { zahlung: { barCent: t.summeGesamtCent, karteCent: 0, sonstigeCent: 0 } })
    },
    onSuccess: (res) => setBezahltBeleg({ belegId: res.belegId, betragCent: tabQuery.data!.summeGesamtCent }),
    onError:   (err) => setBonierFehler(err instanceof Error ? err.message : 'Fehler beim Kassieren'),
  })

  const nichtAkzeptiertMutation = useMutation({
    mutationFn: (belegId: string) => druckerApi.druckenAusweich(belegId),
    onSuccess:  () => fertig(),
    onError:    (err) => setAusweichFehler(err instanceof Error ? err.message : 'Ausweich-Druck fehlgeschlagen'),
  })

  function positionEntfernen(idx: number) {
    const tab = tabQuery.data!
    const neuePositionen = tab.positionen.filter((_, i) => i !== idx)
    tischTabApi.aktualisierePositionen(tab.id, neuePositionen)
      .then(() => qc.invalidateQueries({ queryKey: ['tisch-tab', tabId] }))
      .catch(() => {/* ignore */})
  }

  if (tabQuery.isLoading) return (
    <div className="min-h-screen bg-surface flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!tabQuery.data) return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <div className="text-center space-y-3">
        <p className="text-4xl">⚠️</p>
        <p className="text-ink-muted">Tab nicht gefunden.</p>
        <button onClick={() => navigate('/')} className="text-brand-600 font-bold text-sm">
          Zurück zur Übersicht
        </button>
      </div>
    </div>
  )

  const tab = tabQuery.data

  // Positionen gruppiert anzeigen (gleicher Artikel zusammenfassen)
  interface GruppiertePos {
    key:             string
    artikelId:       string
    bezeichnung:     string
    preisBruttoCent: number
    menge:           number
    modifikatoren:   TabPosition['modifikatoren']
    indices:         number[]
  }
  const gruppen = tab.positionen.reduce<GruppiertePos[]>((acc, pos, idx) => {
    const modKey = JSON.stringify(pos.modifikatoren ?? [])
    const key    = `${pos.artikelId}__${modKey}`
    const existing = acc.find(g => g.key === key)
    if (existing) {
      existing.menge += pos.menge
      existing.indices.push(idx)
    } else {
      acc.push({
        key,
        artikelId:       pos.artikelId,
        bezeichnung:     pos.bezeichnung,
        preisBruttoCent: pos.preisBruttoCent,
        menge:           pos.menge,
        modifikatoren:   pos.modifikatoren,
        indices:         [idx],
      })
    }
    return acc
  }, [])

  return (
    <div className="min-h-screen bg-surface flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <div className="bg-panel border-b border-line px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/')} className="text-ink-subtle hover:text-ink-muted text-2xl leading-none">
            ‹
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-black text-ink text-lg leading-tight truncate">{tab.tischNummer}</h1>
            <p className="text-xs text-ink-subtle">{tab.kellner}</p>
          </div>
          <button
            onClick={() => navigate(`/tab/${tabId}/artikel`)}
            className="bg-brand-600 text-white px-4 py-2 rounded-xl font-bold text-sm active:scale-95 transition shrink-0"
          >
            + Artikel
          </button>
        </div>
      </div>

      {/* Positionen */}
      <div className="flex-1 p-4 space-y-2 pb-36">
        {gruppen.length === 0 ? (
          <div className="text-center py-16 space-y-2">
            <p className="text-4xl">🍽</p>
            <p className="text-ink-subtle text-sm">Noch keine Artikel</p>
            <button
              onClick={() => navigate(`/tab/${tabId}/artikel`)}
              className="text-brand-600 font-bold text-sm"
            >
              Artikel hinzufügen
            </button>
          </div>
        ) : (
          gruppen.map(g => (
            <div key={g.key} className="bg-panel rounded-2xl border border-line px-4 py-3 flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-brand-100 flex items-center justify-center text-brand-700 font-black text-sm shrink-0 mt-0.5">
                {g.menge}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-ink text-sm leading-tight">{g.bezeichnung}</p>
                {(g.modifikatoren?.length ?? 0) > 0 && (
                  <p className="text-xs text-ink-subtle mt-0.5">
                    {g.modifikatoren!.map(m => m.name).join(', ')}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="font-mono text-sm font-semibold text-ink">
                  {formatPreis(g.preisBruttoCent * g.menge)}
                </p>
                <button
                  onClick={() => positionEntfernen(g.indices[g.indices.length - 1]!)}
                  className="text-xs text-red-400 hover:text-red-600 mt-1"
                >
                  −1
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer: Summe + Bonieren */}
      {gruppen.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 max-w-lg mx-auto bg-panel border-t border-line p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-ink-muted">Gesamt</span>
            <span className="font-black text-xl font-mono text-ink">{formatPreis(tab.summeGesamtCent)}</span>
          </div>

          {bonierFehler && (
            <p className="text-red-500 text-sm text-center">{bonierFehler}</p>
          )}
          {bonierErfolg && (
            <p className="text-brand-600 text-sm text-center font-bold">✓ Bon wurde gesendet</p>
          )}

          <button
            onClick={() => { setBonierFehler(null); bonierMutation.mutate() }}
            disabled={bonierMutation.isPending}
            className="w-full py-4 rounded-2xl bg-brand-600 text-white font-black text-lg active:scale-95 transition disabled:opacity-50"
          >
            {bonierMutation.isPending ? '⏳ Wird gesendet…' : '🍳 Bonieren'}
          </button>

          <button
            onClick={() => { setBonierFehler(null); bezahleMutation.mutate() }}
            disabled={bezahleMutation.isPending}
            className="w-full py-4 rounded-2xl bg-green-600 text-white font-black text-lg active:scale-95 transition disabled:opacity-50"
          >
            {bezahleMutation.isPending ? '⏳ Kassiere…' : `💶 Kassieren (Bar) · ${formatPreis(tab.summeGesamtCent)}`}
          </button>
        </div>
      )}

      {/* Bezahlt-Overlay: digitaler Beleg (QR) + Akzeptiert/Nicht-akzeptiert */}
      {bezahltBeleg && (() => {
        const url   = digitalerBelegUrl(druckerCfg.data, bezahltBeleg.belegId)
        const modus = druckerCfg.data?.belegModus
        return (
          <div className="fixed inset-0 z-50 bg-surface flex flex-col items-center justify-center p-6 max-w-lg mx-auto">
            <div className="text-center space-y-1 mb-6">
              <p className="text-5xl">✅</p>
              <p className="text-2xl font-black text-ink">Bezahlt</p>
              <p className="text-xl font-mono font-bold text-ink">{formatPreis(bezahltBeleg.betragCent)}</p>
            </div>
            {url && (
              <div className="flex flex-col items-center gap-3 mb-6">
                <div className="rounded-2xl bg-white p-4"><QRCodeSVG value={url} size={200} level="M" includeMargin /></div>
                <p className="text-lg font-bold text-ink">Beleg scannen</p>
              </div>
            )}
            {modus === 'digital' ? (
              <div className="w-full space-y-3">
                <p className="text-center text-sm text-ink-muted">Hat der Gast den digitalen Beleg angenommen?</p>
                <button onClick={fertig} className="w-full py-4 rounded-2xl bg-brand-600 text-white font-black text-lg active:scale-95 transition">
                  Akzeptiert
                </button>
                <button
                  onClick={() => { setAusweichFehler(null); nichtAkzeptiertMutation.mutate(bezahltBeleg.belegId) }}
                  disabled={nichtAkzeptiertMutation.isPending}
                  className="w-full py-4 rounded-2xl border border-line-strong bg-panel text-ink font-black text-lg active:scale-95 transition disabled:opacity-50"
                >
                  {nichtAkzeptiertMutation.isPending ? 'Drucke…' : 'Nicht akzeptiert (drucken)'}
                </button>
                {ausweichFehler && <p className="text-center text-sm text-red-500">{ausweichFehler}</p>}
              </div>
            ) : (
              <button onClick={fertig} className="w-full py-4 rounded-2xl bg-brand-600 text-white font-black text-lg active:scale-95 transition">
                Fertig
              </button>
            )}
          </div>
        )
      })()}
    </div>
  )
}
