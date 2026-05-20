import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import {
  ALLE_STATIONEN,
  MWST_LABELS,
  STATION_LABELS,
  type Artikel,
  type ArtikelInput,
  type MwStSatz,
  type Station,
} from '@kassa/shared'
import { Field } from './ui/Field'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { Button } from './ui/Button'
import { formatPreis, parseEuroToCent } from '../lib/format'

type FormValues = {
  bezeichnung:   string
  preisEuro:     string
  mwstSatz:      MwStSatz
  artikelnummer: string
  station:       Station | ''
}

interface Props {
  mandantId: string
  initial?:  Artikel | null
  onSubmit:  (input: ArtikelInput) => void
  onCancel:  () => void
  loading?:  boolean
  fehler?:   string | undefined
}

const MWST_OPTIONS: MwStSatz[] = ['normal', 'ermaessigt1', 'ermaessigt2', 'null', 'besonders']

export function ArtikelFormular({ mandantId, initial, onSubmit, onCancel, loading, fehler }: Props) {
  const [preisFehler, setPreisFehler] = useState<string | null>(null)

  const { register, handleSubmit, formState: { errors }, reset } = useForm<FormValues>({
    defaultValues: {
      bezeichnung:   initial?.bezeichnung   ?? '',
      preisEuro:     initial ? (initial.preisBruttoCent / 100).toFixed(2).replace('.', ',') : '',
      mwstSatz:      initial?.mwstSatz      ?? 'normal',
      artikelnummer: initial?.artikelnummer ?? '',
      station:       initial?.station       ?? '',
    },
  })

  useEffect(() => {
    reset({
      bezeichnung:   initial?.bezeichnung   ?? '',
      preisEuro:     initial ? (initial.preisBruttoCent / 100).toFixed(2).replace('.', ',') : '',
      mwstSatz:      initial?.mwstSatz      ?? 'normal',
      artikelnummer: initial?.artikelnummer ?? '',
      station:       initial?.station       ?? '',
    })
  }, [initial, reset])

  const submit = handleSubmit((values) => {
    const cent = parseEuroToCent(values.preisEuro)
    if (cent === null || cent < 0) {
      setPreisFehler('Preis ungültig (z.B. "12,50")')
      return
    }
    setPreisFehler(null)
    onSubmit({
      mandantId,
      bezeichnung:     values.bezeichnung.trim(),
      preisBruttoCent: cent,
      mwstSatz:        values.mwstSatz,
      ...(values.artikelnummer.trim() && { artikelnummer: values.artikelnummer.trim() }),
      station:         values.station || null,
    })
  })

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Bezeichnung" required error={errors.bezeichnung?.message}>
        <Input
          placeholder="Espresso"
          autoFocus
          invalid={!!errors.bezeichnung}
          {...register('bezeichnung', { required: 'Bezeichnung erforderlich' })}
        />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Preis (brutto)" required hint="z.B. 3,50" error={preisFehler ?? undefined}>
          <Input
            placeholder="3,50"
            inputMode="decimal"
            invalid={!!preisFehler}
            {...register('preisEuro', { required: true })}
          />
        </Field>
        <Field label="MwSt-Satz" required>
          <Select {...register('mwstSatz', { required: true })}>
            {MWST_OPTIONS.map((s) => (
              <option key={s} value={s}>{MWST_LABELS[s]}</option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Artikelnummer" hint="Optional, z.B. ESP-01">
          <Input placeholder="" {...register('artikelnummer')} />
        </Field>
        <Field label="KDS-Station" hint="Zielstation für Bonierbon (Küche, Schank …)">
          <Select {...register('station')}>
            <option value="">— ohne KDS-Bonierung —</option>
            {ALLE_STATIONEN.map((s) => (
              <option key={s} value={s}>{STATION_LABELS[s]}</option>
            ))}
          </Select>
        </Field>
      </div>

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
