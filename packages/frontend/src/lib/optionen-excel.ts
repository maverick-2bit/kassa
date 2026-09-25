/**
 * optionen-excel.ts
 *
 * Excel-Vorlage und Parser für den Optionen-Import (Artikel-Optionen / Modifikatoren).
 *
 * Eine Zeile = eine Option. Zeilen mit gleichem Artikel + Warengruppe + Optionsgruppe
 * bilden zusammen eine Gruppe für diesen Artikel; Pflicht/Mehrfachauswahl gelten ab
 * der ersten Zeile der Gruppe. Inhaltsgleiche Gruppen legt der Server nur einmal an.
 */

import type { OptionenImportEintrag } from '@kassa/shared'
import { parseEuroToCent } from './format'

const SPALTEN = [
  { header: 'Artikel',         wch: 30 },
  { header: 'Warengruppe',     wch: 22 },
  { header: 'Optionsgruppe',   wch: 28 },
  { header: 'Option',          wch: 26 },
  { header: 'Aufpreis (EUR)',  wch: 14 },
  { header: 'Pflicht',         wch: 9 },
  { header: 'Mehrfachauswahl', wch: 16 },
]

const BEISPIEL = [
  ['Spritzer', 'Spritzer', 'Sorte',  'weiß',      '0,00',  'Ja',   'Nein'],
  ['Spritzer', 'Spritzer', 'Sorte',  'rot',       '0,00',  'Ja',   'Nein'],
  ['Spritzer', 'Spritzer', 'Extras', 'mit Eis',   '0,00',  'Nein', 'Ja'],
  ['0,75l Weißwein + Soda', '', 'Soda', 'Ohne Soda', '-2,00', 'Nein', 'Nein'],
]

export async function exportOptionenVorlage(): Promise<void> {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([SPALTEN.map(s => s.header), ...BEISPIEL])
  ws['!cols'] = SPALTEN.map(s => ({ wch: s.wch }))
  XLSX.utils.book_append_sheet(wb, ws, 'Optionen')

  const hinweise = [
    ['Feld',            'Pflicht', 'Hinweis'],
    ['Artikel',         'Ja',      'Bezeichnung genau wie in der Kassa (Groß/klein egal)'],
    ['Warengruppe',     'Nein',    'Nur nötig, wenn es den Artikelnamen in mehreren Warengruppen gibt'],
    ['Optionsgruppe',   'Ja',      'Überschrift der Auswahl, z. B. „Sorte" oder „Beilage"'],
    ['Option',          'Ja',      'Eine Zeile je Option — Reihenfolge der Zeilen = Reihenfolge an der Kasse'],
    ['Aufpreis (EUR)',  'Nein',    'z. B. 0,50 — Minus für Abschläge (-2,00); leer = 0'],
    ['Pflicht',         'Nein',    'Ja = an der Kasse muss gewählt werden (Standard: Nein)'],
    ['Mehrfachauswahl', 'Nein',    'Ja = mehrere Optionen der Gruppe wählbar (Standard: Nein = genau eine)'],
    ['',                '',        'Gleiche Gruppen (Name + Optionen + Preise) werden nur einmal angelegt und allen Artikeln zugeordnet. Bestehende Zuordnungen bleiben erhalten; ein zweiter Import legt nichts doppelt an.'],
  ]
  const wsH = XLSX.utils.aoa_to_sheet(hinweise)
  wsH['!cols'] = [{ wch: 16 }, { wch: 8 }, { wch: 100 }]
  XLSX.utils.book_append_sheet(wb, wsH, 'Hinweise')

  XLSX.writeFile(wb, 'optionen-vorlage.xlsx')
}

export interface GeparsteGruppe {
  /** Excel-Zeilen dieser Gruppe (1-basiert, für Meldungen) */
  zeilen:  number[]
  fehler:  string[]
  eintrag: OptionenImportEintrag
}

const JA = ['ja', 'yes', '1', 'true', 'wahr', 'x']

export async function parseOptionenExcel(buffer: ArrayBuffer): Promise<GeparsteGruppe[]> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buffer, { type: 'array' })
  const wsName = wb.SheetNames[0]
  const ws = wsName ? wb.Sheets[wsName] : undefined
  if (!ws) return []

  const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '', raw: false }) as string[][]
  const gruppen = new Map<string, GeparsteGruppe>()

  rows.slice(1).forEach((row, idx) => {
    const zeile = idx + 2
    const [artikel = '', warengruppe = '', gruppe = '', option = '', preis = '', pflicht = '', mehrfach = '']
      = row.map(z => String(z ?? '').trim())
    if (!artikel && !gruppe && !option) return

    const schluessel = [artikel, warengruppe, gruppe].map(s => s.toLowerCase()).join('\u0000')
    let g = gruppen.get(schluessel)
    if (!g) {
      g = {
        zeilen: [],
        fehler: [],
        eintrag: {
          artikel, warengruppe, gruppe,
          typ:        JA.includes(pflicht.toLowerCase()) ? 'pflicht' : 'optional',
          maxAuswahl: JA.includes(mehrfach.toLowerCase()) ? null : 1,
          optionen:   [],
        },
      }
      if (!artikel) g.fehler.push(`Zeile ${zeile}: Artikel fehlt`)
      if (!gruppe)  g.fehler.push(`Zeile ${zeile}: Optionsgruppe fehlt`)
      gruppen.set(schluessel, g)
    }
    g.zeilen.push(zeile)

    if (!option) { g.fehler.push(`Zeile ${zeile}: Option fehlt`); return }
    const aufschlagCent = preis ? parseEuroToCent(preis.replace(/€/g, '')) : 0
    if (aufschlagCent === null) { g.fehler.push(`Zeile ${zeile}: Aufpreis ungültig: „${preis}"`); return }
    g.eintrag.optionen.push({ name: option, aufschlagCent })
  })

  return [...gruppen.values()]
}
