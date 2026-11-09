/**
 * PreislistenPage — Sonderpreise für bestimmte Kunden.
 *
 * Eine Preisliste (z. B. „Tersus") enthält je Artikel einen eigenen Preis (brutto). Zugewiesen wird sie im Kunden;
 * an der Kasse gilt sie, sobald dieser Kunde gewählt ist. Artikel ohne Eintrag behalten ihren normalen Preis.
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Artikel, Preisliste, PreislisteDetail } from '@kassa/shared'
import { artikelApi, preislisteApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { formatPreis, parseEuroToCent } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Select } from '../components/ui/Select'
import { Field } from '../components/ui/Field'
import { Modal } from '../components/ui/Modal'

const centZuEuro = (c: number) => (c / 100).toFixed(2).replace('.', ',')

interface Zeile {
  artikelId:    string
  bezeichnung:  string
  regulaerCent: number
  gespeichert:  number | null     // null = noch nicht in der Liste
  eingabe:      string            // Euro-Eingabe
  aktiv:        boolean
}

function prozentText(regulaer: number, preis: number | null): string {
  if (preis === null || regulaer <= 0) return ''
  const p = Math.round((1 - preis / regulaer) * 1000) / 10
  if (p === 0) return '±0 %'
  return `${p > 0 ? '−' : '+'}${Math.abs(p).toString().replace('.', ',')} %`
}

// ---------------------------------------------------------------------------
// Editor einer Preisliste
// ---------------------------------------------------------------------------

function ListenEditor({ detail, alleArtikel, onGeaendert, onSchliessen }: {
  detail:       PreislisteDetail
  alleArtikel:  Artikel[]
  onGeaendert:  () => void
  onSchliessen: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(detail.name)
  const [fehler, setFehler] = useState<string | null>(null)
  const [hinweis, setHinweis] = useState<string | null>(null)
  const [suche, setSuche] = useState('')
  const [neueZeilen, setNeueZeilen] = useState<Zeile[]>([])
  const [eingaben, setEingaben] = useState<Record<string, string>>({})
  const [loeschen, setLoeschen] = useState(false)

  const zeilen: Zeile[] = useMemo(() => {
    const bestehend = detail.preise.map(p => ({
      artikelId: p.artikelId, bezeichnung: p.artikelBezeichnung, regulaerCent: p.regulaerBruttoCent,
      gespeichert: p.preisBruttoCent, eingabe: eingaben[p.artikelId] ?? centZuEuro(p.preisBruttoCent), aktiv: p.artikelAktiv,
    }))
    const neu = neueZeilen.map(z => ({ ...z, eingabe: eingaben[z.artikelId] ?? z.eingabe }))
    return [...neu, ...bestehend]
  }, [detail.preise, neueZeilen, eingaben])

  const bewertet = zeilen.map(z => {
    const cent = z.eingabe.trim() === '' ? null : parseEuroToCent(z.eingabe)
    const gueltig = cent !== null && cent >= 0
    return { z, cent, gueltig, geaendert: gueltig && cent !== z.gespeichert }
  })
  const zuSpeichern = bewertet.filter(b => b.geaendert)
  const ungueltig = bewertet.filter(b => !b.gueltig)

  const verfuegbar = useMemo(() => {
    const belegt = new Set(zeilen.map(z => z.artikelId))
    const q = suche.trim().toLowerCase()
    return alleArtikel.filter(a => a.aktiv && !belegt.has(a.id) && a.preisBruttoCent >= 0 && (q === '' || a.bezeichnung.toLowerCase().includes(q)))
      .sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung, 'de')).slice(0, 200)
  }, [alleArtikel, zeilen, suche])

  const invalidiere = () => {
    void qc.invalidateQueries({ queryKey: ['preislisten'] })
    void qc.invalidateQueries({ queryKey: ['preisliste-kunde'] })
    onGeaendert()
  }
  const onError = (e: unknown) => { setHinweis(null); setFehler(e instanceof Error ? e.message : 'Fehler') }

  const speichern = useMutation({
    mutationFn: async () => {
      if (name.trim() !== detail.name) await preislisteApi.aktualisiere(detail.id, { name: name.trim() })
      if (zuSpeichern.length > 0) {
        await preislisteApi.preiseSetzen(detail.id, { preise: zuSpeichern.map(b => ({ artikelId: b.z.artikelId, preisBruttoCent: b.cent! })) })
      }
    },
    onSuccess: () => {
      setFehler(null); setNeueZeilen([]); setEingaben({})
      setHinweis(zuSpeichern.length > 0 ? `${zuSpeichern.length} Preis${zuSpeichern.length === 1 ? '' : 'e'} gespeichert.` : 'Gespeichert.')
      invalidiere()
    },
    onError,
  })
  const aktivWechsel = useMutation({
    mutationFn: () => preislisteApi.aktualisiere(detail.id, { aktiv: !detail.aktiv }),
    onSuccess: () => { setFehler(null); invalidiere() }, onError,
  })
  const entfernen = useMutation({
    mutationFn: (artikelId: string) => preislisteApi.preisEntfernen(detail.id, artikelId),
    onSuccess: () => { setFehler(null); invalidiere() }, onError,
  })
  const loescheListe = useMutation({
    mutationFn: () => preislisteApi.loesche(detail.id),
    onSuccess: () => { invalidiere(); onSchliessen() }, onError,
  })

  function hinzu(id: string) {
    const a = alleArtikel.find(x => x.id === id)
    if (!a) return
    setNeueZeilen(l => [{ artikelId: a.id, bezeichnung: a.bezeichnung, regulaerCent: a.preisBruttoCent, gespeichert: null, eingabe: centZuEuro(a.preisBruttoCent), aktiv: a.aktiv }, ...l])
  }

  return (
    <div className="space-y-4" data-testid="preisliste-editor">
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
        <Field label="Name der Preisliste">
          <Input data-testid="preisliste-name" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
        </Field>
        <div className="flex items-center gap-2 text-sm text-ink-muted pb-2">
          <span>{detail.anzahlKunden} Kunde{detail.anzahlKunden === 1 ? '' : 'n'} zugewiesen</span>
          <Button type="button" variant="secondary" loading={aktivWechsel.isPending} onClick={() => aktivWechsel.mutate()}
            data-testid="preisliste-aktiv">{detail.aktiv ? 'Deaktivieren' : 'Aktivieren'}</Button>
        </div>
      </div>
      {!detail.aktiv && <p className="text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">Diese Preisliste ist deaktiviert — an der Kasse gelten die normalen Preise.</p>}

      <Field label="Artikel hinzufügen" hint="Der Sonderpreis startet beim normalen Preis; trage dann deinen Preis ein">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Input placeholder="Artikel suchen…" value={suche} onChange={e => setSuche(e.target.value)} data-testid="preisliste-suche" />
          <Select data-testid="preisliste-artikel-hinzu" value="" onChange={e => { hinzu(e.target.value); e.target.value = '' }}>
            <option value="">— {verfuegbar.length} Artikel{suche ? ' gefunden' : ''} —</option>
            {verfuegbar.map(a => <option key={a.id} value={a.id}>{a.bezeichnung} ({formatPreis(a.preisBruttoCent)})</option>)}
          </Select>
        </div>
      </Field>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-panel-2 text-xs text-ink-muted">
            <tr>
              <th className="px-2 py-2 text-left">Artikel</th>
              <th className="px-2 py-2 text-right">Normalpreis</th>
              <th className="px-2 py-2 text-right">Sonderpreis (€)</th>
              <th className="px-2 py-2 text-right">Unterschied</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {bewertet.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-ink-muted">Noch keine Sonderpreise — oben einen Artikel hinzufügen.</td></tr>
            )}
            {bewertet.map(({ z, cent, gueltig, geaendert }) => (
              <tr key={z.artikelId} className={`border-t border-line ${geaendert ? 'bg-brand-50' : ''}`} data-testid="preisliste-zeile">
                <td className="px-2 py-1.5 min-w-[12rem]">{z.bezeichnung}{!z.aktiv && <span className="ml-2 text-xs text-ink-subtle">(deaktiviert)</span>}</td>
                <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{formatPreis(z.regulaerCent)}</td>
                <td className="px-2 py-1.5 text-right">
                  <Input aria-label={`Sonderpreis ${z.bezeichnung}`} data-testid="preisliste-preis" inputMode="decimal" value={z.eingabe}
                    className={`w-28 text-right ${gueltig ? '' : 'border-red-400'}`}
                    onChange={e => setEingaben(o => ({ ...o, [z.artikelId]: e.target.value }))} />
                </td>
                <td className="px-2 py-1.5 text-right text-xs text-ink-muted whitespace-nowrap">{prozentText(z.regulaerCent, gueltig ? cent : null)}</td>
                <td className="px-2 py-1.5 text-right">
                  <button type="button" className="text-red-500 hover:text-red-700 text-xs font-medium" aria-label={`Sonderpreis ${z.bezeichnung} entfernen`}
                    onClick={() => z.gespeichert === null ? setNeueZeilen(l => l.filter(x => x.artikelId !== z.artikelId)) : entfernen.mutate(z.artikelId)}>
                    Entfernen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ungueltig.length > 0 && <p className="text-sm text-red-600">{ungueltig.length} Preis{ungueltig.length === 1 ? ' ist' : 'e sind'} ungültig (Beispiel: 12,50).</p>}
      {hinweis && <p className="text-sm text-green-700" role="status" data-testid="preisliste-hinweis">{hinweis}</p>}
      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}

      <div className="flex flex-wrap justify-between gap-2 pt-2 border-t border-line">
        <Button type="button" variant="danger" data-testid="preisliste-loeschen" onClick={() => setLoeschen(true)}>Preisliste löschen</Button>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onSchliessen}>Schließen</Button>
          <Button type="button" data-testid="preisliste-speichern" loading={speichern.isPending}
            disabled={ungueltig.length > 0 || name.trim() === '' || (zuSpeichern.length === 0 && name.trim() === detail.name)}
            onClick={() => { setFehler(null); setHinweis(null); speichern.mutate() }}>
            Speichern{zuSpeichern.length > 0 ? ` (${zuSpeichern.length})` : ''}
          </Button>
        </div>
      </div>

      {loeschen && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2" role="alertdialog" data-testid="preisliste-bestaetigung">
          <p className="text-sm text-red-800">
            „{detail.name}" mit {detail.anzahlPreise} Sonderpreis{detail.anzahlPreise === 1 ? '' : 'en'} wirklich löschen?
            {detail.anzahlKunden > 0 ? ` ${detail.anzahlKunden} zugewiesene Kunde${detail.anzahlKunden === 1 ? ' bekommt' : 'n bekommen'} danach wieder die normalen Preise.` : ''}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setLoeschen(false)}>Zurück</Button>
            <Button type="button" variant="danger" data-testid="preisliste-bestaetigen" loading={loescheListe.isPending} onClick={() => loescheListe.mutate()}>Ja, löschen</Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export function PreislistenPage() {
  const auth = getAuth()
  const qc = useQueryClient()
  const [offenId, setOffenId] = useState<string | null>(null)
  const [neu, setNeu] = useState(false)
  const [neuerName, setNeuerName] = useState('')
  const [neuFehler, setNeuFehler] = useState<string | null>(null)

  const { data: listen = [], isLoading } = useQuery({ queryKey: ['preislisten'], queryFn: preislisteApi.liste })
  const { data: alleArtikel = [] } = useQuery({
    queryKey: ['artikel', auth?.mandant.id, true],
    queryFn:  () => artikelApi.list(auth!.mandant.id, true),
    enabled:  !!auth,
  })
  const { data: detail } = useQuery({
    queryKey: ['preislisten', 'detail', offenId],
    queryFn:  () => preislisteApi.hole(offenId!),
    enabled:  !!offenId,
  })

  const anlegen = useMutation({
    mutationFn: () => preislisteApi.erstelle({ name: neuerName.trim() }),
    onSuccess: (l: Preisliste) => { void qc.invalidateQueries({ queryKey: ['preislisten'] }); setNeu(false); setNeuerName(''); setNeuFehler(null); setOffenId(l.id) },
    onError: e => setNeuFehler(e instanceof Error ? e.message : 'Fehler'),
  })

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Preislisten</h1>
          <p className="text-sm text-ink-muted mt-0.5">Sonderpreise für bestimmte Kunden. Zugewiesen wird die Liste im Kunden.</p>
        </div>
        <Button data-testid="preisliste-neu" onClick={() => { setNeu(true); setNeuFehler(null) }}>+ Neue Preisliste</Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-ink-muted">Lädt…</p>
      ) : listen.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong py-14 text-center">
          <p className="text-ink-muted">Noch keine Preisliste.</p>
          <p className="text-sm text-ink-subtle mt-1">Lege z. B. eine Liste „Tersus" an und trage die Sonderpreise ein.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {listen.map(l => (
            <button key={l.id} type="button" data-testid="preisliste-karte" onClick={() => setOffenId(l.id)}
              className="w-full text-left rounded-xl border border-line bg-panel p-3 hover:border-brand-400 transition flex items-center justify-between gap-3">
              <span>
                <span className="font-semibold text-ink">{l.name}</span>
                {!l.aktiv && <span className="ml-2 text-xs rounded-full border border-yellow-200 bg-yellow-100 text-yellow-700 px-2 py-0.5">deaktiviert</span>}
                <span className="block text-xs text-ink-muted mt-0.5">{l.anzahlPreise} Sonderpreis{l.anzahlPreise === 1 ? '' : 'e'} · {l.anzahlKunden} Kunde{l.anzahlKunden === 1 ? '' : 'n'}</span>
              </span>
              <span className="text-brand-600 text-sm">Öffnen</span>
            </button>
          ))}
        </div>
      )}

      <Modal open={neu} onClose={() => setNeu(false)} title="Neue Preisliste" size="sm">
        <div className="space-y-4">
          <Field label="Name" hint="z. B. der Kunde, für den sie gilt">
            <Input autoFocus data-testid="preisliste-neu-name" value={neuerName} maxLength={80} placeholder="z. B. Tersus"
              onChange={e => setNeuerName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && neuerName.trim()) anlegen.mutate() }} />
          </Field>
          {neuFehler && <p className="text-sm text-red-600" role="alert">{neuFehler}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setNeu(false)}>Abbrechen</Button>
            <Button type="button" data-testid="preisliste-anlegen" loading={anlegen.isPending} disabled={!neuerName.trim()} onClick={() => anlegen.mutate()}>Anlegen</Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!offenId} onClose={() => setOffenId(null)} title={detail ? `Preisliste „${detail.name}"` : 'Preisliste'} size="xl" closeOnBackdrop={false}>
        {detail && (
          <ListenEditor key={detail.id} detail={detail} alleArtikel={alleArtikel}
            onGeaendert={() => { void qc.invalidateQueries({ queryKey: ['preislisten', 'detail'] }) }} onSchliessen={() => setOffenId(null)} />
        )}
      </Modal>
    </div>
  )
}
