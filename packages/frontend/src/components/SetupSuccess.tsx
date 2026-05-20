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
        <h2 className="mt-4 text-2xl font-semibold text-gray-900">
          Kasse erfolgreich eingerichtet
        </h2>
        <p className="mt-2 max-w-sm text-sm text-gray-600">
          Die Kasse ist bei FinanzOnline registriert und der Startbeleg wurde geprüft.
          Sie können jetzt Belege erstellen.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
        <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-3 sm:gap-x-4">
          <div className="sm:col-span-1">
            <dt className="font-medium text-gray-500">Startbeleg-Nr.</dt>
            <dd className="text-gray-900">#{data.startbelegNummer}</dd>
          </div>
          {data.pruefwert && (
            <div className="sm:col-span-2">
              <dt className="font-medium text-gray-500">FinanzOnline-Prüfwert</dt>
              <dd className="font-mono text-xs text-gray-900 break-all">{data.pruefwert}</dd>
            </div>
          )}
          {data.startbelegMaschinenlesbareCode && (
            <div className="sm:col-span-3">
              <dt className="font-medium text-gray-500 mb-1">Maschinenlesbarer Code</dt>
              <dd className="font-mono text-xs text-gray-700 break-all bg-white p-2 rounded border border-gray-200">
                {data.startbelegMaschinenlesbareCode}
              </dd>
            </div>
          )}
        </dl>
      </div>

      <p className="text-center text-xs text-gray-500">
        Mandant: <span className="font-mono">{data.mandantId}</span> ·
        Kasse: <span className="font-mono">{data.kasseId}</span>
      </p>
    </div>
  )
}
