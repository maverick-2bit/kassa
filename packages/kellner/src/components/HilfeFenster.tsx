/**
 * HilfeFenster der Kellner-App — runder „?"-Knopf in der Kopfzeile, darunter das Fenster von unten (wie am Handy üblich)
 * mit der Erklärung zum gerade offenen Bildschirm, allen Themen und einer Suche. Texte: hilfe/texte.ts.
 */

import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { findeHilfe, suchHilfe, type HilfeThema } from '@kassa/shared'
import { HILFE_START, HILFE_THEMEN } from '../hilfe/texte'

function ThemaAnsicht({ thema }: { thema: HilfeThema }) {
  return (
    <article data-testid={`hilfe-thema-${thema.id}`} className="space-y-3">
      <div>
        <h3 className="text-lg font-black text-ink">{thema.titel}</h3>
        <p className="text-sm text-ink-muted">{thema.zweck}</p>
      </div>
      {thema.schritte.length > 0 && (
        <ol className="list-decimal space-y-2 pl-5 text-sm text-ink marker:font-bold marker:text-brand-600">
          {thema.schritte.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
      {thema.abschnitte?.map(a => (
        <section key={a.titel} className="rounded-xl border border-line bg-surface p-3">
          <h4 className="mb-1.5 text-sm font-bold text-ink">{a.titel}</h4>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink">
            {a.schritte.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </section>
      ))}
      {thema.tipps && thema.tipps.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="mb-1 font-bold">Gut zu wissen</p>
          <ul className="list-disc space-y-1 pl-5">{thema.tipps.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
    </article>
  )
}

function HilfeInhalt() {
  const { pathname } = useLocation()
  const [suche, setSuche] = useState('')
  const [gewaehlt, setGewaehlt] = useState<string | null>(null)

  const dieseSeite = useMemo(() => findeHilfe(HILFE_THEMEN, pathname), [pathname])
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
        placeholder="Hilfe durchsuchen … (z. B. Storno, Gang)"
        aria-label="Hilfe durchsuchen"
        data-testid="hilfe-suche"
        className="w-full rounded-xl border border-line-strong bg-surface px-3 py-3 text-sm text-ink outline-none focus:border-brand-500"
      />

      {sucht ? (
        treffer.length === 0 ? (
          <p className="text-sm text-ink-muted">Dazu gibt es keinen Hilfetext. Anderes Suchwort probieren.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line" data-testid="hilfe-treffer">
            {treffer.map(t => (
              <li key={t.id}>
                <button type="button" onClick={() => waehle(t.id)} className="block w-full px-3 py-3 text-left active:bg-panel-2">
                  <span className="block text-sm font-bold text-ink">{t.titel}</span>
                  <span className="block text-xs text-ink-subtle">{t.zweck}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        angezeigt && (
          <>
            {gewaehlt && dieseSeite && gewaehlt !== dieseSeite.id && (
              <button type="button" onClick={() => setGewaehlt(null)} className="text-xs font-bold text-brand-600">
                ← zurück zu „{dieseSeite.titel}" (dieser Bildschirm)
              </button>
            )}
            {!gewaehlt && dieseSeite && (
              <p className="text-xs font-bold uppercase tracking-wide text-ink-subtle">Zu diesem Bildschirm</p>
            )}
            <ThemaAnsicht thema={angezeigt} />
          </>
        )
      )}

      {!sucht && (
        <section className="border-t border-line pt-3">
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-subtle">Alle Themen</h4>
          <div className="flex flex-wrap gap-1.5" data-testid="hilfe-themen">
            {HILFE_THEMEN.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => waehle(t.id)}
                aria-pressed={angezeigt?.id === t.id}
                className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                  angezeigt?.id === t.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong bg-panel text-ink-muted'
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
export function HilfeKnopf({ className = '' }: { className?: string }) {
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
        className={`h-10 w-10 shrink-0 rounded-xl border border-line-strong bg-surface text-lg font-black leading-none text-ink active:scale-95 transition ${className}`}
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
            className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-3xl bg-panel shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="text-base font-black text-ink">Hilfe</h2>
              <button
                type="button"
                onClick={() => setOffen(false)}
                aria-label="Schließen"
                data-testid="hilfe-schliessen"
                className="h-9 w-9 rounded-xl text-xl leading-none text-ink-subtle active:bg-panel-2"
              >
                ×
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-4 pb-8">
              <HilfeInhalt />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
