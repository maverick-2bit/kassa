import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { systemApi, type FernwartungStatus } from '../lib/api'
import { getAuth } from '../lib/auth'
import { Button } from './ui/Button'

/**
 * Einstellungen → System → Fernwartung (nur Admin).
 *
 * Zeigt, ob diese Kasse für die Fernwartung eingerichtet ist (TeamViewer Host auf dem
 * Kassen-PC, vom Installer eingerichtet) und unter welcher ID der Support sie erreicht.
 * Rein lesend: Eingerichtet wird per Installer (siehe ops/DEPLOYMENT.md), nicht hier.
 */

/** '123456789' → '123 456 789'; 10-stellig → '1 234 567 890' (Dreiergruppen von rechts, wie in TeamViewer) */
export function formatTeamViewerId(id: string): string {
  const ziffern = id.replace(/\D/g, '')
  const gruppen: string[] = []
  for (let ende = ziffern.length; ende > 0; ende -= 3) {
    gruppen.unshift(ziffern.slice(Math.max(0, ende - 3), ende))
  }
  return gruppen.join(' ')
}

/** '06.10.2026' aus einem ISO-Zeitpunkt (leer, wenn nicht lesbar) */
export function datumKurz(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/**
 * In die Zwischenablage kopieren. Die Kassa läuft im LAN meist über http://<IP> — dort ist
 * navigator.clipboard nicht verfügbar (nur in „sicheren Kontexten"), deshalb der Ersatzweg
 * über ein verstecktes Textfeld + execCommand('copy').
 */
export async function kopiereText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* weiter mit dem Ersatzweg */ }
  try {
    const feld = document.createElement('textarea')
    feld.value = text
    feld.setAttribute('readonly', '')
    feld.style.position = 'fixed'
    feld.style.opacity = '0'
    document.body.appendChild(feld)
    feld.select()
    feld.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(feld)
    return ok
  } catch {
    return false
  }
}

interface AnzeigeProps {
  status:      FernwartungStatus | undefined
  laedt:       boolean
  fehler:      boolean
  kopiert:     boolean
  onKopieren?: (() => void) | undefined
}

/** Reine Darstellung (ohne Daten holen) — getrennt, damit sie sich ohne Browser testen lässt. */
export function FernwartungAnzeige({ status, laedt, fehler, kopiert, onKopieren }: AnzeigeProps) {
  const eingerichtet = status?.eingerichtet === true && !!status.id
  const bereit = !laedt && !fehler && !!status

  return (
    <section className="rounded-xl border border-line bg-panel p-6 space-y-5" data-testid="fernwartung-karte">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink">Fernwartung</h2>
          <p className="mt-0.5 text-sm text-ink-muted">Zugang für den Support dieser Kasse.</p>
        </div>
        {bereit && (
          <span
            data-testid="fernwartung-zustand"
            className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ${
              eingerichtet
                ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
            }`}
          >
            {eingerichtet ? 'Eingerichtet' : 'Nicht eingerichtet'}
          </span>
        )}
      </div>

      {laedt && <p className="text-sm text-ink-subtle">Status wird geladen…</p>}

      {!laedt && fehler && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          Der Fernwartungs-Status konnte nicht geladen werden.
        </div>
      )}

      {bereit && eingerichtet && status && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-ink-muted">TeamViewer-ID</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-3">
              <span data-testid="fernwartung-id" className="font-mono text-2xl font-semibold tracking-wider text-ink">
                {formatTeamViewerId(status.id ?? '')}
              </span>
              <Button variant="secondary" size="sm" onClick={onKopieren} aria-label={kopiert ? 'TeamViewer-ID kopiert' : 'TeamViewer-ID kopieren'}>
                {kopiert ? 'Kopiert ✓' : 'Kopieren'}
              </Button>
            </dd>
            <p className="mt-1.5 text-xs text-ink-muted">Diese ID dem Support nennen.</p>
          </div>
          <div>
            <dt className="text-ink-muted">Anbieter</dt>
            <dd className="mt-0.5 font-medium text-ink">TeamViewer</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-muted">Gerätename</dt>
            <dd className="mt-0.5 break-words font-medium text-ink">{status.alias || '—'}</dd>
          </div>
          {status.gruppe && (
            <div className="min-w-0">
              <dt className="text-ink-muted">Gruppe</dt>
              <dd className="mt-0.5 break-words font-medium text-ink">{status.gruppe}</dd>
            </div>
          )}
          {datumKurz(status.installiertAm) && (
            <div>
              <dt className="text-ink-muted">Eingerichtet am</dt>
              <dd className="mt-0.5 font-medium text-ink">{datumKurz(status.installiertAm)}</dd>
            </div>
          )}
        </dl>
      )}

      {bereit && !eingerichtet && (
        <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-4 text-sm text-ink-muted">
          <p>Auf dieser Kasse ist keine Fernwartung eingerichtet.</p>
          <p>
            Einrichten: den Installer (<span className="font-medium text-ink">Kassa-Setup</span>) zusammen mit
            einer <span className="font-mono text-xs text-ink">fernwartung.json</span> erneut ausführen. Die Anleitung steht
            in <span className="font-mono text-xs text-ink">ops/DEPLOYMENT.md</span>, Abschnitt „Fernwartung (TeamViewer Host)".
          </p>
        </div>
      )}
    </section>
  )
}

function FernwartungKarteAdmin() {
  const [kopiert, setKopiert] = useState(false)

  const statusQ = useQuery({
    queryKey:        ['system-fernwartung'],
    queryFn:         () => systemApi.fernwartung(),
    refetchInterval: 60_000,
    retry:           false,
  })

  async function kopieren() {
    const id = statusQ.data?.id
    if (!id) return
    const ok = await kopiereText(id.replace(/\D/g, ''))
    if (ok) {
      setKopiert(true)
      setTimeout(() => setKopiert(false), 2000)
    }
  }

  return (
    <FernwartungAnzeige
      status={statusQ.data}
      laedt={statusQ.isLoading}
      fehler={statusQ.isError}
      kopiert={kopiert}
      onKopieren={() => { void kopieren() }}
    />
  )
}

/** Karte „Fernwartung" — nur für Administratoren sichtbar. */
export function FernwartungKarte() {
  if (getAuth()?.user.rolle !== 'admin') return null
  return <FernwartungKarteAdmin />
}
