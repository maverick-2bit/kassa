/**
 * MandantenUmschalter — in der Kopfleiste unter dem Namen: der Betrieb (Mandant), für den dieses Gerät gerade
 * angemeldet ist. Kennt das Gerät mehrere Mandanten und darf der Benutzer Einstellungen ändern, klappt der Name zu
 * einer Liste auf: ein Klick wechselt (lib/kontoWechsel.ts). Hat der andere Mandant eine gemerkte Sitzung, geht es
 * ohne Anmeldung; sonst führt der Klick zur Anmeldung dort (PIN-Pad bzw. E-Mail und Passwort).
 *
 * Ohne mehrere Mandanten bleibt es der schlichte Firmenname; in der eingeklappten Kopfleiste erscheint dann nichts.
 */

import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { getAuth, hasBerechtigung } from '../lib/auth'
import { ladeKonten, sitzungGueltig, type Konto } from '../lib/konten'
import { KASSEN_ANSICHT, kasseName } from '../lib/kassenWechsel'
import { entferneKontoVonGeraet, meldeWeiterenMandantenAn, wechsleKonto } from '../lib/kontoWechsel'
import { useAufklappen } from '../lib/useAufklappen'

export function MandantenUmschalter({ kompakt = false }: { kompakt?: boolean }) {
  const { pathname } = useLocation()
  const { offen, setOffen, huelle } = useAufklappen()
  const [, neuZeichnen] = useState(0)
  const auth = getAuth()
  if (!auth) return null

  const konten  = ladeKonten().sort((a, b) => a.firmenname.localeCompare(b.firmenname, 'de'))
  const mehrere = hasBerechtigung('einstellungen') && konten.length >= 2
  if (!mehrere) return kompakt ? null : <p className="text-white/60">{auth.mandant.firmenname}</p>

  const jetzt = Date.now()

  function waehlen(k: Konto) {
    setOffen(false)
    if (k.mandantId === auth!.mandant.id) return
    const anmeldungNoetig = !sitzungGueltig(k.sitzung, jetzt)
    if (KASSEN_ANSICHT.test(pathname) && !window.confirm(
      `Zu „${k.firmenname}" wechseln?\n\n${anmeldungNoetig ? 'Dort ist eine neue Anmeldung nötig. ' : ''}Die Seite wird neu geladen — ein offener Warenkorb geht dabei verloren.`,
    )) return
    wechsleKonto(k.mandantId)
  }

  function entfernen(k: Konto) {
    if (!window.confirm(`„${k.firmenname}" von diesem Gerät entfernen?\n\nDas betrifft nur die Merkliste dieses Geräts — der Mandant selbst bleibt unverändert.`)) return
    entferneKontoVonGeraet(k.mandantId)
    neuZeichnen(n => n + 1)
  }

  const caret = (
    <svg className={`h-3 w-3 shrink-0 transition-transform ${offen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
    </svg>
  )

  return (
    <div ref={huelle} className={`relative shrink-0 ${kompakt ? '' : 'block'}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={offen}
        data-testid="mandanten-umschalter"
        title="Mandant wechseln"
        onClick={() => setOffen(o => !o)}
        className={kompakt
          ? 'flex items-center gap-1.5 rounded-lg bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white transition hover:bg-white/20'
          : 'inline-flex max-w-full items-center gap-1 text-white/60 transition hover:text-white'}
      >
        {kompakt && <span className="text-white/60">Mandant</span>}
        <span className={`truncate ${kompakt ? 'max-w-[10rem] font-semibold' : 'max-w-[14rem]'}`}>{auth.mandant.firmenname}</span>
        {caret}
      </button>

      {offen && (
        <ul
          role="listbox"
          aria-label="Mandant wählen"
          className="absolute right-0 top-full z-30 mt-1 min-w-[17rem] overflow-hidden rounded-lg border border-line bg-panel py-1 text-left shadow-lg"
        >
          {konten.map(k => {
            const aktiv  = k.mandantId === auth.mandant.id
            const kasse  = k.kassen.find(x => x.id === k.kasseId)
            const status = aktiv ? null : sitzungGueltig(k.sitzung, jetzt) ? 'angemeldet' : 'Anmeldung nötig'
            const zeile2 = [k.benutzer, kasse && `Kasse ${kasseName(kasse)}`, status].filter(Boolean).join(' · ')
            return (
              <li key={k.mandantId} role="option" aria-selected={aktiv} className="flex items-stretch">
                <button
                  type="button"
                  data-testid={`mandanten-umschalter-${k.mandantId}`}
                  onClick={() => waehlen(k)}
                  className={`min-w-0 flex-1 px-3 py-2 text-left transition ${aktiv ? 'bg-brand-50 text-brand-700' : 'text-ink hover:bg-panel-2'}`}
                >
                  <span className="block whitespace-nowrap text-sm font-medium">
                    {k.firmenname}{aktiv && <span className="ml-2 text-xs font-semibold">● aktiv</span>}
                  </span>
                  {zeile2 && <span className={`block whitespace-nowrap text-[11px] ${aktiv ? 'text-brand-700/80' : 'text-ink-subtle'}`}>{zeile2}</span>}
                </button>
                {!aktiv && (
                  <button
                    type="button"
                    aria-label={`„${k.firmenname}" von diesem Gerät entfernen`}
                    title="Von diesem Gerät entfernen"
                    data-testid={`mandanten-entfernen-${k.mandantId}`}
                    onClick={() => entfernen(k)}
                    className="px-3 text-lg leading-none text-ink-subtle transition hover:bg-panel-2 hover:text-red-600"
                  >
                    ×
                  </button>
                )}
              </li>
            )
          })}
          <li role="presentation" className="mt-1 border-t border-line pt-1">
            <button
              type="button"
              data-testid="mandanten-umschalter-neu"
              onClick={() => { setOffen(false); meldeWeiterenMandantenAn() }}
              className="w-full px-3 py-2 text-left text-sm font-medium text-brand-700 transition hover:bg-panel-2"
            >
              + Weiteren Mandanten anmelden
            </button>
          </li>
          <li role="presentation" className="px-3 pb-1.5 pt-0.5 text-[11px] leading-snug text-ink-subtle">
            Abmelden beendet alle gemerkten Sitzungen dieses Geräts.
          </li>
        </ul>
      )}
    </div>
  )
}
