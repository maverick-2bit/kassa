/**
 * KontenWahl — Anmeldeseite: zu welchem Mandanten und welcher Kasse gehört das PIN-Pad, und — wenn dieses Gerät
 * mehrere Mandanten kennt — die Auswahl dazu. Die Liste stammt aus lib/konten.ts: nur Namen, keine Zugangsdaten.
 */

import { getKasseIdentity } from '../lib/kasse'
import { ladeKonten } from '../lib/konten'
import { kasseName } from '../lib/kassenWechsel'
import { waehleKontoFuerAnmeldung } from '../lib/kontoWechsel'

export function KontenWahl({ onGewaehlt }: { onGewaehlt: () => void }) {
  const identity = getKasseIdentity()
  const konten   = ladeKonten()
  const aktuell  = konten.find(k => k.mandantId === identity?.mandantId)
  // Gerät ohne gemerkten Mandanten (noch nie damit angemeldet): nichts zu zeigen
  if (!identity || !aktuell) return null
  const kasse = aktuell.kassen.find(k => k.id === identity.kasseId)

  return (
    <div className="mb-5 text-center" data-testid="login-konten">
      <p className="text-sm font-semibold text-ink" data-testid="login-mandant">{aktuell.firmenname}</p>
      {kasse && <p className="text-xs text-ink-muted" data-testid="login-kasse">Kasse {kasseName(kasse)}</p>}

      {konten.length > 1 && (
        <div role="group" aria-label="Mandant wählen" className="mt-3 flex flex-wrap justify-center gap-1.5">
          {konten.map(k => {
            const gewaehlt = k.mandantId === aktuell.mandantId
            return (
              <button
                key={k.mandantId}
                type="button"
                aria-pressed={gewaehlt}
                disabled={k.kassen.length === 0}
                data-testid={`login-konto-${k.mandantId}`}
                onClick={() => { if (!gewaehlt && waehleKontoFuerAnmeldung(k.mandantId)) onGewaehlt() }}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${
                  gewaehlt
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-line bg-panel-2 text-ink-muted hover:text-ink'
                }`}
              >
                {k.firmenname}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
