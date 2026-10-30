/**
 * HilfeFenster — Knopf „? Hilfe" in der Kopfleiste und das Fenster mit der Erklärung zur gerade offenen Seite.
 *
 * Zuerst steht das Thema zur aktuellen Seite (Zweck, Handgriffe der Reihe nach, Tipps); darunter alle anderen Themen
 * zum Anklicken, oben ein Suchfeld. Für Menschen, die die Kassa nicht kennen (z. B. Mieter einer Leih-Kassa).
 * Texte: hilfe/texte.ts — Zuordnung zur Seite und Suche: @kassa/shared (findeHilfe, suchHilfe).
 */

import { useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { findeHilfe, suchHilfe, type HilfeThema } from '@kassa/shared'
import { HILFE_START, HILFE_THEMEN } from '../hilfe/texte'
import { Modal } from './ui/Modal'
import { Input } from './ui/Input'

function ThemaAnsicht({ thema }: { thema: HilfeThema }) {
  return (
    <article data-testid={`hilfe-thema-${thema.id}`} className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-ink">{thema.titel}</h3>
        <p className="mt-0.5 text-sm text-ink-muted">{thema.zweck}</p>
      </div>

      {thema.schritte.length > 0 && (
        <ol className="list-decimal space-y-2 pl-5 text-sm text-ink marker:font-semibold marker:text-brand-600">
          {thema.schritte.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}

      {thema.abschnitte?.map(a => (
        <section key={a.titel} className="rounded-lg border border-line bg-panel-2/50 p-3">
          <h4 className="mb-2 text-sm font-semibold text-ink">{a.titel}</h4>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink marker:text-ink-subtle">
            {a.schritte.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </section>
      ))}

      {thema.tipps && thema.tipps.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="mb-1 font-semibold">Gut zu wissen</p>
          <ul className="list-disc space-y-1 pl-5">
            {thema.tipps.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
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

  // Was oben steht: ein angeklicktes Thema, sonst das zur aktuellen Seite, sonst „Erste Schritte"
  const angezeigt = HILFE_THEMEN.find(t => t.id === gewaehlt)
    ?? (!sucht ? (dieseSeite ?? HILFE_THEMEN.find(t => t.id === HILFE_START)) : undefined)

  const waehle = (id: string) => { setGewaehlt(id); setSuche('') }

  return (
    <div className="space-y-4">
      <Input
        value={suche}
        onChange={e => { setSuche(e.target.value); setGewaehlt(null) }}
        placeholder="Hilfe durchsuchen … (z. B. Storno, Drucker, Rabatt)"
        aria-label="Hilfe durchsuchen"
        data-testid="hilfe-suche"
      />

      {sucht ? (
        treffer.length === 0 ? (
          <p className="text-sm text-ink-muted">Dazu gibt es keinen Hilfetext. Anderes Suchwort probieren oder die Themen unten ansehen.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line" data-testid="hilfe-treffer">
            {treffer.map(t => (
              <li key={t.id}>
                <button type="button" onClick={() => waehle(t.id)} className="block w-full px-3 py-2 text-left hover:bg-panel-2">
                  <span className="block text-sm font-medium text-ink">{t.titel}</span>
                  <span className="block text-xs text-ink-muted">{t.zweck}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        angezeigt && (
          <>
            {gewaehlt && dieseSeite && gewaehlt !== dieseSeite.id && (
              <button type="button" onClick={() => setGewaehlt(null)} className="text-xs font-medium text-brand-700 hover:underline">
                ← zurück zu „{dieseSeite.titel}" (diese Seite)
              </button>
            )}
            {!gewaehlt && dieseSeite && (
              <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Zu dieser Seite</p>
            )}
            <ThemaAnsicht thema={angezeigt} />
          </>
        )
      )}

      {!sucht && (
        <section className="border-t border-line pt-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Alle Themen</h4>
          <div className="flex flex-wrap gap-1.5" data-testid="hilfe-themen">
            {HILFE_THEMEN.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => waehle(t.id)}
                aria-pressed={angezeigt?.id === t.id}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${
                  angezeigt?.id === t.id
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-line-strong bg-panel text-ink-muted hover:border-brand-400 hover:text-ink'
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

/** Knopf für die Kopfleiste (heller Text auf dunklem Grund) samt Fenster. */
export function HilfeKnopf({ className = '' }: { className?: string }) {
  const [offen, setOffen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOffen(true)}
        data-testid="hilfe-knopf"
        title="Hilfe zu dieser Seite"
        aria-label="Hilfe"
        className={`text-xs font-medium text-white/80 hover:text-white px-2 py-1 rounded hover:bg-white/10 ${className}`}
      >
        ? Hilfe
      </button>
      {/* Beim Schließen wird der Inhalt abgebaut: nächstes Öffnen startet wieder mit der aktuellen Seite */}
      <Modal open={offen} onClose={() => setOffen(false)} title="Hilfe" size="lg">
        {offen && <HilfeInhalt />}
      </Modal>
    </>
  )
}
