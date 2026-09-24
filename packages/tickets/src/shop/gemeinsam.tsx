import type { ReactNode } from 'react'
import { eventZeitText, type ShopRechtliches } from '@kassa/shared'

const EURO = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' })

export function euro(cent: number): string {
  return EURO.format(cent / 100)
}

/** Fehlertext aus einer API-Antwort ({ fehler: string }) */
export async function fehlerAus(res: Response): Promise<string> {
  try {
    const body = await res.json() as { fehler?: unknown }
    if (typeof body.fehler === 'string') return body.fehler
  } catch { /* kein JSON */ }
  if (res.status === 429) return 'Zu viele Anfragen — bitte kurz warten und erneut versuchen.'
  return `Das hat leider nicht geklappt (Fehler ${res.status}).`
}

export function Seite({ children }: { children: ReactNode }) {
  return <main className="mx-auto max-w-[640px] px-4 py-6 sm:py-10">{children}</main>
}

export function Karte({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`overflow-hidden rounded-2xl border border-line bg-white shadow-sm ${className}`}>{children}</div>
}

/** Kopf wie auf dem Ticket — Wiedererkennung vom Kauf bis zum Einlass */
export function EventKopf({ titel, beginn, ort, adresse, hinweis, test }: {
  titel: string; beginn: string; ort: string; adresse?: string | null; hinweis?: string | null; test?: boolean
}) {
  return (
    <header className="bg-kopf px-6 pb-5 pt-5 text-white sm:px-7">
      {test && <p className="mb-1 text-[13px] text-kopf-leise">Interner Test · nicht veröffentlichen</p>}
      <h1 className="text-[22px] font-bold leading-tight">{titel}</h1>
      <p className="mt-2 flex items-center gap-2 text-[15px]"><span aria-hidden>📅</span>{eventZeitText(beginn)}</p>
      <p className="mt-1 flex items-center gap-2 text-[15px]"><span aria-hidden>📍</span>{adresse ? `${ort}, ${adresse}` : ort}</p>
      {hinweis && (
        <p className="mt-3 inline-block rounded-full bg-gold px-3.5 py-1.5 text-sm font-bold text-[#1a1a1a]">{hinweis}</p>
      )}
    </header>
  )
}

export function RechtsLinks({ rechtliches, verkaeufer }: { rechtliches: ShopRechtliches; verkaeufer: string }) {
  const links = [
    ['Impressum', rechtliches.impressumUrl],
    ['Datenschutz', rechtliches.datenschutzUrl],
    ['AGB', rechtliches.agbUrl],
  ].filter((l): l is [string, string] => !!l[1])
  return (
    <footer className="mt-4 text-center text-xs text-ink-muted">
      <p>Verkauf: {verkaeufer}</p>
      {links.length > 0 && (
        <p className="mt-1 space-x-3">
          {links.map(([text, url]) => <a key={text} href={url} target="_blank" rel="noreferrer" className="underline">{text}</a>)}
        </p>
      )}
    </footer>
  )
}

export const knopfHaupt = 'inline-flex w-full items-center justify-center rounded-xl bg-kopf px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-[#28356a] disabled:opacity-50'
export const knopfLeise = 'inline-flex items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-4 py-2.5 text-sm font-semibold text-ink shadow-sm hover:bg-gray-50'
export const eingabe = 'block w-full rounded-lg border border-line bg-white px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-kopf/30'
