import { useState } from 'react'
import { getKasseIdentity } from '../lib/kasse'
import { getAuth } from '../lib/auth'

/**
 * Welche Kasse wird abgerechnet? Admins dürfen jede Kasse des Betriebs wählen,
 * unabhängig davon, in welcher Kasse sie gerade angemeldet sind. Alle anderen
 * rechnen nur die eigene Kasse ab. Das Backend prüft die Mandanten-Zugehörigkeit
 * der Kasse ohnehin bei jeder Abfrage.
 */
export function useAbrechnungsKasse() {
  const identity = getKasseIdentity()!
  const auth     = getAuth()!
  const istAdmin = auth.user.rolle === 'admin'
  const kassen   = istAdmin ? auth.kassen : auth.kassen.filter(k => k.id === identity.kasseId)
  const [kasseId, setKasseId] = useState<string>(identity.kasseId)
  const kasse = auth.kassen.find(k => k.id === kasseId)
  const bezeichnung = kasse?.bezeichnung ?? kasse?.kassenId ?? kasseId
  return { kasseId, setKasseId, kassen, bezeichnung, auswahlMoeglich: istAdmin && kassen.length > 1 }
}

export function KassenAuswahl({ kasseId, kassen, onChange }: {
  kasseId:  string
  kassen:   { id: string; kassenId: string; bezeichnung: string | null }[]
  onChange: (id: string) => void
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-ink mb-1">Kasse</label>
      <select
        data-testid="abrechnung-kasse"
        value={kasseId}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line-strong px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
      >
        {kassen.map(k => (
          <option key={k.id} value={k.id}>{k.bezeichnung ?? k.kassenId}</option>
        ))}
      </select>
    </div>
  )
}
