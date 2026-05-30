import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Artikel, Lieferant } from '@kassa/shared'
import { artikelApi, lieferantApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { formatPreis } from '../lib/format'

// ---------------------------------------------------------------------------
// Status-Helfer (gleiche Logik wie LagerstandPage)
// ---------------------------------------------------------------------------

type LagerStatus = 'kritisch' | 'niedrig'

function brauchtNachbestellung(a: Artikel): boolean {
  if (!a.lagerstandAktiv) return false
  const menge = a.lagerstandMenge ?? 0
  if (menge <= 0) return true
  if (a.mindestbestand != null && menge <= a.mindestbestand) return true
  return false
}

function lagerStatus(a: Artikel): LagerStatus {
  const menge = a.lagerstandMenge ?? 0
  if (menge <= 0) return 'kritisch'
  return 'niedrig'
}

const STATUS_FARBE: Record<LagerStatus, string> = {
  kritisch: 'bg-red-100 text-red-700 border-red-200',
  niedrig:  'bg-yellow-100 text-yellow-700 border-yellow-200',
}

// ---------------------------------------------------------------------------
// CSV-Export (client-seitig)
// ---------------------------------------------------------------------------

function exportiereCsv(zeilen: BestellZeile[], lieferantenMap: Map<string, string>) {
  const header = ['Lieferant', 'Artikel', 'Aktuell', 'Mindestbestand', 'Zu bestellen', 'Preis/Stück']
  const rows = zeilen.map(z => [
    z.lieferantId ? (lieferantenMap.get(z.lieferantId) ?? 'Unbekannt') : 'Ohne Lieferant',
    z.bezeichnung,
    String(z.lagerstandMenge ?? 0),
    String(z.mindestbestand ?? '–'),
    String(z.bestellmenge),
    formatPreis(z.preisBruttoCent),
  ])
  const csv = '﻿' + [header, ...rows].map(r => r.join(';')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download  = `Bestellliste-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface BestellZeile {
  id:              string
  bezeichnung:     string
  lieferantId:     string | null
  lagerstandMenge: number | null
  mindestbestand:  number | null
  preisBruttoCent: number
  status:          LagerStatus
  bestellmenge:    number
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

export function BestelllistePage() {
  const auth = getAuth()

  const { data: alleArtikel = [], isLoading: artikelLaed } = useQuery({
    queryKey: ['artikel', auth?.mandant.id, 'alle'],
    queryFn:  () => artikelApi.list(auth!.mandant.id, false),
    enabled:  !!auth,
  })

  const { data: lieferanten = [] } = useQuery({
    queryKey: ['lieferanten'],
    queryFn:  lieferantApi.list,
  })

  const lieferantenMap = useMemo(
    () => new Map(lieferanten.map((l: Lieferant) => [l.id, l])),
    [lieferanten],
  )
  const lieferantenNamenMap = useMemo(
    () => new Map(lieferanten.map((l: Lieferant) => [l.id, l.name])),
    [lieferanten],
  )

  const [mengen, setMengen] = useState<Record<string, number>>({})
  const [filterLieferant, setFilterLieferant] = useState<string>('alle')

  const basisZeilen: BestellZeile[] = useMemo(() => {
    return alleArtikel
      .filter(brauchtNachbestellung)
      .map(a => {
        const menge     = a.lagerstandMenge ?? 0
        const mindest   = a.mindestbestand ?? 0
        const fehlmenge = Math.max(mindest - menge, 0)
        const vorschlag = Math.max(fehlmenge, mindest, 1)
        return {
          id:              a.id,
          bezeichnung:     a.bezeichnung,
          lieferantId:     a.lieferantId ?? null,
          lagerstandMenge: a.lagerstandMenge,
          mindestbestand:  a.mindestbestand,
          preisBruttoCent: a.preisBruttoCent,
          status:          lagerStatus(a),
          bestellmenge:    mengen[a.id] ?? vorschlag,
        }
      })
  }, [alleArtikel, mengen])

  const gefilterteZeilen = useMemo(() => {
    if (filterLieferant === 'alle') return basisZeilen
    if (filterLieferant === 'ohne') return basisZeilen.filter(z => !z.lieferantId)
    return basisZeilen.filter(z => z.lieferantId === filterLieferant)
  }, [basisZeilen, filterLieferant])

  // Gruppierung nach Lieferant
  const gruppen = useMemo(() => {
    const map = new Map<string, BestellZeile[]>()
    for (const z of gefilterteZeilen) {
      const key = z.lieferantId ?? '__ohne__'
      const arr = map.get(key) ?? []
      arr.push(z)
      map.set(key, arr)
    }
    return map
  }, [gefilterteZeilen])

  function setMenge(id: string, wert: number) {
    setMengen(prev => ({ ...prev, [id]: Math.max(0, wert) }))
  }

  const lieferantenMitBestellung = useMemo(() =>
    [...new Set(basisZeilen.map(z => z.lieferantId))].filter(Boolean),
  [basisZeilen])

  if (artikelLaed) return <div className="p-8 text-sm text-gray-500">Wird geladen…</div>

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bestellliste</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {basisZeilen.length === 0
              ? 'Alle Bestände sind ausreichend.'
              : `${basisZeilen.length} Artikel unter Mindestbestand`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            Drucken
          </button>
          <button
            type="button"
            onClick={() => exportiereCsv(gefilterteZeilen, lieferantenNamenMap)}
            className="px-3 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            CSV-Export
          </button>
        </div>
      </div>

      {basisZeilen.length === 0 ? (
        <div className="rounded-xl border border-green-200 bg-green-50 p-12 text-center">
          <p className="text-green-700 font-medium">Alle Bestände sind ausreichend.</p>
          <p className="text-green-600 text-sm mt-1">Es gibt keine Artikel unter dem Mindestbestand.</p>
        </div>
      ) : (
        <>
          {/* Lieferant-Filter */}
          {lieferantenMitBestellung.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-5">
              <button type="button" onClick={() => setFilterLieferant('alle')}
                className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${filterLieferant === 'alle' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-700 border-gray-300 hover:border-brand-400'}`}>
                Alle
              </button>
              {lieferantenMitBestellung.map(lid => (
                <button key={lid} type="button" onClick={() => setFilterLieferant(lid!)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${filterLieferant === lid ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-700 border-gray-300 hover:border-brand-400'}`}>
                  {lieferantenMap.get(lid!)?.name ?? lid}
                </button>
              ))}
              <button type="button" onClick={() => setFilterLieferant('ohne')}
                className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${filterLieferant === 'ohne' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-700 border-gray-300 hover:border-brand-400'}`}>
                Ohne Lieferant
              </button>
            </div>
          )}

          {/* Gruppen */}
          <div className="space-y-6">
            {[...gruppen.entries()].map(([gruppeKey, zeilen]) => {
              const lieferant = gruppeKey !== '__ohne__' ? lieferantenMap.get(gruppeKey) : null
              return (
                <div key={gruppeKey} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  {/* Gruppen-Header */}
                  <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <p className="font-semibold text-gray-800">
                        {lieferant ? lieferant.name : 'Ohne Lieferant'}
                      </p>
                      {lieferant && (
                        <div className="flex gap-4 text-xs text-gray-500 mt-0.5">
                          {lieferant.kontakt && <span>{lieferant.kontakt}</span>}
                          {lieferant.email   && <a href={`mailto:${lieferant.email}`} className="text-brand-600 hover:underline">{lieferant.email}</a>}
                          {lieferant.telefon && <a href={`tel:${lieferant.telefon}`}  className="text-brand-600 hover:underline">{lieferant.telefon}</a>}
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">{zeilen.length} Artikel</p>
                  </div>

                  {/* Artikel-Tabelle */}
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
                        <th className="px-4 py-2 text-left">Artikel</th>
                        <th className="px-4 py-2 text-right">Aktuell</th>
                        <th className="px-4 py-2 text-right">Mindest</th>
                        <th className="px-4 py-2 text-right w-32">Zu bestellen</th>
                        <th className="px-4 py-2 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {zeilen.map(z => (
                        <tr key={z.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium text-gray-900">{z.bezeichnung}</td>
                          <td className="px-4 py-3 text-right font-mono text-gray-600">
                            {z.lagerstandMenge ?? 0}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-gray-500">
                            {z.mindestbestand ?? '–'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <input
                              type="number"
                              min={0}
                              value={z.bestellmenge}
                              onChange={e => setMenge(z.id, parseInt(e.target.value) || 0)}
                              className="w-24 text-right border border-gray-300 rounded-md px-2 py-1 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold border ${STATUS_FARBE[z.status]}`}>
                              {z.status === 'kritisch' ? 'Kritisch' : 'Niedrig'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
