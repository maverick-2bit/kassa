import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { ShopBestellung } from '@kassa/shared'
import { EventKopf, Karte, Seite, euro, knopfHaupt, knopfLeise } from './gemeinsam'

type Laden = { art: 'laedt' } | { art: 'fehlt' } | { art: 'fehler' } | { art: 'da'; b: ShopBestellung }

/** So lange wird nach der Rückkehr von Stripe schnell nachgefragt, danach gemächlich */
const SCHNELL_MS = 3 * 60_000

/**
 * Bestellseite — Rücksprung von Stripe. Zeigt den Stand, bis der Webhook die
 * Zahlung bestätigt hat, danach die Tickets. Mit ?abbruch=1 (Käufer hat auf der
 * Bezahlseite abgebrochen) werden die reservierten Tickets sofort freigegeben.
 */
export function BestellSeite() {
  const { bestellungId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const [zustand, setZustand] = useState<Laden>({ art: 'laedt' })
  const start = useRef(Date.now())
  const abbruchGesendet = useRef(false)

  const laden = useCallback(async (): Promise<ShopBestellung | null> => {
    try {
      const url = `/api/ticketshop/bestellungen/${encodeURIComponent(bestellungId)}`
      const res = await fetch(url, { cache: 'no-store' })
      if (res.status === 404) { setZustand({ art: 'fehlt' }); return null }
      if (!res.ok) throw new Error(String(res.status))
      const b = await res.json() as ShopBestellung
      setZustand({ art: 'da', b })
      return b
    } catch {
      setZustand(z => z.art === 'da' ? z : { art: 'fehler' })
      return null
    }
  }, [bestellungId])

  useEffect(() => {
    let aktiv = true
    let timer: ReturnType<typeof setTimeout> | undefined

    async function runde() {
      let b: ShopBestellung | null
      if (params.get('abbruch') === '1' && !abbruchGesendet.current) {
        abbruchGesendet.current = true
        const res = await fetch(`/api/ticketshop/bestellungen/${encodeURIComponent(bestellungId)}/abbrechen`, { method: 'POST' })
          .catch(() => null)
        b = res?.ok ? await res.json() as ShopBestellung : await laden()
        if (b && aktiv) setZustand({ art: 'da', b })
        setParams({}, { replace: true })
      } else {
        b = await laden()
      }
      if (!aktiv) return
      if (!b || b.status === 'zahlung') {
        const langsam = Date.now() - start.current > SCHNELL_MS
        timer = setTimeout(() => void runde(), langsam ? 10_000 : 2_000)
      }
    }
    void runde()
    return () => { aktiv = false; if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bestellungId])

  const titel = zustand.art === 'da' ? zustand.b.event.titel : null
  useEffect(() => { if (titel) document.title = `Bestellung · ${titel}` }, [titel])

  if (zustand.art !== 'da') {
    return (
      <Seite>
        <Karte>
          <p className="p-10 text-center text-ink-muted">
            {zustand.art === 'laedt' && 'Wird geladen…'}
            {zustand.art === 'fehlt' && 'Diese Bestellung gibt es nicht.'}
            {zustand.art === 'fehler' && 'Die Bestellung konnte nicht geladen werden — bitte neu laden.'}
          </p>
        </Karte>
      </Seite>
    )
  }

  const b = zustand.b

  return (
    <Seite>
      <Karte>
        <EventKopf titel={b.event.titel} beginn={b.event.beginn} ort={b.event.ort} adresse={b.event.adresse} />
        <div className="px-6 py-5 sm:px-7">
          {b.status === 'zahlung' && (
            <div className="text-center" role="status">
              <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-line border-t-kopf" aria-hidden />
              <p className="mt-3 text-lg font-semibold">Zahlung wird bestätigt …</p>
              <p className="mt-1 text-sm text-ink-muted">
                Das dauert meist nur wenige Sekunden. Danach erscheinen hier die Tickets.
              </p>
            </div>
          )}

          {b.status === 'bezahlt' && (
            <>
              <p className="text-lg font-bold text-green-800">✓ Vielen Dank — Ihre Tickets</p>
              <p className="mt-1 text-sm text-ink-muted">
                {b.emailStatus === 'gesendet' && <>Die Tickets sind auch per E-Mail an <span className="whitespace-nowrap">{b.emailMaskiert}</span> unterwegs.</>}
                {b.emailStatus === 'ausstehend' && <>Die Tickets gehen gleich per E-Mail an <span className="whitespace-nowrap">{b.emailMaskiert}</span>.</>}
                {b.emailStatus === 'fehlgeschlagen' && (
                  <>Die E-Mail konnte gerade nicht verschickt werden — bitte diese Seite aufheben oder die Tickets als PDF speichern.</>
                )}
              </p>
              <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
                {b.tickets.map(t => (
                  <li key={t.code} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{t.bezeichnung} (1 Person)</p>
                      {t.name && <p className="text-sm text-ink-muted">{t.name}</p>}
                    </div>
                    <Link to={`/t/${t.code}`} className={knopfLeise}>Ticket öffnen</Link>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap gap-2">
                <a className={knopfLeise} href={`/api/ticketshop/bestellungen/${b.id}/pdf`}><span aria-hidden>📄</span> Alle Tickets als PDF</a>
                {b.belegNummer !== null && (
                  <a className={knopfLeise} href={`/api/ticketshop/bestellungen/${b.id}/rechnung`} target="_blank" rel="noreferrer">
                    <span aria-hidden>🧾</span> Rechnung (Beleg Nr. {b.belegNummer})
                  </a>
                )}
              </div>
              <p className="mt-4 rounded-xl border border-[#fcd34d] bg-[#fef3c7] px-4 py-3 text-sm text-[#78350f]">
                Jedes Ticket gilt für eine Person und wird am Einlass einmal gescannt. Tickets für andere Gäste
                einfach über „Ticket öffnen" weiterleiten.
              </p>
            </>
          )}

          {(b.status === 'abgebrochen' || b.status === 'abgelaufen') && (
            <div className="text-center">
              <p className="text-lg font-semibold">
                {b.status === 'abgebrochen' ? 'Zahlung abgebrochen' : 'Die Reservierung ist abgelaufen'}
              </p>
              <p className="mt-1 text-sm text-ink-muted">Es wurde nichts abgebucht, die Tickets sind wieder freigegeben.</p>
              <Link to={`/e/${b.eventId}`} className={`${knopfHaupt} mt-4`}>Erneut Tickets wählen</Link>
            </div>
          )}

          <ul className="mt-5 space-y-1 border-t border-line pt-4 text-sm text-ink-muted">
            {b.positionen.map((p, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>{p.menge} × {p.bezeichnung}</span>
                <span className="tabular-nums">{p.preisCent === 0 ? 'kostenlos' : euro(p.preisCent * p.menge)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 font-semibold text-ink"><span>Gesamt</span><span className="tabular-nums">{euro(b.summeCent)}</span></li>
          </ul>
        </div>
      </Karte>
    </Seite>
  )
}
