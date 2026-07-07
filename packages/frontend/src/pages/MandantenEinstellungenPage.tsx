import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MANDANT_MODUL_LABELS,
  MANDANT_MODUL_BESCHREIBUNGEN,
  type MandantModul,
  type MandantModule,
} from '@kassa/shared'
import { mandantApi } from '../lib/api'
import { updateMandantModule } from '../lib/auth'

// Reihenfolge + Icons der Module
const MODULE_LISTE: { modul: MandantModul; icon: string }[] = [
  { modul: 'gastro',         icon: '🍽️' },
  { modul: 'reservierungen', icon: '📅' },
  { modul: 'angebote',       icon: '📄' },
  { modul: 'mergeport',      icon: '🛵' },
  { modul: 'zeiterfassung',  icon: '🕒' },
  { modul: 'sbTerminal',     icon: '🛒' },
]

export function MandantenEinstellungenPage() {
  const queryClient = useQueryClient()

  const moduleQuery = useQuery({
    queryKey: ['mandant-module'],
    queryFn:  mandantApi.getModule,
  })

  const speichern = useMutation({
    mutationFn: mandantApi.patchModule,
    onSuccess: (data) => {
      // LocalStorage sofort aktualisieren → hasModul() gibt ohne Re-Login den neuen Wert zurück
      updateMandantModule(data)
      queryClient.setQueryData(['mandant-module'], data)
    },
  })

  const toggleModul = (modul: MandantModul, aktiv: boolean) => {
    const key = modulKey(modul)
    speichern.mutate({ [key]: aktiv })
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-ink">Module</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Funktionsbereiche für diesen Mandanten aktivieren oder deaktivieren.
          Änderungen werden sofort wirksam — eine neue Anmeldung ist nicht erforderlich.
        </p>
      </header>

      {moduleQuery.isLoading ? (
        <div className="rounded-lg border border-line bg-panel p-8 text-center text-sm text-ink-subtle">
          Wird geladen…
        </div>
      ) : moduleQuery.isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          Fehler beim Laden der Modul-Einstellungen.
        </div>
      ) : moduleQuery.data ? (
        <div className="space-y-3">
          {MODULE_LISTE.map(({ modul, icon }) => (
            <ModulKarte
              key={modul}
              modul={modul}
              icon={icon}
              aktiv={getModulWert(moduleQuery.data!, modul)}
              onToggle={(v) => toggleModul(modul, v)}
              speichertGerade={speichern.isPending}
            />
          ))}
        </div>
      ) : null}

      {speichern.isError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {speichern.error instanceof Error
            ? speichern.error.message
            : 'Fehler beim Speichern'}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modul-Karte
// ---------------------------------------------------------------------------

function ModulKarte({
  modul,
  icon,
  aktiv,
  onToggle,
  speichertGerade,
}: {
  modul:           MandantModul
  icon:            string
  aktiv:           boolean
  onToggle:        (v: boolean) => void
  speichertGerade: boolean
}) {
  const [hovering, setHovering] = useState(false)

  return (
    <div
      data-testid={`modul-karte-${modul}`}
      className={`rounded-lg border bg-panel p-5 flex items-start gap-4 transition-shadow ${
        aktiv ? 'border-brand-200 shadow-sm' : 'border-line'
      }`}
    >
      {/* Icon */}
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xl ${
          aktiv ? 'bg-brand-50' : 'bg-panel-2'
        }`}
      >
        {icon}
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className={`font-semibold text-sm ${aktiv ? 'text-ink' : 'text-ink-muted'}`}>
          {MANDANT_MODUL_LABELS[modul]}
        </p>
        <p className="mt-0.5 text-xs text-ink-muted leading-relaxed">
          {MANDANT_MODUL_BESCHREIBUNGEN[modul]}
        </p>
      </div>

      {/* Toggle */}
      <button
        type="button"
        role="switch"
        aria-checked={aktiv}
        disabled={speichertGerade}
        onClick={() => onToggle(!aktiv)}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:opacity-60 ${
          aktiv
            ? hovering ? 'bg-brand-600' : 'bg-brand-500'
            : hovering ? 'bg-line-strong' : 'bg-line'
        }`}
        title={aktiv ? 'Deaktivieren' : 'Aktivieren'}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-panel shadow transition-transform ${
            aktiv ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function modulKey(modul: MandantModul): keyof MandantModule {
  if (modul === 'gastro')         return 'modulGastroAktiv'
  if (modul === 'angebote')       return 'modulAngeboteAktiv'
  if (modul === 'mergeport')      return 'modulMergeportAktiv'
  if (modul === 'reservierungen') return 'modulReservierungenAktiv'
  if (modul === 'sbTerminal')     return 'modulSbTerminalAktiv'
  return 'modulZeiterfassungAktiv'
}

function getModulWert(data: MandantModule, modul: MandantModul): boolean {
  return data[modulKey(modul)]
}
