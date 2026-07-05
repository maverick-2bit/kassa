import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import type { Artikel, ModifikatorGruppe, ModifikatorAuswahl } from '@kassa/shared'
import { artikelApi, kategorieApi, modifikatorApi, tischTabApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface KorbItem {
  artikel:       Artikel
  menge:         number
  modifikatoren: ModifikatorAuswahl[]
}

type Phase = 'artikel' | 'modifikatoren'

// gruppeId → (modId → menge)
type ModMengenMap = Map<string, Map<string, number>>

// ---------------------------------------------------------------------------
// Haupt-Komponente
// ---------------------------------------------------------------------------

export function ArtikelWaehlenPage() {
  const { tabId } = useParams<{ tabId: string }>()
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const identity  = getKasseIdentity()!
  const auth      = getAuth()!

  const [aktivKat,         setAktivKat]         = useState<string | null>(null)
  const [korb,             setKorb]             = useState<KorbItem[]>([])
  const [phase,            setPhase]            = useState<Phase>('artikel')
  const [aktuellerArtikel, setAktuellerArtikel] = useState<Artikel | null>(null)
  const [aktuelleGruppen,  setAktuelleGruppen]  = useState<ModifikatorGruppe[]>([])
  const [modMengen,        setModMengen]        = useState<ModMengenMap>(new Map())
  const [artikelMenge,     setArtikelMenge]     = useState(1)
  const [fehler,           setFehler]           = useState<string | null>(null)

  const katQuery = useQuery({
    queryKey: ['kategorien'],
    queryFn:  () => kategorieApi.list(true),
    staleTime: 30_000,
  })

  const artikelQuery = useQuery({
    queryKey: ['artikel', identity.mandantId],
    queryFn:  () => artikelApi.list(identity.mandantId),
    staleTime: 30_000,
  })

  const kategorien  = katQuery.data ?? []
  const alleArtikel = artikelQuery.data ?? []

  if (kategorien.length > 0 && aktivKat === null) {
    setAktivKat(kategorien[0]!.id)
  }

  const artikelInKat = alleArtikel
    .filter(a => a.kategorieId === aktivKat)
    .sort((a, b) => a.reihenfolge - b.reihenfolge)

  function mengeImKorb(artikelId: string) {
    return korb.filter(k => k.artikel.id === artikelId).reduce((s, k) => s + k.menge, 0)
  }

  // ---------------------------------------------------------------------------
  // Modifikator-Mengen-Helfer
  // ---------------------------------------------------------------------------

  function getModMenge(gruppeId: string, modId: string): number {
    return modMengen.get(gruppeId)?.get(modId) ?? 0
  }

  function gruppenGesamtMenge(gruppeId: string): number {
    const m = modMengen.get(gruppeId)
    if (!m) return 0
    return [...m.values()].reduce((s, v) => s + v, 0)
  }

  function aendereModMenge(gruppeId: string, modId: string, delta: number, maxAuswahl: number | null) {
    setModMengen(prev => {
      const next = new Map(prev)
      const gruppe = new Map(next.get(gruppeId) ?? [])
      const aktuell = gruppe.get(modId) ?? 0
      const neu = Math.max(0, aktuell + delta)

      if (delta > 0 && maxAuswahl !== null) {
        const gesamtOhneAktuell = gruppenGesamtMenge(gruppeId) - aktuell
        if (gesamtOhneAktuell + neu > maxAuswahl) return prev
      }

      if (neu === 0) gruppe.delete(modId)
      else gruppe.set(modId, neu)

      next.set(gruppeId, gruppe)
      return next
    })
  }

  // ---------------------------------------------------------------------------
  // Artikel-Screen: Artikel ohne Modifikatoren direkt in Korb
  // ---------------------------------------------------------------------------

  async function artikelWaehlen(a: Artikel) {
    const gruppen = await modifikatorApi.getGruppenFuerArtikel(a.id).catch(() => [])
    const aktiv   = gruppen.filter(g => g.aktiv)
    if (aktiv.length > 0) {
      setAktuellerArtikel(a)
      setAktuelleGruppen(aktiv)
      setModMengen(new Map())
      setArtikelMenge(1)
      setFehler(null)
      setPhase('modifikatoren')
    } else {
      addToKorb(a, 1, [])
    }
  }

  function addToKorb(a: Artikel, menge: number, mods: ModifikatorAuswahl[]) {
    setKorb(prev => {
      const idx = prev.findIndex(k =>
        k.artikel.id === a.id &&
        JSON.stringify(k.modifikatoren) === JSON.stringify(mods)
      )
      if (idx === -1) return [...prev, { artikel: a, menge, modifikatoren: mods }]
      return prev.map((k, i) => i === idx ? { ...k, menge: k.menge + menge } : k)
    })
  }

  function removeFromKorb(artikelId: string) {
    setKorb(prev => {
      const idx = [...prev].reverse().findIndex(k => k.artikel.id === artikelId)
      if (idx === -1) return prev
      const realIdx = prev.length - 1 - idx
      const item = prev[realIdx]!
      if (item.menge <= 1) return prev.filter((_, i) => i !== realIdx)
      return prev.map((k, i) => i === realIdx ? { ...k, menge: k.menge - 1 } : k)
    })
  }

  // ---------------------------------------------------------------------------
  // Modifikatoren-Screen: Validierung + Buchung
  // ---------------------------------------------------------------------------

  /** Validiert, baut Mods-Array und bucht in den Korb. Gibt false zurück bei Fehler. */
  function versucheHinzufügen(): boolean {
    if (!aktuellerArtikel) return false

    for (const g of aktuelleGruppen.filter(g => g.typ === 'pflicht')) {
      if (gruppenGesamtMenge(g.id) === 0) {
        setFehler(`Bitte mindestens eine Option für „${g.name}" wählen`)
        return false
      }
    }

    const mods: ModifikatorAuswahl[] = []
    for (const g of aktuelleGruppen) {
      const gruppeMap = modMengen.get(g.id)
      if (!gruppeMap) continue
      for (const [modId, menge] of gruppeMap) {
        if (menge === 0) continue
        const mod = g.modifikatoren.find(m => m.id === modId)
        if (mod) mods.push({
          modifikatorId: mod.id,
          gruppeId:      g.id,
          gruppeName:    g.name,
          name:          mod.name,
          aufschlagCent: mod.aufschlagCent,
          menge,
        })
      }
    }

    // Gesamtaufschlag: Aufschlag × Menge pro Mod
    const aufschlag = mods.reduce((s, m) => s + m.aufschlagCent * (m.menge ?? 1), 0)
    addToKorb(
      { ...aktuellerArtikel, preisBruttoCent: aktuellerArtikel.preisBruttoCent + aufschlag },
      artikelMenge,
      mods,
    )
    setFehler(null)
    return true
  }

  function buchenUndWeiter() {
    if (!versucheHinzufügen()) return
    setPhase('artikel')
    setAktuellerArtikel(null)
  }

  function nochEinmal() {
    if (!versucheHinzufügen()) return
    // Selber Artikel, komplett frische Konfiguration
    setModMengen(new Map())
    setArtikelMenge(1)
    setFehler(null)
  }

  // ---------------------------------------------------------------------------
  // Zum Tab bonieren
  // ---------------------------------------------------------------------------

  const speichernMutation = useMutation({
    mutationFn: async () => {
      const tab = await tischTabApi.get(tabId!)
      return tischTabApi.aktualisierePositionen(tab.id, [
        ...tab.positionen,
        ...korb.map(k => ({
          artikelId:       k.artikel.id,
          bezeichnung:     k.artikel.bezeichnung,
          preisBruttoCent: k.artikel.preisBruttoCent,
          menge:           k.menge,
          station:         k.artikel.station ?? undefined,
          modifikatoren:   k.modifikatoren.length > 0 ? k.modifikatoren : undefined,
        })),
      ])
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tisch-tab', tabId] })
      navigate(`/tab/${tabId}`)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : 'Fehler'),
  })

  const korbGesamt = korb.reduce((s, k) => s + k.artikel.preisBruttoCent * k.menge, 0)
  const korbAnzahl = korb.reduce((s, k) => s + k.menge, 0)

  // ---------------------------------------------------------------------------
  // Modifikatoren-Screen
  // ---------------------------------------------------------------------------

  if (phase === 'modifikatoren' && aktuellerArtikel) {
    const basisPreis = aktuellerArtikel.preisBruttoCent
    // Vorschau-Gesamtpreis inklusive aller gewählten Aufschläge × Mengen
    const aufschlagVorschau = aktuelleGruppen.flatMap(g =>
      g.modifikatoren.map(m => (modMengen.get(g.id)?.get(m.id) ?? 0) * m.aufschlagCent)
    ).reduce((s, v) => s + v, 0)
    const einzelPreis = basisPreis + aufschlagVorschau
    const gesamtPreis = einzelPreis * artikelMenge

    return (
      <div className="min-h-screen bg-surface flex flex-col max-w-lg mx-auto">

        {/* Header */}
        <div className="bg-panel border-b border-line px-4 py-4 sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setPhase('artikel'); setFehler(null) }}
              className="text-ink-subtle text-2xl leading-none shrink-0"
            >‹</button>
            <div className="flex-1 min-w-0">
              <h1 className="font-black text-ink text-lg leading-tight truncate">
                {aktuellerArtikel.bezeichnung}
              </h1>
              <p className="text-xs text-ink-subtle">Optionen &amp; Menge</p>
            </div>
          </div>

          {/* Artikelmenge-Zähler */}
          <div className="mt-3 flex items-center justify-between bg-surface rounded-2xl px-4 py-3">
            <div>
              <p className="text-xs text-ink-subtle font-medium">Anzahl</p>
              <p className="text-sm font-mono text-ink-muted mt-0.5">
                {formatPreis(einzelPreis)} × {artikelMenge} = <span className="font-black text-brand-700">{formatPreis(gesamtPreis)}</span>
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setArtikelMenge(m => Math.max(1, m - 1))}
                className="w-10 h-10 rounded-xl border-2 border-brand-300 text-brand-700 font-black text-xl flex items-center justify-center active:scale-90 transition"
              >−</button>
              <span className="w-8 text-center font-black text-xl text-ink">{artikelMenge}</span>
              <button
                onClick={() => setArtikelMenge(m => m + 1)}
                className="w-10 h-10 rounded-xl bg-brand-600 text-white font-black text-xl flex items-center justify-center active:scale-90 transition"
              >+</button>
            </div>
          </div>
        </div>

        {/* Gruppen */}
        <div className="flex-1 p-4 space-y-6 pb-36">
          {aktuelleGruppen.map(g => {
            const gesamtMenge = gruppenGesamtMenge(g.id)
            const maxErreicht = g.maxAuswahl !== null && gesamtMenge >= g.maxAuswahl

            return (
              <div key={g.id}>
                <div className="flex items-center gap-2 mb-3">
                  <p className="font-black text-ink">{g.name}</p>
                  {g.typ === 'pflicht' ? (
                    <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-bold">
                      Pflicht
                    </span>
                  ) : (
                    <span className="text-xs bg-panel-2 text-ink-subtle px-2 py-0.5 rounded-full">
                      Optional
                    </span>
                  )}
                  {g.maxAuswahl !== null && (
                    <span className="text-xs text-ink-subtle ml-auto">
                      {gesamtMenge}/{g.maxAuswahl}
                    </span>
                  )}
                </div>

                <div className="space-y-2">
                  {g.modifikatoren.filter(m => m.aktiv).map(m => {
                    const menge   = getModMenge(g.id, m.id)
                    const gesperrt = menge === 0 && maxErreicht

                    return (
                      <div
                        key={m.id}
                        className={`bg-panel rounded-2xl border-2 px-4 py-3 flex items-center gap-3 transition ${
                          menge > 0
                            ? 'border-brand-500'
                            : gesperrt
                            ? 'border-line opacity-40'
                            : 'border-line'
                        }`}
                      >
                        {/* Name + Aufschlag */}
                        <div className="flex-1 min-w-0">
                          <p className={`font-semibold text-sm ${menge > 0 ? 'text-brand-900' : 'text-ink'}`}>
                            {m.name}
                          </p>
                          {m.aufschlagCent !== 0 && (
                            <p className={`text-xs font-mono mt-0.5 ${m.aufschlagCent > 0 ? 'text-orange-600' : 'text-brand-600'}`}>
                              {m.aufschlagCent > 0 ? '+' : ''}{formatPreis(m.aufschlagCent)}
                            </p>
                          )}
                        </div>

                        {/* Menge-Zähler */}
                        {menge === 0 ? (
                          <button
                            onClick={() => aendereModMenge(g.id, m.id, 1, g.maxAuswahl)}
                            disabled={gesperrt}
                            className="w-9 h-9 rounded-xl bg-brand-600 text-white font-black text-xl flex items-center justify-center active:scale-90 transition disabled:opacity-30 shrink-0"
                          >+</button>
                        ) : (
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => aendereModMenge(g.id, m.id, -1, g.maxAuswahl)}
                              className="w-8 h-8 rounded-xl border-2 border-brand-300 text-brand-700 font-black text-lg flex items-center justify-center active:scale-90 transition"
                            >−</button>
                            <span className="w-6 text-center font-black text-ink text-sm">{menge}</span>
                            <button
                              onClick={() => aendereModMenge(g.id, m.id, 1, g.maxAuswahl)}
                              disabled={maxErreicht}
                              className="w-8 h-8 rounded-xl bg-brand-600 text-white font-black text-lg flex items-center justify-center active:scale-90 transition disabled:opacity-30"
                            >+</button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer: zwei Buttons */}
        <div className="fixed bottom-0 left-0 right-0 max-w-lg mx-auto bg-panel border-t border-line p-4 space-y-2">
          {fehler && <p className="text-red-500 text-sm text-center font-medium">{fehler}</p>}

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={nochEinmal}
              className="py-4 rounded-2xl border-2 border-brand-500 text-brand-700 font-black text-sm active:scale-95 transition flex flex-col items-center gap-0.5"
            >
              <span>Noch einmal</span>
              <span className="text-xs font-normal text-brand-600 opacity-80">{aktuellerArtikel.bezeichnung}</span>
            </button>

            <button
              onClick={buchenUndWeiter}
              className="py-4 rounded-2xl bg-brand-600 text-white font-black text-sm active:scale-95 transition flex flex-col items-center gap-0.5"
            >
              <span>Buchen &amp; weiter</span>
              <span className="text-xs font-normal opacity-80">{formatPreis(gesamtPreis)}</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Artikel-Screen
  // ---------------------------------------------------------------------------

  const isLoading = katQuery.isLoading || artikelQuery.isLoading

  return (
    <div className="min-h-screen bg-surface flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <div className="bg-panel border-b border-line px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(`/tab/${tabId}`)} className="text-ink-subtle text-2xl leading-none">‹</button>
          <h1 className="font-black text-ink text-lg flex-1">Artikel wählen</h1>
          <span className="text-xs text-ink-subtle">{auth.user.name}</span>
        </div>

        {kategorien.length > 0 && (
          <div className="mt-3 flex gap-1 overflow-x-auto pb-1 scrollbar-none">
            {kategorien.map(k => (
              <button
                key={k.id}
                onClick={() => setAktivKat(k.id)}
                className={`px-4 py-1.5 rounded-xl text-sm font-bold whitespace-nowrap transition shrink-0 ${
                  aktivKat === k.id
                    ? 'bg-brand-600 text-white'
                    : 'text-ink-muted hover:bg-panel-2'
                }`}
              >
                {k.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Artikel */}
      <div className="flex-1 p-4 space-y-2 pb-36">
        {isLoading && (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isLoading && artikelInKat.length === 0 && (
          <div className="text-center py-12 text-ink-subtle text-sm">
            Keine Artikel in dieser Kategorie.
          </div>
        )}

        {artikelInKat.map(a => {
          const menge      = mengeImKorb(a.id)
          const ausverkauft = a.lagerstandMenge !== null && a.lagerstandMenge !== undefined && a.lagerstandMenge <= 0
          return (
            <div
              key={a.id}
              className={`bg-panel rounded-2xl border border-line px-4 py-3 flex items-center gap-3 ${ausverkauft ? 'opacity-40' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-ink text-sm leading-tight">{a.bezeichnung}</p>
                <p className="text-brand-700 font-black text-base mt-0.5">{formatPreis(a.preisBruttoCent)}</p>
                {ausverkauft && <p className="text-xs text-red-500 font-bold">Ausverkauft</p>}
              </div>

              {ausverkauft ? (
                <div className="w-10 h-10 shrink-0" />
              ) : menge === 0 ? (
                <button
                  onClick={() => artikelWaehlen(a)}
                  className="w-10 h-10 rounded-xl bg-brand-600 text-white font-black text-xl flex items-center justify-center active:scale-90 transition shrink-0"
                >+</button>
              ) : (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => removeFromKorb(a.id)}
                    className="w-9 h-9 rounded-xl border-2 border-brand-300 text-brand-600 font-black text-xl flex items-center justify-center active:scale-90 transition"
                  >−</button>
                  <span className="w-6 text-center font-black text-ink">{menge}</span>
                  <button
                    onClick={() => artikelWaehlen(a)}
                    className="w-9 h-9 rounded-xl bg-brand-600 text-white font-black text-xl flex items-center justify-center active:scale-90 transition"
                  >+</button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer */}
      {korbAnzahl > 0 && (
        <div className="fixed bottom-0 left-0 right-0 max-w-lg mx-auto bg-panel border-t border-line p-4 space-y-2">
          {fehler && <p className="text-red-500 text-sm text-center">{fehler}</p>}
          <button
            onClick={() => speichernMutation.mutate()}
            disabled={speichernMutation.isPending}
            className="w-full py-4 rounded-2xl bg-brand-600 text-white font-black text-lg active:scale-95 transition disabled:opacity-50 flex items-center justify-between px-6"
          >
            <span className="bg-brand-500 rounded-xl px-2 py-0.5 text-sm">{korbAnzahl} Artikel</span>
            <span>{speichernMutation.isPending ? 'Wird gespeichert…' : 'Zum Tab hinzufügen'}</span>
            <span className="font-mono">{formatPreis(korbGesamt)}</span>
          </button>
        </div>
      )}
    </div>
  )
}
