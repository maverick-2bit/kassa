import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  alterAm,
  wienerTag,
  type ShopBestellungAntwort,
  type ShopBestellungInput,
  type ShopEvent,
  type ShopTicketArt,
} from '@kassa/shared'
import { EventKopf, Karte, RechtsLinks, Seite, eingabe, euro, fehlerAus, knopfHaupt } from './gemeinsam'

type Laden = { art: 'laedt' } | { art: 'fehlt' } | { art: 'fehler' } | { art: 'da'; event: ShopEvent }

/** Angaben je Gast — das Band am Einlass hängt am Geburtsdatum des Gastes, nicht des Käufers */
interface GastEingabe { name: string; geburtsdatum: string }

const DATUM_ZEIT = new Intl.DateTimeFormat('de-AT', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna',
})

/** Eventseite mit Kaufformular: Tickets wählen → je Gast Geburtsdatum → Stripe. */
export function EventShop() {
  const { eventId = '' } = useParams()
  const [zustand, setZustand] = useState<Laden>({ art: 'laedt' })

  useEffect(() => {
    let aktiv = true
    fetch(`/api/ticketshop/events/${encodeURIComponent(eventId)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!aktiv) return
        if (res.status === 404) { setZustand({ art: 'fehlt' }); return }
        if (!res.ok) throw new Error(String(res.status))
        const event = await res.json() as ShopEvent
        setZustand({ art: 'da', event })
        document.title = `Tickets · ${event.titel}`
      })
      .catch(() => { if (aktiv) setZustand({ art: 'fehler' }) })
    return () => { aktiv = false }
  }, [eventId])

  if (zustand.art !== 'da') {
    return (
      <Seite>
        <Karte>
          <p className="p-10 text-center text-ink-muted">
            {zustand.art === 'laedt' && 'Wird geladen…'}
            {zustand.art === 'fehlt' && 'Diese Veranstaltung gibt es nicht (mehr).'}
            {zustand.art === 'fehler' && 'Die Seite konnte nicht geladen werden — bitte die Internetverbindung prüfen.'}
          </p>
        </Karte>
      </Seite>
    )
  }
  return <Kauf event={zustand.event} />
}

function artHinweis(a: ShopTicketArt): string | null {
  switch (a.status) {
    case 'ausverkauft': return 'Ausverkauft'
    case 'beendet':     return 'Verkauf beendet'
    case 'noch_nicht':  return a.verkaufAb ? `Verkauf ab ${DATUM_ZEIT.format(new Date(a.verkaufAb))}` : 'Noch nicht im Verkauf'
    default:
      return a.verfuegbar !== null && a.verfuegbar <= 10 ? `Nur noch ${a.verfuegbar} verfügbar` : null
  }
}

function Kauf({ event }: { event: ShopEvent }) {
  const navigate = useNavigate()
  const [mengen,  setMengen]  = useState<Record<string, number>>({})
  const [gaeste,  setGaeste]  = useState<Record<string, GastEingabe[]>>({})
  const [kaeufer, setKaeufer] = useState({ name: '', email: '', email2: '' })
  const [firma,   setFirma]   = useState<null | { firma: string; strasse: string; plz: string; ort: string; uid: string }>(null)
  const [zustimmung, setZustimmung] = useState(false)
  const [sendet,  setSendet]  = useState(false)
  const [fehler,  setFehler]  = useState<string | null>(null)
  const [geprueft, setGeprueft] = useState(false)

  const eventTag = wienerTag(event.beginn)
  const heute    = wienerTag(new Date())
  const kaufbar  = event.verkaufOffen

  const gewaehlt = useMemo(() => event.arten.flatMap(a =>
    Array.from({ length: mengen[a.id] ?? 0 }, (_, i) => ({ art: a, index: i, gast: gaeste[a.id]?.[i] ?? { name: '', geburtsdatum: '' } })),
  ), [event.arten, mengen, gaeste])
  const summe = gewaehlt.reduce((s, g) => s + g.art.preisCent, 0)

  function setzeMenge(a: ShopTicketArt, menge: number) {
    const max = Math.min(a.maxProBestellung, a.verfuegbar ?? Infinity)
    const neu = Math.max(0, Math.min(max, menge))
    setMengen(m => ({ ...m, [a.id]: neu }))
    setGaeste(g => {
      const liste = [...(g[a.id] ?? [])]
      while (liste.length < neu) liste.push({ name: '', geburtsdatum: '' })
      return { ...g, [a.id]: liste.slice(0, neu) }
    })
  }

  function setzeGast(artId: string, index: number, feld: keyof GastEingabe, wert: string) {
    setGaeste(g => {
      const liste = [...(g[artId] ?? [])]
      liste[index] = { ...(liste[index] ?? { name: '', geburtsdatum: '' }), [feld]: wert }
      return { ...g, [artId]: liste }
    })
  }

  /** Fehler je Gast (Anzeige am Feld) */
  function gastFehler(g: GastEingabe): { name?: string; geburtsdatum?: string } {
    const f: { name?: string; geburtsdatum?: string } = {}
    if (event.namePflicht && !g.name.trim()) f.name = 'Name angeben'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(g.geburtsdatum)) f.geburtsdatum = 'Geburtsdatum angeben'
    else if (g.geburtsdatum > heute) f.geburtsdatum = 'Liegt in der Zukunft'
    else if (event.mindestalter !== null && alterAm(g.geburtsdatum, eventTag) < event.mindestalter) {
      f.geburtsdatum = `Einlass erst ab ${event.mindestalter} Jahren`
    }
    return f
  }

  const emailOk  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(kaeufer.email.trim())
  const formularFehler = [
    ...gewaehlt.flatMap(g => Object.values(gastFehler(g.gast))),
    ...(kaeufer.name.trim() ? [] : ['Name']),
    ...(emailOk ? [] : ['E-Mail']),
    ...(kaeufer.email.trim().toLowerCase() === kaeufer.email2.trim().toLowerCase() ? [] : ['E-Mail-Wiederholung']),
    ...(firma && (!firma.firma.trim() || !firma.strasse.trim() || !firma.plz.trim() || !firma.ort.trim()) ? ['Rechnungsadresse'] : []),
    ...(zustimmung ? [] : ['Zustimmung']),
  ]

  async function absenden() {
    setGeprueft(true)
    setFehler(null)
    if (formularFehler.length > 0) { setFehler('Bitte die markierten Angaben ergänzen.'); return }
    const eingabeDaten: ShopBestellungInput = {
      eventId:  event.id,
      kaeufer:  { name: kaeufer.name.trim(), email: kaeufer.email.trim() },
      tickets:  gewaehlt.map(g => ({
        ticketArtId:  g.art.id,
        geburtsdatum: g.gast.geburtsdatum,
        ...(g.gast.name.trim() ? { name: g.gast.name.trim() } : {}),
      })),
      rechnung: firma
        ? { firma: firma.firma.trim(), strasse: firma.strasse.trim(), plz: firma.plz.trim(), ort: firma.ort.trim(), land: 'AT', ...(firma.uid.trim() ? { uid: firma.uid.trim() } : {}) }
        : null,
      agbAkzeptiert: true,
    }
    setSendet(true)
    try {
      const res = await fetch('/api/ticketshop/bestellungen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eingabeDaten),
      })
      if (!res.ok) { setFehler(await fehlerAus(res)); return }
      const antwort = await res.json() as ShopBestellungAntwort
      if (antwort.checkoutUrl) window.location.href = antwort.checkoutUrl
      else navigate(`/b/${antwort.bestellungId}`)
    } catch {
      setFehler('Keine Verbindung — bitte erneut versuchen.')
    } finally {
      setSendet(false)
    }
  }

  const r = event.rechtliches
  const zeigeFehler = (f?: string) => geprueft && f ? <p className="mt-1 text-sm text-red-600">{f}</p> : null

  return (
    <Seite>
      <Karte>
        <EventKopf titel={event.titel} beginn={event.beginn} ort={event.ort} adresse={event.adresse}
          hinweis={event.hinweis} test={event.status === 'test'} />
        {event.beschreibung && <p className="whitespace-pre-line px-6 pt-5 text-[15px] text-ink sm:px-7">{event.beschreibung}</p>}
        {event.mindestalter !== null && (
          <p className="px-6 pt-3 text-sm font-semibold text-ink sm:px-7">Einlass ab {event.mindestalter} Jahren · Ausweis mitnehmen</p>
        )}

        {!kaufbar && event.verkaufHinweis && (
          <p className="mx-6 mt-5 rounded-xl bg-gray-100 px-4 py-3 text-sm text-gray-700 sm:mx-7">{event.verkaufHinweis}</p>
        )}

        {/* Ticketarten */}
        <section className="px-6 pb-2 pt-5 sm:px-7" aria-label="Tickets">
          <h2 className="text-base font-bold">Tickets</h2>
          <ul className="mt-2 divide-y divide-line">
            {event.arten.map(a => {
              const menge = mengen[a.id] ?? 0
              const max = Math.min(a.maxProBestellung, a.verfuegbar ?? Infinity)
              const waehlbar = kaufbar && a.status === 'verfuegbar'
              const hinweis = artHinweis(a)
              return (
                <li key={a.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{a.bezeichnung}</p>
                    {a.beschreibung && <p className="text-sm text-ink-muted">{a.beschreibung}</p>}
                    <p className="text-sm">
                      <span className="font-semibold">{a.preisCent === 0 ? 'kostenlos' : euro(a.preisCent)}</span>
                      {hinweis && <span className={`ml-2 ${a.status === 'verfuegbar' ? 'text-amber-700' : 'text-ink-muted'}`}>{hinweis}</span>}
                    </p>
                  </div>
                  {waehlbar && (
                    <div className="flex items-center gap-2" role="group" aria-label={`Anzahl ${a.bezeichnung}`}>
                      <button type="button" aria-label={`${a.bezeichnung} weniger`} disabled={menge === 0}
                        onClick={() => setzeMenge(a, menge - 1)}
                        className="h-10 w-10 rounded-full border border-line text-xl font-bold disabled:opacity-30">−</button>
                      <span className="w-6 text-center text-lg font-bold tabular-nums">{menge}</span>
                      <button type="button" aria-label={`${a.bezeichnung} mehr`} disabled={menge >= max}
                        onClick={() => setzeMenge(a, menge + 1)}
                        className="h-10 w-10 rounded-full border border-line text-xl font-bold disabled:opacity-30">+</button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>

        {gewaehlt.length > 0 && (
          <form className="space-y-6 border-t border-line px-6 pb-6 pt-5 sm:px-7" noValidate
            onSubmit={(e) => { e.preventDefault(); void absenden() }}>

            <section aria-label="Angaben zu den Gästen">
              <h2 className="text-base font-bold">Angaben zu den Gästen</h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                Das Geburtsdatum bestimmt das Altersband am Einlass (Jugendschutz). Jedes Ticket gilt für eine Person.
              </p>
              <div className="mt-3 space-y-3">
                {gewaehlt.map(({ art, index, gast }, nr) => {
                  const f = gastFehler(gast)
                  return (
                    <fieldset key={`${art.id}-${index}`} className="rounded-xl border border-line p-3">
                      <legend className="px-1 text-sm font-semibold">Ticket {nr + 1} · {art.bezeichnung}</legend>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block text-sm">
                          <span className="text-ink-muted">Name{event.namePflicht ? '' : ' (optional)'}</span>
                          <input className={`${eingabe} mt-1`} value={gast.name} autoComplete="name"
                            onChange={e => setzeGast(art.id, index, 'name', e.target.value)} />
                          {zeigeFehler(f.name)}
                        </label>
                        <label className="block text-sm">
                          <span className="text-ink-muted">Geburtsdatum</span>
                          <input type="date" className={`${eingabe} mt-1`} value={gast.geburtsdatum} max={heute}
                            onChange={e => setzeGast(art.id, index, 'geburtsdatum', e.target.value)} />
                          {zeigeFehler(f.geburtsdatum)}
                        </label>
                      </div>
                    </fieldset>
                  )
                })}
              </div>
            </section>

            <section aria-label="Ihre Daten">
              <h2 className="text-base font-bold">Ihre Daten</h2>
              <p className="mt-0.5 text-sm text-ink-muted">An diese Adresse schicken wir die Tickets und den Beleg.</p>
              <div className="mt-3 grid gap-3">
                <label className="block text-sm">
                  <span className="text-ink-muted">Name</span>
                  <input className={`${eingabe} mt-1`} value={kaeufer.name} autoComplete="name"
                    onChange={e => setKaeufer(k => ({ ...k, name: e.target.value }))} />
                  {zeigeFehler(kaeufer.name.trim() ? undefined : 'Name angeben')}
                </label>
                <label className="block text-sm">
                  <span className="text-ink-muted">E-Mail</span>
                  <input type="email" className={`${eingabe} mt-1`} value={kaeufer.email} autoComplete="email" inputMode="email"
                    onChange={e => setKaeufer(k => ({ ...k, email: e.target.value }))} />
                  {zeigeFehler(emailOk ? undefined : 'Gültige E-Mail-Adresse angeben')}
                </label>
                <label className="block text-sm">
                  <span className="text-ink-muted">E-Mail wiederholen</span>
                  <input type="email" className={`${eingabe} mt-1`} value={kaeufer.email2} autoComplete="off" inputMode="email"
                    onChange={e => setKaeufer(k => ({ ...k, email2: e.target.value }))} />
                  {zeigeFehler(kaeufer.email.trim().toLowerCase() === kaeufer.email2.trim().toLowerCase() ? undefined : 'Die Adressen stimmen nicht überein')}
                </label>
              </div>

              <label className="mt-3 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={firma !== null}
                  onChange={e => setFirma(e.target.checked ? { firma: '', strasse: '', plz: '', ort: '', uid: '' } : null)} />
                Rechnung auf eine Firma ausstellen
              </label>
              {firma && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {([['firma', 'Firma'], ['strasse', 'Straße und Hausnummer'], ['plz', 'PLZ'], ['ort', 'Ort'], ['uid', 'UID-Nummer (optional)']] as const).map(([feld, text]) => (
                    <label key={feld} className={`block text-sm ${feld === 'firma' || feld === 'strasse' ? 'sm:col-span-2' : ''}`}>
                      <span className="text-ink-muted">{text}</span>
                      <input className={`${eingabe} mt-1`} value={firma[feld]}
                        onChange={e => setFirma(fi => fi && ({ ...fi, [feld]: e.target.value }))} />
                      {feld !== 'uid' && zeigeFehler(firma[feld].trim() ? undefined : `${text} angeben`)}
                    </label>
                  ))}
                </div>
              )}
            </section>

            <section aria-label="Zusammenfassung" className="rounded-xl bg-seite p-4">
              <ul className="space-y-1 text-sm">
                {event.arten.filter(a => (mengen[a.id] ?? 0) > 0).map(a => (
                  <li key={a.id} className="flex justify-between gap-3">
                    <span>{mengen[a.id]} × {a.bezeichnung}</span>
                    <span className="tabular-nums">{a.preisCent === 0 ? 'kostenlos' : euro(a.preisCent * (mengen[a.id] ?? 0))}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 flex justify-between border-t border-line pt-2 text-base font-bold">
                <span>Gesamt</span><span className="tabular-nums">{euro(summe)}</span>
              </p>
            </section>

            {r.kaufhinweis && <p className="whitespace-pre-line rounded-xl border border-[#fcd34d] bg-[#fef3c7] px-4 py-3 text-sm text-[#78350f]">{r.kaufhinweis}</p>}

            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={zustimmung} onChange={e => setZustimmung(e.target.checked)} />
              <span>
                Ich akzeptiere die {r.agbUrl ? <a href={r.agbUrl} target="_blank" rel="noreferrer" className="underline">AGB</a> : 'Verkaufsbedingungen'} und
                habe die {r.datenschutzUrl ? <a href={r.datenschutzUrl} target="_blank" rel="noreferrer" className="underline">Datenschutzerklärung</a> : 'Datenschutzhinweise'} gelesen.
              </span>
            </label>
            {zeigeFehler(zustimmung ? undefined : 'Bitte zustimmen')}

            {fehler && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{fehler}</p>}

            <div>
              <button type="submit" className={knopfHaupt} disabled={sendet}>
                {sendet ? 'Einen Moment …' : summe === 0 ? 'Kostenlos bestellen' : `Weiter zur Zahlung · ${euro(summe)}`}
              </button>
              {summe > 0 && (
                <p className="mt-2 text-center text-xs text-ink-muted">
                  Ihre Tickets sind 30 Minuten reserviert. Die Zahlung läuft sicher über Stripe.
                </p>
              )}
            </div>
          </form>
        )}
      </Karte>
      <RechtsLinks rechtliches={r} verkaeufer={event.verkaeufer} />
    </Seite>
  )
}
