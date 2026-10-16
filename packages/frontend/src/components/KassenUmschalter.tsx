/**
 * KassenUmschalter — Schnellumschalter für die Kasse dieses Geräts, direkt in der Kopfleiste.
 *
 * Bei bis zu drei Kassen stehen sie als Knöpfe nebeneinander (ein Klick), bei mehr als Auswahlliste.
 * Die aktive Kasse ist hervorgehoben. In den Kassier-Ansichten (Kasse, offener Tisch) fragt der Wechsel
 * vorher nach, weil ein offener Warenkorb verloren ginge. Ohne zweite Kasse erscheint nichts.
 *
 * Wer Einstellungen ändern darf, sieht alle Kassen in Betrieb (frisch vom Server), alle anderen nur die
 * ihnen zugeordneten (siehe lib/kassenWechsel.ts).
 */

import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import { kasseApi } from '../lib/api'
import { getAuth, hasBerechtigung } from '../lib/auth'
import { getKasseIdentity } from '../lib/kasse'
import { KASSEN_ANSICHT, kasseName, umschaltKassen, wechsleKasse, type WechselKasse } from '../lib/kassenWechsel'
import { useAufklappen } from '../lib/useAufklappen'

/** Die Kassen, zwischen denen dieses Gerät umschalten darf (weniger als zwei = kein Umschalter). */
export function useUmschaltKassen(): WechselKasse[] {
  const auth        = getAuth()
  const alleErlaubt = hasBerechtigung('einstellungen')
  const liste = useQuery({
    queryKey: ['kassen-liste'],
    queryFn:  kasseApi.liste,
    enabled:  !!auth && alleErlaubt,
    staleTime: 30_000,
  })
  return umschaltKassen({ alleErlaubt, serverListe: liste.data, authKassen: auth?.kassen ?? [] })
}

/** Bis zu so vielen Kassen stehen als Knöpfe nebeneinander, darüber als Auswahlliste. */
const MAX_KNOEPFE = 3

export function KassenUmschalter({ kompakt = false, className = '' }: { kompakt?: boolean; className?: string }) {
  const kassen   = useUmschaltKassen()
  const identity = getKasseIdentity()
  const { pathname } = useLocation()
  // Auswahlliste: schließt bei Klick daneben und mit Esc
  const { offen, setOffen, huelle } = useAufklappen()

  if (!identity || kassen.length < 2) return null

  const aktuell = kassen.find(k => k.id === identity.kasseId)

  function wechseln(k: WechselKasse) {
    setOffen(false)
    if (k.id === identity!.kasseId) return
    if (KASSEN_ANSICHT.test(pathname) && !window.confirm(
      `Zu „${kasseName(k)}" wechseln?\n\nDie Seite wird neu geladen — ein offener Warenkorb geht dabei verloren.`,
    )) return
    wechsleKasse(k)
  }

  const gross = kompakt ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1'

  // ---- wenige Kassen: ein Klick ----
  if (kassen.length <= MAX_KNOEPFE) {
    return (
      <div
        role="group"
        aria-label="Kasse umschalten"
        data-testid="kassen-umschalter"
        className={`flex shrink-0 items-center gap-0.5 rounded-lg bg-white/10 p-0.5 ${className}`}
      >
        {kassen.map(k => {
          const aktiv = k.id === identity.kasseId
          return (
            <button
              key={k.id}
              type="button"
              aria-pressed={aktiv}
              data-testid={`kassen-umschalter-${k.kassenId}`}
              title={aktiv ? `Aktive Kasse: ${kasseName(k)}` : `Auf Kasse „${kasseName(k)}" umschalten`}
              onClick={() => wechseln(k)}
              className={`whitespace-nowrap rounded-md font-medium transition ${gross} ${
                aktiv ? 'bg-white text-header font-semibold' : 'text-white/70 hover:bg-white/15 hover:text-white'
              }`}
            >
              {kasseName(k)}
            </button>
          )
        })}
      </div>
    )
  }

  // ---- viele Kassen: Auswahlliste ----
  return (
    <div ref={huelle} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={offen}
        data-testid="kassen-umschalter"
        title="Kasse dieses Geräts umschalten"
        onClick={() => setOffen(o => !o)}
        className={`flex items-center gap-1.5 rounded-lg bg-white/10 font-medium text-white transition hover:bg-white/20 ${gross}`}
      >
        <span className="text-white/60">Kasse</span>
        <span className="max-w-[10rem] truncate font-semibold">{aktuell ? kasseName(aktuell) : '—'}</span>
        <svg className={`h-3.5 w-3.5 transition-transform ${offen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {offen && (
        <ul
          role="listbox"
          aria-label="Kasse wählen"
          className="absolute right-0 top-full z-30 mt-1 max-h-[70vh] min-w-[14rem] overflow-auto rounded-lg border border-line bg-panel py-1 shadow-lg"
        >
          {kassen.map(k => {
            const aktiv = k.id === identity.kasseId
            return (
              <li key={k.id} role="option" aria-selected={aktiv}>
                <button
                  type="button"
                  data-testid={`kassen-umschalter-${k.kassenId}`}
                  onClick={() => wechseln(k)}
                  className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm transition ${
                    aktiv ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink hover:bg-panel-2'
                  }`}
                >
                  <span className="whitespace-nowrap">{kasseName(k)}{aktiv && <span className="ml-2 text-xs font-semibold">● aktiv</span>}</span>
                  {k.bezeichnung && <span className="whitespace-nowrap font-mono text-[11px] text-ink-subtle">{k.kassenId}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
