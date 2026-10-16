/**
 * LayoutExportModal — Warengruppen samt Untergruppen und ihren Artikeln in eine Layout-Datei (JSON) schreiben und in
 * einer anderen Kassa (einem anderen Mandanten) mit „Layout importieren" wieder einlesen: Name, Preis, MwSt, Farbe,
 * Raster-Platz, Allergene und Optionen der Artikel wandern mit. Nicht dabei: Drucker/KDS-Zuordnung der Artikel, Lager,
 * Rezepte, Bilder, Aktionen, Favoriten.
 *
 * Eine angehakte Gruppe nimmt ihre Untergruppen mit (sie erscheinen angehakt und gesperrt). Wer nur einen Teil einer
 * Gruppe braucht, hakt die Untergruppen einzeln an. Der Dialog setzt seinen Zustand beim SCHLIESSEN zurück.
 */

import { useMemo, useState } from 'react'
import {
  baumFlach, kategoriePfad, nachkommenIds, wurzelgruppen,
  type Artikel, type Kategorie, type LayoutExport,
} from '@kassa/shared'
import { artikelApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { dateinameTeil, speichereAlsDatei } from '../lib/dateiSpeichern'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

interface Props {
  open:       boolean
  onClose:    () => void
  /** Aktive Warengruppen */
  kategorien: readonly Kategorie[]
  /** Artikel (für die Zahlen je Gruppe) */
  artikel:    readonly Artikel[]
}

type Ergebnis = LayoutExport & { dateiname: string }

export function LayoutExportModal({ open, onClose, kategorien, artikel }: Props) {
  const [gewaehlt, setGewaehlt] = useState<ReadonlySet<string>>(new Set())
  const [laeuft, setLaeuft]     = useState(false)
  const [fehler, setFehler]     = useState<string | null>(null)
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null)

  const baum = useMemo(() => baumFlach(kategorien), [kategorien])
  const artikelJeGruppe = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of artikel) {
      if (!a.aktiv || a.istBestandteil || !a.kategorieId) continue
      m.set(a.kategorieId, (m.get(a.kategorieId) ?? 0) + 1)
    }
    return m
  }, [artikel])

  /** Untergruppen angehakter Gruppen: sind ohnehin dabei */
  const inbegriffen = useMemo(() => {
    const s = new Set<string>()
    for (const id of gewaehlt) for (const kind of nachkommenIds(kategorien, id)) s.add(kind)
    return s
  }, [gewaehlt, kategorien])

  const enthalten = useMemo(() => new Set([...gewaehlt, ...inbegriffen]), [gewaehlt, inbegriffen])
  const anzahlArtikel = [...enthalten].reduce((summe, id) => summe + (artikelJeGruppe.get(id) ?? 0), 0)

  const schliessen = () => {
    setGewaehlt(new Set()); setLaeuft(false); setFehler(null); setErgebnis(null)
    onClose()
  }

  const umschalten = (id: string) => setGewaehlt(prev => {
    const neu = new Set(prev)
    if (neu.has(id)) neu.delete(id)
    else {
      neu.add(id)
      for (const kind of nachkommenIds(kategorien, id)) neu.delete(kind)       // die Untergruppen sind jetzt ohnehin dabei
    }
    return neu
  })

  const exportieren = async () => {
    setLaeuft(true); setFehler(null)
    try {
      const e = await artikelApi.layoutExport([...gewaehlt])
      const datum = new Date().toISOString().slice(0, 10)
      const dateiname = `kassa-layout-${dateinameTeil(getAuth()?.mandant.firmenname ?? 'kassa')}-${datum}.json`
      speichereAlsDatei(dateiname, JSON.stringify(e.layout, null, 2))
      setErgebnis({ ...e, dateiname })
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Export fehlgeschlagen')
    } finally {
      setLaeuft(false)
    }
  }

  return (
    <Modal open={open} onClose={schliessen} title="Layout exportieren (JSON)" size="lg">
      <div className="space-y-4" data-testid="layout-export">
        {ergebnis === null ? (
          <>
            <p className="text-sm text-ink-muted">
              Schreibt die gewählten Warengruppen samt Untergruppen und ihren Artikeln (Name, Preis, MwSt, Farbe,
              Raster-Platz, Allergene, Optionen) in eine Datei. In der anderen Kassa — dem anderen Mandanten — lädst du
              sie unter Artikel mit „Layout importieren (JSON)" ein; dort gibt es zuerst eine Vorschau. Nicht enthalten:
              Drucker- und KDS-Zuordnung der Artikel, Lager, Rezepte, Bilder, Aktionen und Favoriten.
            </p>

            {baum.length === 0 ? (
              <p className="text-sm text-ink-muted">Es gibt keine aktiven Warengruppen.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-ink" data-testid="layout-export-zaehler">
                    {enthalten.size === 0
                      ? 'Noch nichts gewählt'
                      : <><strong>{enthalten.size}</strong> {enthalten.size === 1 ? 'Gruppe' : 'Gruppen'}, <strong>{anzahlArtikel}</strong> {anzahlArtikel === 1 ? 'Artikel' : 'Artikel'}</>}
                  </p>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" disabled={laeuft}
                            onClick={() => setGewaehlt(new Set(wurzelgruppen(kategorien).map(k => k.id)))}>Alle</Button>
                    <Button variant="secondary" size="sm" disabled={laeuft || gewaehlt.size === 0}
                            onClick={() => setGewaehlt(new Set())}>Keine</Button>
                  </div>
                </div>

                <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
                  {baum.map(({ kategorie: k, tiefe }) => {
                    const explizit = gewaehlt.has(k.id)
                    const implizit = inbegriffen.has(k.id) && !explizit
                    return (
                      <li key={k.id}>
                        <label
                          className={`flex items-center gap-2 py-1.5 pr-3 text-sm ${implizit ? 'text-ink-muted' : 'text-ink'}`}
                          style={{ paddingLeft: `${0.75 + tiefe * 1.25}rem` }}
                          title={implizit ? 'Ist durch die übergeordnete Gruppe schon dabei' : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={explizit || implizit}
                            disabled={implizit || laeuft}
                            onChange={() => umschalten(k.id)}
                            aria-label={`Warengruppe ${kategoriePfad(kategorien, k.id)} wählen`}
                            className="rounded border-line-strong text-brand-500 focus:ring-brand-500"
                          />
                          <span className="min-w-0 flex-1 truncate">{k.name}</span>
                          <span className="shrink-0 text-xs text-ink-subtle">{artikelJeGruppe.get(k.id) ?? 0} Artikel</span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </>
        ) : (
          <div className="space-y-3" data-testid="layout-export-ergebnis">
            <p className="text-sm font-medium text-ink">Exportiert in <span className="font-mono">{ergebnis.dateiname}</span></p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
              <li>{ergebnis.zusammenfassung.gruppen} Warengruppen, {ergebnis.zusammenfassung.artikel} Artikel, {ergebnis.zusammenfassung.optionsgruppen} Optionsgruppen</li>
              {ergebnis.hinweise.map((h, i) => <li key={i} className="text-amber-700">{h}</li>)}
            </ul>
            <p className="text-sm text-ink-muted">
              Nächster Schritt: in der anderen Kassa anmelden → Artikel → „Layout importieren (JSON)" → diese Datei wählen.
            </p>
          </div>
        )}

        {fehler && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{fehler}</div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-3">
          {ergebnis ? (
            <Button onClick={schliessen}>Fertig</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={schliessen}>Abbrechen</Button>
              <Button onClick={() => { void exportieren() }} loading={laeuft} disabled={laeuft || enthalten.size === 0}>
                Exportieren
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
