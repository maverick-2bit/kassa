/**
 * Drucker & KDS-Station je Kasse — wohin geht der Bon einer Warengruppe bzw. eines Artikels, und zwar
 * für JEDE Kasse einzeln?
 *
 * Die Matrix hat zwei Ebenen (Warengruppen / Einzelartikel) und zwei Merkmale (Bonierdrucker / KDS-Station).
 * Spalte „Allgemein" ist die Vorgabe für alle Kassen (wie bisher an der Warengruppe bzw. am Artikel); die
 * Spalten je Kasse sind Ausnahmen NUR an dieser Kasse. Rangfolge (das Genauere gewinnt):
 *   Artikel an der Kasse → Artikel allgemein → Warengruppe an der Kasse → Warengruppe allgemein.
 * In jeder Zelle steht, was tatsächlich gilt: eine Ausnahme als gewählter Wert (umrandet), sonst grau mit ↳
 * der geerbte Wert. „— keiner —" heißt: an dieser Kasse bewusst kein Drucker / keine Station.
 * Der Server rechnet beim Bonieren mit derselben Regel (@kassa/shared).
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ALLE_STATIONEN,
  STATION_LABELS,
  nachkommenIds,
  sichtbarkeitsMengen,
  wirksamesArtikelRouting,
  wirksamesKategorieRouting,
  type Artikel,
  type EinrichtungKasse,
  type Kategorie,
  type KategorieRouting,
  type RoutingAenderung,
  type Station,
} from '@kassa/shared'
import { artikelApi, bonierdruckerApi, kategorieApi } from '../../lib/api'
import { getAuth } from '../../lib/auth'
import { baumFlach, kategoriePfad } from '../../lib/kategorie-baum'
import {
  ausnahmenNachZelle, hatAngabe, kassenName, routingAenderung, routingJeKasse, zellenSchluessel, zellenWert,
  type RoutingMerkmal, type RoutingZiel,
} from '../../lib/einrichtung'
import { Button } from '../ui/Button'
import { useEinrichtung } from './EinrichtungKontext'

type Ebene = 'warengruppen' | 'artikel'

/** Wie viele Artikel auf einmal gezeigt werden (mehr per Knopf) */
const ARTIKEL_SEITE = 60

interface Zeile {
  id:          string
  ziel:        RoutingZiel
  name:        string
  /** Pfad bzw. Warengruppe unter dem Namen */
  untertitel:  string
  tiefe:       number
  /** Eigene allgemeine Vorgabe (null = keine eigene) */
  eigen:       { drucker: string | null; station: string | null }
  /** Allgemein wirksam, also ohne Kassen-Ausnahmen (eigene Vorgabe, sonst geerbt) */
  allgemein:   KategorieRouting
  /** Wirksames Routing der übergeordneten Ebene ohne eigene Vorgabe (Anzeige „↳ …") */
  geerbt:      KategorieRouting
}

const ZELLE = 'block w-full min-w-[7.5rem] rounded-md border bg-panel px-1.5 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40'

export function RoutingSektion() {
  const qc = useQueryClient()
  const auth = getAuth()!
  const { aktiveKassen, daten, laedt, istGastro, ausnahmenSetzen, meldeFehler } = useEinrichtung()

  const [ebene, setEbene]     = useState<Ebene>('warengruppen')
  const [merkmal, setMerkmal] = useState<RoutingMerkmal>(istGastro ? 'drucker' : 'station')
  const [suche, setSuche]     = useState('')
  const [gruppenFilter, setGruppenFilter] = useState('alle')
  const [zeigen, setZeigen]               = useState<'eigene' | 'ohne' | 'alle'>('eigene')
  const [auswahl, setAuswahl]             = useState<ReadonlySet<string>>(() => new Set())
  const [meldung, setMeldung]             = useState<{ typ: 'ok' | 'fehler'; text: string } | null>(null)
  const [anzahl, setAnzahl]   = useState(ARTIKEL_SEITE)

  const kategorienQuery = useQuery({ queryKey: ['kategorien'], queryFn: () => kategorieApi.list(true) })
  const bonierQuery     = useQuery({ queryKey: ['bonierdrucker'], queryFn: bonierdruckerApi.list, enabled: istGastro })
  const artikelQuery    = useQuery({
    queryKey: ['artikel', auth.mandant.id, true],
    queryFn:  () => artikelApi.list(auth.mandant.id, true),
    enabled:  ebene === 'artikel',
  })

  const kategorien = useMemo(() => kategorienQuery.data ?? [], [kategorienQuery.data])
  // Backup-Drucker bekommen jeden Bon als Kopie, sind aber nie ein Ziel einer Zuordnung
  const druckerListe = useMemo(() => (bonierQuery.data ?? []).filter(d => !d.istBackup), [bonierQuery.data])
  const ausnahmen = daten?.ausnahmen ?? []
  const nachZelle = useMemo(() => ausnahmenNachZelle(ausnahmen), [ausnahmen])

  const optionen = useMemo(
    () => merkmal === 'drucker'
      ? druckerListe.map(d => ({ wert: d.id, label: `${d.name}${d.aktiv ? '' : ' (deaktiviert)'}` }))
      : ALLE_STATIONEN.map(s => ({ wert: s, label: STATION_LABELS[s] })),
    [merkmal, druckerListe],
  )
  const merkmalName = merkmal === 'drucker' ? 'Drucker' : 'Station'
  const wertName = (r: KategorieRouting): string => {
    if (merkmal === 'drucker') return r.bonierdruckerId ? (druckerListe.find(d => d.id === r.bonierdruckerId)?.name ?? '(Backup/gelöscht)') : 'keiner'
    return r.station ? (STATION_LABELS[r.station as Station] ?? r.station) : 'keine'
  }

  // ---- Allgemeine Vorgaben (an Warengruppe / Artikel) ----
  const allgemeinSpeichern = useMutation({
    mutationFn: async ({ ziel, wert }: { ziel: RoutingZiel; wert: string }) => {
      const eingabe = merkmal === 'drucker' ? { bonierdruckerId: wert || null } : { station: (wert || null) as Station | null }
      if ('kategorieId' in ziel) await kategorieApi.update(ziel.kategorieId, eingabe)
      else await artikelApi.update(ziel.artikelId, eingabe)
    },
    onMutate: ({ ziel, wert }) => {
      // sofort anzeigen; schlägt es fehl, lädt onSettled den Serverstand nach
      if ('kategorieId' in ziel) {
        qc.setQueryData<Kategorie[]>(['kategorien'], old => old?.map(k => k.id !== ziel.kategorieId ? k : {
          ...k, ...(merkmal === 'drucker' ? { bonierdruckerId: wert || null } : { station: (wert || null) as Station | null }),
        }))
      } else {
        qc.setQueryData<Artikel[]>(['artikel', auth.mandant.id, true], old => old?.map(a => a.id !== ziel.artikelId ? a : {
          ...a, ...(merkmal === 'drucker' ? { bonierdruckerId: wert || null } : { station: (wert || null) as Station | null }),
        }))
      }
    },
    onError: (err) => meldeFehler(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['kategorien'] })
      void qc.invalidateQueries({ queryKey: ['artikel'] })
    },
  })

  // ---- Wirksames Routing: allgemein und je Kasse ----
  const allgemeinJeGruppe = useMemo(() => wirksamesKategorieRouting(kategorien), [kategorien])
  const jeKasse = useMemo(() => new Map(aktiveKassen.map(k => [k.id, routingJeKasse(kategorien, ausnahmen, k.id)] as const)), [aktiveKassen, kategorien, ausnahmen])
  const sichtbarJeKasse = useMemo(() => new Map(aktiveKassen.map(k => [k.id, sichtbarkeitsMengen(kategorien, k.sichtbareKategorieIds)] as const)), [aktiveKassen, kategorien])

  // ---- Zeilen ----
  const keinRouting: KategorieRouting = { station: null, bonierdruckerId: null }
  const gruppenZeilen: Zeile[] = useMemo(() => baumFlach(kategorien).map(({ kategorie: k, tiefe }): Zeile => {
    const eltern = k.parentId ? allgemeinJeGruppe.get(k.parentId) ?? keinRouting : keinRouting
    return {
      id: k.id, ziel: { kategorieId: k.id }, name: k.name, untertitel: kategoriePfad(kategorien, k.id), tiefe,
      eigen:     { drucker: k.bonierdruckerId, station: k.station },
      allgemein: allgemeinJeGruppe.get(k.id) ?? keinRouting,
      geerbt:    eltern,
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [kategorien, allgemeinJeGruppe])

  const alleArtikel: Artikel[] = useMemo(() => (artikelQuery.data ?? []).filter(a => !a.istBestandteil), [artikelQuery.data])
  const artikelZeilen: { zeile: Zeile; artikel: Artikel }[] = useMemo(() => {
    const q = suche.trim().toLowerCase()
    const gruppeIds = gruppenFilter === 'alle' ? null : new Set([gruppenFilter, ...nachkommenIds(kategorien, gruppenFilter)])
    return alleArtikel
      .filter(a => !gruppeIds || (a.kategorieId !== null && gruppeIds.has(a.kategorieId)))
      .filter(a => !q || a.bezeichnung.toLowerCase().includes(q))
      .filter(a => {
        if (zeigen === 'ohne') {
          // ohne Zuordnung: weder der Artikel noch seine Warengruppe geben (allgemein) einen Drucker bzw. eine Station vor
          const w = wirksamesArtikelRouting(a, a.kategorieId ? allgemeinJeGruppe.get(a.kategorieId) : undefined)
          return merkmal === 'drucker' ? w.bonierdruckerId === null : w.station === null
        }
        if (zeigen === 'alle' || q || gruppenFilter !== 'alle') return true
        const eigen = merkmal === 'drucker' ? a.bonierdruckerId !== null : a.station !== null
        return eigen || aktiveKassen.some(k => hatAngabe(nachZelle.get(zellenSchluessel(k.id, { artikelId: a.id })), merkmal))
      })
      .sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung))
      .map(a => {
        const gruppe = a.kategorieId ? allgemeinJeGruppe.get(a.kategorieId) ?? keinRouting : keinRouting
        return {
          artikel: a,
          zeile: {
            id: a.id, ziel: { artikelId: a.id }, name: a.bezeichnung, tiefe: 0,
            untertitel: a.kategorieId ? kategoriePfad(kategorien, a.kategorieId) : 'ohne Warengruppe',
            eigen:     { drucker: a.bonierdruckerId, station: a.station },
            allgemein: wirksamesArtikelRouting(a, gruppe),
            geerbt:    gruppe,
          } satisfies Zeile,
        }
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alleArtikel, suche, gruppenFilter, zeigen, merkmal, nachZelle, aktiveKassen, allgemeinJeGruppe, kategorien])

  const artikelNachId = useMemo(() => new Map(artikelZeilen.map(x => [x.artikel.id, x.artikel] as const)), [artikelZeilen])

  const zeilen: Zeile[] = ebene === 'warengruppen' ? gruppenZeilen : artikelZeilen.slice(0, anzahl).map(x => x.zeile)

  // ---- Wirksamer Wert einer Zelle (was gilt an dieser Kasse?) ----
  function wirksamAnKasse(kasse: EinrichtungKasse, zeile: Zeile): KategorieRouting {
    const gruppen = jeKasse.get(kasse.id)
    if (ebene === 'warengruppen') return gruppen?.get(zeile.id) ?? keinRouting
    const a = artikelNachId.get(zeile.id)!
    return wirksamesArtikelRouting(a, a.kategorieId ? gruppen?.get(a.kategorieId) : undefined, nachZelle.get(zellenSchluessel(kasse.id, { artikelId: a.id })))
  }

  /** Läuft die Zeile an dieser Kasse überhaupt? (Warengruppe sichtbar bzw. bei der Station: KDS an) */
  function gedimmt(kasse: EinrichtungKasse, zeile: Zeile): string | null {
    const m = sichtbarJeKasse.get(kasse.id)
    const kategorieId = ebene === 'warengruppen' ? zeile.id : (artikelNachId.get(zeile.id)?.kategorieId ?? null)
    if (m && !m.alle && (kategorieId === null || !m.sichtbar.has(kategorieId))) return 'Diese Warengruppe wird an dieser Kasse nicht verkauft.'
    if (merkmal === 'station' && !kasse.kdsAktiv) return 'Das KDS ist an dieser Kasse aus — die Station greift erst, wenn es eingeschaltet ist.'
    return null
  }

  // ---- Ausnahmen setzen ----
  const setzeZelle = (kasse: EinrichtungKasse, ziel: RoutingZiel, wert: string) =>
    void ausnahmenSetzen([routingAenderung(kasse.id, ziel, merkmal, wert)])

  function setzeSpalte(kasse: EinrichtungKasse, wert: string) {
    const ziele = zeilen.filter(z => ebene === 'artikel' || sichtbarJeKasse.get(kasse.id)?.alle || sichtbarJeKasse.get(kasse.id)?.sichtbar.has(z.id))
    if (ziele.length === 0) return
    const text = wert === '' ? 'auf „Standard" zurücksetzen (Ausnahmen entfernen)' : wert === 'keiner' ? `auf „keiner" setzen` : `auf „${optionen.find(o => o.wert === wert)?.label ?? wert}" setzen`
    if (!window.confirm(`${merkmalName} für ${ziele.length} ${ebene === 'warengruppen' ? 'Warengruppen' : 'Artikel'} an „${kassenName(kasse)}" ${text}?`)) return
    void ausnahmenSetzen(ziele.map(z => routingAenderung(kasse.id, z.ziel, merkmal, wert)))
  }

  function zeileZuruecksetzen(zeile: Zeile) {
    const aenderungen: RoutingAenderung[] = aktiveKassen
      .filter(k => hatAngabe(nachZelle.get(zellenSchluessel(k.id, zeile.ziel)), merkmal))
      .map(k => routingAenderung(k.id, zeile.ziel, merkmal, ''))
    void ausnahmenSetzen(aenderungen)
  }

  // ---- Artikel auf die Einstellung ihrer Warengruppe zurücksetzen (eigene Angabe + Kassen-Ausnahmen) ----
  const markierte = artikelZeilen.filter(x => auswahl.has(x.artikel.id)).map(x => x.artikel)
  const gefilterte = artikelZeilen.map(x => x.artikel)
  const toggleAuswahl = (id: string) =>
    setAuswahl(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  async function zuruecksetzen(liste: Artikel[], beschreibung: string) {
    const eigen = (a: Artikel) => (merkmal === 'drucker' ? a.bonierdruckerId !== null : a.station !== null)
    const mitAusnahme = (a: Artikel) => aktiveKassen.some(k => hatAngabe(nachZelle.get(zellenSchluessel(k.id, { artikelId: a.id })), merkmal))
    // Nur Artikel mit eigener Angabe oder Kassen-Ausnahme müssen überhaupt geändert werden
    const betroffen = liste.filter(a => eigen(a) || mitAusnahme(a))
    if (betroffen.length === 0) { setMeldung({ typ: 'ok', text: 'Nichts zu tun — alle folgen schon ihrer Warengruppe.' }); return }
    if (!window.confirm(
      `${betroffen.length} Artikel (${beschreibung}) auf die Einstellung ihrer Warengruppe zurücksetzen?\n\n` +
      `Ihr eigener ${merkmalName} und alle Ausnahmen an den Kassen werden dabei entfernt, auch wenn sie abweichen.`,
    )) return
    setMeldung(null)
    try {
      const mitEigener = betroffen.filter(eigen).map(a => a.id)
      if (merkmal === 'station') {
        if (mitEigener.length > 0) await artikelApi.kdsZuruecksetzen(mitEigener)
      } else {
        for (let i = 0; i < mitEigener.length; i += 10) {
          await Promise.all(mitEigener.slice(i, i + 10).map(id => artikelApi.update(id, { bonierdruckerId: null })))
        }
      }
      await ausnahmenSetzen(betroffen.flatMap(a => aktiveKassen
        .filter(k => hatAngabe(nachZelle.get(zellenSchluessel(k.id, { artikelId: a.id })), merkmal))
        .map(k => routingAenderung(k.id, { artikelId: a.id }, merkmal, ''))))
      void qc.invalidateQueries({ queryKey: ['artikel'] })
      setAuswahl(new Set())
      setMeldung({ typ: 'ok', text: `${betroffen.length} Artikel folgen jetzt ihrer Warengruppe.` })
    } catch (err) {
      setMeldung({ typ: 'fehler', text: err instanceof Error ? err.message : 'Zurücksetzen fehlgeschlagen' })
    }
  }

  const laden = laedt || kategorienQuery.isLoading || (ebene === 'artikel' && artikelQuery.isLoading)
  const eigenErklaerung = ebene === 'warengruppen' ? 'Vorgabe der Warengruppe' : 'eigene Vorgabe des Artikels'

  return (
    <section id="einrichtung-routing" className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink">Drucker & KDS-Station je Kasse</h2>
        <p className="text-sm text-ink-muted mt-0.5">
          Wohin geht der Bon einer Warengruppe oder eines Einzelartikels? <strong>Allgemein</strong> gilt für alle Kassen,
          in den Spalten der Kassen stellst du Ausnahmen <strong>nur für diese Kasse</strong> ein. Das Genauere gewinnt:
          Artikel an der Kasse → Artikel allgemein → Warengruppe an der Kasse → Warengruppe allgemein.
          Umrandet = Ausnahme an dieser Kasse, grau mit ↳ = gilt wie allgemein, „keiner" = an dieser Kasse bewusst kein {merkmalName}.
        </p>
      </div>

      {/* Ebene und Merkmal */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div role="tablist" aria-label="Ebene" className="inline-flex rounded-lg bg-panel-2 p-1">
          {([['warengruppen', 'Warengruppen'], ['artikel', 'Einzelartikel']] as const).map(([wert, label]) => (
            <button
              key={wert}
              type="button"
              role="tab"
              aria-selected={ebene === wert}
              data-testid={`routing-ebene-${wert}`}
              onClick={() => setEbene(wert)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${ebene === wert ? 'bg-panel text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
            >{label}</button>
          ))}
        </div>
        <div role="tablist" aria-label="Merkmal" className="inline-flex rounded-lg bg-panel-2 p-1">
          {([...(istGastro ? [['drucker', 'Bonierdrucker']] as const : []), ['station', 'KDS-Station']] as const).map(([wert, label]) => (
            <button
              key={wert}
              type="button"
              role="tab"
              aria-selected={merkmal === wert}
              data-testid={`routing-merkmal-${wert}`}
              onClick={() => setMerkmal(wert)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${merkmal === wert ? 'bg-panel text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
            >{label}</button>
          ))}
        </div>
      </div>

      {/* Filter der Artikel-Ebene */}
      {ebene === 'artikel' && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            aria-label="Artikel suchen"
            placeholder="Artikel suchen …"
            value={suche}
            onChange={e => { setSuche(e.target.value); setAnzahl(ARTIKEL_SEITE) }}
            className="min-w-48 flex-1 rounded-lg border border-line px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <select
            aria-label="Warengruppe filtern"
            value={gruppenFilter}
            onChange={e => { setGruppenFilter(e.target.value); setAnzahl(ARTIKEL_SEITE) }}
            className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm"
          >
            <option value="alle">Alle Warengruppen</option>
            {gruppenZeilen.map(z => <option key={z.id} value={z.id}>{z.untertitel}</option>)}
          </select>
          <select
            aria-label="Artikel zeigen"
            value={zeigen}
            onChange={e => { setZeigen(e.target.value as typeof zeigen); setAnzahl(ARTIKEL_SEITE) }}
            className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm"
          >
            <option value="eigene">Mit eigener Zuordnung (ohne Suche/Filter)</option>
            <option value="ohne">Ohne Zuordnung (kein Bon)</option>
            <option value="alle">Alle Artikel</option>
          </select>
        </div>
      )}

      {ebene === 'artikel' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" disabled={markierte.length === 0} onClick={() => void zuruecksetzen(markierte, 'markierte')}>
            Markierte auf Warengruppe zurücksetzen ({markierte.length})
          </Button>
          <Button variant="secondary" size="sm" disabled={gefilterte.length === 0} onClick={() => void zuruecksetzen(gefilterte, 'alle gefilterten')}>
            Alle gefilterten zurücksetzen ({gefilterte.length})
          </Button>
          {meldung && <span role="status" className={`text-xs ${meldung.typ === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>{meldung.text}</span>}
        </div>
      )}

      {laden ? (
        <p className="text-sm text-ink-muted">Wird geladen…</p>
      ) : aktiveKassen.length === 0 ? (
        <p className="text-sm text-ink-subtle">Keine Kassen vorhanden.</p>
      ) : merkmal === 'drucker' && druckerListe.length === 0 ? (
        <p className="text-sm text-ink-subtle">Noch kein Bonierdrucker angelegt — bitte zuerst oben bei „Drucker" einen einrichten.</p>
      ) : zeilen.length === 0 ? (
        <p className="text-sm text-ink-subtle">
          {ebene === 'artikel'
            ? (zeigen === 'ohne'
              ? 'Jeder Artikel hat über seine Warengruppe oder eigene Angabe eine Zuordnung.'
              : 'Kein Artikel mit eigener Zuordnung — such oben einen Artikel oder wähle „Alle Artikel", um ihn einem Drucker oder einer Station zuzuordnen.')
            : 'Noch keine Warengruppen angelegt.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm" data-testid="routing-matrix" data-ebene={ebene} data-merkmal={merkmal}>
            <thead className="bg-panel-2 text-ink-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium sticky left-0 bg-panel-2 z-10 align-top min-w-[12rem]">
                  {ebene === 'artikel' && (
                    <input
                      type="checkbox"
                      aria-label="Alle gezeigten Artikel markieren"
                      className="mr-2 align-middle"
                      checked={zeilen.length > 0 && zeilen.every(z => auswahl.has(z.id))}
                      onChange={e => setAuswahl(e.target.checked ? new Set(zeilen.map(z => z.id)) : new Set())}
                    />
                  )}
                  {ebene === 'warengruppen' ? 'Warengruppe' : 'Artikel'}
                </th>
                <th className="px-2 py-2 text-left font-medium align-top min-w-[8rem]">
                  Allgemein
                  <div className="text-[10px] font-normal text-ink-subtle">{eigenErklaerung}</div>
                </th>
                {aktiveKassen.map(k => (
                  <th key={k.id} className="px-2 py-2 text-left font-medium align-top min-w-[8rem]">
                    <div className="truncate">{kassenName(k)}</div>
                    {merkmal === 'station' && (
                      <div className={`text-[10px] font-normal ${k.kdsAktiv ? 'text-brand-700' : 'text-amber-700'}`}>{k.kdsAktiv ? 'KDS an' : 'KDS aus'}</div>
                    )}
                    <select
                      aria-label={`Alle ${ebene === 'warengruppen' ? 'Warengruppen' : 'gezeigten Artikel'} an ${kassenName(k)} setzen`}
                      value=""
                      onChange={e => { const w = e.target.value; e.target.value = ''; if (w !== '__') setzeSpalte(k, w === 'standard' ? '' : w) }}
                      className="mt-1 block w-full rounded border border-line bg-panel px-1 py-0.5 text-[11px] font-normal text-ink-muted"
                    >
                      <option value="__">Alle setzen auf …</option>
                      <option value="standard">Standard (Ausnahmen entfernen)</option>
                      <option value="keiner">— keiner —</option>
                      {optionen.map(o => <option key={o.wert} value={o.wert}>{o.label}</option>)}
                    </select>
                  </th>
                ))}
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {zeilen.map(z => {
                const eigenWert = merkmal === 'drucker' ? (z.eigen.drucker ?? '') : (z.eigen.station ?? '')
                const geerbtText = wertName(z.geerbt)
                const hatAusnahme = aktiveKassen.some(k => hatAngabe(nachZelle.get(zellenSchluessel(k.id, z.ziel)), merkmal))
                return (
                  <tr key={z.id} data-testid="routing-zeile" data-name={z.name} data-pfad={z.untertitel} className="hover:bg-panel-2/60">
                    <td className="px-3 py-1.5 sticky left-0 bg-panel z-10" title={z.untertitel}>
                      <div className="flex items-start gap-2">
                      {ebene === 'artikel' && (
                        <input type="checkbox" aria-label={`${z.name} markieren`} className="mt-1" checked={auswahl.has(z.id)} onChange={() => toggleAuswahl(z.id)} />
                      )}
                      <div style={{ paddingLeft: `${z.tiefe * 1.25}rem` }}>
                        <div className="flex items-center gap-1 font-medium text-ink">
                          {z.tiefe > 0 && <span aria-hidden className="text-ink-subtle">↳</span>}
                          <span>{z.name}</span>
                        </div>
                        {ebene === 'artikel' && <div className="text-[11px] text-ink-subtle">{z.untertitel}</div>}
                      </div>
                      </div>
                    </td>

                    {/* Allgemein */}
                    <td className="px-2 py-1.5">
                      <select
                        aria-label={`${merkmalName} ${z.name} allgemein`}
                        data-testid="routing-allgemein"
                        value={eigenWert}
                        onChange={e => allgemeinSpeichern.mutate({ ziel: z.ziel, wert: e.target.value })}
                        className={`${ZELLE} ${eigenWert ? 'border-line-strong' : 'border-line text-ink-muted'}`}
                      >
                        <option value="">{ebene === 'warengruppen' && z.geerbt.station === null && z.geerbt.bonierdruckerId === null ? '— keiner —' : `↳ ${geerbtText}`}</option>
                        {optionen.map(o => <option key={o.wert} value={o.wert}>{o.label}</option>)}
                      </select>
                    </td>

                    {/* Je Kasse */}
                    {aktiveKassen.map(k => {
                      const a = nachZelle.get(zellenSchluessel(k.id, z.ziel))
                      const wert = zellenWert(a, merkmal)
                      const wirksam = wirksamAnKasse(k, z)
                      const grund = gedimmt(k, z)
                      return (
                        <td key={k.id} className={`px-2 py-1.5 ${grund ? 'opacity-45' : ''}`} {...(grund ? { title: grund } : {})}>
                          <select
                            aria-label={`${merkmalName} ${z.name} an ${kassenName(k)}`}
                            data-testid="routing-zelle"
                            data-kasse={k.kassenId}
                            data-ausnahme={wert === '' ? 'nein' : 'ja'}
                            value={wert}
                            onChange={e => setzeZelle(k, z.ziel, e.target.value)}
                            className={`${ZELLE} ${wert === '' ? 'border-line text-ink-muted' : 'border-brand-500 bg-brand-50 font-medium'}`}
                          >
                            <option value="">{wert === '' ? `↳ ${wertName(wirksam)}` : 'Standard (zurücksetzen)'}</option>
                            <option value="keiner">— keiner —</option>
                            {optionen.map(o => <option key={o.wert} value={o.wert}>{o.label}</option>)}
                          </select>
                        </td>
                      )
                    })}

                    <td className="px-2 py-1.5 text-right">
                      {hatAusnahme && (
                        <button
                          type="button"
                          title="Alle Ausnahmen dieser Zeile entfernen (an allen Kassen wieder wie allgemein)"
                          aria-label={`Ausnahmen von ${z.name} entfernen`}
                          onClick={() => zeileZuruecksetzen(z)}
                          className="text-xs text-ink-subtle hover:text-red-600"
                        >✕</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {ebene === 'artikel' && !laden && artikelZeilen.length > anzahl && (
        <button type="button" onClick={() => setAnzahl(n => n + ARTIKEL_SEITE)}
          className="text-sm text-brand-700 hover:underline">
          Weitere Artikel anzeigen ({artikelZeilen.length - anzahl} übrig)
        </button>
      )}
    </section>
  )
}
