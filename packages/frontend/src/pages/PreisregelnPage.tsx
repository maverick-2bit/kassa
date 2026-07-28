/**
 * PreisregelnPage — Verwaltung der Aktionen (zeitgesteuerte Preise).
 * Eine Aktion senkt den Preis in einem Zeitfenster an bestimmten Wochentagen —
 * per Prozentsatz ODER mit einem fixen Aktionspreis je Artikel (z. B. „alle
 * Pizzen 7,50"). Die Anwendung passiert automatisch an der Kasse und beim
 * Bonieren (siehe aktionsPreisCent in @kassa/shared).
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Preisregel, PreisregelInput, Kategorie, Artikel } from '@kassa/shared'
import { WOCHENTAG_LABELS } from '@kassa/shared'
import { preisregelApi, kategorieApi, artikelApi } from '../lib/api'
import { getKasseIdentity } from '../lib/kasse'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { formatPreis, parseEuroToCent } from '../lib/format'

const WOCHENTAGE = [1, 2, 3, 4, 5, 6, 7]

export function PreisregelnPage() {
  const qc = useQueryClient()
  const [formOffen, setFormOffen]   = useState(false)
  const [editTarget, setEditTarget] = useState<Preisregel | null>(null)

  const identity    = getKasseIdentity()!
  const regelnQuery = useQuery({ queryKey: ['preisregeln'], queryFn: preisregelApi.list })
  const katQuery    = useQuery({ queryKey: ['kategorien'],  queryFn: () => kategorieApi.list(true) })
  const artQuery    = useQuery({
    queryKey: ['artikel', identity.mandantId, true],
    queryFn:  () => artikelApi.list(identity.mandantId, true),
  })

  const loeschen = useMutation({
    mutationFn: (id: string) => preisregelApi.remove(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['preisregeln'] }),
  })

  const regeln     = regelnQuery.data ?? []
  const kategorien = katQuery.data ?? []
  const artikel    = artQuery.data ?? []
  const katName = (id: string) => kategorien.find(k => k.id === id)?.name ?? '—'
  const artName = (id: string) => artikel.find(a => a.id === id)?.bezeichnung ?? '—'

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 space-y-5">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-ink">Aktionen</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Zeitgesteuerte Preise, die beim Kassieren und Bonieren automatisch greifen —
            als Prozent-Rabatt oder mit fixem Aktionspreis je Artikel.
          </p>
        </div>
        <Button onClick={() => { setEditTarget(null); setFormOffen(true) }}>+ Neue Aktion</Button>
      </header>

      {regeln.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong p-10 text-center text-sm text-ink-subtle">
          Noch keine Aktionen. Lege eine an, z. B. „Happy Hour Mo–Fr 17–19 Uhr, −20 % auf Getränke"
          oder „Pizza-Dienstag: alle Standardpizzen 7,50".
        </div>
      ) : (
        <div className="space-y-3">
          {regeln.map(r => (
            <div
              key={r.id}
              className={`rounded-lg border p-4 ${r.aktiv ? 'border-brand-200 bg-panel' : 'border-line bg-panel-2 opacity-70'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-ink">{r.name}</p>
                    {r.rabattProzent > 0 && (
                      <span className="text-xs font-bold text-brand-700 bg-brand-50 rounded px-1.5 py-0.5">
                        −{r.rabattProzent}%
                      </span>
                    )}
                    {(r.artikelPreise?.length ?? 0) > 0 && (
                      <span className="text-xs font-bold text-emerald-700 bg-emerald-50 rounded px-1.5 py-0.5">
                        {r.artikelPreise.length} Aktionspreis{r.artikelPreise.length === 1 ? '' : 'e'}
                      </span>
                    )}
                    {!r.aktiv && <span className="text-xs text-ink-subtle">inaktiv</span>}
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">
                    {[
                      r.wochentage.map(w => WOCHENTAG_LABELS[w]).join(', '),
                      ...r.datumTage,
                    ].filter(Boolean).join(', ')}
                    {' · '}
                    {r.zeitfenster.map(zf => `${zf.von}–${zf.bis}`).join(', ')} Uhr
                    {(r.gueltigVon || r.gueltigBis) && (
                      <> · {r.gueltigVon ?? '…'} bis {r.gueltigBis ?? '…'}</>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {r.kategorieIds.length === 0 && r.artikelIds.length === 0
                      ? 'Alle Artikel'
                      : [...r.kategorieIds.map(katName), ...r.artikelIds.map(artName)].join(', ')}
                  </p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button size="sm" variant="secondary" onClick={() => { setEditTarget(r); setFormOffen(true) }}>
                    Bearbeiten
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="text-red-600"
                    onClick={() => { if (confirm('Aktion löschen?')) loeschen.mutate(r.id) }}
                  >
                    Löschen
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={formOffen}
        onClose={() => { setFormOffen(false); setEditTarget(null) }}
        title={editTarget ? 'Aktion bearbeiten' : 'Neue Aktion'}
      >
        <PreisregelForm
          {...(editTarget ? { initial: editTarget } : {})}
          kategorien={kategorien}
          artikel={artikel}
          onGespeichert={() => { setFormOffen(false); setEditTarget(null); qc.invalidateQueries({ queryKey: ['preisregeln'] }) }}
          onAbbrechen={() => { setFormOffen(false); setEditTarget(null) }}
        />
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formular
// ---------------------------------------------------------------------------

function PreisregelForm({
  initial,
  kategorien,
  artikel,
  onGespeichert,
  onAbbrechen,
}: {
  initial?:      Preisregel
  kategorien:    Kategorie[]
  artikel:       Artikel[]
  onGespeichert: () => void
  onAbbrechen:   () => void
}) {
  const [name,         setName]         = useState(initial?.name ?? '')
  const [aktiv,        setAktiv]        = useState(initial?.aktiv ?? true)
  const [wochentage,   setWochentage]   = useState<number[]>(initial?.wochentage ?? [1, 2, 3, 4, 5])
  const [datumTage,    setDatumTage]    = useState<string[]>(initial?.datumTage ?? [])
  const [neuesDatum,   setNeuesDatum]   = useState('')
  const [zeitfenster,  setZeitfenster]  = useState<{ von: string; bis: string }[]>(initial?.zeitfenster ?? [{ von: '17:00', bis: '19:00' }])
  const [gueltigVon,   setGueltigVon]   = useState(initial?.gueltigVon ?? '')
  const [gueltigBis,   setGueltigBis]   = useState(initial?.gueltigBis ?? '')
  const [rabatt,       setRabatt]       = useState(String(initial?.rabattProzent ?? 20))
  const [kategorieIds, setKategorieIds] = useState<string[]>(initial?.kategorieIds ?? [])
  const [artikelIds,   setArtikelIds]   = useState<string[]>(initial?.artikelIds ?? [])
  const [artikelSuche, setArtikelSuche] = useState('')
  const [fehler,       setFehler]       = useState<string | null>(null)
  // Aktionspreise als Euro-Text je Artikel (leer = kein fixer Preis)
  const [artikelPreise, setArtikelPreise] = useState<Record<string, string>>(() => {
    const start: Record<string, string> = {}
    for (const p of initial?.artikelPreise ?? []) start[p.artikelId] = (p.preisCent / 100).toFixed(2).replace('.', ',')
    return start
  })
  const [kachelKategorie, setKachelKategorie] = useState<string>('alle')
  const [sammelPreis,     setSammelPreis]     = useState('')

  const rabattZahl    = parseInt(rabatt) || 0
  const zeitfensterOk = zeitfenster.length > 0 && zeitfenster.every(zf => zf.von && zf.bis)
  const tageOk        = wochentage.length > 0 || datumTage.length > 0
  const anzahlMitPreis = Object.values(artikelPreise).filter(v => v.trim() !== '').length
  // Entweder Prozent-Rabatt ODER mindestens ein Aktionspreis (wie im Schema)
  const kannSpeichern = name.trim().length > 0 && tageOk && zeitfensterOk
    && rabattZahl >= 0 && rabattZahl <= 100
    && (rabattZahl > 0 || anzahlMitPreis > 0)

  const speichern = useMutation({
    mutationFn: () => {
      // Aktionspreise: nur befüllte, lesbare Beträge übernehmen
      const preise = Object.entries(artikelPreise).flatMap(([artikelId, text]) => {
        if (!text.trim()) return []
        const cent = parseEuroToCent(text)
        return cent === null ? [] : [{ artikelId, preisCent: cent }]
      })
      const input: PreisregelInput = {
        name:          name.trim(),
        aktiv,
        wochentage:    [...wochentage].sort((a, b) => a - b),
        datumTage:     [...datumTage].sort(),
        zeitfenster,
        gueltigVon:    gueltigVon || null,
        gueltigBis:    gueltigBis || null,
        rabattProzent: rabattZahl,
        artikelPreise: preise,
        kategorieIds,
        artikelIds,
      }
      return initial ? preisregelApi.update(initial.id, input) : preisregelApi.create(input)
    },
    onSuccess: onGespeichert,
    onError:   (err) => setFehler(err instanceof Error ? err.message : String(err)),
  })

  /** Aktionspreis eines Artikels setzen; wählt ihn zugleich aus */
  const setzeArtikelPreis = (artikelId: string, text: string) => {
    setArtikelPreise(prev => ({ ...prev, [artikelId]: text }))
    if (text.trim() && !artikelIds.includes(artikelId)) setArtikelIds(prev => [...prev, artikelId])
  }

  /** „alle auswählen" / „abwählen" für die gerade sichtbaren Kacheln */
  const alleSichtbarenWaehlen = (waehlen: boolean) => {
    const ids = gefilterteArtikel.map(a => a.id)
    if (!waehlen) {
      setArtikelPreise(p => { const n = { ...p }; for (const id of ids) delete n[id]; return n })
    }
    setArtikelIds(prev => waehlen
      ? [...new Set([...prev, ...ids])]
      : prev.filter(id => !ids.includes(id)))
  }

  /** Einen Preis auf alle gewählten Artikel anwenden (z. B. „alle Pizzen 7,50") */
  const sammelPreisSetzen = () => {
    if (!sammelPreis.trim()) return
    if (parseEuroToCent(sammelPreis) === null) { setFehler('Preis nicht lesbar — z. B. 7,50'); return }
    setFehler(null)
    setArtikelPreise(prev => {
      const neu = { ...prev }
      for (const id of artikelIds) neu[id] = sammelPreis
      return neu
    })
  }

  const toggleTag = (t: number) => setWochentage(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  const toggleKat = (id: string) => setKategorieIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  // Abwählen nimmt den Aktionspreis mit — sonst bliebe eine tote Angabe stehen,
  // die ohnehin nicht greift (der Artikel wäre nicht im Geltungsbereich).
  const toggleArt = (id: string) => setArtikelIds(prev => {
    if (!prev.includes(id)) return [...prev, id]
    setArtikelPreise(p => { const n = { ...p }; delete n[id]; return n })
    return prev.filter(x => x !== id)
  })
  const addDatum    = () => { const d = neuesDatum.trim(); if (d && !datumTage.includes(d)) setDatumTage(prev => [...prev, d]); setNeuesDatum('') }
  const removeDatum = (d: string) => setDatumTage(prev => prev.filter(x => x !== d))
  const addFenster    = () => setZeitfenster(prev => [...prev, { von: '12:00', bis: '14:00' }])
  const updateFenster = (i: number, feld: 'von' | 'bis', wert: string) => setZeitfenster(prev => prev.map((zf, idx) => idx === i ? { ...zf, [feld]: wert } : zf))
  const removeFenster = (i: number) => setZeitfenster(prev => prev.filter((_, idx) => idx !== i))

  const gefilterteArtikel = artikel.filter(a => {
    if (kachelKategorie !== 'alle' && a.kategorieId !== kachelKategorie) return false
    const q = artikelSuche.trim().toLowerCase()
    return !q || a.bezeichnung.toLowerCase().includes(q)
  })

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); setFehler(null); if (kannSpeichern) speichern.mutate() }}
      className="space-y-4"
    >
      <div>
        <label className="block text-xs font-medium text-ink-muted mb-1">Name *</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Happy Hour" autoFocus />
      </div>

      <div>
        <label className="block text-xs font-medium text-ink-muted mb-1">Wochentage (wöchentlich wiederkehrend)</label>
        <div className="flex flex-wrap gap-1.5">
          {WOCHENTAGE.map(t => (
            <button
              key={t}
              type="button"
              onClick={() => toggleTag(t)}
              className={`px-3 py-1.5 rounded-md border text-sm font-medium transition ${
                wochentage.includes(t) ? 'bg-brand-600 border-brand-600 text-white' : 'border-line-strong text-ink hover:border-brand-400'
              }`}
            >
              {WOCHENTAG_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-ink-muted mb-1">Konkrete Datumstage (optional)</label>
        <div className="flex items-center gap-2">
          <Input type="date" value={neuesDatum} onChange={(e) => setNeuesDatum(e.target.value)} className="flex-1" />
          <Button type="button" variant="secondary" size="sm" disabled={!neuesDatum} onClick={addDatum}>+ Tag</Button>
        </div>
        {datumTage.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {datumTage.map(d => (
              <button
                key={d}
                type="button"
                onClick={() => removeDatum(d)}
                className="px-2 py-0.5 rounded-md border border-brand-600 bg-brand-50 text-xs text-brand-800"
                title="Entfernen"
              >
                {d} ✕
              </button>
            ))}
          </div>
        )}
        <p className="mt-1 text-[11px] text-ink-subtle">Mindestens ein Wochentag oder ein Datumstag.</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-xs font-medium text-ink-muted">Zeitfenster *</label>
          <Button type="button" variant="secondary" size="sm" onClick={addFenster}>+ Fenster</Button>
        </div>
        <div className="space-y-2">
          {zeitfenster.map((zf, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input type="time" value={zf.von} onChange={(e) => updateFenster(i, 'von', e.target.value)} className="flex-1" />
              <span className="text-ink-muted">–</span>
              <Input type="time" value={zf.bis} onChange={(e) => updateFenster(i, 'bis', e.target.value)} className="flex-1" />
              {zeitfenster.length > 1 && (
                <button type="button" onClick={() => removeFenster(i)} className="text-ink-subtle hover:text-red-500 px-1" title="Fenster entfernen">✕</button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">Aktion ab (optional)</label>
          <Input type="date" value={gueltigVon} onChange={(e) => setGueltigVon(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">Aktion bis (optional)</label>
          <Input type="date" value={gueltigBis} onChange={(e) => setGueltigBis(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">Rabatt (%)</label>
          <Input type="number" min={0} max={100} value={rabatt} onChange={(e) => setRabatt(e.target.value)} />
          <p className="mt-0.5 text-[11px] text-ink-subtle">0 = nur Aktionspreise</p>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-ink-muted mb-1">Warengruppen</label>
        {kategorien.length === 0 ? (
          <p className="text-xs text-ink-subtle">Keine Warengruppen vorhanden.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
            {kategorien.map(k => (
              <button
                key={k.id}
                type="button"
                onClick={() => toggleKat(k.id)}
                className={`px-2.5 py-1 rounded-md border text-xs font-medium transition ${
                  kategorieIds.includes(k.id) ? 'bg-brand-600 border-brand-600 text-white' : 'border-line-strong text-ink hover:border-brand-400'
                }`}
              >
                {k.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Artikel-Kacheln wie an der Kasse: anklicken wählt aus, Aktionspreis
          direkt in der Kachel; Sammel-Setzen über die Leiste darüber. */}
      <div>
        <div className="flex items-center justify-between mb-1 flex-wrap gap-1">
          <label className="block text-xs font-medium text-ink-muted">Artikel &amp; Aktionspreise</label>
          <span className="text-xs text-brand-700">
            {artikelIds.length > 0 && <>{artikelIds.length} gewählt</>}
            {anzahlMitPreis > 0 && <> · {anzahlMitPreis} mit Aktionspreis</>}
          </span>
        </div>

        <Input
          value={artikelSuche}
          onChange={(e) => setArtikelSuche(e.target.value)}
          placeholder="Artikel suchen …"
          className="mb-1.5"
        />

        {/* Sammel-Aktionen: ganze Warengruppe wählen/abwählen + ein Preis für alle */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-panel-2 p-2">
          <select
            value={kachelKategorie}
            onChange={(e) => setKachelKategorie(e.target.value)}
            className="rounded-md border border-line-strong bg-panel px-2 py-1 text-xs text-ink"
          >
            <option value="alle">Alle Warengruppen</option>
            {kategorien.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
          <button type="button" onClick={() => alleSichtbarenWaehlen(true)}
            className="rounded-md border border-line-strong px-2 py-1 text-xs font-medium text-ink hover:border-brand-400">
            alle auswählen
          </button>
          <button type="button" onClick={() => alleSichtbarenWaehlen(false)}
            className="rounded-md border border-line-strong px-2 py-1 text-xs font-medium text-ink hover:border-brand-400">
            abwählen
          </button>
          <span className="mx-1 h-4 w-px bg-line" />
          <Input
            value={sammelPreis}
            onChange={(e) => setSammelPreis(e.target.value)}
            placeholder="z. B. 7,50"
            inputMode="decimal"
            className="w-24 text-right font-mono"
          />
          <button
            type="button"
            onClick={sammelPreisSetzen}
            disabled={artikelIds.length === 0 || !sammelPreis.trim()}
            className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Preis für {artikelIds.length || '…'} Gewählte
          </button>
          {anzahlMitPreis > 0 && (
            <button type="button" onClick={() => setArtikelPreise({})}
              className="rounded-md px-2 py-1 text-xs text-red-600 hover:underline">
              Aktionspreise löschen
            </button>
          )}
        </div>

        {gefilterteArtikel.length === 0 ? (
          <p className="text-xs text-ink-subtle">Kein Artikel gefunden.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-64 overflow-y-auto p-0.5">
            {gefilterteArtikel.slice(0, 120).map(a => {
              const gewaehlt = artikelIds.includes(a.id)
              const preis    = artikelPreise[a.id] ?? ''
              return (
                <div
                  key={a.id}
                  className={`rounded-md border p-1.5 transition ${
                    gewaehlt ? 'border-brand-500 bg-brand-50' : 'border-line bg-panel'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleArt(a.id)}
                    className="block w-full text-left"
                    title={gewaehlt ? 'Abwählen' : 'Auswählen'}
                  >
                    <span className={`block text-xs font-medium leading-tight line-clamp-2 min-h-[2rem] ${
                      gewaehlt ? 'text-brand-900' : 'text-ink'
                    }`}>
                      {a.bezeichnung}
                    </span>
                    <span className="block text-[10px] text-ink-subtle">
                      {formatPreis(a.preisBruttoCent)}
                    </span>
                  </button>
                  <input
                    value={preis}
                    onChange={(e) => setzeArtikelPreis(a.id, e.target.value)}
                    placeholder="Aktionspreis"
                    inputMode="decimal"
                    className={`mt-1 w-full rounded border px-1.5 py-0.5 text-xs text-right font-mono ${
                      preis ? 'border-brand-400 bg-white text-brand-800 font-semibold' : 'border-line bg-panel-2'
                    }`}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      <p className="text-xs text-ink-subtle">
        Ohne Warengruppen- und Artikelauswahl gilt die Regel für <strong>alle Artikel</strong>.
        Ein Aktionspreis schlägt den Prozent-Rabatt; ohne Aktionspreis greift der Prozentsatz.
      </p>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={aktiv} onChange={(e) => setAktiv(e.target.checked)} className="accent-brand-600" />
        <span className="text-ink">Aktion aktiv</span>
      </label>

      {fehler && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{fehler}</div>}

      <div className="flex gap-2 justify-end pt-1 border-t border-line">
        <Button variant="secondary" type="button" onClick={onAbbrechen}>Abbrechen</Button>
        <Button type="submit" loading={speichern.isPending} disabled={!kannSpeichern}>
          {initial ? 'Speichern' : 'Anlegen'}
        </Button>
      </div>
    </form>
  )
}
