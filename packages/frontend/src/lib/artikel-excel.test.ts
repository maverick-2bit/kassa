import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseArtikelExcel } from './artikel-excel'

/** Excel-Datei (erste Zeile = Kopf) als ArrayBuffer. */
function excel(zeilen: string[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(zeilen), 'Artikel')
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return out
}

const KOPF = ['Bezeichnung', 'Preis (EUR)', 'MwSt-Satz', 'KDS-Station', 'Kategorie', 'Lagerstand', 'Anfangsbestand', 'Mindestbestand', 'Allergene']
const NORMAL = '20 %'

describe('parseArtikelExcel — Spalte „Allergene"', () => {
  it('liest Codes locker und legt sie sortiert ab', async () => {
    const [z] = await parseArtikelExcel(excel([KOPF, ['Schnitzel', '12,00', NORMAL, '', '', 'Nein', '', '', 'g, a c']]), [])
    expect(z?.gueltig).toBe(true)
    expect(z?.daten?.allergene).toBe('A,C,G')
  })

  it('leer = keine Angabe (null)', async () => {
    const [z] = await parseArtikelExcel(excel([KOPF, ['Cola', '3,50', NORMAL, '', '', 'Nein', '', '', '']]), [])
    expect(z?.gueltig).toBe(true)
    expect(z?.daten?.allergene).toBeNull()
  })

  it('ältere Dateien ohne die Spalte gehen weiter', async () => {
    const [z] = await parseArtikelExcel(excel([KOPF.slice(0, 8), ['Cola', '3,50', NORMAL, '', '', 'Nein', '', '']]), [])
    expect(z?.gueltig).toBe(true)
    expect(z?.daten?.allergene).toBeNull()
  })

  it('unbekannte Buchstaben machen die Zeile ungültig und werden genannt', async () => {
    const [z] = await parseArtikelExcel(excel([KOPF, ['Suppe', '5,00', NORMAL, '', '', 'Nein', '', '', 'A, X, Z']]), [])
    expect(z?.gueltig).toBe(false)
    expect(z?.fehler.join(' ')).toMatch(/Allergene ungültig: X, Z/)
  })
})
