/**
 * DatenuebernahmePage — Stammdaten aus der bisherigen Warenwirtschaft (SelectLine) per Excel übernehmen.
 *
 * Reihenfolge: 1. Lieferanten, 2. Kunden, 3. Artikel (Artikel verknüpfen sich mit den Lieferanten).
 * Mehrfaches Übernehmen derselben Datei ist gefahrlos: Bereits übernommene Einträge werden erkannt
 * (Markierung in Notiz bzw. Artikelnummer beim Lieferanten) und übersprungen.
 */

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { MwStSatz } from '@kassa/shared'
import { artikelApi, kategorieApi, kundeApi, lieferantApi, preislisteApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { Button } from '../components/ui/Button'
import {
  kundeMarke, lieferantMarke, nettoZuBruttoCent, parseArtikel, parseKunden, parseLieferanten, parsePreisgruppen,
  type ParsedArtikel, type ParsedKunde, type ParsedLieferant, type ParsedPreisgruppe, type Zeile,
} from '../lib/selectline-import'

async function leseExcel(datei: File, blattPrefix: string): Promise<Zeile[]> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await datei.arrayBuffer(), { type: 'array' })
  const name = wb.SheetNames.find(n => n.toLowerCase().startsWith(blattPrefix.toLowerCase())) ?? wb.SheetNames[0]
  if (!name) return []
  return XLSX.utils.sheet_to_json<Zeile>(wb.Sheets[name]!, { defval: null, raw: true })
}

interface Ergebnis { erstellt: number; vorhanden: number; fehler: string[] }

function Karte({ nr, titel, hinweis, children }: { nr: number; titel: string; hinweis: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4 space-y-3">
      <div>
        <h2 className="text-base font-semibold text-ink">{nr}. {titel}</h2>
        <p className="text-xs text-ink-muted mt-0.5">{hinweis}</p>
      </div>
      {children}
    </section>
  )
}

function ErgebnisZeile({ e }: { e: Ergebnis }) {
  return (
    <div className="text-sm space-y-1" data-testid="uebernahme-ergebnis">
      <p className="text-green-700">
        {e.erstellt} neu angelegt{e.vorhanden > 0 ? `, ${e.vorhanden} waren schon vorhanden` : ''}.
      </p>
      {e.fehler.length > 0 && (
        <details className="text-red-700">
          <summary className="cursor-pointer">{e.fehler.length} Fehler</summary>
          <ul className="list-disc pl-5 text-xs max-h-40 overflow-auto">
            {e.fehler.slice(0, 200).map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

function Uebersprungen({ liste }: { liste: string[] }) {
  if (liste.length === 0) return null
  return (
    <details className="text-xs text-ink-muted">
      <summary className="cursor-pointer">{liste.length} Zeilen werden nicht übernommen</summary>
      <ul className="list-disc pl-5 max-h-32 overflow-auto">{liste.slice(0, 200).map((t, i) => <li key={i}>{t}</li>)}</ul>
    </details>
  )
}

// ---------------------------------------------------------------------------

function LieferantenKarte() {
  const [vorschau, setVorschau] = useState<{ eintraege: ParsedLieferant[]; uebersprungen: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null)

  async function waehle(f: File | undefined) {
    setErgebnis(null); setFehler(null); setVorschau(null)
    if (!f) return
    try { setVorschau(parseLieferanten(await leseExcel(f, 'Lieferanten'))) }
    catch (e) { setFehler(e instanceof Error ? e.message : 'Datei nicht lesbar') }
  }

  async function uebernehmen() {
    if (!vorschau) return
    setBusy(true); setFehler(null)
    const res: Ergebnis = { erstellt: 0, vorhanden: 0, fehler: [] }
    try {
      const bestehend = await lieferantApi.list()
      const namen = new Set(bestehend.map(l => l.name.trim().toLowerCase()))
      const marken = new Set(bestehend.map(l => l.notiz ?? '').flatMap(n => n.split('\n')).map(s => s.trim()))
      for (const e of vorschau.eintraege) {
        if (marken.has(lieferantMarke(e.nummer)) || namen.has(e.input.name.trim().toLowerCase())) { res.vorhanden++; continue }
        try { await lieferantApi.create(e.input); res.erstellt++ }
        catch (err) { res.fehler.push(`${e.input.name}: ${err instanceof Error ? err.message : 'Fehler'}`) }
      }
      setErgebnis(res)
    } catch (e) { setFehler(e instanceof Error ? e.message : 'Fehler') }
    finally { setBusy(false) }
  }

  return (
    <Karte nr={1} titel="Lieferanten" hinweis="Datei „Lieferanten.xlsx“ aus dem SelectLine-Export. Adresse, UID, Zahlungsbedingung und Notiz werden mit übernommen.">
      <input type="file" accept=".xlsx" data-testid="uebernahme-lieferanten-datei" onChange={e => void waehle(e.target.files?.[0])} />
      {vorschau && (
        <div className="space-y-2">
          <p className="text-sm">{vorschau.eintraege.length} Lieferanten bereit zur Übernahme.</p>
          <Uebersprungen liste={vorschau.uebersprungen} />
          <Button loading={busy} onClick={() => void uebernehmen()} data-testid="uebernahme-lieferanten-start">Lieferanten übernehmen</Button>
        </div>
      )}
      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}
      {ergebnis && <ErgebnisZeile e={ergebnis} />}
    </Karte>
  )
}

// ---------------------------------------------------------------------------

function KundenKarte() {
  const [vorschau, setVorschau] = useState<{ eintraege: ParsedKunde[]; uebersprungen: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null)

  async function waehle(f: File | undefined) {
    setErgebnis(null); setFehler(null); setVorschau(null)
    if (!f) return
    try { setVorschau(parseKunden(await leseExcel(f, 'Kunden'))) }
    catch (e) { setFehler(e instanceof Error ? e.message : 'Datei nicht lesbar') }
  }

  async function uebernehmen() {
    if (!vorschau) return
    setBusy(true); setFehler(null)
    const res: Ergebnis = { erstellt: 0, vorhanden: 0, fehler: [] }
    try {
      const bestehend = await kundeApi.list({ nurAktive: false, limit: 20000 })
      const marken = new Set(bestehend.flatMap(k => (k.notizen ?? '').split('\n')).map(s => s.trim()))
      for (const e of vorschau.eintraege) {
        if (marken.has(kundeMarke(e.nummer))) { res.vorhanden++; continue }
        try { await kundeApi.create(e.input); res.erstellt++ }
        catch (err) { res.fehler.push(`${e.input.firma ?? e.input.nachname}: ${err instanceof Error ? err.message : 'Fehler'}`) }
      }
      setErgebnis(res)
    } catch (e) { setFehler(e instanceof Error ? e.message : 'Fehler') }
    finally { setBusy(false) }
  }

  return (
    <Karte nr={2} titel="Kunden" hinweis="Datei „Kunden.xlsx“ (Blatt „Kunden“). Die alte Kundennummer steht danach in den Notizen des Kunden.">
      <input type="file" accept=".xlsx" data-testid="uebernahme-kunden-datei" onChange={e => void waehle(e.target.files?.[0])} />
      {vorschau && (
        <div className="space-y-2">
          <p className="text-sm">{vorschau.eintraege.length} Kunden bereit zur Übernahme.</p>
          <Uebersprungen liste={vorschau.uebersprungen} />
          <Button loading={busy} onClick={() => void uebernehmen()} data-testid="uebernahme-kunden-start">Kunden übernehmen</Button>
        </div>
      )}
      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}
      {ergebnis && <ErgebnisZeile e={ergebnis} />}
    </Karte>
  )
}

// ---------------------------------------------------------------------------

function ArtikelKarte() {
  const auth = getAuth()
  const qc = useQueryClient()
  const [vorschau, setVorschau] = useState<{ eintraege: ParsedArtikel[]; uebersprungen: string[]; ohnePreis: number } | null>(null)
  const [auchOhnePreis, setAuchOhnePreis] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null)

  async function waehle(f: File | undefined) {
    setErgebnis(null); setFehler(null); setVorschau(null)
    if (!f) return
    try { setVorschau(parseArtikel(await leseExcel(f, 'M10'))) }
    catch (e) { setFehler(e instanceof Error ? e.message : 'Datei nicht lesbar') }
  }

  async function uebernehmen() {
    if (!vorschau || !auth) return
    setBusy(true); setFehler(null)
    const res: Ergebnis = { erstellt: 0, vorhanden: 0, fehler: [] }
    try {
      const kandidaten = vorschau.eintraege.filter(a => auchOhnePreis || a.hatVerkaufspreis)

      // Lieferanten: Markierung „SelectLine-Nr. 70001" → ID
      const lieferanten = await lieferantApi.list()
      const lieferantIdJeNr = new Map<string, string>()
      for (const l of lieferanten) {
        for (const zeile of (l.notiz ?? '').split('\n')) {
          const m = /^SelectLine-Nr\. (.+)$/.exec(zeile.trim())
          if (m) lieferantIdJeNr.set(m[1]!.trim(), l.id)
        }
      }

      // Warengruppen: vorhandene nach Name, fehlende anlegen
      // Query-Keys nach Konvention: ['kategorien', 'alle'] ⇔ list(false)
      const kategorien = await qc.fetchQuery({ queryKey: ['kategorien', 'alle'], queryFn: () => kategorieApi.list(false), staleTime: 0 })
      const katIdJeName = new Map(kategorien.map(k => [k.name.trim().toLowerCase(), k.id] as const))
      for (const name of new Set(kandidaten.map(a => a.warengruppe).filter(Boolean))) {
        const key = name.trim().toLowerCase()
        if (katIdJeName.has(key)) continue
        try {
          const neu = await kategorieApi.create({ name: name.slice(0, 80), farbe: 'grau', reihenfolge: katIdJeName.size, terminalSichtbar: false })
          katIdJeName.set(key, neu.id)
        } catch (err) { res.fehler.push(`Warengruppe „${name}“: ${err instanceof Error ? err.message : 'Fehler'}`) }
      }

      // Schon Übernommenes erkennen (SelectLine-Artikelnummer = Artikelnummer beim Lieferanten)
      const bestehend = await qc.fetchQuery({ queryKey: ['artikel', auth.mandant.id, false], queryFn: () => artikelApi.list(auth.mandant.id, false), staleTime: 0 })
      const vorhandeneNr = new Set(bestehend.map(a => a.lieferantenArtikelnummer).filter((n): n is string => !!n))
      const neue = kandidaten.filter(a => {
        if (a.nummer && vorhandeneNr.has(a.nummer)) { res.vorhanden++; return false }
        return true
      })

      const zeilen = neue.map(a => ({
        ...a.input,
        kategorieId: katIdJeName.get(a.warengruppe.trim().toLowerCase()) ?? null,
        lieferantId: lieferantIdJeNr.get(a.lieferantNummer) ?? null,
      }))
      for (let i = 0; i < zeilen.length; i += 500) {
        const teil = zeilen.slice(i, i + 500)
        const r = await artikelApi.bulkImport(teil)
        res.erstellt += r.erstellt
        for (const f of r.fehlzeilen) res.fehler.push(`${teil[f.index]?.bezeichnung ?? `Zeile ${i + f.index + 1}`}: ${f.fehler}`)
      }
      void qc.invalidateQueries({ queryKey: ['artikel'] })
      void qc.invalidateQueries({ queryKey: ['kategorien'] })
      setErgebnis(res)
    } catch (e) { setFehler(e instanceof Error ? e.message : 'Fehler') }
    finally { setBusy(false) }
  }

  const anzahl = vorschau ? vorschau.eintraege.filter(a => auchOhnePreis || a.hatVerkaufspreis).length : 0
  return (
    <Karte nr={3} titel="Artikel mit Preisen" hinweis="Datei „Artikel.xlsx“ (Blatt „M10“). Übernommen werden Verkaufspreis brutto, Steuer, EAN, Einkaufspreis, Hersteller, Warengruppe und Lieferant. Die SelectLine-Artikelnummer steht danach als „Artikelnummer beim Lieferanten“ am Artikel.">
      <input type="file" accept=".xlsx" data-testid="uebernahme-artikel-datei" onChange={e => void waehle(e.target.files?.[0])} />
      {vorschau && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={auchOhnePreis} onChange={e => setAuchOhnePreis(e.target.checked)} data-testid="uebernahme-auch-ohne-preis" />
            Auch Artikel ohne Verkaufspreis übernehmen (Preis 0,00 €) — {vorschau.ohnePreis} Stück
          </label>
          <p className="text-sm">{anzahl} Artikel bereit zur Übernahme.</p>
          <Uebersprungen liste={vorschau.uebersprungen} />
          <Button loading={busy} onClick={() => void uebernehmen()} data-testid="uebernahme-artikel-start">Artikel übernehmen</Button>
        </div>
      )}
      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}
      {ergebnis && <ErgebnisZeile e={ergebnis} />}
    </Karte>
  )
}

// ---------------------------------------------------------------------------

function PreislistenKarte() {
  const auth = getAuth()
  const qc = useQueryClient()
  const [gruppen, setGruppen] = useState<ParsedPreisgruppe[] | null>(null)
  const [gewaehlt, setGewaehlt] = useState<Record<string, boolean>>({})
  const [namen, setNamen] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [ergebnisse, setErgebnisse] = useState<string[]>([])

  async function waehle(f: File | undefined) {
    setErgebnisse([]); setFehler(null); setGruppen(null); setGewaehlt({}); setNamen({})
    if (!f) return
    try {
      const g = parsePreisgruppen(await leseExcel(f, 'M10'))
      setGruppen(g)
      setNamen(Object.fromEntries(g.map(x => [x.nummer, x.name])))
    } catch (e) { setFehler(e instanceof Error ? e.message : 'Datei nicht lesbar') }
  }

  async function uebernehmen() {
    if (!gruppen || !auth) return
    setBusy(true); setFehler(null); setErgebnisse([])
    const meldungen: string[] = []
    try {
      // Kassa-Artikel über die SelectLine-Artikelnummer finden (steht als „Artikelnummer beim Lieferanten")
      const bestehend = await qc.fetchQuery({ queryKey: ['artikel', auth.mandant.id, false], queryFn: () => artikelApi.list(auth.mandant.id, false), staleTime: 0 })
      const jeNummer = new Map(bestehend.flatMap(a => a.lieferantenArtikelnummer ? [[a.lieferantenArtikelnummer, a] as const] : []))
      const vorhandene = await preislisteApi.liste()

      for (const g of gruppen.filter(x => gewaehlt[x.nummer])) {
        const name = (namen[g.nummer] ?? g.name).trim()
        if (!name) { meldungen.push(`Gruppe ${g.nummer}: ohne Namen übersprungen`); continue }
        const preise: { artikelId: string; preisBruttoCent: number }[] = []
        let fehlend = 0
        for (const e of g.eintraege) {
          const a = jeNummer.get(e.artikelNr)
          if (!a) { fehlend++; continue }
          preise.push({ artikelId: a.id, preisBruttoCent: nettoZuBruttoCent(e.nettoEuro, a.mwstSatz as MwStSatz) })
        }
        if (preise.length === 0) { meldungen.push(`„${name}": kein Artikel gefunden — bitte zuerst die Artikel übernehmen (Schritt 3)`); continue }
        const liste = vorhandene.find(l => l.name.trim().toLowerCase() === name.toLowerCase()) ?? await preislisteApi.erstelle({ name })
        for (let i = 0; i < preise.length; i += 1000) await preislisteApi.preiseSetzen(liste.id, { preise: preise.slice(i, i + 1000) })
        meldungen.push(`„${name}": ${preise.length} Sonderpreise übernommen${fehlend > 0 ? `, ${fehlend} Artikel nicht gefunden` : ''}.`)
      }
      void qc.invalidateQueries({ queryKey: ['preislisten'] })
      setErgebnisse(meldungen)
    } catch (e) { setFehler(e instanceof Error ? e.message : 'Fehler') }
    finally { setBusy(false) }
  }

  const anzahl = gruppen ? gruppen.filter(g => gewaehlt[g.nummer]).length : 0
  return (
    <Karte nr={4} titel="Sonderpreise (Preislisten)" hinweis="Dieselbe Datei „Artikel.xlsx“ wie bei den Artikeln. Jede Preisgruppe wird eine Preisliste mit Bruttopreisen. Danach weist du die Liste im Kunden zu. Erst nach Schritt 3 möglich.">
      <input type="file" accept=".xlsx" data-testid="uebernahme-preislisten-datei" onChange={e => void waehle(e.target.files?.[0])} />
      {gruppen && gruppen.length === 0 && <p className="text-sm text-ink-muted">In dieser Datei gibt es keine Preisgruppen mit Preisen.</p>}
      {gruppen && gruppen.length > 0 && (
        <div className="space-y-2">
          {gruppen.map(g => (
            <div key={g.nummer} className="flex items-center gap-3">
              <input type="checkbox" aria-label={`Preisgruppe ${g.nummer} übernehmen`} data-testid={`uebernahme-pg-${g.nummer}`}
                checked={!!gewaehlt[g.nummer]} onChange={e => setGewaehlt(o => ({ ...o, [g.nummer]: e.target.checked }))} />
              <input type="text" value={namen[g.nummer] ?? ''} maxLength={80} aria-label={`Name der Preisliste für Gruppe ${g.nummer}`}
                data-testid={`uebernahme-pg-name-${g.nummer}`} onChange={e => setNamen(o => ({ ...o, [g.nummer]: e.target.value }))}
                className="rounded-lg border border-line-strong px-2 py-1 text-sm w-56" />
              <span className="text-xs text-ink-muted">{g.eintraege.length} Preise (SelectLine-Gruppe {g.nummer})</span>
            </div>
          ))}
          <Button loading={busy} disabled={anzahl === 0} onClick={() => void uebernehmen()} data-testid="uebernahme-preislisten-start">
            {anzahl === 0 ? 'Preislisten übernehmen' : `${anzahl} Preisliste${anzahl === 1 ? '' : 'n'} übernehmen`}
          </Button>
        </div>
      )}
      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}
      {ergebnisse.length > 0 && (
        <ul className="text-sm text-green-700 list-disc pl-5" data-testid="uebernahme-preislisten-ergebnis">
          {ergebnisse.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      )}
    </Karte>
  )
}

// ---------------------------------------------------------------------------

export function DatenuebernahmePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-ink">Datenübernahme</h1>
        <p className="text-sm text-ink-muted mt-0.5">
          Lieferanten, Kunden, Artikel und Sonderpreise aus der bisherigen Warenwirtschaft übernehmen. Bitte der Reihe nach vorgehen.
          Eine Datei kann gefahrlos mehrmals übernommen werden — Vorhandenes wird erkannt und übersprungen.
        </p>
      </div>
      <LieferantenKarte />
      <KundenKarte />
      <ArtikelKarte />
      <PreislistenKarte />
    </div>
  )
}
