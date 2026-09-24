import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react'
import {
  TICKET_ANZEIGE_STATUS_LABELS,
  eventZeitText,
  ticketGueltigkeitsHinweis,
  ticketTitel,
  type TicketAnzeigeStatus,
  type TicketOeffentlich,
} from '@kassa/shared'
import { ticketAlsBild } from './bild'

type Laden =
  | { art: 'laedt' }
  | { art: 'fehlt' }
  | { art: 'fehler' }
  | { art: 'da'; ticket: TicketOeffentlich }

const STATUS_STIL: Record<TicketAnzeigeStatus, string> = {
  gueltig:    'bg-green-100 text-green-800',
  eingeloest: 'bg-gray-200 text-gray-700',
  storniert:  'bg-red-100 text-red-800',
  abgesagt:   'bg-red-100 text-red-800',
}

const STATUS_ERKLAERUNG: Partial<Record<TicketAnzeigeStatus, string>> = {
  eingeloest: 'Dieses Ticket wurde am Einlass bereits gescannt.',
  storniert:  'Dieses Ticket wurde storniert und gilt nicht mehr.',
  abgesagt:   'Das Event wurde abgesagt — dieses Ticket gilt nicht mehr.',
}

export function TicketSeite() {
  const { code = '' } = useParams()
  const [zustand, setZustand] = useState<Laden>({ art: 'laedt' })

  const laden = useCallback(async () => {
    try {
      const res = await fetch(`/api/ticketshop/ticket/${encodeURIComponent(code)}`, { cache: 'no-store' })
      if (res.status === 404) { setZustand({ art: 'fehlt' }); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setZustand({ art: 'da', ticket: await res.json() as TicketOeffentlich })
    } catch {
      setZustand(z => z.art === 'da' ? z : { art: 'fehler' })
    }
  }, [code])

  // Beim Zurückkehren in den Tab neu laden — nach dem Einlass steht dann „eingelöst" da
  useEffect(() => {
    void laden()
    const beiFokus = () => { if (document.visibilityState === 'visible') void laden() }
    document.addEventListener('visibilitychange', beiFokus)
    return () => document.removeEventListener('visibilitychange', beiFokus)
  }, [laden])

  if (zustand.art === 'laedt') {
    return <Rahmen><p className="p-10 text-center text-ink-muted">Ticket wird geladen…</p></Rahmen>
  }
  if (zustand.art === 'fehlt' || zustand.art === 'fehler') {
    return (
      <Rahmen>
        <div className="p-10 text-center">
          <p className="text-lg font-semibold">
            {zustand.art === 'fehlt' ? 'Ticket nicht gefunden' : 'Ticket konnte nicht geladen werden'}
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            {zustand.art === 'fehlt'
              ? 'Bitte den Link aus der Ticket-E-Mail verwenden.'
              : 'Bitte die Internetverbindung prüfen und neu laden.'}
          </p>
        </div>
      </Rahmen>
    )
  }
  return <Ticket ticket={zustand.ticket} />
}

function Rahmen({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-[640px] px-4 py-6 sm:py-10">
      <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">{children}</div>
    </main>
  )
}

function Ticket({ ticket: t }: { ticket: TicketOeffentlich }) {
  const qrCanvas = useRef<HTMLCanvasElement>(null)
  const [bildLaeuft, setBildLaeuft] = useState(false)
  const url = `${window.location.origin}/t/${t.code}`
  const hinweis = ticketGueltigkeitsHinweis(t.typ)
  const ungueltig = t.anzeigeStatus === 'storniert' || t.anzeigeStatus === 'abgesagt'
  const ort = t.event.adresse ? `${t.event.ort}, ${t.event.adresse}` : t.event.ort
  const teilenText = `Ticket für ${t.event.titel} (${eventZeitText(t.event.beginn)})`

  useEffect(() => { document.title = `Ticket · ${t.event.titel}` }, [t.event.titel])

  async function alsFoto() {
    if (!qrCanvas.current) return
    setBildLaeuft(true)
    try {
      const blob = await ticketAlsBild(t, qrCanvas.current)
      const datei = new File([blob], `Ticket-${t.code}.png`, { type: 'image/png' })
      // Am Handy über das Teilen-Menü („Bild sichern"), am PC als Download
      const handy = window.matchMedia('(pointer: coarse)').matches
      if (handy && navigator.canShare?.({ files: [datei] })) {
        await navigator.share({ files: [datei], title: teilenText }).catch(() => {})
      } else {
        const link = document.createElement('a')
        link.href = URL.createObjectURL(blob)
        link.download = datei.name
        document.body.appendChild(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
      }
    } finally {
      setBildLaeuft(false)
    }
  }

  const knopf = 'inline-flex items-center gap-1.5 rounded-xl border border-line bg-white px-4 py-2.5 text-sm font-semibold text-ink shadow-sm hover:bg-gray-50'

  return (
    <Rahmen>
      {/* Kopf */}
      <header className="bg-kopf px-6 pb-5 pt-5 text-white sm:px-7">
        {t.event.status === 'test' && (
          <p className="mb-1 text-[13px] text-kopf-leise">Interner Test · nicht veröffentlichen</p>
        )}
        <h1 className="text-[22px] font-bold leading-tight">{t.event.titel}</h1>
        <p className="mt-2 flex items-center gap-2 text-[15px]"><span aria-hidden>📅</span>{eventZeitText(t.event.beginn)}</p>
        <p className="mt-1 flex items-center gap-2 text-[15px]"><span aria-hidden>📍</span>{ort}</p>
        {t.event.hinweis && (
          <p className="mt-3 inline-block rounded-full bg-gold px-3.5 py-1.5 text-sm font-bold text-[#1a1a1a]">{t.event.hinweis}</p>
        )}
      </header>
      <div className="border-t-2 border-dashed border-[#cbd2e1]" />

      {/* Körper */}
      <section className="px-6 pb-5 pt-5 sm:px-7">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold">{ticketTitel(t)}</h2>
            {t.name && <p className="text-sm text-ink-muted">{t.name}</p>}
            {t.band && (
              <p className="mt-1.5 inline-block rounded-full px-2.5 py-1 text-[13px] font-bold text-white" style={{ background: t.band.farbe }}>
                Band {t.band.bezeichnung} · {t.band.altersText}
              </p>
            )}
          </div>
          <span className={`shrink-0 rounded-full px-3 py-1 text-[13px] font-semibold ${STATUS_STIL[t.anzeigeStatus]}`}>
            {TICKET_ANZEIGE_STATUS_LABELS[t.anzeigeStatus]}
          </span>
        </div>

        {STATUS_ERKLAERUNG[t.anzeigeStatus] && (
          <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${ungueltig ? 'bg-red-50 text-red-800' : 'bg-gray-100 text-gray-700'}`}>
            {STATUS_ERKLAERUNG[t.anzeigeStatus]}
          </p>
        )}

        <div className={`mt-4 flex flex-col items-center ${ungueltig ? 'opacity-30' : ''}`}>
          <QRCodeSVG value={url} size={256} level="M" marginSize={0} className="h-auto w-full max-w-[256px]" />
          {/* Unsichtbares Canvas-Pendant als Quelle für „Als Foto speichern" */}
          <QRCodeCanvas ref={qrCanvas} value={url} size={600} level="M" marginSize={0} className="hidden" />
          <span className="mt-3 rounded-md bg-[#eceef1] px-2.5 py-1 font-mono text-sm">{t.code}</span>
        </div>

        <p className="mt-5 rounded-xl border border-[#fcd34d] bg-[#fef3c7] px-4 py-3 text-sm text-[#78350f]">
          <span aria-hidden>⚠️ </span><strong>{hinweis.titel}</strong> {hinweis.text}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-muted">Dieses Ticket weiterleiten:</span>
          <a className={knopf} href={`https://wa.me/?text=${encodeURIComponent(`${teilenText}: ${url}`)}`} target="_blank" rel="noreferrer">WhatsApp</a>
          <a className={knopf} href={`mailto:?subject=${encodeURIComponent(teilenText)}&body=${encodeURIComponent(`${teilenText}\n\n${url}`)}`}>E-Mail</a>
          {typeof navigator.share === 'function' && (
            <button type="button" className={knopf}
              onClick={() => { void navigator.share({ title: teilenText, url }).catch(() => {}) }}>
              Teilen …
            </button>
          )}
          <a className={knopf} href={`/api/ticketshop/ticket/${t.code}/pdf`}><span aria-hidden>📄</span> PDF (A4)</a>
          <button type="button" className={knopf} onClick={() => void alsFoto()} disabled={bildLaeuft}>
            <span aria-hidden>🖼️</span> {bildLaeuft ? 'Wird erstellt …' : 'Als Foto speichern'}
          </button>
        </div>
      </section>

      <footer className="border-t border-line px-6 py-4 text-center text-xs text-ink-muted">
        {t.event.veranstalter === t.verkaeufer
          ? <>Veranstalter &amp; Verkäufer: {t.verkaeufer}</>
          : <>Veranstalter: {t.event.veranstalter} · Verkauf: {t.verkaeufer}</>}
      </footer>
    </Rahmen>
  )
}
