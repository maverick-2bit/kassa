import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import {
  STATION_LABELS,
  ALLE_STATIONEN,
  type Bonierdrucker,
  type KategorieFarbe,
  type KategorieInput,
  type Kategorie,
  type Station,
} from '@kassa/shared'
import { Field } from './ui/Field'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { Button } from './ui/Button'
import { FarbAuswahl } from './FarbAuswahl'
import { baumFlach, nachkommenIds } from '../lib/kategorie-baum'

type FormValues = {
  name:            string
  farbe:           KategorieFarbe
  parentId:        string
  reihenfolge:     string
  bonierdruckerId: string
  station:         string
}

interface Props {
  initial?:       Kategorie | null
  /** Alle Warengruppen — für die Auswahl „Übergeordnete Gruppe" */
  kategorien?:    Kategorie[] | undefined
  bonierdrucker?: Bonierdrucker[] | undefined
  onSubmit:       (input: KategorieInput) => void
  onCancel:       () => void
  loading?:       boolean
  fehler?:        string | undefined
}

export function KategorieFormular({ initial, kategorien, bonierdrucker, onSubmit, onCancel, loading, fehler }: Props) {
  const { register, handleSubmit, formState: { errors }, reset, setValue, watch } = useForm<FormValues>({
    defaultValues: {
      name:            initial?.name               ?? '',
      farbe:           initial?.farbe              ?? 'grau',
      parentId:        initial?.parentId           ?? '',
      reihenfolge:     String(initial?.reihenfolge ?? 0),
      bonierdruckerId: initial?.bonierdruckerId    ?? '',
      station:         initial?.station            ?? '',
    },
  })

  useEffect(() => {
    reset({
      name:            initial?.name               ?? '',
      farbe:           initial?.farbe              ?? 'grau',
      parentId:        initial?.parentId           ?? '',
      reihenfolge:     String(initial?.reihenfolge ?? 0),
      bonierdruckerId: initial?.bonierdruckerId    ?? '',
      station:         initial?.station            ?? '',
    })
  }, [initial, reset])

  // Auswahl: nicht die Gruppe selbst und nicht ihre eigenen Untergruppen (Zyklus)
  const parentOptionen = (() => {
    const alle = kategorien ?? []
    const gesperrt = new Set(initial ? [initial.id, ...nachkommenIds(alle, initial.id)] : [])
    return baumFlach(alle).filter(e => !gesperrt.has(e.kategorie.id))
  })()

  const submit = handleSubmit((values) => {
    onSubmit({
      name:            values.name.trim(),
      farbe:           values.farbe,
      parentId:        values.parentId || null,
      reihenfolge:     parseInt(values.reihenfolge || '0', 10) || 0,
      bonierdruckerId: values.bonierdruckerId || null,
      station:         (values.station || null) as Station | null,
      // Wird zentral im SB-Terminal-Bereich der Einstellungen verwaltet — hier nur erhalten
      terminalSichtbar: initial?.terminalSichtbar ?? false,
    })
  })

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Name" required error={errors.name?.message}>
        <Input
          placeholder="Getränke"
          autoFocus
          invalid={!!errors.name}
          {...register('name', { required: 'Name erforderlich' })}
        />
      </Field>

      <Field label="Farbe" required hint="Färbt die Artikel-Kacheln dieser Warengruppe (einzelne Artikel können abweichen)">
        <FarbAuswahl
          wert={watch('farbe')}
          onChange={(f) => { if (f) setValue('farbe', f as KategorieFarbe) }}
        />
      </Field>

      {kategorien && (
        <Field label="Übergeordnete Gruppe" hint="Leer = Hauptgruppe (eigener Reiter). Mit Auswahl erscheint diese Gruppe als Kachel in der übergeordneten Gruppe.">
          <Select {...register('parentId')}>
            <option value="">— keine (Hauptgruppe) —</option>
            {parentOptionen.map(({ kategorie: k, tiefe }) => (
              <option key={k.id} value={k.id}>{'\u00a0\u00a0'.repeat(tiefe)}{tiefe > 0 ? '↳ ' : ''}{k.name}{k.aktiv ? '' : ' (deaktiviert)'}</option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Reihenfolge" hint="Kleinere Zahl = weiter links im Tab bzw. früher in der Kachelreihe">
        <Input
          type="number"
          min="0"
          step="1"
          placeholder="0"
          className="w-32"
          {...register('reihenfolge')}
        />
      </Field>

      <Field label="KDS-Station (Vorgabe)" hint="Gilt für alle Artikel dieser Warengruppe — einzelne Artikel können abweichen">
        <Select {...register('station')}>
          <option value="">— keine Vorgabe —</option>
          {ALLE_STATIONEN.map(s => (
            <option key={s} value={s}>{STATION_LABELS[s]}</option>
          ))}
        </Select>
      </Field>

      {bonierdrucker && bonierdrucker.length > 0 && (
        <Field label="Standard-Bonierdrucker" hint="Gilt für alle Artikel dieser Kategorie (überschreibbar pro Artikel)">
          <Select {...register('bonierdruckerId')}>
            <option value="">— kein Bonierdrucker —</option>
            {bonierdrucker.filter(d => d.aktiv).map(d => (
              <option key={d.id} value={d.id}>
                {d.name} {d.istBackup ? '(Backup)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {fehler && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {fehler}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-line">
        <Button variant="secondary" type="button" onClick={onCancel}>Abbrechen</Button>
        <Button type="submit" loading={loading}>
          {initial ? 'Speichern' : 'Anlegen'}
        </Button>
      </div>
    </form>
  )
}
