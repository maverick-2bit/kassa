import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import {
  KATEGORIE_FARBE_LABELS,
  type Bonierdrucker,
  type KategorieFarbe,
  type KategorieInput,
  type Kategorie,
} from '@kassa/shared'
import { Field } from './ui/Field'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { Button } from './ui/Button'

const ALLE_FARBEN: KategorieFarbe[] = [
  'grau', 'rot', 'orange', 'gelb', 'gruen', 'blau', 'lila', 'pink',
]

type FormValues = {
  name:            string
  farbe:           KategorieFarbe
  reihenfolge:     string
  bonierdruckerId: string
}

interface Props {
  initial?:       Kategorie | null
  bonierdrucker?: Bonierdrucker[] | undefined
  onSubmit:       (input: KategorieInput) => void
  onCancel:       () => void
  loading?:       boolean
  fehler?:        string | undefined
}

export function KategorieFormular({ initial, bonierdrucker, onSubmit, onCancel, loading, fehler }: Props) {
  const { register, handleSubmit, formState: { errors }, reset } = useForm<FormValues>({
    defaultValues: {
      name:            initial?.name               ?? '',
      farbe:           initial?.farbe              ?? 'grau',
      reihenfolge:     String(initial?.reihenfolge ?? 0),
      bonierdruckerId: initial?.bonierdruckerId    ?? '',
    },
  })

  useEffect(() => {
    reset({
      name:            initial?.name               ?? '',
      farbe:           initial?.farbe              ?? 'grau',
      reihenfolge:     String(initial?.reihenfolge ?? 0),
      bonierdruckerId: initial?.bonierdruckerId    ?? '',
    })
  }, [initial, reset])

  const submit = handleSubmit((values) => {
    onSubmit({
      name:            values.name.trim(),
      farbe:           values.farbe,
      reihenfolge:     parseInt(values.reihenfolge || '0', 10) || 0,
      bonierdruckerId: values.bonierdruckerId || null,
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Farbe" required>
          <Select {...register('farbe', { required: true })}>
            {ALLE_FARBEN.map((f) => (
              <option key={f} value={f}>{KATEGORIE_FARBE_LABELS[f]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Reihenfolge" hint="Kleinere Zahl = weiter links im Tab">
          <Input
            type="number"
            min="0"
            step="1"
            placeholder="0"
            {...register('reihenfolge')}
          />
        </Field>
      </div>

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

      <div className="flex justify-end gap-2 pt-2 border-t border-gray-200">
        <Button variant="secondary" type="button" onClick={onCancel}>Abbrechen</Button>
        <Button type="submit" loading={loading}>
          {initial ? 'Speichern' : 'Anlegen'}
        </Button>
      </div>
    </form>
  )
}
