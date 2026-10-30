import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  MwStSatz,
  SammelrechnungResponse,
  WartungsIntervall,
  WartungsPositionInput,
  WartungsvertragResponse,
  WartungsvertragStatus,
} from '@kassa/shared'
import {
  MWST_LABELS,
  WARTUNGS_INTERVALL_LABELS,
  WARTUNGSVERTRAG_STATUS_LABELS,
  ersteVertragsperiode,
} from '@kassa/shared'
import { artikelApi, kundeApi, sammelrechnungApi, wartungsvertragApi, ApiError } from '../lib/api'
import { getAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis, parseEuroToCent } from '../lib/format'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Field'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { Select } from '../components/ui/Select'
import { AusgabeDialog } from '../components/AusgabeDialog'
import { druckeSammelrechnung } from '../lib/rechnung'

const INTERVALLE = Object.keys(WARTUNGS_INTERVALL_LABELS) as WartungsIntervall[]
const MONATE = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']

const vertragNr = (n: number) => `W-${String(n).padStart(4, '0')}`
const periodeText = (p: string) => `${p.slice(5, 7)}/${p.slice(0, 4)}`

function fehlerText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : 'Unbekannter Fehler'
}

// ---------------------------------------------------------------------------
// Formular (Anlegen + Bearbeiten)
// ---------------------------------------------------------------------------

interface PosEntwurf {
  artikelId:  string
  bezeichnung: string
  menge:      string
  preis:      string          // Euro, wie getippt
  mwstSatz:   MwStSatz
  intervall:  WartungsIntervall
  ankerMonat: string          // '' = Monat nach dem Beginn
}

const leerePosition = (): PosEntwurf => ({
  artikelId: '', bezeichnung: '', menge: '1', preis: '', mwstSatz: 'normal', intervall: 'monatlich', ankerMonat: '',
})

function VertragFormular({ vertrag, onFertig }: { vertrag: WartungsvertragResponse | null; onFertig: () => void }) {
  const qc       = useQueryClient()
  const identity = getKasseIdentity()!
  const bearbeite = vertrag !== null
  const gesperrterBeginn = bearbeite && !!vertrag.letztePeriode

  const kunden  = useQuery({ queryKey: ['kunden', 'wartung'], queryFn: () => kundeApi.list({ limit: 500 }) })
  const artikel = useQuery({
    queryKey: ['artikel', identity.mandantId, true],
    queryFn:  () => artikelApi.list(identity.mandantId, true),
  })

  const [kundeId, setKundeId]       = useState(vertrag?.kundeId ?? '')
  const [bezeichnung, setBezeichnung] = useState(vertrag?.bezeichnung ?? 'Kassa-Wartung')
  const [beginn, setBeginn]         = useState(vertrag?.beginn ?? '')
  const [ende, setEnde]             = useState(vertrag?.ende ?? '')
  const [rechnungsIntervall, setRechnungsIntervall] = useState<WartungsIntervall>(vertrag?.rechnungsIntervall ?? 'monatlich')
  const [status, setStatus]         = useState<WartungsvertragStatus>(vertrag?.status ?? 'aktiv')
  const [notiz, setNotiz]           = useState(vertrag?.notiz ?? '')
  const [positionen, setPositionen] = useState<PosEntwurf[]>(
    vertrag
      ? vertrag.positionen.map(p => ({
          artikelId:   p.artikelId ?? '',
          bezeichnung: p.bezeichnung,
          menge:       String(p.menge),
          preis:       (p.einzelpreisBreutto / 100).toFixed(2).replace('.', ','),
          mwstSatz:    p.mwstSatz,
          intervall:   p.intervall,
          ankerMonat:  p.ankerMonat ? String(p.ankerMonat) : '',
        }))
      : [leerePosition()],
  )
  const [fehler, setFehler] = useState<string | null>(null)

  const setPos = (i: number, patch: Partial<PosEntwurf>) =>
    setPositionen(ps => ps.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))

  const artikelWaehlen = (i: number, id: string) => {
    const a = (artikel.data ?? []).find(x => x.id === id)
    if (!a) { setPos(i, { artikelId: '' }); return }
    setPos(i, {
      artikelId:   a.id,
      bezeichnung: a.bezeichnung,
      preis:       (a.preisBruttoCent / 100).toFixed(2).replace('.', ','),
      mwstSatz:    a.mwstSatz as MwStSatz,
    })
  }

  const speichern = useMutation({
    mutationFn: async () => {
      const pos: WartungsPositionInput[] = positionen.map((p, i) => {
        const cent  = parseEuroToCent(p.preis)
        const menge = parseInt(p.menge, 10)
        if (!p.bezeichnung.trim()) throw new Error(`Position ${i + 1}: Bezeichnung fehlt`)
        if (cent === null)        throw new Error(`Position ${i + 1}: Preis ungültig`)
        if (!(menge >= 1))        throw new Error(`Position ${i + 1}: Menge ungültig`)
        return {
          ...(p.artikelId && { artikelId: p.artikelId }),
          bezeichnung:        p.bezeichnung.trim(),
          menge,
          einzelpreisBreutto: cent,
          mwstSatz:           p.mwstSatz,
          intervall:          p.intervall,
          ...(p.intervall !== 'monatlich' && p.ankerMonat && { ankerMonat: parseInt(p.ankerMonat, 10) }),
        }
      })
      if (!kundeId) throw new Error('Bitte einen Kunden wählen')
      if (!beginn)  throw new Error('Bitte den Vertragsbeginn angeben')

      if (!bearbeite) {
        return wartungsvertragApi.create({
          kasseId: identity.kasseId, kundeId, bezeichnung: bezeichnung.trim(), beginn,
          ...(ende && { ende }), rechnungsIntervall, status, ...(notiz.trim() && { notiz: notiz.trim() }),
          positionen: pos,
        })
      }
      return wartungsvertragApi.update(vertrag.id, {
        kundeId, bezeichnung: bezeichnung.trim(),
        ...(!gesperrterBeginn && { beginn }),
        ende: ende || null, rechnungsIntervall, status, notiz: notiz.trim() || null,
        positionen: pos,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wartungsvertraege'] })
      onFertig()
    },
    onError: (err) => setFehler(fehlerText(err)),
  })

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Kunde" htmlFor="wv-kunde" required>
          <Select id="wv-kunde" value={kundeId} onChange={e => setKundeId(e.target.value)} className="w-full">
            <option value="">— wählen —</option>
            {(kunden.data ?? []).map(k => (
              <option key={k.id} value={k.id}>{k.firma ?? [k.vorname, k.nachname].filter(Boolean).join(' ')}</option>
            ))}
          </Select>
        </Field>
        <Field label="Bezeichnung" htmlFor="wv-bez" required>
          <Input id="wv-bez" value={bezeichnung} onChange={e => setBezeichnung(e.target.value)} className="w-full" />
        </Field>
        <Field
          label="Vertragsbeginn" htmlFor="wv-beginn" required
          hint={gesperrterBeginn
            ? 'Nicht mehr änderbar, weil schon Lieferscheine erzeugt wurden.'
            : beginn
              ? `Erste Abrechnung: ${periodeText(ersteVertragsperiode(beginn))} (der Startmonat zählt nicht).`
              : 'Der Startmonat wird nicht verrechnet.'}
        >
          <Input id="wv-beginn" type="date" value={beginn} disabled={gesperrterBeginn}
                 onChange={e => setBeginn(e.target.value)} className="w-full" />
        </Field>
        <Field label="Vertragsende (optional)" htmlFor="wv-ende" hint="Der Endmonat wird auf jeden Fall verrechnet, auch wenn er nur angefangen ist.">
          <Input id="wv-ende" type="date" value={ende} onChange={e => setEnde(e.target.value)} className="w-full" />
        </Field>
        <Field label="Rechnungsintervall" htmlFor="wv-intervall" hint="Wie oft die offenen Wartungslieferscheine zur Sammelrechnung werden.">
          <Select id="wv-intervall" value={rechnungsIntervall}
                  onChange={e => setRechnungsIntervall(e.target.value as WartungsIntervall)} className="w-full">
            {INTERVALLE.map(i => <option key={i} value={i}>{WARTUNGS_INTERVALL_LABELS[i]}</option>)}
          </Select>
        </Field>
        {bearbeite && (
          <Field label="Status" htmlFor="wv-status">
            <Select id="wv-status" value={status} onChange={e => setStatus(e.target.value as WartungsvertragStatus)} className="w-full">
              {(Object.keys(WARTUNGSVERTRAG_STATUS_LABELS) as WartungsvertragStatus[]).map(s => (
                <option key={s} value={s}>{WARTUNGSVERTRAG_STATUS_LABELS[s]}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {/* Positionen mit eigenem Intervall */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Positionen</p>
        <div className="space-y-3">
          {positionen.map((p, i) => (
            <div key={i} className="rounded-lg border border-line bg-panel-2 p-3 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
                <div className="sm:col-span-6">
                  <Select aria-label={`Artikel Position ${i + 1}`} value={p.artikelId}
                          onChange={e => artikelWaehlen(i, e.target.value)} className="w-full">
                    <option value="">Freie Position / Artikel übernehmen …</option>
                    {(artikel.data ?? []).map(a => (
                      <option key={a.id} value={a.id}>{a.bezeichnung} ({formatPreis(a.preisBruttoCent)})</option>
                    ))}
                  </Select>
                </div>
                <div className="sm:col-span-3">
                  <Input aria-label={`Bezeichnung Position ${i + 1}`} placeholder="Bezeichnung" value={p.bezeichnung}
                         onChange={e => setPos(i, { bezeichnung: e.target.value })} className="w-full" />
                </div>
                <Input aria-label={`Menge Position ${i + 1}`} inputMode="numeric" placeholder="Menge" value={p.menge}
                       onChange={e => setPos(i, { menge: e.target.value })} className="w-full" />
                <Input aria-label={`Einzelpreis Position ${i + 1}`} inputMode="decimal" placeholder="Preis brutto €" value={p.preis}
                       onChange={e => setPos(i, { preis: e.target.value })} className="w-full" />
                <Select aria-label={`MwSt Position ${i + 1}`} value={p.mwstSatz}
                        onChange={e => setPos(i, { mwstSatz: e.target.value as MwStSatz })} className="w-full">
                  {(Object.keys(MWST_LABELS) as MwStSatz[]).map(s => <option key={s} value={s}>{MWST_LABELS[s]}</option>)}
                </Select>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Abgerechnet" htmlFor={`wv-pi-${i}`}>
                  <Select id={`wv-pi-${i}`} value={p.intervall}
                          onChange={e => setPos(i, { intervall: e.target.value as WartungsIntervall })} className="w-44">
                    {INTERVALLE.map(iv => <option key={iv} value={iv}>{WARTUNGS_INTERVALL_LABELS[iv]}</option>)}
                  </Select>
                </Field>
                {p.intervall !== 'monatlich' && (
                  <Field label="Fällig im Monat" htmlFor={`wv-pa-${i}`}
                         hint={p.intervall === 'jahr' ? 'Einmal im Jahr, in diesem Monat.' : 'Erster Fälligkeitsmonat; danach im Takt.'}>
                    <Select id={`wv-pa-${i}`} value={p.ankerMonat}
                            onChange={e => setPos(i, { ankerMonat: e.target.value })} className="w-44">
                      <option value="">Monat nach Beginn</option>
                      {MONATE.map((m, idx) => <option key={m} value={idx + 1}>{m}</option>)}
                    </Select>
                  </Field>
                )}
                {positionen.length > 1 && (
                  <Button variant="secondary" size="sm" className="ml-auto"
                          onClick={() => setPositionen(ps => ps.filter((_, idx) => idx !== i))}>
                    Entfernen
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setPositionen(ps => [...ps, leerePosition()])}>
          + Position
        </Button>
      </div>

      <Field label="Notiz (intern)" htmlFor="wv-notiz">
        <Input id="wv-notiz" value={notiz} onChange={e => setNotiz(e.target.value)} className="w-full" />
      </Field>

      {fehler && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{fehler}</p>}

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="secondary" onClick={onFertig}>Abbrechen</Button>
        <Button loading={speichern.isPending} onClick={() => { setFehler(null); speichern.mutate() }}>
          {bearbeite ? 'Speichern' : 'Vertrag anlegen'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Monatslauf-Dialog
// ---------------------------------------------------------------------------

function LaufDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const vorschau = useQuery({
    queryKey: ['wartungsvertraege', 'lauf-vorschau'],
    queryFn:  () => wartungsvertragApi.lauf(true),
    enabled:  open,
    staleTime: 0,
  })
  const ausfuehren = useMutation({
    mutationFn: () => wartungsvertragApi.lauf(false),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wartungsvertraege'] })
      onClose()
    },
  })
  const eintraege = vorschau.data?.eintraege ?? []
  const summe     = eintraege.reduce((s, e) => s + e.betragCent, 0)

  return (
    <Modal open={open} onClose={onClose} title="Monatslauf" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          Die Kassa startet den Lauf zum Monatswechsel selbst. Hier siehst du vorab, welche Wartungslieferscheine
          noch fehlen, und kannst sie sofort erzeugen.
        </p>
        {vorschau.isLoading ? (
          <p className="py-6 text-center text-sm text-ink-subtle">Wird berechnet…</p>
        ) : eintraege.length === 0 ? (
          <p className="rounded-md bg-panel-2 px-3 py-6 text-center text-sm text-ink-muted">Alles auf dem aktuellen Stand — es fehlt kein Lieferschein.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-ink-muted">
                <th className="pb-1.5 text-left font-medium">Vertrag</th>
                <th className="pb-1.5 text-left font-medium">Monat</th>
                <th className="pb-1.5 text-center font-medium">Positionen</th>
                <th className="pb-1.5 text-right font-medium">Betrag</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {eintraege.map(e => (
                <tr key={`${e.vertragId}-${e.periode}`}>
                  <td className="py-1.5 font-mono">{vertragNr(e.vertragNummer)}</td>
                  <td className="py-1.5">{periodeText(e.periode)}</td>
                  <td className="py-1.5 text-center text-ink-muted">{e.positionen}</td>
                  <td className="py-1.5 text-right font-mono">{formatPreis(e.betragCent)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line-strong">
                <td colSpan={3} className="pt-2 pr-2 text-right font-bold">{eintraege.length} Lieferschein{eintraege.length === 1 ? '' : 'e'}</td>
                <td className="pt-2 text-right font-mono font-bold">{formatPreis(summe)}</td>
              </tr>
            </tfoot>
          </table>
        )}
        {ausfuehren.isError && <p className="text-sm text-red-600" role="alert">{fehlerText(ausfuehren.error)}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="secondary" onClick={onClose}>Schließen</Button>
          <Button disabled={eintraege.length === 0} loading={ausfuehren.isPending} onClick={() => ausfuehren.mutate()}>
            Lieferscheine jetzt erzeugen
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

type Reiter = 'vertraege' | 'verrechnung'

export function WartungsvertraegePage() {
  const qc       = useQueryClient()
  const auth     = getAuth()
  const identity = getKasseIdentity()!
  const [reiter, setReiter]       = useState<Reiter>('vertraege')
  const [bearbeiten, setBearbeiten] = useState<WartungsvertragResponse | 'neu' | null>(null)
  const [laufOffen, setLaufOffen] = useState(false)
  const [nurAktive, setNurAktive] = useState(true)
  const [rechnung, setRechnung]   = useState<SammelrechnungResponse | null>(null)

  const vertraege = useQuery({ queryKey: ['wartungsvertraege', 'liste'], queryFn: () => wartungsvertragApi.list() })
  const faellig   = useQuery({ queryKey: ['wartungsvertraege', 'faellig'], queryFn: () => wartungsvertragApi.faelligeRechnungen() })

  const abrechnen = useMutation({
    mutationFn: (id: string) => wartungsvertragApi.abrechnen(id),
    onSuccess: (sr) => {
      void qc.invalidateQueries({ queryKey: ['wartungsvertraege'] })
      setRechnung(sr)
    },
  })

  const sichtbar = useMemo(
    () => (vertraege.data ?? []).filter(v => !nurAktive || v.status === 'aktiv'),
    [vertraege.data, nurAktive],
  )
  const faelligListe = faellig.data ?? []

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Wartungsverträge</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setLaufOffen(true)}>Monatslauf</Button>
          <Button onClick={() => setBearbeiten('neu')}>Neuer Vertrag</Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {([['vertraege', 'Verträge'], ['verrechnung', `Zur Verrechnung${faelligListe.length ? ` (${faelligListe.length})` : ''}`]] as Array<[Reiter, string]>).map(([key, label]) => (
          <button
            key={key} type="button" onClick={() => setReiter(key)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
              reiter === key ? 'bg-brand-600 border-brand-600 text-white' : 'bg-panel border-line-strong text-ink-muted hover:border-brand-400'
            }`}
          >
            {label}
          </button>
        ))}
        {reiter === 'vertraege' && (
          <label className="ml-auto flex items-center gap-2 text-sm text-ink-muted">
            <input type="checkbox" className="rounded" checked={nurAktive} onChange={e => setNurAktive(e.target.checked)} />
            nur aktive
          </label>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
        {reiter === 'vertraege' ? (
          vertraege.isLoading ? (
            <p className="py-12 text-center text-sm text-ink-subtle">Wird geladen…</p>
          ) : sichtbar.length === 0 ? (
            <div className="py-16 text-center text-ink-subtle">
              <p className="mb-3 text-4xl">🔧</p>
              <p className="text-sm font-medium">Keine Wartungsverträge</p>
              <p className="mt-1 text-xs">Lege mit „Neuer Vertrag" den ersten an.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-panel-2">
                <tr>
                  {['Nr.', 'Kunde', 'Bezeichnung', 'Rechnung', 'Status', 'Offen'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sichtbar.map(v => (
                  <tr key={v.id} className="cursor-pointer transition hover:bg-panel-2" onClick={() => setBearbeiten(v)}>
                    <td className="px-4 py-3 font-mono font-medium text-ink">{vertragNr(v.nummer)}</td>
                    <td className="px-4 py-3 text-ink">{v.kunde?.bezeichnung ?? '—'}</td>
                    <td className="px-4 py-3 text-ink-muted">{v.bezeichnung}</td>
                    <td className="px-4 py-3 text-ink-muted">{WARTUNGS_INTERVALL_LABELS[v.rechnungsIntervall]}</td>
                    <td className="px-4 py-3 text-ink-muted">{WARTUNGSVERTRAG_STATUS_LABELS[v.status]}</td>
                    <td className="px-4 py-3 text-ink-muted">{v.offeneLieferscheine > 0 ? `${v.offeneLieferscheine} Lieferschein${v.offeneLieferscheine === 1 ? '' : 'e'}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : faellig.isLoading ? (
          <p className="py-12 text-center text-sm text-ink-subtle">Wird geladen…</p>
        ) : faelligListe.length === 0 ? (
          <div className="py-16 text-center text-ink-subtle">
            <p className="mb-3 text-4xl">🧾</p>
            <p className="text-sm font-medium">Aktuell ist nichts zu verrechnen</p>
            <p className="mt-1 text-xs">Sobald ein Rechnungsblock abgeschlossen ist, erscheint der Vertrag hier.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-panel-2">
              <tr>
                {['Nr.', 'Kunde', 'Monate', 'Betrag', ''].map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {faelligListe.map(f => (
                <tr key={f.vertragId}>
                  <td className="px-4 py-3 font-mono font-medium text-ink">{vertragNr(f.vertragNummer)}</td>
                  <td className="px-4 py-3 text-ink">{f.kunde?.bezeichnung ?? '—'}</td>
                  <td className="px-4 py-3 text-ink-muted">{f.perioden.map(periodeText).join(', ')}</td>
                  <td className="px-4 py-3 font-mono font-semibold text-ink">{formatPreis(f.betragCent)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" loading={abrechnen.isPending && abrechnen.variables === f.vertragId}
                            onClick={() => abrechnen.mutate(f.vertragId)}>
                      Sammelrechnung erstellen
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {abrechnen.isError && <p className="mt-3 text-sm text-red-600" role="alert">{fehlerText(abrechnen.error)}</p>}

      <Modal
        open={bearbeiten !== null}
        onClose={() => setBearbeiten(null)}
        title={bearbeiten && bearbeiten !== 'neu' ? `Wartungsvertrag ${vertragNr(bearbeiten.nummer)}` : 'Neuer Wartungsvertrag'}
        size="lg"
      >
        {bearbeiten !== null && (
          <VertragFormular vertrag={bearbeiten === 'neu' ? null : bearbeiten} onFertig={() => setBearbeiten(null)} />
        )}
      </Modal>

      <LaufDialog open={laufOffen} onClose={() => setLaufOffen(false)} />

      <AusgabeDialog
        open={rechnung !== null}
        onClose={() => setRechnung(null)}
        titel={rechnung ? `Rechnung SR-${String(rechnung.nummer).padStart(4, '0')} ausgeben` : 'Ausgabe wählen'}
        beschreibung="Der Bon zeigt Positionen mit Preisen, USt-Aufteilung und Gesamtbetrag."
        {...(rechnung?.kunde?.email ? { mailVorschlag: rechnung.kunde.email } : {})}
        onAusgabe={async (ziel) => {
          if (!rechnung) return
          switch (ziel.art) {
            case 'bon':     await sammelrechnungApi.drucken(rechnung.id, identity.kasseId); break
            case 'drucker': await sammelrechnungApi.drucken(rechnung.id, identity.kasseId, ziel.druckerId); break
            case 'mail':    await sammelrechnungApi.email(rechnung.id, ziel.empfaenger); break
            case 'a4':
              if (auth) druckeSammelrechnung(rechnung, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
              break
            case 'keine': break
          }
        }}
      />
    </div>
  )
}
