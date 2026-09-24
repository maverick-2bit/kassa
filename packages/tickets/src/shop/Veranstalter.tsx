import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { eventZeitText, type ShopVeranstalter } from '@kassa/shared'
import { Karte, RechtsLinks, Seite, euro } from './gemeinsam'

type Laden = { art: 'laedt' } | { art: 'fehlt' } | { art: 'fehler' } | { art: 'da'; v: ShopVeranstalter }

/** Alle kommenden Events eines Veranstalters — der Link für Website und Social Media. */
export function Veranstalter() {
  const { mandantId = '' } = useParams()
  const [zustand, setZustand] = useState<Laden>({ art: 'laedt' })

  useEffect(() => {
    let aktiv = true
    fetch(`/api/ticketshop/veranstalter/${encodeURIComponent(mandantId)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!aktiv) return
        if (res.status === 404) { setZustand({ art: 'fehlt' }); return }
        if (!res.ok) throw new Error(String(res.status))
        const v = await res.json() as ShopVeranstalter
        setZustand({ art: 'da', v })
        document.title = `Tickets · ${v.firmenname}`
      })
      .catch(() => { if (aktiv) setZustand({ art: 'fehler' }) })
    return () => { aktiv = false }
  }, [mandantId])

  if (zustand.art !== 'da') {
    return (
      <Seite>
        <Karte>
          <p className="p-10 text-center text-ink-muted">
            {zustand.art === 'laedt' && 'Wird geladen…'}
            {zustand.art === 'fehlt' && 'Diese Seite gibt es nicht.'}
            {zustand.art === 'fehler' && 'Die Seite konnte nicht geladen werden — bitte neu laden.'}
          </p>
        </Karte>
      </Seite>
    )
  }

  const { v } = zustand
  return (
    <Seite>
      <h1 className="mb-4 text-2xl font-bold">{v.firmenname}</h1>
      {v.events.length === 0 ? (
        <Karte><p className="p-8 text-center text-ink-muted">Aktuell sind keine Veranstaltungen im Vorverkauf.</p></Karte>
      ) : (
        <ul className="space-y-3">
          {v.events.map(e => (
            <li key={e.id}>
              <Link to={`/e/${e.id}`} className="block overflow-hidden rounded-2xl border border-line bg-white shadow-sm hover:shadow-md">
                <div className="bg-kopf px-5 py-4 text-white">
                  <p className="text-lg font-bold leading-tight">{e.titel}</p>
                  <p className="mt-1 text-sm">📅 {eventZeitText(e.beginn)} · 📍 {e.ort}</p>
                </div>
                <div className="flex items-center justify-between gap-3 px-5 py-3">
                  <span className="text-sm text-ink-muted">{e.hinweis ?? ''}</span>
                  <span className="shrink-0 text-sm font-semibold">
                    {e.ausverkauft ? 'Ausverkauft' : e.abPreisCent === null ? 'Tickets' : e.abPreisCent === 0 ? 'Kostenlos' : `ab ${euro(e.abPreisCent)}`} →
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <RechtsLinks rechtliches={v.rechtliches} verkaeufer={v.firmenname} />
    </Seite>
  )
}
