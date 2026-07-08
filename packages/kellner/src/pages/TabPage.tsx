import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import type { TabPosition } from '@kassa/shared'
import { tischTabApi, bonierApi, druckerApi, oeffentlicherBelegApi, zvtApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { KartenzahlungOverlay } from '../components/KartenzahlungOverlay'

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

  // Kartenzahlung: ZVT-Konfiguration der Kasse + Overlay-Zustand
  const [karteOffen, setKarteOffen] = useState(false)
  const zvtCfg = useQuery({
    queryKey: ['zvt', tabQuery.data?.kasseId],
    queryFn:  () => zvtApi.getConfig(tabQuery.data!.kasseId),
    enabled:  !!tabQuery.data?.kasseId,
  })

  // Foto-Beleg: nach der Zahlung den vollständigen Beleg laden (digital/beides) —
  // wird am Handy-Bildschirm angezeigt, der Gast fotografiert ihn ab.
  const fotoBeleg = useQuery({
    queryKey: ['foto-beleg', bezahltBeleg?.belegId],
    queryFn:  () => oeffentlicherBelegApi.get(bezahltBeleg!.belegId),
    enabled:  !!bezahltBeleg &&
              (druckerCfg.data?.belegModus === 'digital' || druckerCfg.data?.belegModus === 'beides'),
  })

  const bezahleMutation = useMutation({
    mutationFn: ({ art, trinkgeldCent = 0 }: { art: 'bar' | 'karte'; trinkgeldCent?: number }) => {
      const t = tabQuery.data!
      return tischTabApi.bezahle(t.id, {
        zahlung: {
          barCent:      art === 'bar'   ? t.summeGesamtCent : 0,
          karteCent:    art === 'karte' ? t.summeGesamtCent : 0,
          sonstigeCent: 0,
        },
        ...(trinkgeldCent > 0 ? { trinkgeldCent } : {}),
      })
    },
    onSuccess: (res, vars) => {
      setKarteOffen(false)
      setBezahltBeleg({ belegId: res.belegId, betragCent: tabQuery.data!.summeGesamtCent + (vars.trinkgeldCent ?? 0) })
    },
    onError: (err) => { setKarteOffen(false); setBonierFehler(err instanceof Error ? err.message : 'Fehler beim Kassieren') },
  })

  /** Karte: bei aktivem ZVT ans Terminal (Overlay mit Trinkgeld), sonst direkt buchen. */
  const handleKarte = () => {
    setBonierFehler(null)
    if (zvtCfg.data?.zvtAktiv) { setKarteOffen(true); return }
    bezahleMutation.mutate({ art: 'karte' })
  }

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

          <div className="flex gap-2">
            <button
              onClick={() => { setBonierFehler(null); bezahleMutation.mutate({ art: 'bar' }) }}
              disabled={bezahleMutation.isPending}
              className="flex-1 py-4 rounded-2xl bg-green-600 text-white font-black text-base active:scale-95 transition disabled:opacity-50"
            >
              {bezahleMutation.isPending ? '⏳…' : `💶 Bar · ${formatPreis(tab.summeGesamtCent)}`}
            </button>
            <button
              onClick={handleKarte}
              disabled={bezahleMutation.isPending}
              className="flex-1 py-4 rounded-2xl bg-blue-600 text-white font-black text-base active:scale-95 transition disabled:opacity-50"
            >
              {`💳 Karte · ${formatPreis(tab.summeGesamtCent)}`}
            </button>
          </div>
        </div>
      )}

      {/* Kartenzahlung: Trinkgeld + ZVT-Terminal (nur bei aktivem ZVT) */}
      {karteOffen && tab && (
        <KartenzahlungOverlay
          kasseId={tab.kasseId}
          betragCent={tab.summeGesamtCent}
          onErfolg={(trinkgeldCent) => bezahleMutation.mutate({ art: 'karte', trinkgeldCent })}
          onAbbruch={() => { setKarteOffen(false); setBonierFehler('Kartenzahlung abgebrochen — kein Beleg erstellt') }}
        />
      )}

      {/* Bezahlt-Overlay: Foto-Beleg (vollständiger Beleg inkl. RKSV-QR am Handy-Bildschirm,
          der Gast fotografiert ihn ab) + Akzeptiert/Nicht-akzeptiert */}
      {bezahltBeleg && (() => {
        const modus = druckerCfg.data?.belegModus
        const fb    = fotoBeleg.data
        return (
          <div className="fixed inset-0 z-50 bg-surface flex flex-col p-5 max-w-lg mx-auto overflow-y-auto">
            <div className="text-center space-y-1 mb-4 mt-2">
              <p className="text-4xl">✅</p>
              <p className="text-2xl font-black text-ink">Bezahlt</p>
              <p className="text-xl font-mono font-bold text-ink">{formatPreis(bezahltBeleg.betragCent)}</p>
            </div>
            {(modus === 'digital' || modus === 'beides') && fb && (
              <div className="bg-white text-gray-900 rounded-2xl px-5 py-4 mb-4 shadow-lg">
                <div className="text-center border-b border-dashed border-gray-300 pb-2">
                  <p className="text-lg font-black">{fb.firmenname}</p>
                  <p className="text-xs text-gray-500">UID: {fb.uid} · Beleg #{fb.beleg.belegNummer}</p>
                </div>
                <table className="w-full text-sm my-2">
                  <tbody>
                    {fb.beleg.positionen.map((p, i) => (
                      <tr key={i}>
                        <td className="py-0.5 pr-2">{p.menge}× {p.bezeichnung}</td>
                        <td className="py-0.5 text-right font-mono whitespace-nowrap">{formatPreis(p.einzelpreisBreutto * p.menge)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex justify-between font-black border-t-2 border-gray-900 pt-1.5">
                  <span>Gesamt</span><span className="font-mono">{formatPreis(fb.beleg.gesamtbetragCent)}</span>
                </div>
                <div className="mt-3 flex flex-col items-center gap-1.5">
                  <QRCodeSVG value={fb.beleg.maschinenlesbareCode} size={170} level="M" includeMargin />
                  <p className="text-sm font-bold">Digitaler Beleg — bitte abfotografieren</p>
                </div>
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
