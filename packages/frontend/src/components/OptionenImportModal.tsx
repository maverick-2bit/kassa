/**
 * OptionenImportModal
 *
 * Ablauf:
 *   1. Datei wählen (drag & drop oder Button)
 *   2. Vorschau: je Artikel + Optionsgruppe eine Zeile mit Optionen und Status
 *      (Artikel gefunden / nicht gefunden / mehrdeutig — lokal gegen die geladene Artikelliste)
 *   3. Import: POST /api/modifikator-gruppen/import — der Server ordnet verbindlich zu,
 *      legt gleiche Gruppen nur einmal an und ergänzt bestehende Zuordnungen
 *   4. Ergebnis inkl. Liste der nicht zugeordneten Einträge
 */

import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Artikel, OptionenImportErgebnis } from '@kassa/shared'
import { kategorieApi, modifikatorApi } from '../lib/api'
import { formatPreis } from '../lib/format'
import { parseOptionenExcel, type GeparsteGruppe } from '../lib/optionen-excel'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

interface Props {
  open:    boolean
  artikel: Artikel[]
  onClose: () => void
}

type Schritt = 'auswahl' | 'vorschau' | 'erfolg'

export function OptionenImportModal({ open, artikel, onClose }: Props) {
  const qc           = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [schritt, setSchritt]       = useState<Schritt>('auswahl')
  const [gruppen, setGruppen]       = useState<GeparsteGruppe[]>([])
  const [ergebnis, setErgebnis]     = useState<OptionenImportErgebnis | null>(null)
  const [fehlerMsg, setFehlerMsg]   = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const kategorien = useQuery({
    queryKey: ['kategorien'],
    queryFn:  () => kategorieApi.list(),
    enabled:  open,
  })

  // Vorschau-Status: gleiche Regeln wie der Server (aktive Artikel, Name + ggf. Warengruppe)
  const katName = new Map((kategorien.data ?? []).map(k => [k.id, k.name.toLowerCase()]))
  const trefferZahl = (g: GeparsteGruppe) => artikel.filter(a =>
    a.aktiv
    && a.bezeichnung.trim().toLowerCase() === g.eintrag.artikel.toLowerCase()
    && (!g.eintrag.warengruppe
      || (a.kategorieId ? katName.get(a.kategorieId) : '') === g.eintrag.warengruppe.toLowerCase()),
  ).length

  const gueltig    = gruppen.filter(g => g.fehler.length === 0 && g.eintrag.optionen.length > 0)
  const ungueltig  = gruppen.length - gueltig.length
  const ohneTreffer = gueltig.filter(g => trefferZahl(g) !== 1).length
  const optionenGesamt = gueltig.reduce((s, g) => s + g.eintrag.optionen.length, 0)

  const handleFile = async (file: File) => {
    setFehlerMsg(null)
    try {
      const geparst = await parseOptionenExcel(await file.arrayBuffer())
      if (geparst.length === 0) {
        setFehlerMsg('Keine Datenzeilen gefunden. Bitte prüfe das Format der Datei.')
        return
      }
      setGruppen(geparst)
      setSchritt('vorschau')
    } catch {
      setFehlerMsg('Datei konnte nicht gelesen werden. Bitte nur .xlsx-Dateien verwenden.')
    }
  }

  const importMutation = useMutation({
    mutationFn: () => modifikatorApi.importiere({ eintraege: gueltig.map(g => g.eintrag) }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['modifikator-gruppen'] })
      qc.invalidateQueries({ queryKey: ['artikel-modifikator-gruppen'] })
      setErgebnis(data)
      setSchritt('erfolg')
    },
    onError: (err) => setFehlerMsg(err instanceof Error ? err.message : 'Importfehler'),
  })

  const handleClose = () => {
    setSchritt('auswahl')
    setGruppen([])
    setErgebnis(null)
    setFehlerMsg(null)
    onClose()
  }

  return (
    <Modal open={open} onClose={handleClose} title="Optionen importieren" size="lg">
      {schritt === 'auswahl' && (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            Lade eine Excel-Datei (.xlsx) mit einer Zeile je Option hoch — Spalten wie in der{' '}
            <strong>Vorlage</strong>. Gleiche Gruppen werden nur einmal angelegt, bestehende
            Zuordnungen bleiben erhalten.
          </p>
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setIsDragOver(false)
              const file = e.dataTransfer.files[0]
              if (file) void handleFile(file)
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed cursor-pointer py-12 px-6 transition ${
              isDragOver ? 'border-brand-400 bg-brand-50' : 'border-line-strong hover:border-brand-300 hover:bg-panel-2'
            }`}
          >
            <p className="text-sm font-medium text-ink">Datei hier ablegen oder klicken</p>
            <p className="text-xs text-ink-subtle">.xlsx — eine Zeile je Option</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
              e.target.value = ''
            }}
          />
          {fehlerMsg && <Fehler text={fehlerMsg} />}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={handleClose}>Abbrechen</Button>
          </div>
        </div>
      )}

      {schritt === 'vorschau' && (
        <div className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <Chip klassen="bg-green-100 text-green-700">
              {gueltig.length} Zuordnungen · {optionenGesamt} Optionen
            </Chip>
            {ungueltig > 0 && <Chip klassen="bg-red-100 text-red-700">{ungueltig} ungültig</Chip>}
            {ohneTreffer > 0 && (
              <Chip klassen="bg-amber-100 text-amber-700">{ohneTreffer} Artikel nicht eindeutig gefunden</Chip>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto rounded-lg border border-line">
            <table className="w-full text-xs">
              <thead className="bg-panel-2 sticky top-0 text-left text-ink-muted uppercase tracking-wide text-[10px]">
                <tr>
                  <th className="px-3 py-2 font-semibold">Artikel</th>
                  <th className="px-3 py-2 font-semibold">Gruppe</th>
                  <th className="px-3 py-2 font-semibold">Optionen</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {gruppen.map((g) => {
                  const treffer = trefferZahl(g)
                  const e = g.eintrag
                  return (
                    <tr
                      key={g.zeilen[0]}
                      className={g.fehler.length > 0 ? 'bg-red-50' : treffer !== 1 ? 'bg-amber-50' : ''}
                    >
                      <td className="px-3 py-2 align-top">
                        <p className="font-medium text-ink">{e.artikel || '—'}</p>
                        {e.warengruppe && <p className="text-ink-subtle">{e.warengruppe}</p>}
                      </td>
                      <td className="px-3 py-2 align-top text-ink-muted">
                        <p>{e.gruppe || '—'}</p>
                        <p className="text-ink-subtle">
                          {e.typ === 'pflicht' ? 'Pflicht' : 'optional'} · {e.maxAuswahl === 1 ? 'eine' : 'mehrere'}
                        </p>
                      </td>
                      <td className="px-3 py-2 align-top text-ink-muted">
                        {e.optionen.map((o, i) => (
                          <span key={i} className="mr-2 whitespace-nowrap">
                            {o.name}
                            {o.aufschlagCent !== 0 && (
                              <span className="font-mono"> {o.aufschlagCent > 0 ? '+' : ''}{formatPreis(o.aufschlagCent)}</span>
                            )}
                          </span>
                        ))}
                      </td>
                      <td className="px-3 py-2 align-top">
                        {g.fehler.length > 0
                          ? g.fehler.map((f, i) => <p key={i} className="text-red-600">✗ {f}</p>)
                          : treffer === 0
                          ? <p className="text-amber-600">⚠ Artikel nicht gefunden</p>
                          : treffer > 1
                          ? <p className="text-amber-600">⚠ {treffer}× vorhanden — Warengruppe angeben</p>
                          : <span className="text-green-600">✓ OK</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {ohneTreffer > 0 && (
            <p className="text-xs text-ink-muted">
              Nicht eindeutig gefundene Artikel werden beim Import übersprungen, der Rest wird importiert.
            </p>
          )}
          {fehlerMsg && <Fehler text={fehlerMsg} />}

          <div className="flex justify-between pt-1">
            <Button variant="secondary" onClick={() => { setSchritt('auswahl'); setGruppen([]) }}>
              Andere Datei
            </Button>
            <Button
              onClick={() => importMutation.mutate()}
              loading={importMutation.isPending}
              disabled={gueltig.length === 0}
            >
              Optionen importieren
            </Button>
          </div>
        </div>
      )}

      {schritt === 'erfolg' && ergebnis && (
        <div className="space-y-4 py-2">
          <div className="text-center">
            <p className="text-lg font-semibold text-ink">Import abgeschlossen</p>
            <p className="mt-1 text-sm text-ink-muted">
              <span className="text-green-700 font-medium">{ergebnis.gruppenNeu} Gruppen</span> neu angelegt
              {ergebnis.gruppenWiederverwendet > 0 && `, ${ergebnis.gruppenWiederverwendet} vorhandene wiederverwendet`}
              {' · '}
              <span className="text-green-700 font-medium">{ergebnis.zuweisungenNeu} Artikel-Zuordnungen</span> ergänzt
            </p>
          </div>
          {ergebnis.fehler.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-medium mb-1">{ergebnis.fehler.length} Einträge nicht zugeordnet:</p>
              <ul className="max-h-40 overflow-y-auto space-y-0.5 text-xs">
                {ergebnis.fehler.map((f) => (
                  <li key={f.index}>
                    {f.artikel}{f.warengruppe && ` (${f.warengruppe})`} — {f.fehler}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-center">
            <Button onClick={handleClose}>Schließen</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Fehler({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{text}</div>
  )
}

function Chip({ klassen, children }: { klassen: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${klassen}`}>
      {children}
    </span>
  )
}
