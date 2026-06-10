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

// ---------------------------------------------------------------------------
// Haupt-Komponente
// ---------------------------------------------------------------------------

export function ArtikelWaehlenPage() {
  const { tabId } = useParams<{ tabId: string }>()
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const identity  = getKasseIdentity()!
  const auth      = getAuth()!

  const [aktivKat,       setAktivKat]       = useState<string | null>(null)
  const [korb,           setKorb]           = useState<KorbItem[]>([])
  const [phase,          setPhase]          = useState<Phase>('artikel')
  const [aktuellerArtikel, setAktuellerArtikel] = useState<Artikel | null>(null)
  const [aktuelleGruppen,  setAktuelleGruppen]  = useState<ModifikatorGruppe[]>([])
  const [modAuswahl,     setModAuswahl]     = useState<Map<string, string[]>>(new Map())
  const [fehler,         setFehler]         = useState<string | null>(null)

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

  const kategorien = katQuery.data ?? []
  const alleArtikel = artikelQuery.data ?? []

  // Erste Kategorie vorbelegen
  if (kategorien.length > 0 && aktivKat === null) {
    setAktivKat(kategorien[0]!.id)
  }

  const artikelInKat = alleArtikel
    .filter(a => a.kategorieId === aktivKat)
    .sort((a, b) => a.reihenfolge - b.reihenfolge)

  function mengeVon(artikelId: string) {
    return korb.filter(k => k.artikel.id === artikelId).reduce((s, k) => s + k.menge, 0)
  }

  async function artikelWaehlen(artikel: Artikel) {
    const gruppen = await modifikatorApi.getGruppenFuerArtikel(artikel.id).catch(() => [])
    const pflicht = gruppen.filter(g => g.typ === 'pflicht' && g.aktiv)
    if (pflicht.length > 0) {
      setAktuellerArtikel(artikel)
      setAktuelleGruppen(gruppen.filter(g => g.aktiv))
      setModAuswahl(new Map())
      setPhase('modifikatoren')
    } else {
      addToKorb(artikel, 1, [])
    }
  }

  function addToKorb(artikel: Artikel, menge: number, modifikatoren: ModifikatorAuswahl[]) {
    setKorb(prev => {
      const idx = prev.findIndex(k =>
        k.artikel.id === artikel.id &&
        JSON.stringify(k.modifikatoren) === JSON.stringify(modifikatoren)
      )
      if (idx === -1) return [...prev, { artikel, menge, modifikatoren }]
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

  function modToggle(gruppeId: string, modId: string, maxAuswahl: number | null) {
    setModAuswahl(prev => {
      const next = new Map(prev)
      const aktuelle = next.get(gruppeId) ?? []
      if (aktuelle.includes(modId)) {
        next.set(gruppeId, aktuelle.filter(id => id !== modId))
      } else if (maxAuswahl === null || aktuelle.length < maxAuswahl) {
        next.set(gruppeId, [...aktuelle, modId])
      } else if (maxAuswahl === 1) {
        next.set(gruppeId, [modId])
      }
      return next
    })
  }

  function modBestätigen() {
    if (!aktuellerArtikel) return
    const pflichtGruppen = aktuelleGruppen.filter(g => g.typ === 'pflicht')
    for (const g of pflichtGruppen) {
      if (!modAuswahl.get(g.id)?.length) {
        setFehler(`Bitte "${g.name}" wählen`)
        return
      }
    }
    const mods: ModifikatorAuswahl[] = []
    for (const g of aktuelleGruppen) {
      const gewaehlte = modAuswahl.get(g.id) ?? []
      for (const modId of gewaehlte) {
        const mod = g.modifikatoren.find(m => m.id === modId)
        if (mod) mods.push({
          modifikatorId: mod.id,
          gruppeId:      g.id,
          gruppeName:    g.name,
          name:          mod.name,
          aufschlagCent: mod.aufschlagCent,
        })
      }
    }
    const aufschlag = mods.reduce((s, m) => s + m.aufschlagCent, 0)
    addToKorb(
      { ...aktuellerArtikel, preisBruttoCent: aktuellerArtikel.preisBruttoCent + aufschlag },
      1,
      mods,
    )
    setPhase('artikel')
    setAktuellerArtikel(null)
    setFehler(null)
  }

  const speichernMutation = useMutation({
    mutationFn: async () => {
      const tab = await tischTabApi.get(tabId!)
      const neuePositionen = [
        ...tab.positionen,
        ...korb.map(k => ({
          artikelId:       k.artikel.id,
          bezeichnung:     k.artikel.bezeichnung,
          preisBruttoCent: k.artikel.preisBruttoCent,
          menge:           k.menge,
          station:         k.artikel.station ?? undefined,
          modifikatoren:   k.modifikatoren.length > 0 ? k.modifikatoren : undefined,
        })),
      ]
      return tischTabApi.aktualisierePositionen(tab.id, neuePositionen)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tisch-tab', tabId] })
      navigate(`/tab/${tabId}`)
    },
    onError: (err) => setFehler(err instanceof Error ? err.message : 'Fehler'),
  })

  const korbGesamt  = korb.reduce((s, k) => s + k.artikel.preisBruttoCent * k.menge, 0)
  const korbAnzahl  = korb.reduce((s, k) => s + k.menge, 0)

  // ---------------------------------------------------------------------------
  // Modifikatoren-Screen
  // ---------------------------------------------------------------------------

  if (phase === 'modifikatoren' && aktuellerArtikel) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col max-w-lg mx-auto">
        <div className="bg-white border-b border-gray-200 px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
          <button onClick={() => { setPhase('artikel'); setFehler(null) }} className="text-gray-400 text-2xl leading-none">‹</button>
          <div className="flex-1">
            <h1 className="font-black text-gray-900 text-lg leading-tight">{aktuellerArtikel.bezeichnung}</h1>
            <p className="text-xs text-gray-500">Optionen wählen</p>
          </div>
        </div>

        <div className="flex-1 p-4 space-y-5 pb-32">
          {aktuelleGruppen.map(g => (
            <div key={g.id}>
              <div className="flex items-center gap-2 mb-2">
                <p className="font-bold text-gray-900 text-sm">{g.name}</p>
                {g.typ === 'pflicht' && (
                  <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-bold">Pflicht</span>
                )}
                {g.maxAuswahl && g.typ !== 'pflicht' && (
                  <span className="text-xs text-gray-400">max. {g.maxAuswahl}</span>
                )}
              </div>
              <div className="space-y-2">
                {g.modifikatoren.filter(m => m.aktiv).map(m => {
                  const sel = modAuswahl.get(g.id)?.includes(m.id) ?? false
                  return (
                    <button
                      key={m.id}
                      onClick={() => modToggle(g.id, m.id, g.maxAuswahl)}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition ${
                        sel ? 'border-green-500 bg-green-50' : 'border-gray-200 bg-white'
                      }`}
                    >
                      <span className={`font-semibold text-sm ${sel ? 'text-green-800' : 'text-gray-900'}`}>
                        {m.name}
                      </span>
                      <span className={`text-sm font-mono ${sel ? 'text-green-700' : 'text-gray-500'}`}>
                        {m.aufschlagCent > 0 ? `+${formatPreis(m.aufschlagCent)}` : ''}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="fixed bottom-0 left-0 right-0 max-w-lg mx-auto bg-white border-t border-gray-200 p-4 space-y-2">
          {fehler && <p className="text-red-500 text-sm text-center">{fehler}</p>}
          <button
            onClick={modBestätigen}
            className="w-full py-4 rounded-2xl bg-green-600 text-white font-black text-lg active:scale-95 transition"
          >
            Hinzufügen
          </button>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Artikel-Screen
  // ---------------------------------------------------------------------------

  const isLoading = katQuery.isLoading || artikelQuery.isLoading

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-lg mx-auto">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-4 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(`/tab/${tabId}`)} className="text-gray-400 text-2xl leading-none">‹</button>
          <h1 className="font-black text-gray-900 text-lg flex-1">Artikel wählen</h1>
          <span className="text-xs text-gray-400">{auth.user.name}</span>
        </div>

        {/* Kategorie-Tabs */}
        {kategorien.length > 0 && (
          <div className="mt-3 flex gap-1 overflow-x-auto pb-1 scrollbar-none">
            {kategorien.map(k => (
              <button
                key={k.id}
                onClick={() => setAktivKat(k.id)}
                className={`px-4 py-1.5 rounded-xl text-sm font-bold whitespace-nowrap transition shrink-0 ${
                  aktivKat === k.id
                    ? 'bg-green-600 text-white'
                    : 'text-gray-600 hover:bg-gray-100'
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
            <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isLoading && artikelInKat.length === 0 && (
          <div className="text-center py-12 text-gray-400 text-sm">
            Keine Artikel in dieser Kategorie.
          </div>
        )}

        {artikelInKat.map(a => {
          const menge = mengeVon(a.id)
          const ausverkauft = a.lagerstandMenge !== null && a.lagerstandMenge !== undefined && a.lagerstandMenge <= 0
          return (
            <div
              key={a.id}
              className={`bg-white rounded-2xl border border-gray-200 px-4 py-3 flex items-center gap-3 ${ausverkauft ? 'opacity-40' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-gray-900 text-sm leading-tight">{a.bezeichnung}</p>
                <p className="text-green-700 font-black text-base mt-0.5">{formatPreis(a.preisBruttoCent)}</p>
                {ausverkauft && <p className="text-xs text-red-500 font-bold">Ausverkauft</p>}
              </div>

              {ausverkauft ? (
                <div className="w-10 h-10 shrink-0" />
              ) : menge === 0 ? (
                <button
                  onClick={() => artikelWaehlen(a)}
                  className="w-10 h-10 rounded-xl bg-green-600 text-white font-black text-xl flex items-center justify-center active:scale-90 transition shrink-0"
                >
                  +
                </button>
              ) : (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => removeFromKorb(a.id)}
                    className="w-9 h-9 rounded-xl border-2 border-green-300 text-green-600 font-black text-xl flex items-center justify-center active:scale-90 transition"
                  >
                    −
                  </button>
                  <span className="w-6 text-center font-black text-gray-900">{menge}</span>
                  <button
                    onClick={() => artikelWaehlen(a)}
                    className="w-9 h-9 rounded-xl bg-green-600 text-white font-black text-xl flex items-center justify-center active:scale-90 transition"
                  >
                    +
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer */}
      {korbAnzahl > 0 && (
        <div className="fixed bottom-0 left-0 right-0 max-w-lg mx-auto bg-white border-t border-gray-200 p-4 space-y-2">
          {fehler && <p className="text-red-500 text-sm text-center">{fehler}</p>}
          <button
            onClick={() => speichernMutation.mutate()}
            disabled={speichernMutation.isPending}
            className="w-full py-4 rounded-2xl bg-green-600 text-white font-black text-lg active:scale-95 transition disabled:opacity-50 flex items-center justify-between px-6"
          >
            <span className="bg-green-500 rounded-xl px-2 py-0.5 text-sm">{korbAnzahl} Artikel</span>
            <span>{speichernMutation.isPending ? 'Wird gespeichert…' : 'Zum Tab hinzufügen'}</span>
            <span className="font-mono">{formatPreis(korbGesamt)}</span>
          </button>
        </div>
      )}
    </div>
  )
}
