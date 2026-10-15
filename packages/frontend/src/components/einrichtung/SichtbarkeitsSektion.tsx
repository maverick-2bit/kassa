/**
 * Warengruppen-Verteilung (Matrix: Warengruppe × Kasse) — welche Warengruppen an welcher Kasse erscheinen.
 *
 * Die Logik (Haken, „samt Untergruppen", „Alle sichtbar" / „Alle ausblenden", Neustart) steht in
 * lib/sichtbarkeit.ts und gilt genauso in der POS-Konfiguration. Die Daten kommen aus der gemeinsamen
 * Einrichtungs-Abfrage; gespeichert wird weiter die Liste der sichtbaren Warengruppen je Kasse.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { kategorieApi } from '../../lib/api'
import { baumFlach, kategorieAnzeigeNamen, kategoriePfad } from '../../lib/kategorie-baum'
import {
  SICHTBARKEIT_TEXTE, alleAusblendenKlick, alleSichtbarKlick, anzeigeZustaende, auswahlStatus, gruppeKlick, mitNeustart,
  teilbaumKlick, zustandTitel, type Auswahl, type Uebergang,
} from '../../lib/sichtbarkeit'
import { kassenName } from '../../lib/einrichtung'
import { SichtbarkeitsHaken } from '../SichtbarkeitsHaken'
import { SichtbarkeitsKnoepfe } from '../SichtbarkeitsKnoepfe'
import { TeilbaumKnopf } from '../TeilbaumKnopf'
import { useEinrichtung } from './EinrichtungKontext'

export function SichtbarkeitsSektion() {
  const { kassen, laedt, speichereKasse } = useEinrichtung()
  // Nur aktive: eine deaktivierte Warengruppe erscheint an keiner Kasse, braucht also keine Zeile
  const kategorienQuery = useQuery({ queryKey: ['kategorien'], queryFn: () => kategorieApi.list(true) })

  const kategorien = kategorienQuery.data ?? []
  // Zeilen im Baum (Reihenfolge unter Geschwistern, Einrückung nach Tiefe) — gleichnamige Gruppen
  // wie die drei „Alkoholfrei" stehen so unter ihrer Elterngruppe und sind unterscheidbar
  const baum = useMemo(() => baumFlach(kategorien), [kategorien])
  const [hinweis, setHinweis] = useState<string | null>(null)
  // „Alle ausblenden" = Auswahl-NEUSTART einer Kasse: nur Oberflächenzustand (lib/sichtbarkeit), nie gespeichert —
  // der Server kennt „keine Gruppe" nicht (leer = alle). Je Kasse getrennt; Verlassen der Seite oder Neuladen
  // verwirft ihn, dann gilt wieder der Serverstand.
  const [neustartKassen, setNeustartKassen] = useState<ReadonlySet<string>>(() => new Set())
  // Kassen, deren Auswahl gerade gespeichert wird (Knöpfe solange gesperrt)
  const [speichert, setSpeichert] = useState<ReadonlySet<string>>(() => new Set())

  function setzeAuswahl(kasseId: string, ids: string[]) {
    setSpeichert(prev => new Set(prev).add(kasseId))
    speichereKasse(kasseId, { sichtbareKategorieIds: ids })
      // Fehlgeschlagen: den vorab angezeigten Stand verwirft die Einrichtung — es gilt der Serverstand
      .catch(err => setHinweis(`Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSpeichert(prev => { const n = new Set(prev); n.delete(kasseId); return n }))
  }

  /** Zustand einer Kasse; null, solange die Daten nicht geladen sind — sonst überschriebe ein Klick die noch unbekannte Auswahl. */
  function auswahlVon(kasseId: string): Auswahl | null {
    const k = kassen.find(x => x.id === kasseId)
    return k ? { liste: k.sichtbareKategorieIds, neustart: neustartKassen.has(kasseId) } : null
  }

  /** Ergebnis eines Klicks übernehmen (gemeinsame Logik mit der POS-Konfiguration: lib/sichtbarkeit). */
  function anwenden(kasse: { id: string; name: string }, u: Uebergang) {
    setNeustartKassen(prev => mitNeustart(prev, kasse.id, u.neustart))
    setHinweis(u.blockiert === 'letzte'
      ? `${kassen.length > 1 ? `${kasse.name}: ` : ''}${SICHTBARKEIT_TEXTE.letzteHinweis}`
      : null)
    if (u.speichern) setzeAuswahl(kasse.id, u.speichern)
  }

  const laden = laedt || kategorienQuery.isLoading
  const anzeigeName = useMemo(() => kategorieAnzeigeNamen(kategorien), [kategorien])

  // Gruppen mit Untergruppen bekommen den Komfort-Knopf „samt Untergruppen"
  const hatKinder = useMemo(() => new Set(kategorien.flatMap(c => (c.parentId ? [c.parentId] : []))), [kategorien])

  // Eine Spalte je Kasse — Zustand, Beschriftung und Haken einmal je Kasse berechnet (jede Kasse für sich)
  const spalten = kassen.map(k => {
    const auswahl = auswahlVon(k.id)
    return {
      id:        k.id,
      name:      kassenName(k),
      auswahl,
      status:    auswahl ? auswahlStatus(kategorien, auswahl) : null,
      zustaende: auswahl ? anzeigeZustaende(kategorien, auswahl) : null,
    }
  })

  return (
    <section id="einrichtung-warengruppen" className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink">Warengruppen-Verteilung</h2>
        <p className="text-sm text-ink-muted mt-0.5">
          Lege fest, welche Warengruppen an welcher Kasse erscheinen — z. B. eine Kasse „Getränke",
          eine Kasse „Speisen". Ohne Einschränkung sind <strong>alle</strong> Warengruppen angehakt
          (auch künftig angelegte). <strong>Jede Warengruppe wird einzeln gewählt</strong>: Ein Haken gilt nur
          für diese Gruppe und ihre eigenen Artikel, nicht für ihre Untergruppen — der kleine Knopf daneben
          schaltet die Gruppe samt allen Untergruppen auf einmal. Ist nur eine Untergruppe gewählt, zeigt
          die Elterngruppe einen halben Haken und bleibt als Zugang sichtbar — ohne eigene Artikel.
          Mindestens eine Warengruppe bleibt immer sichtbar. „Alle ausblenden" entfernt alle Haken einer Kasse,
          um die Auswahl neu zu beginnen: Gespeichert wird erst die erste Warengruppe, die du danach einschaltest.
        </p>
      </div>

      {hinweis && (
        <p role="status" data-testid="verteilung-hinweis" className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {hinweis}
        </p>
      )}

      {spalten.filter(s => s.status?.art === 'keine').map(s => (
        <p key={s.id} role="status" data-testid="verteilung-neustart-hinweis" className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {kassen.length > 1 && <strong>{s.name}: </strong>}
          {SICHTBARKEIT_TEXTE.neustartHinweis}
        </p>
      ))}

      {laden ? (
        <p className="text-sm text-ink-muted">Wird geladen…</p>
      ) : kategorien.length === 0 ? (
        <p className="text-sm text-ink-subtle">Noch keine Warengruppen angelegt.</p>
      ) : kassen.length === 0 ? (
        <p className="text-sm text-ink-subtle">Keine Kassen vorhanden.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm" data-testid="verteilung-matrix">
            <thead className="bg-panel-2 text-ink-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium sticky left-0 bg-panel-2 z-10 align-top">Warengruppe</th>
                {spalten.map(s => (
                  <th key={s.id} className="px-2 py-2 text-center font-medium min-w-[7.5rem] align-top">
                    <div className="truncate">{s.name}</div>
                    <div
                      data-testid="verteilung-status"
                      data-art={s.status?.art ?? 'laedt'}
                      className={`text-[10px] font-normal mt-0.5 ${
                        s.status?.art === 'alle' ? 'text-brand-700' : s.status?.art === 'keine' ? 'text-amber-700' : 'text-ink-subtle'
                      }`}
                    >
                      {s.status ? s.status.text : '…'}
                    </div>
                    <SichtbarkeitsKnoepfe
                      art={s.status?.art ?? 'teilweise'}
                      disabled={!s.auswahl || speichert.has(s.id)}
                      testId="verteilung"
                      kassenName={s.name}
                      kompakt
                      onAlleSichtbar={() => { if (s.auswahl) anwenden(s, alleSichtbarKlick(s.auswahl)) }}
                      onAlleAusblenden={() => { if (s.auswahl) anwenden(s, alleAusblendenKlick(s.auswahl)) }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {baum.map(({ kategorie: kat, tiefe }) => {
                const pfad = kategoriePfad(kategorien, kat.id)
                return (
                  <tr key={kat.id} data-testid="verteilung-zeile" data-pfad={pfad} data-tiefe={tiefe} className="hover:bg-panel-2/60">
                    <td className="px-3 py-2 text-ink font-medium sticky left-0 bg-panel z-10" title={pfad}>
                      <div className="flex items-center gap-1" style={{ paddingLeft: `${tiefe * 1.25}rem` }}>
                        {tiefe > 0 && <span aria-hidden className="text-ink-subtle">↳</span>}
                        <span className={kat.aktiv ? '' : 'text-ink-subtle'}>{kat.name}</span>
                        {!kat.aktiv && <span className="text-[10px] font-normal italic text-ink-subtle">inaktiv</span>}
                      </div>
                    </td>
                    {spalten.map(s => {
                      // Erst bedienbar, wenn die Daten dieser Kasse geladen sind —
                      // sonst würde ein Klick die noch ungeladene Auswahl überschreiben.
                      const zustand = s.zustaende?.get(kat.id) ?? 'aus'
                      return (
                        <td key={s.id} className="px-3 py-2">
                          <div className="flex items-center justify-center gap-1">
                            {/* linker Platzhalter in Breite des Teilbaum-Knopfs: der Haken bleibt in jeder Zeile mittig */}
                            <span aria-hidden className="inline-block h-5 w-5 flex-shrink-0" />
                            <SichtbarkeitsHaken
                              zustand={zustand}
                              disabled={!s.auswahl}
                              onChange={() => { if (s.auswahl) anwenden(s, gruppeKlick(kategorien, s.auswahl, kat.id)) }}
                              label={`${anzeigeName(kat.id)} an ${s.name}`}
                              title={zustandTitel(zustand, pfad)}
                            />
                            {hatKinder.has(kat.id) ? (
                              <TeilbaumKnopf
                                disabled={!s.auswahl}
                                onClick={() => { if (s.auswahl) anwenden(s, teilbaumKlick(kategorien, s.auswahl, kat.id)) }}
                                label={`${anzeigeName(kat.id)} samt Untergruppen an ${s.name} ein- oder ausschalten`}
                              />
                            ) : (
                              <span aria-hidden className="inline-block h-5 w-5 flex-shrink-0" />
                            )}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
