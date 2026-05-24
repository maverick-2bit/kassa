import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import {
  ALLE_STATIONEN,
  MWST_LABELS,
  STATION_LABELS,
  type Artikel,
  type ArtikelInput,
  type Bonierdrucker,
  type Kategorie,
  type MwStSatz,
  type Station,
} from '@kassa/shared'
import { Field } from './ui/Field'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { Button } from './ui/Button'
import { formatPreis, parseEuroToCent } from '../lib/format'

type FormValues = {
  bezeichnung:        string
  preisEuro:          string
  mwstSatz:           MwStSatz
  station:            Station | ''
  kategorieId:        string
  istFavorit:         boolean
  bonierdruckerId:    string
  lagerstandAktiv:    boolean
  lagerstandMengeStr: string
}

interface Props {
  mandantId:    string
  initial?:     Artikel | null
  kategorien?:  Kategorie[] | undefined
  bonierdrucker?: Bonierdrucker[] | undefined
  onSubmit:     (input: ArtikelInput) => void
  onCancel:     () => void
  loading?:     boolean
  fehler?:      string | undefined
}

const MWST_OPTIONS: MwStSatz[] = ['normal', 'ermaessigt1', 'ermaessigt2', 'null', 'besonders']

export function ArtikelFormular({ mandantId, initial, kategorien, bonierdrucker, onSubmit, onCancel, loading, fehler }: Props) {
  const [preisFehler, setPreisFehler] = useState<string | null>(null)

  const { register, handleSubmit, formState: { errors }, reset, watch } = useForm<FormValues>({
    defaultValues: {
      bezeichnung:        initial?.bezeichnung      ?? '',
      preisEuro:          initial ? (initial.preisBruttoCent / 100).toFixed(2).replace('.', ',') : '',
      mwstSatz:           initial?.mwstSatz         ?? 'normal',
      station:            initial?.station          ?? '',
      kategorieId:        initial?.kategorieId      ?? '',
      istFavorit:         initial?.istFavorit       ?? false,
      bonierdruckerId:    initial?.bonierdruckerId  ?? '',
      lagerstandAktiv:    initial?.lagerstandAktiv  ?? false,
      lagerstandMengeStr: initial?.lagerstandMenge != null ? String(initial.lagerstandMenge) : '',
    },
  })

  const lagerstandAktiv = watch('lagerstandAktiv')

  useEffect(() => {
    reset({
      bezeichnung:        initial?.bezeichnung      ?? '',
      preisEuro:          initial ? (initial.preisBruttoCent / 100).toFixed(2).replace('.', ',') : '',
      mwstSatz:           initial?.mwstSatz         ?? 'normal',
      station:            initial?.station          ?? '',
      kategorieId:        initial?.kategorieId      ?? '',
      istFavorit:         initial?.istFavorit       ?? false,
      bonierdruckerId:    initial?.bonierdruckerId  ?? '',
      lagerstandAktiv:    initial?.lagerstandAktiv  ?? false,
      lagerstandMengeStr: initial?.lagerstandMenge != null ? String(initial.lagerstandMenge) : '',
    })
  }, [initial, reset])

  const submit = handleSubmit((values) => {
    const cent = parseEuroToCent(values.preisEuro)
    if (cent === null || cent < 0) {
      setPreisFehler('Preis ungültig (z.B. "12,50")')
      return
    }
    setPreisFehler(null)
    const lsMenge = values.lagerstandAktiv && values.lagerstandMengeStr.trim() !== ''
      ? parseInt(values.lagerstandMengeStr.trim(), 10)
      : null
    onSubmit({
      mandantId,
      bezeichnung:     values.bezeichnung.trim(),
      preisBruttoCent: cent,
      mwstSatz:        values.mwstSatz,
      station:         values.station          || null,
      kategorieId:     values.kategorieId      || null,
      istFavorit:      values.istFavorit,
      bonierdruckerId: values.bonierdruckerId  || null,
      lagerstandAktiv: values.lagerstandAktiv,
      lagerstandMenge: lsMenge,
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

      <Field label="KDS-Station" hint="Zielstation für Bonierbon (Küche, Schank …)">
        <Select {...register('station')}>
          <option value="">— ohne KDS-Bonierung —</option>
          {ALLE_STATIONEN.map((s) => (
            <option key={s} value={s}>{STATION_LABELS[s]}</option>
          ))}
        </Select>
      </Field>

      {kategorien && kategorien.length > 0 && (
        <Field label="Kategorie" hint="Gruppierung in der Kassen-Ansicht">
          <Select {...register('kategorieId')}>
            <option value="">— ohne Kategorie —</option>
            {kategorien
              .filter(k => k.aktiv)
              .sort((a, b) => a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name))
              .map((k) => (
                <option key={k.id} value={k.id}>{k.name}</option>
              ))}
          </Select>
        </Field>
      )}

      {/* Favorit + Bonierdrucker */}
      <div className="rounded-lg border border-gray-200 p-3 space-y-3">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300 text-amber-500 focus:ring-amber-400"
            {...register('istFavorit')}
          />
          <div>
            <p className="text-sm font-medium text-gray-800">⭐ Favorit</p>
            <p className="text-xs text-gray-400">Erscheint im Favoriten-Tab der Kasse</p>
          </div>
        </label>

        {bonierdrucker && bonierdrucker.length > 0 && (
          <Field label="Bonierdrucker (Override)" hint="Überschreibt den Drucker der Warengruppe">
            <Select {...register('bonierdruckerId')}>
              <option value="">— Standard der Warengruppe —</option>
              {bonierdrucker.filter(d => d.aktiv).map(d => (
                <option key={d.id} value={d.id}>
                  {d.name} {d.istBackup ? '(Backup)' : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {/* Lagerstand / Countdown */}
      <div className="rounded-lg border border-gray-200 p-3 space-y-3">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
            {...register('lagerstandAktiv')}
          />
          <div>
            <p className="text-sm font-medium text-gray-800">Lagerstand (Countdown)</p>
            <p className="text-xs text-gray-400">
              Artikel wird bei Bestand&nbsp;= 0 automatisch gesperrt
            </p>
          </div>
        </label>

        {lagerstandAktiv && (
          <Field label="Aktueller Bestand" hint="Leer = unbegrenzt (Countdown deaktiviert)">
            <Input
              type="number"
              min="0"
              step="1"
              placeholder="z. B. 12"
              className="w-36"
              {...register('lagerstandMengeStr')}
            />
          </Field>
        )}
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
