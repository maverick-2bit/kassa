/**
 * NeueKasseFormular — eine oder mehrere weitere Kassen anlegen, direkt in der Einrichtungs-Übersicht.
 *
 * Jede Kasse bekommt eine eigene Signatureinheit (SEE-Zertifikat) samt Startbeleg; Firmenname und UID kommen
 * vom Mandanten. Für den schnellen Aufbau (z. B. zehn Kassen für einen Test): die erste Kassen-ID wird
 * vorgeschlagen und hochgezählt, optional übernimmt jede neue Kasse die Einrichtung einer bestehenden
 * (Warengruppen, Drucker, KDS, Zuordnungen). Angelegt wird nacheinander — bei einem Fehler bleibt stehen,
 * was schon angelegt ist.
 */

import { useMemo, useState } from 'react'
import type { EinrichtungKasse, WeitereKasseInput } from '@kassa/shared'
import { einrichtungApi, kasseApi } from '../../lib/api'
import { addKasse } from '../../lib/auth'
import { kassenIdsFolge, kassenName, naechsteKassenIds } from '../../lib/einrichtung'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'

type Meldung = { typ: 'ok' | 'fehler'; text: string }

const MAX_ANZAHL = 20

export function NeueKasseFormular({ kassen, onFertig, onAbbrechen }: {
  kassen:      EinrichtungKasse[]
  onFertig:    (m: Meldung) => void
  onAbbrechen: () => void
}) {
  const aktive = kassen.filter(k => k.status === 'aktiv')
  // Vorgeschlagen: die nächste freie ID in der Schreibweise der vorhandenen, Umgebung wie die meisten Kassen
  const vorschlag = useMemo(() => naechsteKassenIds(kassen.map(k => k.kassenId), 1)[0]!, [kassen])
  const standardUmgebung: 'test' | 'produktion' =
    aktive.filter(k => k.umgebung === 'produktion').length > aktive.length / 2 ? 'produktion' : 'test'

  const [kassenId, setKassenId]       = useState(vorschlag)
  const [bezeichnung, setBezeichnung] = useState('')
  const [umgebung, setUmgebung]       = useState<'test' | 'produktion'>(standardUmgebung)
  const [anzahl, setAnzahl]           = useState('1')
  const [vonKasse, setVonKasse]       = useState('')
  const [tid, setTid]     = useState('')
  const [benId, setBenId] = useState('')
  const [pin, setPin]     = useState('')
  const [fortschritt, setFortschritt] = useState<string | null>(null)

  const n = Math.min(MAX_ANZAHL, Math.max(1, parseInt(anzahl, 10) || 1))
  const laeuft = fortschritt !== null

  async function anlegen() {
    const ids = kassenIdsFolge(kassenId, n)
    const belegt = new Set(kassen.map(k => k.kassenId.toLowerCase()))
    const doppelt = ids.find(id => belegt.has(id.toLowerCase()))
    if (doppelt) { onFertig({ typ: 'fehler', text: `Kassen-ID „${doppelt}" ist bereits vergeben.` }); return }

    const angelegt: string[] = []
    let letzteStartbeleg = 0
    try {
      for (const [i, id] of ids.entries()) {
        setFortschritt(n > 1 ? `Kasse ${i + 1} von ${n} wird angelegt …` : 'Kasse wird angelegt …')
        const name = bezeichnung.trim() ? (n > 1 ? `${bezeichnung.trim()} ${i + 1}` : bezeichnung.trim()) : ''
        const fonKomplett = n === 1 && tid.trim() && benId.trim() && pin.trim()
        const input: WeitereKasseInput = {
          kassenId: id,
          umgebung,
          ...(name && { bezeichnung: name }),
          ...(fonKomplett && { finanzOnline: { teilnehmerId: tid.trim(), benutzerkennung: benId.trim(), pin: pin.trim() } }),
        }
        const res = await kasseApi.anlegen(input)
        if (!res.erfolgreich || !res.kasseId) throw new Error(`„${id}": ${res.fehler ?? 'Kasse konnte nicht angelegt werden'}`)
        addKasse({ id: res.kasseId, kassenId: id, bezeichnung: name || null, umgebung })
        angelegt.push(id)
        letzteStartbeleg = res.startbelegNummer ?? 0
        if (vonKasse) await einrichtungApi.kopieren(res.kasseId, vonKasse)
      }
      onFertig({
        typ: 'ok',
        text: n === 1
          ? `Kasse „${ids[0]}" angelegt (Startbeleg #${letzteStartbeleg}).`
          : `${n} Kassen angelegt: ${ids[0]} bis ${ids[ids.length - 1]}.`,
      })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      onFertig({
        typ: 'fehler',
        text: angelegt.length > 0
          ? `${angelegt.length} von ${n} Kassen angelegt (${angelegt.join(', ')}). Danach ${text}`
          : text,
      })
    } finally {
      setFortschritt(null)
    }
  }

  return (
    <div className="space-y-4 rounded-md border border-line bg-panel-2 p-4">
      <div>
        <p className="text-sm font-medium text-ink">Neue Registrierkasse</p>
        <p className="text-xs text-ink-muted mt-0.5">
          Jede Kasse bekommt eine eigene Signatureinheit (SEE-Zertifikat) samt Startbeleg.
          Firmenname und UID werden vom Mandanten übernommen.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Field label="Kassen-ID" hint={n > 1 ? 'Erste ID — die Nummer wird hochgezählt' : 'Eindeutig, z. B. KASSE-002'}>
          <Input aria-label="Kassen-ID" value={kassenId} onChange={e => setKassenId(e.target.value)} maxLength={40} placeholder="KASSE-002" disabled={laeuft} />
        </Field>
        <Field label="Bezeichnung (optional)" hint={n > 1 ? 'Wird nummeriert: „Bar 1", „Bar 2" …' : 'Anzeigename, z. B. Bar Terrasse'}>
          <Input aria-label="Bezeichnung" value={bezeichnung} onChange={e => setBezeichnung(e.target.value)} maxLength={90} placeholder="Bar Terrasse" disabled={laeuft} />
        </Field>
        <Field label="Anzahl" hint={`1 bis ${MAX_ANZAHL} Kassen auf einmal`}>
          <Input aria-label="Anzahl" type="number" min={1} max={MAX_ANZAHL} value={anzahl} onChange={e => setAnzahl(e.target.value)} disabled={laeuft} />
        </Field>
        <Field label="Umgebung">
          <select
            className="block w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-sm text-ink shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            value={umgebung}
            disabled={laeuft}
            onChange={e => setUmgebung(e.target.value as 'test' | 'produktion')}
          >
            <option value="test">Test (FinanzOnline-Testumgebung)</option>
            <option value="produktion">Produktion (Echtbetrieb)</option>
          </select>
        </Field>
      </div>

      {aktive.length > 0 && (
        <Field label="Einrichtung übernehmen von (optional)" hint="Sichtbare Warengruppen, Drucker, KDS, Zahlungsarten, Startseite und alle Zuordnungen auf Drucker und Stationen">
          <select
            className="block w-full max-w-sm rounded-md border border-line-strong bg-panel px-3 py-2 text-sm text-ink shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            value={vonKasse}
            disabled={laeuft}
            onChange={e => setVonKasse(e.target.value)}
          >
            <option value="">Nein, leer starten</option>
            {aktive.map(k => <option key={k.id} value={k.id}>{kassenName(k)}</option>)}
          </select>
        </Field>
      )}

      {n === 1 && (
        <details className="rounded-md border border-line bg-panel p-3">
          <summary className="cursor-pointer text-sm font-medium text-ink">FinanzOnline-Registrierung (optional)</summary>
          <p className="mt-2 text-xs text-ink-muted">
            Fehlen die Daten, wird die Kasse provisorisch (ohne FON-Registrierung) angelegt —
            die Registrierung kann später nachgetragen werden. Zugangsdaten werden nicht gespeichert.
          </p>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Field label="Teilnehmer-ID"><Input value={tid} onChange={e => setTid(e.target.value)} autoComplete="off" /></Field>
            <Field label="Benutzerkennung"><Input value={benId} onChange={e => setBenId(e.target.value)} autoComplete="off" /></Field>
            <Field label="PIN"><Input type="password" value={pin} onChange={e => setPin(e.target.value)} autoComplete="off" /></Field>
          </div>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void anlegen()} loading={laeuft} disabled={!kassenId.trim()}>
          {n > 1 ? `${n} Kassen anlegen` : 'Kasse anlegen'}
        </Button>
        <Button variant="secondary" onClick={onAbbrechen} disabled={laeuft}>Abbrechen</Button>
        {fortschritt && <span role="status" className="text-sm text-ink-muted">{fortschritt}</span>}
      </div>
    </div>
  )
}
