import type { EinrichtungsSchrittDto } from '@kassa/shared'

const SCHRITT_LABELS: Record<EinrichtungsSchrittDto['schritt'], string> = {
  'eingabe-validierung':         'Eingabe prüfen',
  'see-generierung':             'Zertifikat erstellen',
  'finanzonline-registrierung':  'Bei FinanzOnline registrieren',
  'startbeleg-erstellung':       'Startbeleg signieren',
  'startbeleg-pruefung':         'Startbeleg prüfen lassen',
}

const ALLE_SCHRITTE: EinrichtungsSchrittDto['schritt'][] = [
  'eingabe-validierung',
  'see-generierung',
  'finanzonline-registrierung',
  'startbeleg-erstellung',
  'startbeleg-pruefung',
]

interface Props {
  schritte: EinrichtungsSchrittDto[]
  pending?: boolean
}

export function SetupProgress({ schritte, pending = false }: Props) {
  /** Letzten Status pro Schritt ermitteln */
  const statusMap = new Map<EinrichtungsSchrittDto['schritt'], EinrichtungsSchrittDto>()
  for (const s of schritte) statusMap.set(s.schritt, s)

  return (
    <ol className="space-y-3">
      {ALLE_SCHRITTE.map((typ) => {
        const eintrag = statusMap.get(typ)
        const status  = eintrag?.status ?? 'wartet'
        return (
          <li key={typ} className="flex items-start gap-3">
            <StatusIcon status={status} pending={pending && !eintrag} />
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${status === 'fehler' ? 'text-red-700' : 'text-ink'}`}>
                {SCHRITT_LABELS[typ]}
              </p>
              {eintrag?.meldung && (
                <p className={`text-xs mt-0.5 ${status === 'fehler' ? 'text-red-600' : 'text-ink-muted'}`}>
                  {eintrag.meldung}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function StatusIcon({ status, pending }: { status: string; pending: boolean }) {
  if (status === 'erfolgreich') {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-500 text-white">
        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L9 11.6l6.3-6.3a1 1 0 0 1 1.4 0z" clipRule="evenodd"/>
        </svg>
      </span>
    )
  }
  if (status === 'fehler') {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-white">
        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.3 5.3a1 1 0 0 1 1.4 0L10 8.6l3.3-3.3a1 1 0 1 1 1.4 1.4L11.4 10l3.3 3.3a1 1 0 1 1-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 1 1-1.4-1.4L8.6 10 5.3 6.7a1 1 0 0 1 0-1.4z" clipRule="evenodd"/>
        </svg>
      </span>
    )
  }
  if (status === 'startet' || pending) {
    return (
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white">
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.3" strokeWidth="4"/>
          <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/>
        </svg>
      </span>
    )
  }
  return (
    <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-line-strong" />
  )
}
