/**
 * LayoutImportModal — Gruppenbaum, Artikelanordnung (inkl. leerer Rasterfelder),
 * Farben und Favoriten aus einer Layout-Datei (JSON) übernehmen.
 *
 * Ablauf: 1. Datei wählen → 2. Vorschau (dryRun, schreibt nichts) mit Bericht und
 * den beiden Haken → 3. „Anwenden" → Ergebnis. Danach werden alle Abfragen neu geladen.
 * Der Dialog setzt seinen Zustand beim SCHLIESSEN zurück (immer gemountet gedacht).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { LayoutBericht } from '@kassa/shared'
import { artikelApi } from '../lib/api'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

interface Props {
  open:    boolean
  onClose: () => void
}

type Schritt = 'auswahl' | 'vorschau' | 'erfolg'

export function LayoutImportModal({ open, onClose }: Props) {
  const qc = useQueryClient()
  const dateiRef = useRef<HTMLInputElement>(null)
  const [schritt, setSchritt] = useState<Schritt>('auswahl')
  const [dateiName, setDateiName] = useState('')
  const [layout, setLayout] = useState<unknown>(null)
  const [fehlendeAnlegen, setFehlendeAnlegen] = useState(true)
  const [spaltenSetzen, setSpaltenSetzen] = useState(true)
  /** Sauberer Neustart: Altbestand LÖSCHEN (Standard aus) + Tipp-Bestätigung */
  const [katalogLoeschen, setKatalogLoeschen] = useState(false)
  const [bestaetigung, setBestaetigung] = useState('')
  const [bericht, setBericht] = useState<LayoutBericht | null>(null)
  const [laeuft, setLaeuft] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  /** Zählt Vorschau-Anfragen: nur die jüngste darf das Ergebnis setzen (Haken schnell umgeschaltet) */
  const anfrage = useRef(0)

  const zuruecksetzen = useCallback(() => {
    anfrage.current++
    setSchritt('auswahl'); setDateiName(''); setLayout(null)
    setFehlendeAnlegen(true); setSpaltenSetzen(true); setKatalogLoeschen(false); setBestaetigung('')
    setBericht(null); setLaeuft(false); setFehler(null)
    if (dateiRef.current) dateiRef.current.value = ''
  }, [])

  const schliessen = () => { zuruecksetzen(); onClose() }

  const fehlerText = (e: unknown) => (e instanceof Error ? e.message : 'Unbekannter Fehler')

  const vorschau = useCallback(async (daten: unknown, anlegen: boolean, spalten: boolean, loeschen: boolean) => {
    const meine = ++anfrage.current
    setLaeuft(true); setFehler(null)
    try {
      const b = await artikelApi.layoutImport(daten, { dryRun: true, fehlendeAnlegen: anlegen, spaltenSetzen: spalten, katalogLoeschen: loeschen })
      if (meine !== anfrage.current) return
      setBericht(b); setSchritt('vorschau')
    } catch (e) {
      if (meine !== anfrage.current) return
      setFehler(fehlerText(e)); setBericht(null)
    } finally {
      if (meine === anfrage.current) setLaeuft(false)
    }
  }, [])

  // Haken geändert → Vorschau neu rechnen
  useEffect(() => {
    if (open && layout !== null && schritt === 'vorschau') void vorschau(layout, fehlendeAnlegen, spaltenSetzen, katalogLoeschen)
    // nur auf die Haken reagieren
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fehlendeAnlegen, spaltenSetzen, katalogLoeschen])

  const dateiGewaehlt = async (datei: File | undefined) => {
    if (!datei) return
    setFehler(null)
    try {
      const daten = JSON.parse(await datei.text()) as unknown
      setDateiName(datei.name); setLayout(daten)
      await vorschau(daten, fehlendeAnlegen, spaltenSetzen, katalogLoeschen)
    } catch (e) {
      setFehler(e instanceof SyntaxError ? 'Die Datei ist kein gültiges JSON.' : fehlerText(e))
    }
  }

  const anwenden = async () => {
    if (layout === null) return
    anfrage.current++
    setLaeuft(true); setFehler(null)
    try {
      const b = await artikelApi.layoutImport(layout, { dryRun: false, fehlendeAnlegen, spaltenSetzen, katalogLoeschen })
      setBericht(b); setSchritt('erfolg')
      await qc.invalidateQueries()
    } catch (e) {
      setFehler(fehlerText(e))
    } finally {
      setLaeuft(false)
    }
  }

  return (
    <Modal open={open} onClose={schliessen} title="Layout importieren (JSON)" size="lg">
      <div className="space-y-4" data-testid="layout-import">
        {schritt === 'auswahl' && (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              Übernimmt Gruppenbaum (mit Untergruppen), die Anordnung der Artikel im Raster samt leerer Felder,
              Farben und Favoriten aus einer Layout-Datei. Bestehende Artikel werden über den Namen zugeordnet —
              Preise, Stationen und Bonierdrucker bleiben unberührt. Zuerst gibt es eine Vorschau, die nichts ändert.
            </p>
            <input
              ref={dateiRef}
              type="file"
              accept=".json,application/json"
              aria-label="Layout-Datei (JSON)"
              onChange={(e) => { void dateiGewaehlt(e.target.files?.[0]) }}
              className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-panel-2 file:px-3 file:py-1.5 file:text-sm"
            />
            {laeuft && <p className="text-sm text-ink-muted">Vorschau wird berechnet…</p>}
          </div>
        )}

        {schritt !== 'auswahl' && bericht && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-ink">
                {schritt === 'erfolg' ? 'Layout angewendet' : <>Vorschau — noch nichts geändert <span className="font-normal text-ink-muted">({dateiName})</span></>}
              </p>
            </div>

            {schritt === 'vorschau' && (
              <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-3">
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={fehlendeAnlegen} disabled={laeuft}
                         onChange={(e) => setFehlendeAnlegen(e.target.checked)}
                         className="rounded border-line-strong text-brand-500 focus:ring-brand-500" />
                  Fehlende Artikel anlegen
                </label>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={spaltenSetzen} disabled={laeuft}
                         onChange={(e) => setSpaltenSetzen(e.target.checked)}
                         className="rounded border-line-strong text-brand-500 focus:ring-brand-500" />
                  Raster auf die Spaltenzahl des Layouts stellen (Artikel je Zeile, alle Kassen)
                </label>
                <label className="flex items-center gap-2 text-sm font-medium text-red-700">
                  <input type="checkbox" checked={katalogLoeschen} disabled={laeuft}
                         onChange={(e) => { setKatalogLoeschen(e.target.checked); setBestaetigung('') }}
                         className="rounded border-red-400 text-red-600 focus:ring-red-500" />
                  Sauberer Neustart: vorher ALLE bestehenden Artikel, Warengruppen und Optionen LÖSCHEN (nicht rückgängig)
                </label>
              </div>
            )}

            {schritt === 'vorschau' && katalogLoeschen && <LoeschWarnung bericht={bericht} bestaetigung={bestaetigung} onChange={setBestaetigung} />}

            <ul className="list-disc space-y-1 pl-5 text-sm text-ink" data-testid="layout-bericht">
              {bericht.zusammenfassung.map((z, i) => <li key={i}>{z}</li>)}
            </ul>

            <Probleme bericht={bericht} />
          </>
        )}

        {fehler && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{fehler}</div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-3">
          {schritt === 'erfolg' ? (
            <Button onClick={schliessen}>Fertig</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={schliessen}>Abbrechen</Button>
              {schritt === 'vorschau' && (
                <Button onClick={() => { void anwenden() }} loading={laeuft} disabled={laeuft || !bericht || (katalogLoeschen && bestaetigung.trim() !== 'LOESCHEN')}>
                  Anwenden
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Roter Warnblock beim „Sauberen Neustart": Zahlen aus dem dryRun, Anwenden erst nach Eintippen von LOESCHEN. */
function LoeschWarnung({ bericht, bestaetigung, onChange }: { bericht: LayoutBericht; bestaetigung: string; onChange: (v: string) => void }) {
  const g = bericht.katalogLoeschen.geloescht
  return (
    <div role="alert" data-testid="loesch-warnung" className="space-y-2 rounded-lg border-2 border-red-400 bg-red-50 p-3 text-sm text-red-800">
      <p className="font-bold">Achtung: Das LÖSCHT den bisherigen Katalog — nicht rückgängig.</p>
      <p>
        Es werden gelöscht: <strong>{g.artikel}</strong> Artikel, <strong>{g.gruppen}</strong> Warengruppen, <strong>{g.optionsgruppen}</strong> Optionsgruppen
        {' '}(dazu {g.seriennummern} Seriennummern und {g.inventurPositionen} Inventurpositionen dieser Artikel; {g.sichtbarkeiten} Gruppen-Zuordnungen und {g.kassenFavoriten} Kassen-Favoriten werden geleert, {g.preisregelnBereinigt} Preisregeln bereinigt).
      </p>
      {(bericht.katalogLoeschen.nurDeaktiviert.artikel.length > 0 || bericht.katalogLoeschen.nurDeaktiviert.gruppen.length > 0) && (
        <p>
          Nur deaktiviert statt gelöscht (laufende Vorgänge): {bericht.katalogLoeschen.nurDeaktiviert.artikel.length} Artikel, {bericht.katalogLoeschen.nurDeaktiviert.gruppen.length} Gruppen — Details unter „Problemfälle".
        </p>
      )}
      <p>Belege, Tagesabschlüsse und der DEP-Export bleiben unberührt. Danach wird alles aus dem Layout <strong>neu angelegt — auch bei Wiederholung</strong>.</p>
      <label className="block">
        <span className="font-medium">Zur Bestätigung das Wort <strong>LOESCHEN</strong> eintippen:</span>
        <input
          value={bestaetigung}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Bestätigung: LOESCHEN eintippen"
          autoComplete="off"
          className="mt-1 block w-48 rounded-md border border-red-400 bg-white px-2 py-1 text-ink focus:outline-none focus:ring-2 focus:ring-red-500"
        />
      </label>
    </div>
  )
}

function Probleme({ bericht }: { bericht: LayoutBericht }) {
  const p = bericht.probleme
  const nd = bericht.katalogLoeschen.nurDeaktiviert
  const bloecke: { titel: string; zeilen: string[] }[] = [
    { titel: `Nur deaktiviert statt gelöscht (${nd.artikel.length + nd.gruppen.length})`,
      zeilen: [...nd.artikel.map(a => `Artikel ${a.name} — ${a.grund}`), ...nd.gruppen.map(g => `Gruppe ${g.name} — ${g.grund}`)] },
    { titel: `Mehrdeutig — nicht angefasst (${p.mehrdeutig.length})`,
      zeilen: p.mehrdeutig.map(m => `${m.pfad} › ${m.name}  (Kandidaten in: ${m.kandidaten.map(k => k.gruppe).join(', ')})`) },
    { titel: `Nicht gefunden / nicht angelegt (${p.nichtGefunden.length})`,
      zeilen: p.nichtGefunden.map(n => `${n.pfad} › ${n.name}${n.grund ? ` — ${n.grund}` : ''}`) },
    { titel: `Favoriten nicht aufgelöst (${p.favoritenNichtAufgeloest.length})`,
      zeilen: p.favoritenNichtAufgeloest.map(f => `${f.pfad} › ${f.name} — ${f.grund}`) },
    { titel: `Doppelte Raster-Plätze (${p.doppelteSlots.length})`,
      zeilen: p.doppelteSlots.map(d => `${d.pfad} › ${d.name} (Platz ${d.slot})`) },
    { titel: `Kassa-Gruppen ohne Gegenstück im Layout (${p.nichtZugeordneteKassaGruppen.length})`,
      zeilen: p.nichtZugeordneteKassaGruppen.map(g => `${g.name} — ${g.artikel} Artikel`) },
  ].filter(b => b.zeilen.length > 0)
  if (bloecke.length === 0) return <p className="text-sm text-green-700">Keine Problemfälle.</p>
  return (
    <div className="space-y-2" data-testid="layout-probleme">
      {bloecke.map(b => (
        <details key={b.titel} className="rounded-lg border border-line bg-panel">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">{b.titel}</summary>
          <ul className="max-h-48 space-y-0.5 overflow-y-auto border-t border-line px-3 py-2 text-xs text-ink-muted">
            {b.zeilen.map((z, i) => <li key={i}>{z}</li>)}
          </ul>
        </details>
      ))}
    </div>
  )
}
