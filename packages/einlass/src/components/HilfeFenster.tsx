/**
 * HilfeFenster dieser App — runder „?"-Knopf in der Kopfzeile, darunter das Fenster von unten (wie am Handy üblich)
 * mit der Erklärung zum gerade offenen Bildschirm (Prop aktuell = Kennung des Themas), allen Themen und einer Suche. Texte: hilfe/texte.ts.
 */

import { useEffect, useMemo, useState } from 'react'
import { suchHilfe, type HilfeThema } from '@kassa/shared'
import { HILFE_START, HILFE_THEMEN } from '../hilfe/texte'

function ThemaAnsicht({ thema }: { thema: HilfeThema }) {
  return (
    <article data-testid={`hilfe-thema-${thema.id}`} className="space-y-3">
      <div>
        <h3 className="text-lg font-black text-text">{thema.titel}</h3>
        <p className="text-sm text-leise">{thema.zweck}</p>
      </div>
      {thema.schritte.length > 0 && (
        <ol className="list-decimal space-y-2 pl-5 text-sm text-text marker:font-bold marker:text-green-500">
          {thema.schritte.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
      {thema.abschnitte?.map(a => (
        <section key={a.titel} className="rounded-xl border border-rand bg-grund p-3">
          <h4 className="mb-1.5 text-sm font-bold text-text">{a.titel}</h4>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-text">
            {a.schritte.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </section>
      ))}
      {thema.tipps && thema.tipps.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
          <p className="mb-1 font-bold">Gut zu wissen</p>
          <ul className="list-disc space-y-1 pl-5">{thema.tipps.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
    </article>
  )
}

function HilfeInhalt({ aktuell }: { aktuell: string | undefined }) {
  const [suche, setSuche] = useState('')
  const [gewaehlt, setGewaehlt] = useState<string | null>(null)

  const dieseSeite = useMemo(() => HILFE_THEMEN.find(t => t.id === aktuell), [aktuell])
  const treffer = useMemo(() => suchHilfe(HILFE_THEMEN, suche), [suche])
  const sucht = suche.trim() !== ''
  const angezeigt = HILFE_THEMEN.find(t => t.id === gewaehlt)
    ?? (!sucht ? (dieseSeite ?? HILFE_THEMEN.find(t => t.id === HILFE_START)) : undefined)
  const waehle = (id: string) => { setGewaehlt(id); setSuche('') }

  return (
    <div className="space-y-4">
      <input
        value={suche}
        onChange={e => { setSuche(e.target.value); setGewaehlt(null) }}
        placeholder="Hilfe durchsuchen … (z. B. Bon, Station)"
        aria-label="Hilfe durchsuchen"
        data-testid="hilfe-suche"
        className="w-full rounded-xl border border-rand bg-grund px-3 py-3 text-sm text-text outline-none focus:border-green-500"
      />

      {sucht ? (
        treffer.length === 0 ? (
          <p className="text-sm text-leise">Dazu gibt es keinen Hilfetext. Anderes Suchwort probieren.</p>
        ) : (
          <ul className="divide-y divide-rand rounded-xl border border-rand" data-testid="hilfe-treffer">
            {treffer.map(t => (
              <li key={t.id}>
                <button type="button" onClick={() => waehle(t.id)} className="block w-full px-3 py-3 text-left active:bg-rand">
                  <span className="block text-sm font-bold text-text">{t.titel}</span>
                  <span className="block text-xs text-leise">{t.zweck}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        angezeigt && (
          <>
            {gewaehlt && dieseSeite && gewaehlt !== dieseSeite.id && (
              <button type="button" onClick={() => setGewaehlt(null)} className="text-xs font-bold text-green-400">
                ← zurück zu „{dieseSeite.titel}" (dieser Bildschirm)
              </button>
            )}
            {!gewaehlt && dieseSeite && (
              <p className="text-xs font-bold uppercase tracking-wide text-leise">Zu diesem Bildschirm</p>
            )}
            <ThemaAnsicht thema={angezeigt} />
          </>
        )
      )}

      {!sucht && (
        <section className="border-t border-rand pt-3">
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-leise">Alle Themen</h4>
          <div className="flex flex-wrap gap-1.5" data-testid="hilfe-themen">
            {HILFE_THEMEN.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => waehle(t.id)}
                aria-pressed={angezeigt?.id === t.id}
                className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                  angezeigt?.id === t.id ? 'border-green-600 bg-green-600 text-white' : 'border-rand bg-flaeche text-leise'
                }`}
              >
                {t.titel}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** Runder „?"-Knopf für die Kopfzeile samt Fenster. */
export function HilfeKnopf({ aktuell, className = '' }: { aktuell?: string; className?: string }) {
  const [offen, setOffen] = useState(false)

  useEffect(() => {
    if (!offen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOffen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [offen])

  return (
    <>
      <button
        type="button"
        onClick={() => setOffen(true)}
        data-testid="hilfe-knopf"
        aria-label="Hilfe"
        title="Hilfe zu diesem Bildschirm"
        className={`h-10 w-10 shrink-0 rounded-xl border border-rand bg-grund text-lg font-black leading-none text-text active:scale-95 transition ${className}`}
      >
        ?
      </button>
      {offen && (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-label="Hilfe"
          onClick={() => setOffen(false)}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-3xl bg-flaeche shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-rand px-5 py-3">
              <h2 className="text-base font-black text-text">Hilfe</h2>
              <button
                type="button"
                onClick={() => setOffen(false)}
                aria-label="Schließen"
                data-testid="hilfe-schliessen"
                className="h-9 w-9 rounded-xl text-xl leading-none text-leise active:bg-rand"
              >
                ×
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-4 pb-8">
              <HilfeInhalt aktuell={aktuell} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
