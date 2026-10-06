/**
 * ArtikelGrid — wiederverwendbares Artikel-Raster mit Kategorie-Tabs.
 * Wird in KassePage und TischTabPage eingesetzt.
 *
 * Layout:
 *  - Kategorie-Leiste: horizontal scrollbar, Touch-optimiert, Fade-Ränder
 *  - Artikel-Raster:   `artikelProZeile` Spalten, vertikal scrollbar innerhalb des Containers
 *  - Reiter sind die Hauptgruppen; Untergruppen erscheinen als Kacheln IM Raster
 *    (zuerst), danach die Artikel an ihrer Raster-Position — fehlende Positionen
 *    sind leere Felder (Asello-Layout). „◂ Elterngruppe" führt zurück.
 *  - Je Kasse kann eine Warengruppe eine EIGENE Anordnung haben (`kassenLayouts`,
 *    Editor: POS-Konfiguration → Artikel); ohne sie gilt das Standard-Layout.
 *
 * Damit der interne Scroll funktioniert muss der Parent-Container
 * eine definierte Höhe haben (flex-1 min-h-0 oder max-h-[...]).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { allergeneAnzeige, allergeneBeschreibung, ausgeblendeteArtikelIds, baueKassenRaster, farbeZuHex, type AktiveAktion, type Artikel, type KasseArtikelLayout, type Kategorie, type ModifikatorAuswahl, type ModifikatorGruppe, type RasterZelle } from '@kassa/shared'
import { formatPreis } from '../lib/format'
import {
  artikelDerKasse,
  FAVORITEN_TAB_ID,
  reiterGueltig,
  sichtbareWarengruppen,
  SONSTIGE_TAB_ID,
  startReiter,
  type ReiterLage,
} from '../lib/artikel-reiter'
import { erweitereSichtbarkeit, nachkommenIds, untergruppenVon, wurzelgruppen, wurzelIdVon } from '../lib/kategorie-baum'
import { ModifikatorModal } from './ModifikatorModal'
import { BoxSymbol, schriftAuf } from './RasterBausteine'
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
  /** Ausdrücklich gewünschter Start-Reiter: Kategorie-ID oder '__favoriten__' (überstimmt die Kassen-Einstellung) */
  initialKategorieId?:  string | null
  /** POS-Konfiguration: Artikelwahl öffnet mit den Favoriten (default: true) */
  startFavoriten?:      boolean | undefined
  /** POS-Konfiguration: sonst mit dieser Warengruppe (null = erste mit Artikeln) */
  startKategorieId?:    string | null | undefined
  /** Optional: artikelId → Menge im Warenkorb (zeigt ein Mengen-Badge auf der Kachel) */
  mengenProArtikel?:    Map<string, number>
  /** Optional: gerade laufende Aktionen je Artikel — zeigt Badge + Aktionspreis */
  aktionen?:            Map<string, AktiveAktion>
  /** Favoriten dieser Kasse (artikelId null = Platzhalter); leer/undefined = globale istFavorit-Liste */
  favoritenEintraege?:  { artikelId: string | null }[] | undefined
  /** Artikel je Zeile (2–6, default 4) — gemeinsame Einstellung mit der Kellner-App */
  artikelProZeile?:     number | undefined
  /**
   * Eigene Anordnung der Artikel je Warengruppe an DIESER Kasse (Slots, Leerfelder, ausgeblendete Artikel);
   * Warengruppen ohne Eintrag zeigen das Standard-Layout. Ausgeblendete Artikel fehlen nur im Raster der
   * eigenen Warengruppe — Suche und Favoriten finden sie weiterhin.
   */
  kassenLayouts?:       KasseArtikelLayout[] | undefined
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

export function ArtikelGrid({ artikel, kategorien, artikelGruppen, onArtikelClick, loading, sichtbareKategorieIds, artikelbilderAktiv = true, initialKategorieId = null, startFavoriten, startKategorieId, mengenProArtikel, aktionen, favoritenEintraege, artikelProZeile, kassenLayouts }: Props) {
  // Kategorie-ID → Farbe, für den Akzentstreifen je Artikel (auch in Favoriten + Suche).
  const farbeProKategorie = useMemo(
    () => new Map(kategorien.map(k => [k.id, k.farbe] as const)),
    [kategorien],
  )
  // Vom Benutzer gewählter Reiter; null = noch keiner → Start-Reiter der Kasse
  const [gewaehlterReiter, setGewaehlterReiterRoh] = useState<string | null>(null)
  // Untergruppe, in die hineingewechselt wurde (null = oberste Ebene des Reiters)
  const [gewaehlteEbene, setGewaehlteEbene] = useState<string | null>(null)
  const setGewaehlterReiter = (id: string | null) => { setGewaehlterReiterRoh(id); setGewaehlteEbene(null) }
  const [modArtikel, setModArtikel] = useState<Artikel | null>(null)
  const [suche, setSuche] = useState('')
  // Suchfeld einklappbar (mehr Platz fürs Raster); pro Gerät gemerkt, Standard: sichtbar
  const [sucheKlein, setSucheKlein] = useState<boolean>(() => {
    try { return localStorage.getItem('kassa:artikelSucheEingeklappt') === '1' } catch { return false }
  })
  const sucheKleinSetzen = (wert: boolean) => {
    setSucheKlein(wert)
    try { localStorage.setItem('kassa:artikelSucheEingeklappt', wert ? '1' : '0') } catch { /* ignorieren */ }
  }

  // Scroll-State für Fade-Ränder der Kategorieleiste
  const scrollRef    = useRef<HTMLDivElement>(null)
  const [fadeLinks,  setFadeLinks]  = useState(false)
  const [fadeRechts, setFadeRechts] = useState(false)

  // Sichtbarkeit der Kasse gilt samt Untergruppen (und deren Vorfahren, sonst unerreichbar)
  const sichtbareIds = useMemo(
    () => erweitereSichtbarkeit(kategorien, sichtbareKategorieIds),
    [kategorien, sichtbareKategorieIds],
  )
  // Alle aktiven, sichtbaren Gruppen — jede Ebene
  const aktiveKategorien = useMemo(
    () => sichtbareWarengruppen(kategorien, sichtbareIds),
    [kategorien, sichtbareIds],
  )
  // Reiter = Hauptgruppen
  const reiterGruppen = useMemo(() => wurzelgruppen(aktiveKategorien), [aktiveKategorien])

  // Rohstoffe/Bestandteile sind nur Lager, nicht direkt verkäuflich → aus dem Raster ausblenden.
  // Und nur, was diese Kasse zeigen darf — auch in der Suche.
  const verkaufsartikel = useMemo(
    () => artikelDerKasse(artikel.filter(a => !a.istBestandteil), sichtbareIds),
    [artikel, sichtbareIds],
  )

  // Artikel ohne (aktive) Warengruppe — eigener Reiter, nur wenn die Kasse alle zeigt
  const sonstige = useMemo(() => {
    const ids = new Set(aktiveKategorien.map(k => k.id))
    return verkaufsartikel
      .filter(a => !a.kategorieId || !ids.has(a.kategorieId))
      .sort((a, b) => a.reihenfolge - b.reihenfolge || a.bezeichnung.localeCompare(b.bezeichnung))
  }, [verkaufsartikel, aktiveKategorien])

  /**
   * Favoriten mit Platzhaltern (null): kommt eine Kassen-Liste, gilt exakt
   * deren Reihenfolge; ohne eigene Liste die globalen istFavorit-Artikel.
   */
  const favoriten = useMemo<(Artikel | null)[]>(() => {
    // Nur Favoriten aus Warengruppen, die an dieser Kasse sichtbar sind (leer = alle)
    const kategorieSichtbar = (a: Artikel) =>
      !sichtbareIds || sichtbareIds.length === 0 ||
      (a.kategorieId !== null && sichtbareIds.includes(a.kategorieId))
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
  }, [verkaufsartikel, favoritenEintraege, sichtbareIds])

  // Eigene Anordnung dieser Kasse je Warengruppe (Warengruppen ohne Eintrag: Standard-Layout)
  const anordnungVonGruppe = useMemo(
    () => new Map((kassenLayouts ?? []).map(l => [l.kategorieId, l.eintraege] as const)),
    [kassenLayouts],
  )

  // Anzahl je Warengruppe ohne die an dieser Kasse in ihrer Gruppe ausgeblendeten Artikel
  // (sonst zeigte der Reiter Artikel an, die das Raster nicht hat)
  const anzahlProKategorie = useMemo(() => {
    const ausgeblendet = ausgeblendeteArtikelIds(verkaufsartikel, kassenLayouts)
    const map = new Map<string, number>()
    for (const a of verkaufsartikel) {
      if (a.kategorieId && !ausgeblendet.has(a.id)) map.set(a.kategorieId, (map.get(a.kategorieId) ?? 0) + 1)
    }
    return map
  }, [verkaufsartikel, kassenLayouts])

  // Artikel je Reiter = die der ganzen Hauptgruppe samt aller Untergruppen
  const anzahlProReiter = useMemo(() => {
    const map = new Map<string, number>()
    for (const w of reiterGruppen) {
      const ids = [w.id, ...nachkommenIds(aktiveKategorien, w.id)]
      map.set(w.id, ids.reduce((summe, id) => summe + (anzahlProKategorie.get(id) ?? 0), 0))
    }
    return map
  }, [reiterGruppen, aktiveKategorien, anzahlProKategorie])

  const lage = useMemo<ReiterLage>(() => ({
    hatFavoriten: favoriten.length > 0,
    hatSonstige:  sonstige.length > 0,
    kategorieIds: reiterGruppen.map(k => k.id),
    kategorieIdsMitArtikeln: reiterGruppen.filter(k => (anzahlProReiter.get(k.id) ?? 0) > 0).map(k => k.id),
  }), [favoriten, sonstige, reiterGruppen, anzahlProReiter])

  // Gewählter Reiter, solange es ihn gibt — sonst der Start-Reiter der Kasse
  // Start-Einstellungen können eine Untergruppe nennen → deren Hauptgruppe öffnen
  const alsReiter = (id: string | null | undefined) =>
    id && id !== FAVORITEN_TAB_ID && id !== SONSTIGE_TAB_ID ? (wurzelIdVon(aktiveKategorien, id) ?? id) : id
  const aktivKategorieId = reiterGueltig(gewaehlterReiter, lage)
    ? gewaehlterReiter
    : startReiter(lage, { startFavoriten, startKategorieId: alsReiter(startKategorieId) }, alsReiter(initialKategorieId))

  // Gruppe, deren Inhalt das Raster zeigt: gewählte Untergruppe (wenn sie noch im Reiter liegt) sonst der Reiter selbst
  const aktuelleGruppeId = useMemo(() => {
    if (!aktivKategorieId || aktivKategorieId === FAVORITEN_TAB_ID || aktivKategorieId === SONSTIGE_TAB_ID) return null
    if (gewaehlteEbene && nachkommenIds(aktiveKategorien, aktivKategorieId).includes(gewaehlteEbene)) return gewaehlteEbene
    return aktivKategorieId
  }, [aktivKategorieId, gewaehlteEbene, aktiveKategorien])
  const aktuelleGruppe = aktuelleGruppeId ? aktiveKategorien.find(k => k.id === aktuelleGruppeId) ?? null : null
  const elterGruppe    = aktuelleGruppe && aktuelleGruppe.id !== aktivKategorieId && aktuelleGruppe.parentId
    ? aktiveKategorien.find(k => k.id === aktuelleGruppe.parentId) ?? null
    : null

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
  }, [reiterGruppen.length])

  // Raster-Zellen: Untergruppen zuerst, dann Artikel an ihrem Slot (Lücken = leere Felder).
  // Favoriten-Platzhalter (null) werden ebenfalls zu leeren Feldern.
  const zellen = useMemo<RasterZelle<Kategorie, Artikel>[]>(() => {
    // Aktive Suche überstimmt Kategorie/Favoriten und filtert global über
    // Bezeichnung UND Artikelnummer (client-seitig, artikel ist komplett geladen).
    const q = suche.trim().toLowerCase()
    if (q) {
      return verkaufsartikel
        .filter(a =>
          a.bezeichnung.toLowerCase().includes(q) ||
          (a.artikelnummer?.toLowerCase().includes(q) ?? false))
        .sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung))
        .map((a): RasterZelle<Kategorie, Artikel> => ({ typ: 'artikel', artikel: a }))
    }
    if (aktivKategorieId === FAVORITEN_TAB_ID) {
      return favoriten.map((a): RasterZelle<Kategorie, Artikel> => (a === null ? { typ: 'leer' } : { typ: 'artikel', artikel: a }))
    }
    if (aktivKategorieId === SONSTIGE_TAB_ID) {
      return sonstige.map((a): RasterZelle<Kategorie, Artikel> => ({ typ: 'artikel', artikel: a }))
    }
    if (aktuelleGruppeId === null) return []
    return baueKassenRaster(
      untergruppenVon(aktiveKategorien, aktuelleGruppeId),
      verkaufsartikel.filter(a => a.kategorieId === aktuelleGruppeId),
      anordnungVonGruppe.get(aktuelleGruppeId),
    )
  }, [aktivKategorieId, aktuelleGruppeId, aktiveKategorien, verkaufsartikel, favoriten, sonstige, suche, anordnungVonGruppe])
  const mitZurueck = suche.trim() === '' && elterGruppe !== null

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
      {(!sucheKlein || suche !== '') && <div className="relative shrink-0 mb-2">
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
      </div>}

      {/* ---- Kategorie-Leiste (bleibt oben) + Knopf zum Ein-/Ausklappen der Suche ---- */}
      <div className="flex items-start gap-2 shrink-0 mb-3">
      {(aktiveKategorien.length > 0 || favoriten.length > 0 || sonstige.length > 0) && (
        <div className="relative min-w-0 flex-1">
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
                onClick={() => setGewaehlterReiter(FAVORITEN_TAB_ID)}
                farbeHex="#f59e0b"
              >
                ⭐ Favoriten <Anzahl wert={favoriten.filter(f => f !== null).length} aktiv={aktivKategorieId === FAVORITEN_TAB_ID} />
              </TabBtn>
            )}

            {reiterGruppen.map((k) => {
              const isAktiv = k.id === aktivKategorieId
              const anzahl  = anzahlProReiter.get(k.id) ?? 0
              return (
                <TabBtn
                  key={k.id}
                  aktiv={isAktiv}
                  onClick={() => setGewaehlterReiter(k.id)}
                  farbeHex={farbeZuHex(k.farbe) ?? '#9ca3af'}
                >
                  {k.name}
                  {anzahl > 0 && <Anzahl wert={anzahl} aktiv={isAktiv} />}
                </TabBtn>
              )
            })}

            {/* Artikel ohne (aktive) Warengruppe */}
            {sonstige.length > 0 && (
              <TabBtn
                aktiv={aktivKategorieId === SONSTIGE_TAB_ID}
                onClick={() => setGewaehlterReiter(SONSTIGE_TAB_ID)}
                farbeHex="#64748b"
              >
                Sonstige <Anzahl wert={sonstige.length} aktiv={aktivKategorieId === SONSTIGE_TAB_ID} />
              </TabBtn>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => sucheKleinSetzen(!sucheKlein)}
        aria-label={sucheKlein ? 'Suchfeld einblenden' : 'Suchfeld ausblenden'}
        aria-expanded={!sucheKlein}
        title={sucheKlein ? 'Suchfeld einblenden' : 'Suchfeld ausblenden'}
        className="ml-auto shrink-0 min-h-[36px] rounded-lg border border-line bg-panel px-2.5 text-sm text-ink-muted hover:bg-panel-2 transition"
      >
        {sucheKlein ? '🔍' : '🔍 ▴'}
      </button>
      </div>

      {/* ---- Zurück zur Elterngruppe (nur innerhalb einer Untergruppe) ---- */}
      {mitZurueck && elterGruppe && aktuelleGruppe && (
        <div className="shrink-0 mb-2 flex items-center gap-2">
          <button
            type="button"
            data-testid="untergruppe-zurueck"
            onClick={() => setGewaehlteEbene(elterGruppe.id === aktivKategorieId ? null : elterGruppe.id)}
            className="min-h-[40px] shrink-0 rounded-lg border border-line bg-panel px-3 text-sm font-medium text-ink hover:bg-panel-2 transition"
          >
            ◂ {elterGruppe.name}
          </button>
          <span className="min-w-0 truncate text-sm font-semibold text-ink-muted">{aktuelleGruppe.name}</span>
        </div>
      )}

      {/* ---- Artikel-Raster (scrollt vertikal) ---- */}
      {zellen.length === 0 ? (
        <p className="text-sm text-ink-subtle py-4 text-center shrink-0">
          Keine Artikel in dieser Kategorie.
        </p>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto pr-0.5">
          <div
            className="grid gap-1.5 pb-1"
            style={{ gridTemplateColumns: `repeat(${artikelProZeile ?? 4}, minmax(0, 1fr))` }}
          >
            {zellen.map((zelle, idx) => {
              // Leeres Feld (Lücke im Raster / Favoriten-Platzhalter): graue, gesperrte Kachel
              if (zelle.typ === 'leer') {
                return (
                  <div
                    key={`leer-${idx}`}
                    aria-hidden
                    data-testid="raster-leer"
                    className="rounded-lg border border-dashed border-line bg-panel-2/60 min-h-[4.5rem]"
                  />
                )
              }
              // Untergruppe: Kachel in der Gruppenfarbe mit Box-Symbol — Klick wechselt hinein
              if (zelle.typ === 'gruppe') {
                const g = zelle.gruppe
                const hex = farbeZuHex(g.farbe) ?? '#9ca3af'
                return (
                  <button
                    key={`gruppe-${g.id}`}
                    type="button"
                    data-testid="untergruppe-kachel"
                    onClick={() => setGewaehlteEbene(g.id)}
                    className="relative flex min-h-[4.5rem] w-full flex-col items-start justify-between gap-1 overflow-hidden rounded-lg p-2 text-left shadow-sm transition active:scale-[0.97] hover:opacity-90"
                    style={{ backgroundColor: hex, color: schriftAuf(hex) }}
                  >
                    <BoxSymbol />
                    <span className="line-clamp-2 text-xs font-semibold leading-tight">{g.name}</span>
                  </button>
                )
              }
              const a = zelle.artikel
              // Eigene Artikel-Farbe geht vor, sonst die der Warengruppe
              const farbe         = a.farbe ?? (a.kategorieId ? farbeProKategorie.get(a.kategorieId) : undefined)
              const farbeHex      = farbe ? farbeZuHex(farbe) : undefined
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
              const aktion        = a.preisBruttoCent < 0 ? null : (aktionen?.get(a.id) ?? null)
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
                  data-testid="artikel-kachel"
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
                  <div data-testid="artikel-farbe" className="h-2.5 w-full" style={{ backgroundColor: farbeHex ?? 'var(--color-brand-500, #16a34a)' }} />

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
                        {a.allergene && (
                          <span
                            data-testid="artikel-allergene"
                            title={allergeneBeschreibung(a.allergene)}
                            className="text-[10px] font-semibold tracking-wide text-ink-subtle leading-none"
                          >
                            {allergeneAnzeige(a.allergene)}
                          </span>
                        )}
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
      aria-pressed={aktiv}
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
