import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { MANDANT_MODUL_BESCHREIBUNGEN, MANDANT_MODUL_LABELS, SetupInputSchema, type MandantModul, type SetupInput } from '@kassa/shared'
import { Field } from './ui/Field'
import { Input } from './ui/Input'
import { Button } from './ui/Button'

interface Props {
  onSubmit: (data: SetupInput) => void
  loading?: boolean
  error?:   string | undefined
}

export function SetupForm({ onSubmit, loading = false, error }: Props) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<SetupInput>({
    resolver: zodResolver(SetupInputSchema),
    defaultValues: {
      firmenname: '',
      uid:        '',
      kassenId:   '',
      finanzOnline: {
        teilnehmerId:    '',
        benutzerkennung: '',
        pin:             '',
      },
      umgebung: 'test',
      admin: {
        name:     '',
        email:    '',
        passwort: '',
      },
      module: {
        gastro:    true,
        angebote:  false,
        mergeport: false,
      },
    },
  })

  const umgebung = watch('umgebung')
  const module   = watch('module')

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-8" noValidate>
      {/* Sektion: Unternehmensdaten */}
      <fieldset className="space-y-4">
        <SectionHeader title="Unternehmensdaten" subtitle="Wem gehört die Kasse?" />
        <Field label="Firmenname" htmlFor="firmenname" required error={errors.firmenname?.message}>
          <Input
            id="firmenname"
            placeholder="Restaurant Mustermann GmbH"
            autoComplete="organization"
            invalid={!!errors.firmenname}
            {...register('firmenname')}
          />
        </Field>
        <Field
          label="UID-Nummer"
          htmlFor="uid"
          required
          hint="Österreichische Umsatzsteuer-ID, Format: ATU + 8 Ziffern"
          error={errors.uid?.message}
        >
          <Input
            id="uid"
            placeholder="ATU12345678"
            invalid={!!errors.uid}
            {...register('uid')}
          />
        </Field>
      </fieldset>

      {/* Sektion: Kasse */}
      <fieldset className="space-y-4">
        <SectionHeader title="Kasse" subtitle="Eindeutige Kennung für diese Registrierkasse" />
        <Field
          label="Kassen-ID"
          htmlFor="kassenId"
          required
          hint="Z. B. KASSE-001 oder STANDORT-A-01. Wird bei FinanzOnline hinterlegt."
          error={errors.kassenId?.message}
        >
          <Input
            id="kassenId"
            placeholder="KASSE-001"
            invalid={!!errors.kassenId}
            {...register('kassenId')}
          />
        </Field>
      </fieldset>

      {/* Sektion: FinanzOnline (optional) */}
      <fieldset className="space-y-4">
        <SectionHeader
          title="FinanzOnline-Zugang (optional)"
          subtitle="Zugangsdaten Ihres FinanzOnline-Kontos — nur für die Registrierung verwendet, nicht gespeichert."
        />
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <strong>Kurzfristig ohne FinanzOnline?</strong> Diese Felder leer lassen — die Kasse wird
          dann <em>provisorisch</em> eingerichtet und kann sofort kassieren. Die FinanzOnline-Registrierung
          ist anschließend zeitnah nachzutragen (Warnhinweis erscheint danach in der App). Entweder alle
          drei Felder ausfüllen oder alle leer lassen.
        </div>
        <Field label="Teilnehmer-ID (TID)" htmlFor="tid" error={errors.finanzOnline?.teilnehmerId?.message}>
          <Input
            id="tid"
            invalid={!!errors.finanzOnline?.teilnehmerId}
            {...register('finanzOnline.teilnehmerId')}
          />
        </Field>
        <Field label="Benutzerkennung (BenID)" htmlFor="benid" error={errors.finanzOnline?.benutzerkennung?.message}>
          <Input
            id="benid"
            invalid={!!errors.finanzOnline?.benutzerkennung}
            {...register('finanzOnline.benutzerkennung')}
          />
        </Field>
        <Field label="PIN" htmlFor="pin" error={errors.finanzOnline?.pin?.message}>
          <Input
            id="pin"
            type="password"
            autoComplete="off"
            invalid={!!errors.finanzOnline?.pin}
            {...register('finanzOnline.pin')}
          />
        </Field>
      </fieldset>

      {/* Sektion: Administrator */}
      <fieldset className="space-y-4">
        <SectionHeader
          title="Administrator"
          subtitle="Erster Benutzer für die Anmeldung nach der Einrichtung"
        />
        <Field label="Name" htmlFor="admin-name" required error={errors.admin?.name?.message}>
          <Input
            id="admin-name"
            placeholder="Max Mustermann"
            autoComplete="name"
            invalid={!!errors.admin?.name}
            {...register('admin.name')}
          />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="E-Mail" htmlFor="admin-email" required error={errors.admin?.email?.message}>
            <Input
              id="admin-email"
              type="email"
              placeholder="admin@firma.at"
              autoComplete="email"
              invalid={!!errors.admin?.email}
              {...register('admin.email')}
            />
          </Field>
          <Field
            label="Passwort"
            htmlFor="admin-passwort"
            required
            hint="Mindestens 8 Zeichen"
            error={errors.admin?.passwort?.message}
          >
            <Input
              id="admin-passwort"
              type="password"
              autoComplete="new-password"
              invalid={!!errors.admin?.passwort}
              {...register('admin.passwort')}
            />
          </Field>
        </div>
      </fieldset>

      {/* Sektion: Umgebung */}
      <fieldset className="space-y-3">
        <SectionHeader title="Umgebung" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UmgebungOption
            value="test"
            checked={umgebung === 'test'}
            register={register('umgebung')}
            title="Testumgebung"
            description="FinanzOnline-Testserver. Empfohlen für den ersten Test."
          />
          <UmgebungOption
            value="produktion"
            checked={umgebung === 'produktion'}
            register={register('umgebung')}
            title="Produktion"
            description="Echtbetrieb. Registrierung ist verbindlich."
          />
        </div>
      </fieldset>

      {/* Sektion: Module */}
      <fieldset className="space-y-3">
        <SectionHeader
          title="Module aktivieren"
          subtitle="Welche Funktionen benötigst du? Kann jederzeit unter Einstellungen → Module geändert werden."
        />
        <div className="space-y-2">
          {(['gastro', 'angebote', 'mergeport', 'reservierungen', 'zeiterfassung', 'sbTerminal'] as MandantModul[]).map((modul) => (
            <label
              key={modul}
              className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition ${
                module?.[modul]
                  ? 'border-brand-400 bg-brand-50/50 ring-1 ring-brand-400'
                  : 'border-line hover:border-line-strong'
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5 rounded border-line-strong text-brand-600 focus:ring-brand-500"
                {...register(`module.${modul}`)}
              />
              <div>
                <p className="text-sm font-medium text-ink">{MANDANT_MODUL_LABELS[modul]}</p>
                <p className="text-xs text-ink-muted mt-0.5">{MANDANT_MODUL_BESCHREIBUNGEN[modul]}</p>
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-3 pt-4 border-t border-line">
        <Button type="submit" loading={loading}>
          Kasse einrichten
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Sub-Komponenten
// ---------------------------------------------------------------------------

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {subtitle && <p className="text-sm text-ink-muted mt-0.5">{subtitle}</p>}
    </div>
  )
}

interface UmgebungOptionProps {
  value:       'test' | 'produktion'
  checked:     boolean
  title:       string
  description: string
  register:    ReturnType<ReturnType<typeof useForm<SetupInput>>['register']>
}

function UmgebungOption({ value, checked, title, description, register }: UmgebungOptionProps) {
  return (
    <label
      className={`relative flex cursor-pointer rounded-lg border p-3 ${
        checked
          ? 'border-brand-500 ring-1 ring-brand-500 bg-brand-50/50'
          : 'border-line-strong hover:border-line-strong'
      }`}
    >
      <input type="radio" value={value} className="sr-only" {...register} />
      <span className="flex flex-1 flex-col">
        <span className="text-sm font-medium text-ink">{title}</span>
        <span className="mt-1 text-xs text-ink-muted">{description}</span>
      </span>
      {checked && (
        <svg className="h-5 w-5 text-brand-500 shrink-0" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm3.7-9.3a1 1 0 0 0-1.4-1.4L9 10.6 7.7 9.3a1 1 0 1 0-1.4 1.4l2 2a1 1 0 0 0 1.4 0l4-4z" clipRule="evenodd"/>
        </svg>
      )}
    </label>
  )
}
