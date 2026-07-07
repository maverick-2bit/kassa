import type { SetupResponse } from '@kassa/shared'

interface Props {
  data: SetupResponse
}

export function SetupSuccess({ data }: Props) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-green-600">
          <svg className="h-9 w-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
        </span>
        <h2 className="mt-4 text-2xl font-semibold text-ink">
          Kasse erfolgreich eingerichtet
        </h2>
        <p className="mt-2 max-w-sm text-sm text-ink-muted">
          Die Kasse ist bei FinanzOnline registriert. Prüfe den Startbeleg zum
          Abschluss mit der BMF-BelegCheck-App (QR-Code scannen). Du kannst jetzt
          Belege erstellen.
        </p>
      </div>

      <div className="rounded-lg border border-line bg-panel-2 p-4 text-sm">
        <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-3 sm:gap-x-4">
          <div className="sm:col-span-1">
            <dt className="font-medium text-ink-muted">Startbeleg-Nr.</dt>
            <dd className="text-ink">#{data.startbelegNummer}</dd>
          </div>
          {data.pruefwert && (
            <div className="sm:col-span-2">
              <dt className="font-medium text-ink-muted">FinanzOnline-Kassenstatus</dt>
              <dd className="font-mono text-xs text-ink break-all">{data.pruefwert}</dd>
            </div>
          )}
          {data.startbelegMaschinenlesbareCode && (
            <div className="sm:col-span-3">
              <dt className="font-medium text-ink-muted mb-1">Maschinenlesbarer Code</dt>
              <dd className="font-mono text-xs text-ink break-all bg-panel p-2 rounded border border-line">
                {data.startbelegMaschinenlesbareCode}
              </dd>
            </div>
          )}
        </dl>
      </div>

      <p className="text-center text-xs text-ink-muted">
        Mandant: <span className="font-mono">{data.mandantId}</span> ·
        Kasse: <span className="font-mono">{data.kasseId}</span>
      </p>
    </div>
  )
}
