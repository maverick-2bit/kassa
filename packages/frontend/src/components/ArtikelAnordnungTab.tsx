/**
 * ArtikelAnordnungTab — POS-Konfiguration → Reiter „Artikel": Artikel einer Warengruppe als Kacheln anordnen.
 *
 * Zwei Ebenen (Umschalter oben):
 *  - „Diese Kasse (eigene Anordnung)": gilt nur an der oben gewählten Kasse — Kasse, Tisch und Kellner-App —
 *    in der Spaltenzahl DIESER Kasse (dieselbe Einstellung wie im Reiter Favoriten). Leere Felder, Ausblenden.
 *    Ohne gespeicherte Anordnung gilt das Standard-Layout; der Editor startet immer mit dem, was die Kasse
 *    gerade zeigt, damit der erste Speichervorgang genau das festhält.
 *  - „Standard für alle Kassen": das Layout des Artikelstamms (raster_position + reihenfolge, wie der
 *    Layout-Import es setzt). Die Spaltenzahl ist hier nur Vorschau (Standard 3, wie das Import-Layout).
 * Der Editor selbst: components/ArtikelAnordnungEditor.tsx; die Zustandslogik: lib/artikel-anordnung.ts.
 *
 * Ungespeicherte Änderungen gehen nie still verloren: Wechsel der Warengruppe oder der Ebene fragt nach (Hinweis
 * im Reiter), Kassen- und Reiterwechsel fragt die Seite nach (`onGeaendertChange`).
 */

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { loeseAnordnungAuf, type Artikel, type Kategorie } from '@kassa/shared'
import { artikelApi, posConfigApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { baumFlach, erweitereSichtbarkeit, kategorieAnzeigeNamen, kategoriePfad, untergruppenVon } from '../lib/kategorie-baum'
import { sichtbareWarengruppen } from '../lib/artikel-reiter'
import {
  anordnungSchluessel,
  anordnungVon,
  anzahlPlatziert,
  entferneLuecken,
  hatLuecken,
  unbekannteZeilenBehalten,
  zuKassenEintraegen,
  zuStandardEintraegen,
  type Anordnung,
} from '../lib/artikel-anordnung'
import { Button } from './ui/Button'
import { ArtikelAnordnungEditor } from './ArtikelAnordnungEditor'

type Modus = 'kasse' | 'standard'

/** Vorschau-Spalten im Standard-Layout: das Import-Layout ist für 3 Spalten gebaut. */
const STANDARD_VORSCHAU_SPALTEN = 3

interface Props {
  kategorien:  Kategorie[]
  alleArtikel: Artikel[]
  kasseId:     string
  /** Anzeigename der gewählten Kasse */
  kasseName:   string
  /** Meldet der Seite, ob ungespeicherte Änderungen vorliegen (Kassen-/Reiterwechsel fragt dort nach) */
  onGeaendertChange?: ((geaendert: boolean) => void) | undefined
}

/** Hinweis „ungespeicherte Änderungen" mit den zwei Auswegen — nie `fixed`, steht im Fluss der Seite. */
export function UngespeichertHinweis({ onVerwerfen, onBleiben }: { onVerwerfen: () => void; onBleiben: () => void }) {
  return (
    <div
      role="alert"
      data-testid="anordnung-wechsel-hinweis"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"
    >
      <span className="font-medium">Die Anordnung hat ungespeicherte Änderungen.</span>
      <Button size="sm" variant="secondary" onClick={onVerwerfen}>Verwerfen und wechseln</Button>
      <Button size="sm" variant="secondary" onClick={onBleiben}>Hier bleiben</Button>
    </div>
  )
}

export function ArtikelAnordnungTab({ kategorien, alleArtikel, kasseId, kasseName, onGeaendertChange }: Props) {
  const qc = useQueryClient()
  const istAdmin = getAuth()?.user.rolle === 'admin'

  const [modus, setModus] = useState<Modus>('kasse')
  const [vorschauSpalten, setVorschauSpalten] = useState(STANDARD_VORSCHAU_SPALTEN)

  const posQuery = useQuery({
    queryKey: ['pos-config', kasseId],
    queryFn:  () => posConfigApi.get(kasseId),
  })
  const layoutsQuery = useQuery({
    queryKey: ['kasse-artikel-layouts', kasseId],
    queryFn:  () => posConfigApi.artikelLayouts(kasseId),
  })

  const spalten = modus === 'kasse' ? (posQuery.data?.artikelProZeile ?? 4) : vorschauSpalten

  // Wie an der Kasse: Untergruppen einer sichtbaren Gruppe sind sichtbar, Vorfahren einer sichtbaren Untergruppe auch
  const sichtbareIds = useMemo(
    () => erweitereSichtbarkeit(kategorien, posQuery.data?.sichtbareKategorieIds ?? []) ?? [],
    [kategorien, posQuery.data],
  )
  const kasseSiehtGruppe = (id: string) => sichtbareIds.length === 0 || sichtbareIds.includes(id)
  /** Aktive, an dieser Kasse sichtbare Gruppen — daraus die Untergruppen-Kacheln, die die Kasse vorn zeigt */
  const sichtbareGruppen = useMemo(() => sichtbareWarengruppen(kategorien, sichtbareIds), [kategorien, sichtbareIds])

  // Warengruppen-Chips im Baum; gleichnamige Gruppen zeigen den Pfad. Die Kassen-Ebene bietet nur an, was die Kasse zeigt.
  const gruppen = useMemo(
    () => baumFlach(kategorien).map(e => e.kategorie).filter(k => k.aktiv && (modus === 'standard' || kasseSiehtGruppe(k.id))),
    [kategorien, modus, sichtbareIds], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const anzeigeName = useMemo(() => kategorieAnzeigeNamen(kategorien.filter(k => k.aktiv)), [kategorien])
  const [gewaehlteKatId, setGewaehlteKatId] = useState('')
  const katId = gruppen.some(k => k.id === gewaehlteKatId) ? gewaehlteKatId : (gruppen[0]?.id ?? '')

  // Artikel, die die Kasse in dieser Gruppe zeigt: aktiv und verkäuflich (Rohstoffe sind nur Lager)
  const artikelDerGruppe = useMemo(
    () => alleArtikel.filter(a => a.kategorieId === katId && a.aktiv && !a.istBestandteil),
    [alleArtikel, katId],
  )
  const artikelById = useMemo(() => new Map(artikelDerGruppe.map(a => [a.id, a] as const)), [artikelDerGruppe])
  const farbeProKategorie = useMemo(() => new Map(kategorien.map(k => [k.id, k.farbe] as const)), [kategorien])
  const untergruppen = useMemo(() => (katId ? untergruppenVon(sichtbareGruppen, katId) : []), [sichtbareGruppen, katId])

  // Effektive Anordnung: eigene Zeilen dieser Kasse, sonst Standard (immer das, was die Kasse jetzt zeigt)
  const gespeicherteZeilen = layoutsQuery.data?.find(l => l.kategorieId === katId)?.eintraege
  const aufgeloest = useMemo(
    () => loeseAnordnungAuf(artikelDerGruppe, modus === 'kasse' ? gespeicherteZeilen : undefined),
    [artikelDerGruppe, modus, gespeicherteZeilen],
  )
  const serverAnordnung = useMemo(() => anordnungVon(aufgeloest), [aufgeloest])
  const serverSchluessel = anordnungSchluessel(serverAnordnung)
  const hatEigene = modus === 'kasse' && aufgeloest.eigene
  /** Diese Kasse hat für die Gruppe eine eigene Anordnung (auch im Standard-Modus wichtig zu wissen) */
  const kasseHatEigene = (layoutsQuery.data?.find(l => l.kategorieId === katId)?.eintraege.length ?? 0) > 0
  const bereit = !!posQuery.data && layoutsQuery.isSuccess && katId !== ''

  // Entwurf: wird beim Wechsel von Kasse/Gruppe/Ebene neu aufgesetzt und folgt dem Serverstand, solange nichts geändert ist
  const kontext = `${modus}|${kasseId}|${katId}`
  const [entwurf, setEntwurf] = useState<Anordnung | null>(null)
  const [entwurfKontext, setEntwurfKontext] = useState('')
  const [geaendert, setGeaendertRoh] = useState(false)
  // Die Seite erfährt es SOFORT im selben Ereignis (nicht erst per Effekt): ein Klick auf Kassen-Chip oder Reiter
  // unmittelbar nach einer Änderung muss den Hinweis noch auslösen
  const setGeaendert = (wert: boolean) => { setGeaendertRoh(wert); onGeaendertChange?.(wert) }
  useEffect(() => {
    if (!bereit) return
    if (entwurfKontext !== kontext) {
      setEntwurf(serverAnordnung)
      setEntwurfKontext(kontext)
      setGeaendert(false)
    } else if (!geaendert) {
      setEntwurf(serverAnordnung)
    }
  }, [bereit, kontext, entwurfKontext, geaendert, serverSchluessel]) // eslint-disable-line react-hooks/exhaustive-deps
  const entwurfGueltig = bereit && entwurf !== null && entwurfKontext === kontext

  // Beim Verlassen des Reiters (Kassen-/Reiterwechsel) gibt es nichts Ungespeichertes mehr zu melden
  useEffect(() => () => onGeaendertChange?.(false), []) // eslint-disable-line react-hooks/exhaustive-deps

  const [meldung, setMeldung] = useState<string | null>(null)
  // Ein Fehler vom letzten Speichern verschwindet, sobald wieder etwas geändert wird
  const [fehlerAusblenden, setFehlerAusblenden] = useState(false)
  const [zuruecksetzenFrage, setZuruecksetzenFrage] = useState(false)

  const aendere = (neu: Anordnung) => { setEntwurf(neu); setGeaendert(true); setMeldung(null); setFehlerAusblenden(true) }

  // Ungespeicherte Änderungen: Wechsel der Gruppe/Ebene fragt nach
  const [wechsel, setWechsel] = useState<(() => void) | null>(null)
  const mitSchutz = (aktion: () => void) => { if (geaendert) setWechsel(() => aktion); else aktion() }
  const verwerfenUndWechseln = () => {
    const aktion = wechsel
    setWechsel(null)
    setGeaendert(false)
    setZuruecksetzenFrage(false)
    aktion?.()
  }

  const speichern = useMutation({
    mutationFn: async (z: Anordnung) => {
      if (modus === 'kasse') {
        const neu = zuKassenEintraegen(z)
        // Zeilen deaktivierter Artikel (der Editor kennt sie nicht) behalten ihren Platz
        const behalten = unbekannteZeilenBehalten(gespeicherteZeilen ?? [], new Set(artikelDerGruppe.map(a => a.id)), neu)
        await posConfigApi.artikelLayoutSpeichern(kasseId, katId, [...neu, ...behalten])
      } else {
        await artikelApi.rasterSpeichern(katId, zuStandardEintraegen(z))
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: modus === 'kasse' ? ['kasse-artikel-layouts', kasseId] : ['artikel'] })
      setGeaendert(false)
      setMeldung(modus === 'kasse' ? 'Gespeichert.' : 'Standard-Layout gespeichert.')
    },
  })

  const zuruecksetzen = useMutation({
    mutationFn: () => posConfigApi.artikelLayoutZuruecksetzen(kasseId, katId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['kasse-artikel-layouts', kasseId] })
      setGeaendert(false)
      setZuruecksetzenFrage(false)
      setMeldung('Zurückgesetzt: Hier gilt wieder das Standard-Layout.')
    },
  })

  // „Artikel je Zeile" — dieselbe Kassen-Einstellung wie im Reiter Favoriten (gilt für Kasse UND Kellner-App)
  const spaltenWahl = useMutation({
    mutationFn: (n: number) => posConfigApi.update(kasseId, { artikelProZeile: n }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pos-config', kasseId] }),
  })
  const waehleSpalten = (n: number) => {
    if (modus === 'kasse') spaltenWahl.mutate(n)
    else setVorschauSpalten(n)
  }

  const fehler = fehlerAusblenden ? null : (speichern.error ?? zuruecksetzen.error)
  const beschaeftigt = speichern.isPending || zuruecksetzen.isPending
  const gesperrt = !istAdmin || beschaeftigt
  const z = entwurfGueltig ? entwurf : null
  const kannSpeichern = istAdmin && z !== null && artikelDerGruppe.length > 0 && (geaendert || (modus === 'kasse' && !hatEigene))

  const waehleGruppe = (id: string) => {
    if (id === katId) return
    mitSchutz(() => { setGewaehlteKatId(id); setMeldung(null); setZuruecksetzenFrage(false) })
  }
  const waehleModus = (neu: Modus) => {
    if (neu === modus) return
    mitSchutz(() => { setModus(neu); setMeldung(null); setZuruecksetzenFrage(false) })
  }

  return (
    <div className="space-y-4" data-testid="anordnung-tab">
      {/* Ebene: diese Kasse oder Standard für alle */}
      <div className="space-y-1.5">
        <div role="group" aria-label="Anordnung gilt für" className="inline-flex rounded-xl bg-panel-2 p-1">
          {([
            ['kasse', 'Diese Kasse (eigene Anordnung)', 'anordnung-modus-kasse'],
            ['standard', 'Standard für alle Kassen', 'anordnung-modus-standard'],
          ] as const).map(([wert, label, testid]) => (
            <button
              key={wert}
              type="button"
              data-testid={testid}
              aria-pressed={modus === wert}
              onClick={() => waehleModus(wert)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                modus === wert ? 'bg-panel text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-ink-subtle">
          {modus === 'kasse'
            ? <>Die Anordnung gilt nur für <strong>{kasseName}</strong> — Kasse, Tisch und Kellner-App — in der Spaltenzahl dieser Kasse.
                Ohne gespeicherte Anordnung gilt das Standard-Layout.</>
            : <>Das Standard-Layout gilt an allen Kassen, die für eine Warengruppe keine eigene Anordnung haben (es wird auch vom
                Layout-Import gesetzt).</>}
        </p>
      </div>

      {/* Artikel je Zeile */}
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-ink">Artikel je Zeile</h3>
        <div className="flex gap-1">
          {[2, 3, 4, 5, 6].map(n => (
            <button
              key={n}
              type="button"
              data-testid={`anordnung-spalten-${n}`}
              aria-pressed={spalten === n}
              onClick={() => waehleSpalten(n)}
              disabled={modus === 'kasse' && (spaltenWahl.isPending || !posQuery.data)}
              className={`h-9 w-9 rounded-lg text-sm font-semibold transition ${
                spalten === n ? 'bg-brand-600 text-white' : 'bg-panel-2 text-ink-muted hover:text-ink'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="text-xs text-ink-subtle">
          {modus === 'kasse'
            ? 'gilt für Kasse und Kellner-App gemeinsam (wie im Reiter Favoriten)'
            : 'nur Vorschau — das Standard-Layout speichert Slots, keine Spaltenzahl'}
        </span>
      </div>

      {/* Warengruppe */}
      <div className="flex flex-wrap gap-2">
        {gruppen.map(k => {
          const eigene = layoutsQuery.data?.some(l => l.kategorieId === k.id && l.eintraege.length > 0) ?? false
          return (
            <button
              key={k.id}
              type="button"
              data-testid="wg-chip"
              data-kategorie-id={k.id}
              data-eigene={eigene}
              onClick={() => waehleGruppe(k.id)}
              title={`${kategoriePfad(kategorien, k.id)}${eigene ? ' — eigene Anordnung an dieser Kasse' : ''}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                katId === k.id ? 'bg-brand-600 text-white' : 'bg-panel-2 text-ink-muted hover:text-ink'
              }`}
            >
              {anzeigeName(k.id)}
              {eigene && <span aria-hidden className="ml-1 text-[10px]">●</span>}
            </button>
          )
        })}
      </div>

      {wechsel && <UngespeichertHinweis onVerwerfen={verwerfenUndWechseln} onBleiben={() => setWechsel(null)} />}

      {!istAdmin && (
        <p data-testid="anordnung-nur-lesen" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Nur Administratoren können die Anordnung ändern — du siehst sie hier nur an.
        </p>
      )}

      {/* Status + Aktionen */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p
            data-testid="anordnung-status"
            data-eigene={hatEigene}
            className="text-sm text-ink-muted"
          >
            {modus === 'kasse'
              ? (hatEigene
                  ? <>✓ Eigene Anordnung für diese Kasse gespeichert.</>
                  : <>Noch keine eigene Anordnung — es gilt der Standard, hier so angezeigt. „Speichern" legt ihn für diese Kasse fest.</>)
              : <>Standard-Layout · {artikelDerGruppe.length} Artikel in dieser Warengruppe.</>}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="anordnung-luecken"
              variant="secondary"
              size="sm"
              disabled={gesperrt || !z || !hatLuecken(z)}
              title="Verdichtet die Artikel in der aktuellen Reihenfolge lückenlos — zum Beispiel vom 3er- zum 4er-Raster"
              onClick={() => z && aendere(entferneLuecken(z))}
            >
              Lücken entfernen
            </Button>
            {modus === 'kasse' && (
              <Button
                data-testid="anordnung-zuruecksetzen"
                variant="secondary"
                size="sm"
                disabled={gesperrt || !kasseHatEigene}
                title="Löscht die eigene Anordnung dieser Kasse für diese Warengruppe — es gilt wieder der Standard"
                onClick={() => setZuruecksetzenFrage(true)}
              >
                Auf Standard zurücksetzen
              </Button>
            )}
            <Button
              data-testid="anordnung-verwerfen"
              variant="secondary"
              size="sm"
              disabled={gesperrt || !geaendert}
              onClick={() => { setEntwurf(serverAnordnung); setGeaendert(false); setMeldung(null) }}
            >
              Änderungen verwerfen
            </Button>
            <Button
              data-testid="anordnung-speichern"
              size="sm"
              loading={speichern.isPending}
              disabled={!kannSpeichern || beschaeftigt}
              onClick={() => { if (z) { setFehlerAusblenden(false); speichern.mutate(z) } }}
            >
              Speichern
            </Button>
          </div>
        </div>

        {zuruecksetzenFrage && (
          <div
            role="alert"
            data-testid="anordnung-zuruecksetzen-frage"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"
          >
            <span className="font-medium">Eigene Anordnung dieser Kasse für diese Warengruppe löschen? Es gilt dann wieder das Standard-Layout.</span>
            <Button data-testid="anordnung-zuruecksetzen-ja" size="sm" variant="danger" loading={zuruecksetzen.isPending}
              onClick={() => { setFehlerAusblenden(false); zuruecksetzen.mutate() }}>
              Ja, zurücksetzen
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setZuruecksetzenFrage(false)}>Abbrechen</Button>
          </div>
        )}

        {modus === 'standard' && kasseHatEigene && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            {kasseName} hat für diese Warengruppe eine eigene Anordnung — Änderungen am Standard wirken dort erst nach „Auf Standard zurücksetzen".
          </p>
        )}

        {meldung && !fehler && (
          <p role="status" data-testid="anordnung-meldung" className="text-xs text-brand-700">{meldung}</p>
        )}
        {fehler && (
          <p role="alert" data-testid="anordnung-fehler" className="text-xs text-red-600">
            {fehler instanceof Error ? fehler.message : 'Speichern fehlgeschlagen'}
          </p>
        )}
      </div>

      {/* Editor */}
      {layoutsQuery.isError ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
          Die Anordnung konnte nicht geladen werden.{' '}
          <button type="button" className="font-medium underline" onClick={() => void layoutsQuery.refetch()}>Erneut versuchen</button>
        </div>
      ) : !bereit ? (
        <div className="py-8 text-center text-sm text-ink-subtle">{katId === '' ? 'Keine Warengruppen vorhanden.' : 'Laden…'}</div>
      ) : artikelDerGruppe.length === 0 && untergruppen.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-line p-8 text-center text-sm text-ink-subtle">
          Keine Artikel in dieser Warengruppe.
        </div>
      ) : z ? (
        <div className="space-y-1.5">
          <p className="text-xs text-ink-subtle">
            {anzahlPlatziert(z)} Artikel im Raster
            {untergruppen.length > 0 && <> · davor {untergruppen.length} {untergruppen.length === 1 ? 'Untergruppe' : 'Untergruppen'} als feste Kacheln</>}
            . Kacheln ziehen oder die Pfeile benutzen; leere Felder bleiben leer.
            {modus === 'kasse' && ' Die Kellner-App zeigt die Reihenfolge ohne Leerfelder.'}
          </p>
          <ArtikelAnordnungEditor
            anordnung={z}
            onChange={aendere}
            artikel={artikelById}
            untergruppen={untergruppen}
            spalten={spalten}
            farbeProKategorie={farbeProKategorie}
            artikelbilder={posQuery.data?.artikelbilderAktiv ?? true}
            ausblendenErlaubt={modus === 'kasse'}
            gesperrt={gesperrt}
          />
        </div>
      ) : null}
    </div>
  )
}
