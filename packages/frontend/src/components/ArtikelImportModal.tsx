/**
 * ArtikelImportModal
 *
 * Ablauf:
 *   1. Datei wählen (drag & drop oder Button)
 *   2. Vorschau: jede Zeile mit Status (gültig / ungültig / Warnung)
 *      – Kategorie-Spalte mit Dropdown zum Zuweisen / Korrigieren
 *      – Neue Warengruppen-Namen werden im Import automatisch angelegt
 *   3. Import: ggf. neue Kategorien anlegen, dann POST /api/artikel/bulk
 *   4. Erfolgsmeldung
 */

import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Kategorie } from '@kassa/shared'
import { artikelApi, kategorieApi } from '../lib/api'
import { parseArtikelExcel, type GeparsterArtikel } from '../lib/artikel-excel'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

interface Props {
  open:       boolean
  kategorien: Kategorie[]
  mandantId:  string
  onClose:    () => void
}

type Schritt = 'auswahl' | 'vorschau' | 'erfolg'

export function ArtikelImportModal({ open, kategorien, mandantId, onClose }: Props) {
  const qc             = useQueryClient()
  const fileInputRef   = useRef<HTMLInputElement>(null)
  const [schritt, setSchritt]       = useState<Schritt>('auswahl')
  const [zeilen, setZeilen]         = useState<GeparsterArtikel[]>([])
  const [ergebnis, setErgebnis]     = useState<{ erstellt: number; fehlgeschlagen: number } | null>(null)
  const [fehlerMsg, setFehlerMsg]   = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  /**
   * zeileKategorie: zeile-number → Kategoriename (user-editierbar).
   * Initialisiert aus kategorieStr beim Parsen; kann im Modal geändert werden.
   */
  const [zeileKategorie, setZeileKategorie] = useState<Record<number, string>>({})

  const gueltigeZeilen   = zeilen.filter(z => z.gueltig)
  const ungueltigeZeilen = zeilen.filter(z => !z.gueltig)

  /** Namen, die noch nicht als Kategorie existieren → werden beim Import neu angelegt. */
  const katNamenSet = new Set(kategorien.map(k => k.name.toLowerCase()))
  const neueKatNamen = Array.from(
    new Set(
      gueltigeZeilen
        .map(z => zeileKategorie[z.zeile] ?? '')
        .filter(n => n && !katNamenSet.has(n.toLowerCase())),
    ),
  )

  // ---------------------------------------------------------------------------
  // Datei einlesen
  // ---------------------------------------------------------------------------
  const handleFile = async (file: File) => {
    setFehlerMsg(null)
    try {
      const buffer  = await file.arrayBuffer()
      const geparst = await parseArtikelExcel(buffer, kategorien)
      if (geparst.length === 0) {
        setFehlerMsg('Keine Datenzeilen gefunden. Bitte prüfe das Format der Datei.')
        return
      }
      setZeilen(geparst)
      // Kategorie-State mit geparsten Namen vorbelegen
      const initKat: Record<number, string> = {}
      for (const z of geparst) {
        if (z.kategorieStr) initKat[z.zeile] = z.kategorieStr
      }
      setZeileKategorie(initKat)
      setSchritt('vorschau')
    } catch {
      setFehlerMsg('Datei konnte nicht gelesen werden. Bitte nur .xlsx-Dateien verwenden.')
    }
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ''
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  // ---------------------------------------------------------------------------
  // Import-Mutation
  // ---------------------------------------------------------------------------
  const importMutation = useMutation({
    mutationFn: async () => {
      // 1. Neue Kategorien anlegen (falls nötig)
      const katMap = new Map(kategorien.map(k => [k.name.toLowerCase(), k.id]))

      for (const name of neueKatNamen) {
        const neu = await kategorieApi.create({ name, farbe: 'grau', reihenfolge: 0 })
        katMap.set(neu.name.toLowerCase(), neu.id)
      }

      // 2. Gültige Zeilen mit aktualisierter kategorieId aufbauen
      const rows = gueltigeZeilen
        .filter(z => z.daten)
        .map(z => {
          const katName    = zeileKategorie[z.zeile] ?? ''
          const kategorieId = katName ? (katMap.get(katName.toLowerCase()) ?? null) : null
          return { ...z.daten!, kategorieId }
        })

      return artikelApi.bulkImport(rows)
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['artikel', mandantId] })
      qc.invalidateQueries({ queryKey: ['kategorien'] })
      setErgebnis({ erstellt: data.erstellt, fehlgeschlagen: data.fehlgeschlagen })
      setSchritt('erfolg')
    },
    onError: (err) => {
      setFehlerMsg(err instanceof Error ? err.message : 'Importfehler')
    },
  })

  // ---------------------------------------------------------------------------
  // Reset beim Schließen
  // ---------------------------------------------------------------------------
  const handleClose = () => {
    setSchritt('auswahl')
    setZeilen([])
    setErgebnis(null)
    setFehlerMsg(null)
    setZeileKategorie({})
    onClose()
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Artikel importieren"
      size="lg"
    >
      {/* ---- Schritt 1: Datei auswählen ---- */}
      {schritt === 'auswahl' && (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            Lade eine Excel-Datei (.xlsx) mit deinen Artikeldaten hoch.
            Verwende die <strong>Vorlage</strong> aus der Artikel-Verwaltung als Grundlage.
            Neue Warengruppen werden beim Import automatisch angelegt.
          </p>

          {/* Drop Zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`
              flex flex-col items-center justify-center gap-3
              rounded-xl border-2 border-dashed cursor-pointer
              py-12 px-6 transition
              ${isDragOver
                ? 'border-brand-400 bg-brand-50'
                : 'border-line-strong hover:border-brand-300 hover:bg-panel-2'
              }
            `}
          >
            <svg className="h-10 w-10 text-ink-subtle" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12 3 3m0 0 3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            <div className="text-center">
              <p className="text-sm font-medium text-ink">
                Datei hier ablegen oder klicken
              </p>
              <p className="text-xs text-ink-subtle mt-0.5">.xlsx — max. 500 Artikel</p>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={handleFileInput}
          />

          {fehlerMsg && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {fehlerMsg}
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="secondary" onClick={handleClose}>Abbrechen</Button>
          </div>
        </div>
      )}

      {/* ---- Schritt 2: Vorschau ---- */}
      {schritt === 'vorschau' && (
        <div className="space-y-4">
          {/* Zusammenfassung */}
          <div className="flex gap-3 flex-wrap">
            <Chip farbe="gruen">{gueltigeZeilen.length} gültig</Chip>
            {ungueltigeZeilen.length > 0 && (
              <Chip farbe="rot">{ungueltigeZeilen.length} ungültig</Chip>
            )}
            {zeilen.some(z => z.warnungen.length > 0) && (
              <Chip farbe="gelb">{zeilen.filter(z => z.warnungen.length > 0).length} mit Hinweisen</Chip>
            )}
            {neueKatNamen.length > 0 && (
              <Chip farbe="blau">{neueKatNamen.length} neue Warengruppe{neueKatNamen.length > 1 ? 'n' : ''}</Chip>
            )}
          </div>

          {/* Neue Warengruppen Hinweis */}
          {neueKatNamen.length > 0 && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
              Folgende Warengruppen werden beim Import automatisch angelegt:{' '}
              <strong>{neueKatNamen.join(', ')}</strong>
            </div>
          )}

          {/* Tabelle */}
          <div className="max-h-96 overflow-y-auto rounded-lg border border-line">
            <table className="w-full text-xs">
              <thead className="bg-panel-2 sticky top-0 text-left text-ink-muted uppercase tracking-wide text-[10px]">
                <tr>
                  <th className="px-3 py-2 font-semibold w-10">Zeile</th>
                  <th className="px-3 py-2 font-semibold">Bezeichnung</th>
                  <th className="px-3 py-2 font-semibold w-24 text-right">Preis</th>
                  <th className="px-3 py-2 font-semibold w-28">MwSt</th>
                  <th className="px-3 py-2 font-semibold w-36">Warengruppe</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {zeilen.map((z) => {
                  const aktuelleKat = zeileKategorie[z.zeile] ?? ''
                  const istNeueKat  = aktuelleKat && !katNamenSet.has(aktuelleKat.toLowerCase())

                  return (
                    <tr
                      key={z.zeile}
                      className={
                        !z.gueltig
                          ? 'bg-red-50'
                          : z.warnungen.length > 0
                          ? 'bg-amber-50'
                          : ''
                      }
                    >
                      <td className="px-3 py-2 text-ink-subtle tabular-nums">{z.zeile}</td>
                      <td className="px-3 py-2 font-medium text-ink">
                        {z.daten?.bezeichnung ?? <span className="text-ink-subtle italic">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-ink-muted">
                        {z.daten ? `€ ${(z.daten.preisBruttoCent / 100).toFixed(2).replace('.', ',')}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-ink-muted">
                        {z.daten?.mwstSatz ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={aktuelleKat}
                          onChange={e => setZeileKategorie(prev => ({ ...prev, [z.zeile]: e.target.value }))}
                          className="text-xs border border-line rounded px-1.5 py-0.5 bg-panel w-full max-w-[140px] focus:outline-none focus:ring-1 focus:ring-brand-400"
                          title={istNeueKat ? `Neue Warengruppe: ${aktuelleKat}` : undefined}
                        >
                          <option value="">— keine —</option>
                          {kategorien
                            .filter(k => k.aktiv)
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map(k => (
                              <option key={k.id} value={k.name}>{k.name}</option>
                            ))
                          }
                          {/* Unbekannte Namen als eigene Option anzeigen */}
                          {istNeueKat && (
                            <option value={aktuelleKat}>✦ {aktuelleKat} (neu)</option>
                          )}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        {!z.gueltig ? (
                          <div className="space-y-0.5">
                            {z.fehler.map((f, i) => (
                              <p key={i} className="text-red-600">✗ {f}</p>
                            ))}
                          </div>
                        ) : z.warnungen.length > 0 ? (
                          <div className="space-y-0.5">
                            {z.warnungen.map((w, i) => (
                              <p key={i} className="text-amber-600">⚠ {w}</p>
                            ))}
                          </div>
                        ) : (
                          <span className="text-green-600">✓ OK</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {gueltigeZeilen.length === 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Keine gültigen Zeilen gefunden. Bitte prüfe die Datei anhand der Vorlage und der Hinweise.
            </div>
          )}

          {fehlerMsg && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {fehlerMsg}
            </div>
          )}

          <div className="flex justify-between pt-1">
            <Button variant="secondary" onClick={() => { setSchritt('auswahl'); setZeilen([]); setZeileKategorie({}) }}>
              Andere Datei
            </Button>
            <Button
              onClick={() => importMutation.mutate()}
              loading={importMutation.isPending}
              disabled={gueltigeZeilen.length === 0}
            >
              {gueltigeZeilen.length} Artikel importieren
              {neueKatNamen.length > 0 && ` + ${neueKatNamen.length} Warengruppe${neueKatNamen.length > 1 ? 'n' : ''}`}
            </Button>
          </div>
        </div>
      )}

      {/* ---- Schritt 3: Erfolg ---- */}
      {schritt === 'erfolg' && ergebnis && (
        <div className="space-y-4 py-2">
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <svg className="h-8 w-8 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-ink">Import abgeschlossen</p>
              <p className="mt-1 text-sm text-ink-muted">
                <span className="text-green-700 font-medium">{ergebnis.erstellt} Artikel</span> wurden erfolgreich angelegt.
                {ergebnis.fehlgeschlagen > 0 && (
                  <span className="text-red-600"> {ergebnis.fehlgeschlagen} fehlgeschlagen.</span>
                )}
              </p>
              {neueKatNamen.length > 0 && (
                <p className="mt-1 text-sm text-blue-600">
                  {neueKatNamen.length} neue Warengruppe{neueKatNamen.length > 1 ? 'n' : ''} angelegt.
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-center">
            <Button onClick={handleClose}>Schließen</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Hilfsbaustein
// ---------------------------------------------------------------------------

function Chip({
  farbe,
  children,
}: {
  farbe: 'gruen' | 'rot' | 'gelb' | 'blau'
  children: React.ReactNode
}) {
  const klassen = {
    gruen: 'bg-green-100 text-green-700',
    rot:   'bg-red-100 text-red-700',
    gelb:  'bg-amber-100 text-amber-700',
    blau:  'bg-blue-100 text-blue-700',
  }[farbe]
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${klassen}`}>
      {children}
    </span>
  )
}
