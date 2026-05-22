/**
 * ArtikelGrid — wiederverwendbares Artikel-Raster mit Kategorie-Tabs.
 * Wird in KassePage und TischTabPage eingesetzt.
 */

import { useState } from 'react'
import type { Artikel, Kategorie, KategorieFarbe } from '@kassa/shared'
import { formatPreis } from '../lib/format'

// ---------------------------------------------------------------------------
// Farb-Mapping Kategorie → Tailwind-Klassen
// ---------------------------------------------------------------------------

const FARBE_TAB_INAKTIV: Record<KategorieFarbe, string> = {
  grau:   'bg-gray-100 text-gray-700 hover:bg-gray-200',
  rot:    'bg-red-50 text-red-700 hover:bg-red-100',
  orange: 'bg-orange-50 text-orange-700 hover:bg-orange-100',
  gelb:   'bg-yellow-50 text-yellow-700 hover:bg-yellow-100',
  gruen:  'bg-green-50 text-green-700 hover:bg-green-100',
  blau:   'bg-blue-50 text-blue-700 hover:bg-blue-100',
  lila:   'bg-purple-50 text-purple-700 hover:bg-purple-100',
  pink:   'bg-pink-50 text-pink-700 hover:bg-pink-100',
}

const FARBE_TAB_AKTIV: Record<KategorieFarbe, string> = {
  grau:   'bg-gray-600 text-white',
  rot:    'bg-red-600 text-white',
  orange: 'bg-orange-500 text-white',
  gelb:   'bg-yellow-500 text-white',
  gruen:  'bg-green-600 text-white',
  blau:   'bg-blue-600 text-white',
  lila:   'bg-purple-600 text-white',
  pink:   'bg-pink-500 text-white',
}

const FARBE_ARTIKEL_AKTIV: Record<KategorieFarbe, string> = {
  grau:   'hover:border-gray-400 hover:bg-gray-50',
  rot:    'hover:border-red-400 hover:bg-red-50',
  orange: 'hover:border-orange-400 hover:bg-orange-50',
  gelb:   'hover:border-yellow-400 hover:bg-yellow-50',
  gruen:  'hover:border-green-400 hover:bg-green-50',
  blau:   'hover:border-blue-400 hover:bg-blue-50',
  lila:   'hover:border-purple-400 hover:bg-purple-50',
  pink:   'hover:border-pink-400 hover:bg-pink-50',
}

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface Props {
  artikel:        Artikel[]
  kategorien:     Kategorie[]
  onArtikelClick: (a: Artikel) => void
  loading?:       boolean
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

export function ArtikelGrid({ artikel, kategorien, onArtikelClick, loading }: Props) {
  const [aktivKategorieId, setAktivKategorieId] = useState<string | null>(null)

  // Nur aktive Kategorien in der richtigen Reihenfolge
  const aktiveKategorien = kategorien
    .filter(k => k.aktiv)
    .sort((a, b) => a.reihenfolge - b.reihenfolge || a.name.localeCompare(b.name))

  // Gefilterte Artikel je nach Tab
  const gefilterteArtikel = aktivKategorieId === null
    ? artikel
    : artikel.filter(a => a.kategorieId === aktivKategorieId)

  const aktiveKategorie = aktiveKategorien.find(k => k.id === aktivKategorieId)

  if (loading) {
    return <p className="text-sm text-gray-500">Wird geladen…</p>
  }

  if (artikel.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-gray-300 p-6 text-center">
        <p className="text-sm text-gray-500">Noch keine Artikel angelegt.</p>
        <a href="/artikel" className="mt-2 inline-block text-sm text-brand-600 hover:underline">
          Zur Artikel-Verwaltung →
        </a>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Kategorie-Tab-Leiste — nur anzeigen wenn Kategorien vorhanden */}
      {aktiveKategorien.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setAktivKategorieId(null)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
              aktivKategorieId === null
                ? 'bg-brand-600 text-white'
                : 'bg-brand-50 text-brand-700 hover:bg-brand-100'
            }`}
          >
            Alle
          </button>
          {aktiveKategorien.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setAktivKategorieId(k.id === aktivKategorieId ? null : k.id)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
                k.id === aktivKategorieId
                  ? FARBE_TAB_AKTIV[k.farbe]
                  : FARBE_TAB_INAKTIV[k.farbe]
              }`}
            >
              {k.name}
            </button>
          ))}
        </div>
      )}

      {/* Artikel-Raster */}
      {gefilterteArtikel.length === 0 ? (
        <p className="text-sm text-gray-400 py-4 text-center">
          Keine Artikel in dieser Kategorie.
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {gefilterteArtikel.map((a) => {
            const farbe = aktiveKategorie?.farbe
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onArtikelClick(a)}
                className={`rounded-lg border border-gray-200 bg-white transition p-3 text-left shadow-sm ${
                  farbe
                    ? FARBE_ARTIKEL_AKTIV[farbe]
                    : 'hover:bg-brand-50 hover:border-brand-400'
                }`}
              >
                <p className="text-sm font-medium text-gray-900 line-clamp-2 min-h-[2.5rem]">
                  {a.bezeichnung}
                </p>
                <p className="mt-1 text-base font-bold text-brand-600">
                  {formatPreis(a.preisBruttoCent)}
                </p>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
