import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { druckerPoolApi } from '../lib/api'
import { hasBerechtigung } from '../lib/auth'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

/**
 * Eigener Drucker für Tagesabschluss (Z-Bon) und Kassensturz — unabhängig vom
 * Bondrucker der Kasse. Auswahl aus der Drucker-Bibliothek; die Wahl wird je
 * Gerät gemerkt (das Gerät steht meist beim Büro-/Abrechnungsdrucker). Wer
 * Einstellungen ändern darf, kann hier auch gleich einen neuen Drucker anlegen.
 */

const KEY = 'kassa:abrechnungsDrucker'
const KASSEN_DRUCKER = ''

function gemerkt(): string {
  try { return localStorage.getItem(KEY) ?? KASSEN_DRUCKER } catch { return KASSEN_DRUCKER }
}

function merke(id: string): void {
  try {
    if (id === KASSEN_DRUCKER) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, id)
  } catch { /* Speicher gesperrt: Wahl gilt dann nur bis zum Neuladen */ }
}

export function useAbrechnungsDrucker() {
  const [auswahl, setAuswahl] = useState<string>(gemerkt())
  const query = useQuery({
    queryKey:  ['drucker-pool'],
    queryFn:   () => druckerPoolApi.list(),
    staleTime: 30_000,
  })
  const drucker = (query.data ?? []).filter(d => d.aktiv)
  // Gemerkter Drucker wurde inzwischen gelöscht/deaktiviert → zurück auf den Kassen-Drucker
  const gueltig = auswahl === KASSEN_DRUCKER || drucker.some(d => d.id === auswahl) || query.isLoading
  const druckerId = gueltig && auswahl !== KASSEN_DRUCKER ? auswahl : undefined
  const waehle = (id: string) => { setAuswahl(id); merke(id) }
  return { druckerId, auswahl: gueltig ? auswahl : KASSEN_DRUCKER, waehle, drucker }
}

export function AbrechnungsDruckerAuswahl({ auswahl, drucker, onChange }: {
  auswahl:  string
  drucker:  { id: string; name: string; ip: string }[]
  onChange: (id: string) => void
}) {
  const qc = useQueryClient()
  const darfAnlegen = hasBerechtigung('einstellungen')
  const [offen, setOffen] = useState(false)
  const [name, setName]   = useState('')
  const [ip, setIp]       = useState('')
  const [port, setPort]   = useState('9100')

  const anlegen = useMutation({
    mutationFn: () => druckerPoolApi.create({
      name: name.trim(), ip: ip.trim(), port: parseInt(port, 10) || 9100,
      breite: 42, timeoutSek: 5, aktiv: true,
    }),
    onSuccess: async (neu) => {
      await qc.invalidateQueries({ queryKey: ['drucker-pool'] })
      onChange(neu.id)
      setOffen(false); setName(''); setIp(''); setPort('9100')
    },
  })

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-ink mb-1">Drucker für Abschlüsse</label>
          <select
            data-testid="abrechnung-drucker"
            value={auswahl}
            onChange={(e) => onChange(e.target.value)}
            className="rounded-md border border-line-strong px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          >
            <option value={KASSEN_DRUCKER}>Bondrucker der Kasse (Standard)</option>
            {drucker.map(d => (
              <option key={d.id} value={d.id}>{d.name} ({d.ip})</option>
            ))}
          </select>
        </div>
        {darfAnlegen && !offen && (
          <Button variant="secondary" onClick={() => setOffen(true)}>Drucker einrichten</Button>
        )}
      </div>

      {offen && (
        <div className="rounded-md border border-line bg-panel-2 p-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-ink-muted mb-1">Name</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Büro-Drucker" />
          </div>
          <div>
            <label className="block text-xs text-ink-muted mb-1">IP-Adresse</label>
            <Input value={ip} onChange={e => setIp(e.target.value)} placeholder="192.168.1.100" />
          </div>
          <div>
            <label className="block text-xs text-ink-muted mb-1">Port</label>
            <Input value={port} onChange={e => setPort(e.target.value)} className="w-24" />
          </div>
          <Button
            onClick={() => anlegen.mutate()}
            loading={anlegen.isPending}
            disabled={!name.trim() || !ip.trim()}
          >
            Anlegen
          </Button>
          <Button variant="secondary" onClick={() => setOffen(false)}>Abbrechen</Button>
          {anlegen.isError && (
            <span className="text-sm text-red-700 w-full">
              {anlegen.error instanceof Error ? anlegen.error.message : 'Drucker konnte nicht angelegt werden'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
