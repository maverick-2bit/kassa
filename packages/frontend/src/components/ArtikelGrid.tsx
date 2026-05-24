/**
 * ArtikelGrid — wiederverwendbares Artikel-Raster mit Kategorie-Tabs.
 * Wird in KassePage und TischTabPage eingesetzt.
 *
 * Layout:
 *  - Kategorie-Leiste: horizontal scrollbar, Touch-optimiert, Fade-Ränder
 *  - Artikel-Raster:   immer 3 Spalten, vertikal scrollbar innerhalb des Containers
 *
 * Damit der interne Scroll funktioniert muss der Parent-Container
 * eine definierte Höhe haben (flex-1 min-h-0 oder max-h-[...]).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Artikel, Kategorie, KategorieFarbe, ModifikatorAuswahl, ModifikatorGruppe } from '@kassa/shared'
import { formatPreis } from '../lib/format'
import { ModifikatorModal } from './ModifikatorModal'

// ---------------------------------------------------------------------------
// Farb-Mapping
// ---------------------------------------------------------------------------

const FARBE_TAB_INAKTIV: Record<KategorieFarbe, string> = {
  grau:   'bg-gray-100 text-gray-700 hover:bg-gray-200',
  rot:    'bg-red-50 text-red-700 hover:bg-red-100',
  orange: 'bg-orange-50 text-orange-700 hover:bg-orange-100',
  gelb:   'bg-yellow-50 text-yellow-700 hover:bg-yellow-100',
  gruen:  'bg-green-50 text-green-700 hover:bg-green-100',
  blau:   'bg-blue-50 text-blue-700 hover:bg-blue-100',
  lila:   'bg-purple-50 text-purple-700 hover:bg-purple-100',
  pink:   'bg-pink-50 text-pink-700 hover:bg-pink-100',
}

const FARBE_TAB_AKTIV: Record<KategorieFarbe, string> = {
  grau:   'bg-gray-600 text-white',
  rot:    'bg-red-600 text-white',
  orange: 'bg-orange-500 text-white',
  gelb:   'bg-yellow-500 text-white',
  gruen:  'bg-green-600 text-white',
  blau:   'bg-blue-600 text-white',
  lila:   'bg-purple-600 text-white',
  pink:   'bg-pink-500 text-white',
}

const FARBE_ARTIKEL_HOVER: Record<KategorieFarbe, string> = {
  grau:   'hover:border-gray-400 hover:bg-gray-50',
  rot:    'hover:border-red-400 hover:bg-red-50',
  orange: 'hover:border-orange-400 hover:bg-orange-50',
  gelb:   'hover:border-yellow-400 hover:bg-yellow-50',
  gruen:  'hover:border-green-400 hover:bg-green-50',
  blau:   'hover:border-blue-400 hover:bg-blue-50',
  lila:   'hover:border-purple-400 hover:bg-purple-50',
  pink:   'hover:border-pink-400 hover:bg-pink-50',
}

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface Props {
  artikel:              Artikel[]
  kategorien:           Kategorie[]
  /** Wenn gesetzt: Artikel mit Modifikator-Gruppen öffnen erst einen Auswahl-Dialog */
  artikelGruppen?:      Map<string, ModifikatorGruppe[]>
  onArtikelClick:       (a: Artikel, modifikatoren: ModifikatorAuswahl[]) => void
  loading?:             boolean
  /** Wenn gesetzt: nur diese Kategorie-IDs im Tab anzeigen (leer = alle) */
  sichtbareKategorieIds?: string[] | undefined
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

// Sentinel für den Favoriten-Tab
const FAVORITEN_TAB_ID = '__favoriten__'

export function ArtikelGrid({ artikel, kategorien, artikelGruppen, onArtikelClick, loading, sichtbareKategorieIds }: Props) {
  const [aktivKategorieId, setAktivKategorieId] = useState<string | null>(null)
  const [modArtikel, setModArtikel] = useState<Artikel | null>(null)

  // Scroll-State für Fade-Ränder der Kategorieleiste
  const scrollRef    = useRef<HTMLDivElement>(null)
  const [fadeLinks,  setFadeLinks]  = useState(false)
  const [fadeRechts, setFadeRechts] = useState(false)

  const aktiveKategorien = useMemo(() => {
    const sorted = kategorien
      .filter((k) => k.aktiv)
      .sort((a, b) => a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name))
    // Kassen-Sichtbarkeit: wenn IDs gesetzt, nur diese anzeigen
    if (sichtbareKategorieIds && sichtbareKategorieIds.length > 0) {
      return sorted.filter(k => sichtbareKategorieIds.includes(k.id))
    }
    return sorted
  }, [kategorien, sichtbareKategorieIds])

  const favoriten = useMemo(
    () =>
      artikel
        .filter(a => a.istFavorit)
        .sort((a, b) => a.favoritenReihenfolge - b.favoritenReihenfolge || a.bezeichnung.localeCompare(b.bezeichnung)),
    [artikel],
  )

  const anzahlProKategorie = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of artikel) {
      if (a.kategorieId) map.set(a.kategorieId, (map.get(a.kategorieId) ?? 0) + 1)
    }
    return map
  }, [artikel])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const check = () => {
      setFadeLinks(el.scrollLeft > 4)
      setFadeRechts(el.scrollLeft < el.scrollWidth - el.clientWidth - 4)
    }
    check()
    el.addEventListener('scroll', check, { passive: true })
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', check); ro.disconnect() }
  }, [aktiveKategorien.length])

  const gefilterteArtikel = useMemo(() => {
    if (aktivKategorieId === FAVORITEN_TAB_ID) return favoriten
    if (aktivKategorieId === null) {
      // "Alle"-Tab: nach reihenfolge sortieren
      return [...artikel].sort((a, b) => a.reihenfolge - b.reihenfolge || a.bezeichnung.localeCompare(b.bezeichnung))
    }
    return artikel
      .filter(a => a.kategorieId === aktivKategorieId)
      .sort((a, b) => a.reihenfolge - b.reihenfolge || a.bezeichnung.localeCompare(b.bezeichnung))
  }, [aktivKategorieId, artikel, favoriten])

  const aktiveKategorie = aktiveKategorien.find((k) => k.id === aktivKategorieId)

  // ---------------------------------------------------------------------------

  if (loading) {
    return <p className="text-sm text-gray-500">Wird geladen…</p>
  }

  if (artikel.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-gray-300 p-6 text-center">
        <p className="text-sm text-gray-500">Noch keine Artikel angelegt.</p>
        <a href="/artikel" className="mt-2 inline-block text-sm text-brand-600 hover:underline">
          Zur Artikel-Verwaltung →
        </a>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">

      {/* ---- Kategorie-Leiste (bleibt oben) ---- */}
      {(aktiveKategorien.length > 0 || favoriten.length > 0) && (
        <div className="relative shrink-0 mb-3">
          {fadeLinks && (
            <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-8 z-10
                            bg-gradient-to-r from-white to-transparent" />
          )}
          {fadeRechts && (
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 z-10
                            bg-gradient-to-l from-white to-transparent" />
          )}
          <div ref={scrollRef} className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            {/* Favoriten-Tab (nur wenn es Favoriten gibt) */}
            {favoriten.length > 0 && (
              <TabBtn
                aktiv={aktivKategorieId === FAVORITEN_TAB_ID}
                onClick={() => setAktivKategorieId(
                  aktivKategorieId === FAVORITEN_TAB_ID ? null : FAVORITEN_TAB_ID,
                )}
                klassen={
                  aktivKategorieId === FAVORITEN_TAB_ID
                    ? 'bg-amber-500 text-white'
                    : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                }
              >
                ⭐ Favoriten <Anzahl wert={favoriten.length} aktiv={aktivKategorieId === FAVORITEN_TAB_ID} />
              </TabBtn>
            )}

            <TabBtn
              aktiv={aktivKategorieId === null}
              onClick={() => setAktivKategorieId(null)}
              klassen={aktivKategorieId === null ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-700 hover:bg-brand-100'}
            >
              Alle <Anzahl wert={artikel.length} aktiv={aktivKategorieId === null} />
            </TabBtn>

            {aktiveKategorien.map((k) => {
              const isAktiv = k.id === aktivKategorieId
              const anzahl  = anzahlProKategorie.get(k.id) ?? 0
              return (
                <TabBtn
                  key={k.id}
                  aktiv={isAktiv}
                  onClick={() => setAktivKategorieId(isAktiv ? null : k.id)}
                  klassen={isAktiv ? FARBE_TAB_AKTIV[k.farbe] : FARBE_TAB_INAKTIV[k.farbe]}
                >
                  {k.name}
                  {anzahl > 0 && <Anzahl wert={anzahl} aktiv={isAktiv} />}
                </TabBtn>
              )
            })}
          </div>
        </div>
      )}

      {/* ---- Artikel-Raster (scrollt vertikal) ---- */}
      {gefilterteArtikel.length === 0 ? (
        <p className="text-sm text-gray-400 py-4 text-center shrink-0">
          Keine Artikel in dieser Kategorie.
        </p>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto pr-0.5">
          <div className="grid grid-cols-3 gap-2 pb-1">
            {gefilterteArtikel.map((a) => {
              const farbe         = aktiveKategorie?.farbe
              const gruppen       = artikelGruppen?.get(a.id) ?? []
              const hatMods       = gruppen.length > 0
              // Artikel ist ausverkauft wenn Lagerstand aktiv UND Bestand = 0
              const istAusverkauft = a.lagerstandAktiv && a.lagerstandMenge === 0
              // Zeigt Restbestand wenn Lagerstand aktiv und > 0
              const zeigeBestand  = a.lagerstandAktiv && a.lagerstandMenge !== null && a.lagerstandMenge > 0

              const handleClick = () => {
                if (istAusverkauft) return
                if (hatMods) {
                  setModArtikel(a)
                } else {
                  onArtikelClick(a, [])
                }
              }

              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={istAusverkauft}
                  onClick={handleClick}
                  className={`
                    rounded-lg border bg-white transition p-3 text-left shadow-sm
                    ${istAusverkauft
                      ? 'border-gray-200 opacity-50 cursor-not-allowed'
                      : `active:scale-[0.97] border-gray-200 ${farbe
                          ? FARBE_ARTIKEL_HOVER[farbe]
                          : 'hover:bg-brand-50 hover:border-brand-400'
                        }`
                    }
                  `}
                >
                  <p className="text-sm font-medium text-gray-900 line-clamp-2 min-h-[2.5rem]">
                    {a.bezeichnung}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                    <p className="text-sm font-bold text-brand-600">
                      {formatPreis(a.preisBruttoCent)}
                    </p>
                    {istAusverkauft && (
                      <span className="text-[10px] bg-red-100 text-red-600 rounded-full px-1.5 py-0.5 font-medium leading-none">
                        Ausverkauft
                      </span>
                    )}
                    {zeigeBestand && (
                      <span className="text-[10px] bg-amber-100 text-amber-700 rounded-full px-1.5 py-0.5 font-medium leading-none">
                        noch {a.lagerstandMenge}
                      </span>
                    )}
                    {!istAusverkauft && hatMods && (
                      <span className="text-[10px] bg-brand-100 text-brand-700 rounded-full px-1.5 py-0.5 font-medium leading-none">
                        Optionen
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Modifikator-Auswahl-Dialog */}
      <ModifikatorModal
        open={!!modArtikel}
        artikel={modArtikel}
        gruppen={modArtikel ? (artikelGruppen?.get(modArtikel.id) ?? []) : []}
        onOk={(a, auswahl) => {
          setModArtikel(null)
          onArtikelClick(a, auswahl)
        }}
        onClose={() => setModArtikel(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hilfsbausteine
// ---------------------------------------------------------------------------

function TabBtn({
  aktiv: _aktiv,
  onClick,
  klassen,
  children,
}: {
  aktiv:    boolean
  onClick:  () => void
  klassen:  string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        shrink-0 px-4 py-2.5 rounded-full text-sm font-medium transition
        min-h-[44px] flex items-center gap-1.5 ${klassen}
      `}
    >
      {children}
    </button>
  )
}

function Anzahl({ wert, aktiv }: { wert: number; aktiv: boolean }) {
  return (
    <span
      className={`
        inline-flex items-center justify-center min-w-[1.25rem] h-5
        rounded-full text-[11px] font-semibold px-1 leading-none
        ${aktiv ? 'bg-white/25 text-current' : 'bg-black/10 text-current'}
      `}
    >
      {wert}
    </span>
  )
}
