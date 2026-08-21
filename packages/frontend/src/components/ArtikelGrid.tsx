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
import { KATEGORIE_FARBE_HEX, type AktiveAktion, type Artikel, type Kategorie, type KategorieFarbe, type ModifikatorAuswahl, type ModifikatorGruppe } from '@kassa/shared'
import { formatPreis } from '../lib/format'
import { ModifikatorModal } from './ModifikatorModal'
import { Input } from './ui/Input'

// Farben kommen aus der zentralen 20er-Hex-Palette (@kassa/shared) — die
// früheren Tailwind-Klassen-Maps je Farbe waren auf 8 Farben festgenagelt.

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
  /** Artikelbilder anzeigen (default: true) */
  artikelbilderAktiv?:  boolean
  /** Initialer Tab: Kategorie-ID oder '__favoriten__' (default: null = Alle) */
  initialKategorieId?:  string | null
  /** Optional: artikelId → Menge im Warenkorb (zeigt ein Mengen-Badge auf der Kachel) */
  mengenProArtikel?:    Map<string, number>
  /** Optional: gerade laufende Aktionen je Artikel — zeigt Badge + Aktionspreis */
  aktionen?:            Map<string, AktiveAktion>
  /** Favoriten dieser Kasse (artikelId null = Platzhalter); leer/undefined = globale istFavorit-Liste */
  favoritenEintraege?:  { artikelId: string | null }[] | undefined
  /** Artikel je Zeile (2–6, default 4) — gemeinsame Einstellung mit der Kellner-App */
  artikelProZeile?:     number | undefined
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

// Sentinel für den Favoriten-Tab
const FAVORITEN_TAB_ID = '__favoriten__'

export function ArtikelGrid({ artikel, kategorien, artikelGruppen, onArtikelClick, loading, sichtbareKategorieIds, artikelbilderAktiv = true, initialKategorieId = null, mengenProArtikel, aktionen, favoritenEintraege, artikelProZeile }: Props) {
  // Kategorie-ID → Farbe, für den Akzentstreifen je Artikel (auch im „Alle"-Tab).
  const farbeProKategorie = useMemo(
    () => new Map(kategorien.map(k => [k.id, k.farbe] as const)),
    [kategorien],
  )
  const [aktivKategorieId, setAktivKategorieId] = useState<string | null>(initialKategorieId)
  const [modArtikel, setModArtikel] = useState<Artikel | null>(null)
  const [suche, setSuche] = useState('')

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

  // Rohstoffe/Bestandteile sind nur Lager, nicht direkt verkäuflich → aus dem Raster ausblenden.
  const verkaufsartikel = useMemo(() => artikel.filter(a => !a.istBestandteil), [artikel])

  /**
   * Favoriten mit Platzhaltern (null): kommt eine Kassen-Liste, gilt exakt
   * deren Reihenfolge; ohne eigene Liste die globalen istFavorit-Artikel.
   */
  const favoriten = useMemo<(Artikel | null)[]>(() => {
    // Nur Favoriten aus Warengruppen, die an dieser Kasse sichtbar sind (leer = alle)
    const kategorieSichtbar = (a: Artikel) =>
      !sichtbareKategorieIds || sichtbareKategorieIds.length === 0 ||
      (a.kategorieId !== null && sichtbareKategorieIds.includes(a.kategorieId))
    if (favoritenEintraege && favoritenEintraege.length > 0) {
      const byId = new Map(verkaufsartikel.map(a => [a.id, a] as const))
      return favoritenEintraege
        .map(e => (e.artikelId === null ? null : byId.get(e.artikelId)))
        .filter((x): x is Artikel | null => x !== undefined)
        .filter(x => x === null || kategorieSichtbar(x))
    }
    return verkaufsartikel
      .filter(a => a.istFavorit && kategorieSichtbar(a))
      .sort((a, b) => a.favoritenReihenfolge - b.favoritenReihenfolge || a.bezeichnung.localeCompare(b.bezeichnung))
  }, [verkaufsartikel, favoritenEintraege, sichtbareKategorieIds])

  const anzahlProKategorie = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of verkaufsartikel) {
      if (a.kategorieId) map.set(a.kategorieId, (map.get(a.kategorieId) ?? 0) + 1)
    }
    return map
  }, [verkaufsartikel])

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

  // Kann Platzhalter (null) enthalten — nur im Favoriten-Tab ohne aktive Suche.
  const gefilterteArtikel = useMemo<(Artikel | null)[]>(() => {
    // Aktive Suche überstimmt Kategorie/Favoriten und filtert global über
    // Bezeichnung UND Artikelnummer (client-seitig, artikel ist komplett geladen).
    const q = suche.trim().toLowerCase()
    if (q) {
      return verkaufsartikel
        .filter(a =>
          a.bezeichnung.toLowerCase().includes(q) ||
          (a.artikelnummer?.toLowerCase().includes(q) ?? false))
        .sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung))
    }
    if (aktivKategorieId === FAVORITEN_TAB_ID) return favoriten
    if (aktivKategorieId === null) {
      // "Alle"-Tab: nach reihenfolge sortieren
      return [...verkaufsartikel].sort((a, b) => a.reihenfolge - b.reihenfolge || a.bezeichnung.localeCompare(b.bezeichnung))
    }
    return verkaufsartikel
      .filter(a => a.kategorieId === aktivKategorieId)
      .sort((a, b) => a.reihenfolge - b.reihenfolge || a.bezeichnung.localeCompare(b.bezeichnung))
  }, [aktivKategorieId, verkaufsartikel, favoriten, suche])

  const aktiveKategorie = aktiveKategorien.find((k) => k.id === aktivKategorieId)

  // ---------------------------------------------------------------------------

  if (loading) {
    return <p className="text-sm text-ink-muted">Wird geladen…</p>
  }

  if (artikel.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-line-strong p-6 text-center">
        <p className="text-sm text-ink-muted">Noch keine Artikel angelegt.</p>
        <a href="/artikel" className="mt-2 inline-block text-sm text-brand-600 hover:underline">
          Zur Artikel-Verwaltung →
        </a>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">

      {/* ---- Suchfeld (Name oder Artikelnummer) ---- */}
      <div className="relative shrink-0 mb-2">
        <Input
          value={suche}
          onChange={(e) => setSuche(e.target.value)}
          placeholder="Artikel suchen (Name oder Nummer)…"
          className="pr-8"
          aria-label="Artikel suchen"
        />
        {suche && (
          <button
            type="button"
            onClick={() => setSuche('')}
            aria-label="Suche löschen"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-subtle hover:text-red-500 text-lg leading-none"
          >
            ×
          </button>
        )}
      </div>

      {/* ---- Kategorie-Leiste (bleibt oben) ---- */}
      {(aktiveKategorien.length > 0 || favoriten.length > 0) && (
        <div className="relative shrink-0 mb-3">
          {fadeLinks && (
            <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-8 z-10
                            bg-gradient-to-r from-panel to-transparent" />
          )}
          {fadeRechts && (
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 z-10
                            bg-gradient-to-l from-panel to-transparent" />
          )}
          <div ref={scrollRef} className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            {/* Favoriten-Tab (nur wenn es Favoriten gibt) */}
            {favoriten.length > 0 && (
              <TabBtn
                aktiv={aktivKategorieId === FAVORITEN_TAB_ID}
                onClick={() => setAktivKategorieId(
                  aktivKategorieId === FAVORITEN_TAB_ID ? null : FAVORITEN_TAB_ID,
                )}
                farbeHex="#f59e0b"
              >
                ⭐ Favoriten <Anzahl wert={favoriten.filter(f => f !== null).length} aktiv={aktivKategorieId === FAVORITEN_TAB_ID} />
              </TabBtn>
            )}

            <TabBtn
              aktiv={aktivKategorieId === null}
              onClick={() => setAktivKategorieId(null)}
              farbeHex="#16a34a"
            >
              Alle <Anzahl wert={verkaufsartikel.length} aktiv={aktivKategorieId === null} />
            </TabBtn>

            {aktiveKategorien.map((k) => {
              const isAktiv = k.id === aktivKategorieId
              const anzahl  = anzahlProKategorie.get(k.id) ?? 0
              return (
                <TabBtn
                  key={k.id}
                  aktiv={isAktiv}
                  onClick={() => setAktivKategorieId(isAktiv ? null : k.id)}
                  farbeHex={KATEGORIE_FARBE_HEX[k.farbe]}
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
        <p className="text-sm text-ink-subtle py-4 text-center shrink-0">
          Keine Artikel in dieser Kategorie.
        </p>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto pr-0.5">
          <div
            className="grid gap-1.5 pb-1"
            style={{ gridTemplateColumns: `repeat(${artikelProZeile ?? 4}, minmax(0, 1fr))` }}
          >
            {gefilterteArtikel.map((a, idx) => {
              // Platzhalter (nur im Favoriten-Tab): graue, gesperrte Kachel
              if (a === null) {
                return (
                  <div
                    key={`platzhalter-${idx}`}
                    aria-hidden
                    className="rounded-lg border border-dashed border-line bg-panel-2/60 min-h-[4.5rem]"
                  />
                )
              }
              // Eigene Artikel-Farbe geht vor, sonst die der Warengruppe
              const farbe         = a.farbe ?? (a.kategorieId ? farbeProKategorie.get(a.kategorieId) : undefined)
              const farbeHex      = farbe ? KATEGORIE_FARBE_HEX[farbe as KategorieFarbe] : undefined
              const gruppen       = artikelGruppen?.get(a.id) ?? []
              const hatMods       = gruppen.length > 0
              // Abgeleitete Verfügbarkeit aus dem Rezept (null = kein Rezept-Limit)
              const verfuegbar    = a.verfuegbareMenge ?? null
              // Ausverkauft wenn eigener Lagerstand = 0 ODER ein Bestandteil fehlt (verfuegbar = 0)
              const istAusverkauft = (a.lagerstandAktiv && a.lagerstandMenge === 0) || verfuegbar === 0
              // Restbestand = min aus eigenem Lagerstand und abgeleiteter Rezept-Verfügbarkeit
              const eigenerBestand = a.lagerstandAktiv ? a.lagerstandMenge : null
              const restBestand =
                eigenerBestand !== null && verfuegbar !== null ? Math.min(eigenerBestand, verfuegbar)
                : eigenerBestand !== null ? eigenerBestand
                : verfuegbar
              const zeigeBestand  = !istAusverkauft && restBestand !== null && restBestand > 0
              const mengeImKorb   = mengenProArtikel?.get(a.id) ?? 0
              const aktion        = aktionen?.get(a.id) ?? null
              const aktionsPreis  = aktion === null ? null
                : aktion.typ === 'fix' ? aktion.preisCent
                : Math.round(a.preisBruttoCent * (100 - aktion.prozent) / 100)

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
                    relative appearance-none rounded-lg border bg-panel transition text-left overflow-hidden
                    ${istAusverkauft
                      ? 'border-line opacity-50 cursor-not-allowed'
                      : `active:scale-[0.97] shadow-sm ${mengeImKorb > 0 ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line'} ${farbe
                          ? 'hover:bg-panel-2 hover:border-line-strong'
                          : 'hover:bg-brand-50 hover:border-brand-400'
                        }`
                    }
                  `}
                >
                  {/* Farbiger Akzent oben: Artikel-Farbe ?? Warengruppen-Farbe */}
                  <div className="h-1.5 w-full" style={{ backgroundColor: farbeHex ?? 'var(--color-brand-500, #16a34a)' }} />

                  {/* Mengen-Badge, wenn im Warenkorb */}
                  {mengeImKorb > 0 && (
                    <span className="absolute top-2.5 right-1.5 z-10 min-w-5 h-5 px-1 flex items-center justify-center
                                     rounded-full bg-red-600 text-white text-[11px] font-semibold leading-none shadow">
                      {mengeImKorb}
                    </span>
                  )}

                  {/* Thumbnail — nur wenn Bild vorhanden UND Bilder aktiviert */}
                  {artikelbilderAktiv && a.bild && (
                    <div className="w-full h-16 overflow-hidden bg-panel-2">
                      <img
                        src={a.bild}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </div>
                  )}
                  <div className="p-2">
                    <p className="text-xs font-medium text-ink line-clamp-2 min-h-[2rem] leading-tight">
                      {a.bezeichnung}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-1 flex-wrap">
                      {aktionsPreis !== null ? (
                        <p className="text-xs font-semibold text-amber-700 flex items-baseline gap-1">
                          <span className="line-through text-ink-subtle font-normal">
                            {formatPreis(a.preisBruttoCent)}
                          </span>
                          <span>{formatPreis(aktionsPreis)}</span>
                        </p>
                      ) : (
                        <p className="text-xs font-semibold text-brand-600">
                          {formatPreis(a.preisBruttoCent)}
                        </p>
                      )}
                      <div className="flex items-center gap-1.5">
                        {istAusverkauft && (
                          <span className="text-[10px] bg-red-100 text-red-600 rounded-full px-1.5 py-0.5 font-medium leading-none">
                            Ausverkauft
                          </span>
                        )}
                        {zeigeBestand && (
                          <span className="text-[10px] bg-amber-100 text-amber-700 rounded-full px-1.5 py-0.5 font-medium leading-none">
                            noch {restBestand}
                          </span>
                        )}
                        {!istAusverkauft && aktion !== null && (
                          <span className="text-[10px] bg-amber-100 text-amber-800 rounded-full px-1.5 py-0.5 font-bold leading-none"
                                title="Aktionspreis aktiv">
                            {aktion.typ === 'prozent' ? `★ −${aktion.prozent}%` : '★ Aktion'}
                          </span>
                        )}
                        {!istAusverkauft && hatMods && (
                          <span className="text-[10px] bg-brand-100 text-brand-700 rounded-full px-1.5 py-0.5 font-medium leading-none">
                            Optionen
                          </span>
                        )}
                      </div>
                    </div>
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
  aktiv,
  onClick,
  farbeHex,
  children,
}: {
  aktiv:    boolean
  onClick:  () => void
  farbeHex: string
  children: React.ReactNode
}) {
  // Aktiv = Vollton mit weißer Schrift, inaktiv = zarter Farbton mit
  // Farbtext — direkt aus der Hex-Palette, damit alle 20 Farben tragen.
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 px-4 py-2.5 rounded-full text-sm font-medium transition
        min-h-[44px] flex items-center gap-1.5 hover:opacity-85"
      style={aktiv
        ? { backgroundColor: farbeHex, color: '#fff' }
        : { backgroundColor: `${farbeHex}1f`, color: farbeHex }}
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
