/**
 * EinrichtungSeite — Einstellungen → Kassen: alle Kassen, Drucker, Warengruppen und KDS auf einen Blick.
 *
 *   Kassen            jede Kasse in einer Zeile (Startseite, Belegausgabe, Rechnungsdrucker, Bonierdrucker,
 *                     KDS) — neue Kassen anlegen, Einrichtung von einer anderen Kasse übernehmen
 *   Drucker           alle Drucker an einer Stelle, mit Verwendung
 *   Warengruppen      welche Warengruppen an welcher Kasse erscheinen
 *   Zuordnung         welcher Drucker / welche KDS-Station je Warengruppe oder Artikel — je Kasse
 *   KDS-Stationen     Papierdruck je Station samt Backup-Drucker und Fallback
 *
 * Ersetzt „Kassen" (Umschalter), „Warengruppen-Verteilung", „Kassenbezeichnung" und den ganzen Bereich
 * „Hardware" (Drucker, KDS, Kartenterminal), die jeweils nur EINE Kasse oder getrennte Bibliotheken kannten.
 */

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { KdsDruckerZuordnung } from '../KdsDruckerZuordnung'
import { DruckerSektion } from './DruckerSektion'
import { EinrichtungProvider, useEinrichtung } from './EinrichtungKontext'
import { KassenSektion } from './KassenSektion'
import { RoutingSektion } from './RoutingSektion'
import { SichtbarkeitsSektion } from './SichtbarkeitsSektion'

const SPRUNGMARKEN: { id: string; label: string }[] = [
  { id: 'einrichtung-kassen',       label: 'Kassen' },
  { id: 'einrichtung-drucker',      label: 'Drucker' },
  { id: 'einrichtung-warengruppen', label: 'Warengruppen' },
  { id: 'einrichtung-routing',      label: 'Drucker & Station je Kasse' },
  { id: 'einrichtung-kds',          label: 'KDS-Stationen' },
]

function Inhalt() {
  const { fehler, meldeFehler, istGastro, laedt } = useEinrichtung()
  const { hash } = useLocation()
  // Eine Adresse mit Abschnitt (z. B. /einstellungen?bereich=kassen#einrichtung-routing) scrollt dorthin
  useEffect(() => {
    if (!hash || laedt) return
    const t = window.setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250)
    return () => window.clearTimeout(t)
  }, [hash, laedt])
  const marken = istGastro ? SPRUNGMARKEN : SPRUNGMARKEN.filter(m => m.id !== 'einrichtung-kds')

  return (
    <div className="space-y-6">
      <nav aria-label="Abschnitte" className="flex flex-wrap gap-2 text-sm">
        {marken.map(m => (
          <a
            key={m.id}
            href={`#${m.id}`}
            onClick={e => { e.preventDefault(); document.getElementById(m.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}
            className="rounded-full border border-line-strong bg-panel px-3 py-1 text-ink-muted hover:border-brand-400 hover:text-ink"
          >{m.label}</a>
        ))}
      </nav>

      {fehler && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <span>{fehler}</span>
          <button type="button" onClick={() => meldeFehler(null)} className="shrink-0 text-red-600 hover:underline">schließen</button>
        </div>
      )}

      <KassenSektion />
      <DruckerSektion />
      <SichtbarkeitsSektion />
      <RoutingSektion />
      {istGastro && <KdsDruckerZuordnung />}
    </div>
  )
}

export function EinrichtungSeite() {
  return (
    <EinrichtungProvider>
      <Inhalt />
    </EinrichtungProvider>
  )
}
