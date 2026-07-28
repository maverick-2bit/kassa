/**
 * Beleg-Archiv — Verlauf des Zweigs Angebot → Lieferschein → Rechnung.
 *
 * Drei Reiter mit je einer Liste, Detailansicht und dem einheitlichen
 * Ausgabe-Dialog zum Nachdrucken/Versenden. Bewusst read-only: hier wird nichts
 * erzeugt oder geändert — das passiert auf der Angebote-Seite bzw. an der Kasse.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  AngebotResponse, AngebotStatus, LiferscheinResponse, LiferscheinStatus, SammelrechnungResponse,
} from '@kassa/shared'
import { ANGEBOT_STATUS_LABELS, LIEFERSCHEIN_STATUS_LABELS } from '@kassa/shared'
import { angebotApi, lieferscheinApi, sammelrechnungApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { formatPreis } from '../lib/format'
import { Modal } from '../components/ui/Modal'
import { AusgabeDialog } from '../components/AusgabeDialog'
import { druckeAngebot, druckeLiferschein, druckeSammelrechnung } from '../lib/rechnung'

type Reiter = 'angebote' | 'lieferscheine' | 'rechnungen'

const REITER: { key: Reiter; label: string }[] = [
  { key: 'angebote',      label: 'Angebote' },
  { key: 'lieferscheine', label: 'Lieferscheine' },
  { key: 'rechnungen',    label: 'Rechnungen' },
]

/** Detail- bzw. Ausgabe-Ziel (ein Eintrag aus einem der drei Reiter) */
type Eintrag =
  | { art: 'angebot';      a: AngebotResponse }
  | { art: 'lieferschein'; ls: LiferscheinResponse }
  | { art: 'rechnung';     sr: SammelrechnungResponse }

function nummerLabel(e: Eintrag): string {
  if (e.art === 'angebot')      return `A-${String(e.a.nummer).padStart(4, '0')}`
  if (e.art === 'lieferschein') return `L-${String(e.ls.nummer).padStart(4, '0')}`
  return `SR-${String(e.sr.nummer).padStart(4, '0')}`
}

function datumVon(e: Eintrag): string {
  return e.art === 'angebot' ? e.a.datum : e.art === 'lieferschein' ? e.ls.datum : e.sr.datum
}

function summeCent(e: Eintrag): number {
  if (e.art === 'rechnung') return e.sr.gesamtbetragCent
  const pos = e.art === 'angebot' ? e.a.positionen : e.ls.positionen
  return pos.reduce((s, p) => s + p.einzelpreisBreutto * p.menge, 0)
}

export function BelegArchivPage() {
  const auth     = getAuth()
  const identity = getKasseIdentity()
  const [reiter, setReiter] = useState<Reiter>('rechnungen')
  const [suche,  setSuche]  = useState('')
  const [detail, setDetail] = useState<Eintrag | null>(null)
  const [ausgabe, setAusgabe] = useState<Eintrag | null>(null)

  const angebote = useQuery({
    queryKey: ['archiv-angebote'],
    queryFn:  () => angebotApi.list({}),
    enabled:  reiter === 'angebote',
  })
  const lieferscheine = useQuery({
    queryKey: ['archiv-lieferscheine'],
    queryFn:  () => lieferscheinApi.list({ limit: 200 }),
    enabled:  reiter === 'lieferscheine',
  })
  const rechnungen = useQuery({
    queryKey: ['archiv-rechnungen'],
    queryFn:  () => sammelrechnungApi.list({ limit: 200 }),
    enabled:  reiter === 'rechnungen',
  })

  const eintraege: Eintrag[] = useMemo(() => {
    if (reiter === 'angebote')      return (angebote.data      ?? []).map(a  => ({ art: 'angebot'      as const, a }))
    if (reiter === 'lieferscheine') return (lieferscheine.data ?? []).map(ls => ({ art: 'lieferschein' as const, ls }))
    return (rechnungen.data ?? []).map(sr => ({ art: 'rechnung' as const, sr }))
  }, [reiter, angebote.data, lieferscheine.data, rechnungen.data])

  const laedt = reiter === 'angebote' ? angebote.isLoading
    : reiter === 'lieferscheine' ? lieferscheine.isLoading : rechnungen.isLoading

  const gefiltert = useMemo(() => {
    const q = suche.trim().toLowerCase()
    if (!q) return eintraege
    return eintraege.filter(e => {
      const kunde = e.art === 'angebot' ? e.a.kunde?.bezeichnung
        : e.art === 'lieferschein' ? e.ls.kunde?.bezeichnung : e.sr.kunde?.bezeichnung
      return nummerLabel(e).toLowerCase().includes(q) || (kunde ?? '').toLowerCase().includes(q)
    })
  }, [eintraege, suche])

  const statusBadge = (e: Eintrag) => {
    if (e.art === 'angebot') {
      return <span className="rounded-full bg-panel-2 px-2 py-0.5 text-xs text-ink-muted">
        {ANGEBOT_STATUS_LABELS[e.a.status as AngebotStatus]}
      </span>
    }
    if (e.art === 'lieferschein') {
      return <span className="rounded-full bg-panel-2 px-2 py-0.5 text-xs text-ink-muted">
        {LIEFERSCHEIN_STATUS_LABELS[e.ls.status as LiferscheinStatus]}
      </span>
    }
    return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">abgerechnet</span>
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div>
        <h1 className="text-lg font-black text-ink">Beleg-Archiv</h1>
        <p className="text-sm text-ink-muted">
          Verlauf des Zweigs Angebot → Lieferschein → Rechnung: ansehen, nachdrucken, versenden.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line overflow-hidden">
          {REITER.map(r => (
            <button
              key={r.key}
              type="button"
              onClick={() => setReiter(r.key)}
              className={`px-4 py-2 text-sm font-medium transition ${
                reiter === r.key ? 'bg-brand-600 text-white' : 'bg-panel text-ink hover:bg-panel-2'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <input
          value={suche}
          onChange={e => setSuche(e.target.value)}
          placeholder="Nummer oder Kunde suchen …"
          className="flex-1 min-w-[12rem] rounded-md border border-line-strong px-3 py-2 text-sm"
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-panel-2 border-b border-line">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold text-ink-muted uppercase">Nr.</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-ink-muted uppercase">Datum</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-ink-muted uppercase">Kunde</th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-ink-muted uppercase">Betrag</th>
              <th className="px-4 py-2 text-center text-xs font-semibold text-ink-muted uppercase">Status</th>
              <th className="px-4 py-2 w-28" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {laedt && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-subtle">Wird geladen…</td></tr>
            )}
            {!laedt && gefiltert.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-subtle">
                {suche ? 'Nichts gefunden.' : 'Noch keine Einträge.'}
              </td></tr>
            )}
            {gefiltert.map((e, i) => {
              const kunde = e.art === 'angebot' ? e.a.kunde?.bezeichnung
                : e.art === 'lieferschein' ? e.ls.kunde?.bezeichnung : e.sr.kunde?.bezeichnung
              return (
                <tr key={i} className="hover:bg-panel-2 cursor-pointer" onClick={() => setDetail(e)}>
                  <td className="px-4 py-2 font-mono font-medium text-ink">{nummerLabel(e)}</td>
                  <td className="px-4 py-2 text-ink-muted">{new Date(datumVon(e)).toLocaleDateString('de-AT')}</td>
                  <td className="px-4 py-2 text-ink">{kunde ?? <span className="text-ink-subtle">–</span>}</td>
                  <td className="px-4 py-2 text-right font-mono">{formatPreis(summeCent(e))}</td>
                  <td className="px-4 py-2 text-center">{statusBadge(e)}</td>
                  <td className="px-4 py-2 text-right" onClick={ev => ev.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => setAusgabe(e)}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      🖨 Ausgabe …
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Detail: Positionen des gewählten Belegs */}
      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail ? `${nummerLabel(detail)} — Positionen` : ''}
        size="lg"
      >
        {detail && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-muted">{new Date(datumVon(detail)).toLocaleString('de-AT')}</span>
              <span className="font-bold text-ink">{formatPreis(summeCent(detail))}</span>
            </div>
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className="py-1.5 text-left text-xs font-semibold text-ink-muted uppercase">Position</th>
                  <th className="py-1.5 text-right text-xs font-semibold text-ink-muted uppercase">Menge</th>
                  <th className="py-1.5 text-right text-xs font-semibold text-ink-muted uppercase">Einzel</th>
                  <th className="py-1.5 text-right text-xs font-semibold text-ink-muted uppercase">Gesamt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(detail.art === 'rechnung'
                  ? detail.sr.lieferscheine.flatMap(ls => ls.positionen)
                  : detail.art === 'angebot' ? detail.a.positionen : detail.ls.positionen
                ).map((p, idx) => (
                  <tr key={idx}>
                    <td className="py-1.5 text-ink">
                      {p.bezeichnung}
                      {p.seriennummern && p.seriennummern.length > 0 && (
                        <span className="block text-xs text-ink-subtle font-mono">
                          SN: {p.seriennummern.join(', ')}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right font-mono">{p.menge}</td>
                    <td className="py-1.5 text-right font-mono">{formatPreis(p.einzelpreisBreutto)}</td>
                    <td className="py-1.5 text-right font-mono font-semibold">
                      {formatPreis(p.einzelpreisBreutto * p.menge)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.art === 'rechnung' && detail.sr.lieferscheine.length > 0 && (
              <p className="text-xs text-ink-subtle">
                Enthält {detail.sr.lieferscheine.length} Lieferschein
                {detail.sr.lieferscheine.length === 1 ? '' : 'e'}:{' '}
                {detail.sr.lieferscheine.map(ls => `L-${String(ls.nummer).padStart(4, '0')}`).join(', ')}
              </p>
            )}
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => { setAusgabe(detail); setDetail(null) }}
                className="rounded-lg border border-line-strong px-3 py-2 text-sm font-medium text-ink hover:bg-panel-2"
              >
                🖨 Ausgabe …
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Einheitlicher Ausgabe-Dialog (nachdrucken / versenden) */}
      <AusgabeDialog
        open={ausgabe !== null}
        onClose={() => setAusgabe(null)}
        titel={ausgabe ? `${nummerLabel(ausgabe)} ausgeben` : 'Ausgabe wählen'}
        // Angebote kennen keinen Bon-/Mail-Endpoint — dort bleibt der A4-Weg
        {...(ausgabe?.art === 'angebot'
          ? { wege: { bon: false, weitereDrucker: false, mail: false, a4: true, ohne: true } }
          : {})}
        onAusgabe={async (ziel) => {
          if (!ausgabe) return
          if (ausgabe.art === 'angebot') {
            if (ziel.art === 'a4' && auth) {
              druckeAngebot(ausgabe.a, { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid })
            }
            return
          }
          const istLs = ausgabe.art === 'lieferschein'
          const id    = istLs ? ausgabe.ls.id : ausgabe.sr.id
          const api   = istLs ? lieferscheinApi : sammelrechnungApi
          switch (ziel.art) {
            case 'bon':
            case 'drucker': {
              if (!identity) throw new Error('Keine aktive Kasse — Druck braucht die Kassen-Zuordnung')
              await api.drucken(id, identity.kasseId, ziel.art === 'drucker' ? ziel.druckerId : undefined)
              break
            }
            case 'mail': await api.email(id, ziel.empfaenger); break
            case 'a4':
              if (auth) {
                const m = { firmenname: auth.mandant.firmenname, uid: auth.mandant.uid }
                if (istLs) druckeLiferschein(ausgabe.ls, m)
                else       druckeSammelrechnung(ausgabe.sr, m)
              }
              break
            case 'keine': break
          }
        }}
      />
    </div>
  )
}
