import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  TICKET_ANZEIGE_STATUS_LABELS,
  ticketTitel,
  type TicketAdmin,
  type TicketEventDetail,
} from '@kassa/shared'
import { oeffneTicketsPdf, ticketingApi } from '../../lib/api'
import { TICKET_STATUS_STIL, fehlerText } from '../../lib/ticketing'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Modal } from '../ui/Modal'
import { TicketAusstellenModal } from './TicketAusstellenModal'

const UHRZEIT = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' })

export function TicketListe({ event }: { event: TicketEventDetail }) {
  const qc = useQueryClient()
  const [suche,        setSuche]        = useState('')
  const [sucheAktiv,   setSucheAktiv]   = useState('')
  const [auswahl,      setAuswahl]      = useState<Set<string>>(new Set())
  const [ausstellen,   setAusstellen]   = useState(false)
  const [sendenIds,    setSendenIds]    = useState<string[] | null>(null)
  const [meldung,      setMeldung]      = useState<string | null>(null)

  // Suche leicht verzögert, damit nicht jeder Tastendruck eine Abfrage auslöst
  useEffect(() => {
    const t = setTimeout(() => setSucheAktiv(suche.trim()), 300)
    return () => clearTimeout(t)
  }, [suche])

  const { data: liste = [], isLoading } = useQuery({
    queryKey: ['ticket-liste', event.id, sucheAktiv],
    queryFn:  () => ticketingApi.tickets(event.id, sucheAktiv || undefined),
    refetchInterval: 10_000,
  })

  const aktualisieren = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['ticket-liste', event.id] }),
      qc.invalidateQueries({ queryKey: ['ticket-event', event.id] }),
      qc.invalidateQueries({ queryKey: ['ticket-events'] }),
    ])
  }

  const stornieren = useMutation({
    mutationFn: ticketingApi.stornieren,
    onSuccess:  () => aktualisieren(),
    onError:    (err) => setMeldung(fehlerText(err)),
  })

  const ausgewaehlt = useMemo(() => liste.filter(t => auswahl.has(t.id)), [liste, auswahl])
  const alleGewaehlt = liste.length > 0 && ausgewaehlt.length === liste.length

  function umschalten(id: string) {
    setAuswahl(prev => {
      const neu = new Set(prev)
      if (neu.has(id)) neu.delete(id); else neu.add(id)
      return neu
    })
  }

  async function linkKopieren(t: TicketAdmin) {
    if (!t.url) return
    await navigator.clipboard.writeText(t.url)
    setMeldung(`Link zu ${t.code} kopiert`)
    setTimeout(() => setMeldung(null), 2000)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[14rem] flex-1">
          <Input value={suche} onChange={e => setSuche(e.target.value)} placeholder="Suche: Code, Name, E-Mail, Rolle" />
        </div>
        {ausgewaehlt.length > 0 && (
          <>
            <Button size="sm" variant="secondary" onClick={() => void oeffneTicketsPdf(ausgewaehlt.map(t => t.id))}>
              PDF ({ausgewaehlt.length})
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setSendenIds(ausgewaehlt.map(t => t.id))}>
              Senden ({ausgewaehlt.length})
            </Button>
          </>
        )}
        <Button size="sm" onClick={() => setAusstellen(true)} disabled={event.status === 'abgesagt'}>
          + Tickets ausstellen
        </Button>
      </div>

      {meldung && <p className="text-sm text-ink-muted">{meldung}</p>}

      {isLoading ? (
        <p className="text-sm text-ink-muted">Lädt…</p>
      ) : liste.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong py-10 text-center text-sm text-ink-muted">
          {sucheAktiv ? 'Keine Treffer.' : 'Noch keine Tickets für dieses Event.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-muted">
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={alleGewaehlt} aria-label="Alle auswählen"
                    onChange={() => setAuswahl(alleGewaehlt ? new Set() : new Set(liste.map(t => t.id)))} />
                </th>
                <th className="px-3 py-2">Ticket</th>
                <th className="px-3 py-2">Band / Alter</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Einlass</th>
                <th className="px-3 py-2 text-right">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {liste.map(t => (
                <tr key={t.id} className="border-b border-line last:border-0 align-top">
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={auswahl.has(t.id)} onChange={() => umschalten(t.id)} aria-label={`Ticket ${t.code} auswählen`} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{ticketTitel(t)}</div>
                    {t.name && <div className="text-xs text-ink-muted">{t.name}</div>}
                    <div className="font-mono text-[11px] text-ink-subtle">{t.code}</div>
                  </td>
                  <td className="px-3 py-2">
                    {t.band ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="rounded-full px-2 py-0.5 text-[11px] font-bold text-white" style={{ background: t.band.farbe }}>
                          {t.band.bezeichnung}
                        </span>
                        <span className="text-xs text-ink-muted">{t.alter} J.</span>
                      </span>
                    ) : <span className="text-xs text-ink-subtle">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TICKET_STATUS_STIL[t.anzeigeStatus]}`}>
                      {TICKET_ANZEIGE_STATUS_LABELS[t.anzeigeStatus]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted tabular-nums">
                    {t.ersterEinlassAt ? UHRZEIT.format(new Date(t.ersterEinlassAt)) : '—'}
                    {t.typ === 'mehrfach' && t.einlassAnzahl > 0 && <div>{t.einlassAnzahl}× drin</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs font-medium">
                      <button type="button" className="text-brand-600 hover:underline" onClick={() => void oeffneTicketsPdf([t.id])}>PDF</button>
                      <button type="button" className="text-brand-600 hover:underline" onClick={() => setSendenIds([t.id])}>Senden</button>
                      {t.url && <button type="button" className="text-brand-600 hover:underline" onClick={() => void linkKopieren(t)}>Link</button>}
                      {t.status !== 'storniert' && (
                        <button
                          type="button" className="text-red-600 hover:underline"
                          onClick={() => { if (window.confirm(`Ticket ${t.code} stornieren? Es wird am Einlass dann abgewiesen.`)) stornieren.mutate(t.id) }}
                        >
                          Stornieren
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TicketAusstellenModal event={event} offen={ausstellen} onClose={() => setAusstellen(false)} onFertig={aktualisieren} />
      <SendenModal
        ids={sendenIds}
        vorschlag={sendenIds?.length === 1 ? liste.find(t => t.id === sendenIds[0])?.email ?? '' : ''}
        onClose={() => setSendenIds(null)}
      />
    </div>
  )
}

function SendenModal({ ids, vorschlag, onClose }: { ids: string[] | null; vorschlag: string; onClose: () => void }) {
  const [email,    setEmail]    = useState('')
  const [ergebnis, setErgebnis] = useState<{ erfolgreich: boolean; fehler?: string } | null>(null)

  useEffect(() => { if (ids) { setEmail(vorschlag); setErgebnis(null) } }, [ids, vorschlag])

  const senden = useMutation({
    mutationFn: () => ticketingApi.senden(ids ?? [], email.trim()),
    onSuccess:  setErgebnis,
    onError:    (err) => setErgebnis({ erfolgreich: false, fehler: fehlerText(err) }),
  })

  return (
    <Modal open={ids !== null} onClose={onClose} title={ids && ids.length > 1 ? `${ids.length} Tickets senden` : 'Ticket senden'} size="sm">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); senden.mutate() }}>
        <Input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="gast@example.at" autoFocus />
        {ergebnis && (
          ergebnis.erfolgreich
            ? <p className="text-sm text-green-700">✓ verschickt</p>
            : <p className="text-sm text-red-600">{ergebnis.fehler}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{ergebnis?.erfolgreich ? 'Schließen' : 'Abbrechen'}</Button>
          {!ergebnis?.erfolgreich && <Button type="submit" loading={senden.isPending}>Senden</Button>}
        </div>
      </form>
    </Modal>
  )
}
