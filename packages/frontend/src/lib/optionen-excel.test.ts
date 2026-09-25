import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseOptionenExcel } from './optionen-excel'

function datei(zeilen: (string | number)[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Artikel', 'Warengruppe', 'Optionsgruppe', 'Option', 'Aufpreis (EUR)', 'Pflicht', 'Mehrfachauswahl'],
    ...zeilen,
  ]), 'Optionen')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

describe('parseOptionenExcel', () => {
  it('fasst Zeilen je Artikel + Warengruppe + Optionsgruppe zusammen', async () => {
    const gruppen = await parseOptionenExcel(datei([
      ['Spritzer', 'Spritzer', 'Sorte',  'weiß',    '',      'Ja',   'Nein'],
      ['Spritzer', 'Spritzer', 'Extras', 'mit Eis', '0,50',  'Nein', 'Ja'],
      ['spritzer', 'SPRITZER', 'sorte',  'rot',     '0',     '',     ''],
      ['Wein + Soda', '',      'Soda',   'Ohne Soda', '-2,00', '', ''],
      ['', '', '', '', '', '', ''],
    ]))
    expect(gruppen.map(g => g.eintrag)).toEqual([
      { artikel: 'Spritzer', warengruppe: 'Spritzer', gruppe: 'Sorte', typ: 'pflicht', maxAuswahl: 1,
        optionen: [{ name: 'weiß', aufschlagCent: 0 }, { name: 'rot', aufschlagCent: 0 }] },
      { artikel: 'Spritzer', warengruppe: 'Spritzer', gruppe: 'Extras', typ: 'optional', maxAuswahl: null,
        optionen: [{ name: 'mit Eis', aufschlagCent: 50 }] },
      { artikel: 'Wein + Soda', warengruppe: '', gruppe: 'Soda', typ: 'optional', maxAuswahl: 1,
        optionen: [{ name: 'Ohne Soda', aufschlagCent: -200 }] },
    ])
    expect(gruppen[0]!.zeilen).toEqual([2, 4])
    expect(gruppen.every(g => g.fehler.length === 0)).toBe(true)
  })

  it('meldet fehlende Pflichtfelder und ungültige Preise mit Zeilennummer', async () => {
    const gruppen = await parseOptionenExcel(datei([
      ['',      '', 'Sorte', 'weiß', '',    '', ''],
      ['Cola',  '', 'Sorte', '',     '',    '', ''],
      ['Limo',  '', 'Sorte', 'rot',  'abc', '', ''],
    ]))
    expect(gruppen.map(g => g.fehler)).toEqual([
      ['Zeile 2: Artikel fehlt'],
      ['Zeile 3: Option fehlt'],
      ['Zeile 4: Aufpreis ungültig: „abc"'],
    ])
  })
})
