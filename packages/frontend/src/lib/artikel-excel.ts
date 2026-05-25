/**
 * artikel-excel.ts
 *
 * Export: Erzeugt eine Excel-Vorlage (leer oder mit bestehenden Artikeln).
 * Import: Parst eine hochgeladene Excel-Datei und validiert jede Zeile.
 *
 * MwSt-Sätze und Stationen werden in beide Richtungen gemappt.
 * Artikelnummern werden serverseitig auto-generiert — weder exportiert noch importiert.
 * Kategorien: bekannte Namen → ID; unbekannte Namen → als kategorieStr zurückgegeben
 *   (das Modal kann sie automatisch anlegen oder der User wählt eine vorhandene).
 */

import * as XLSX from 'xlsx'
import {
  MWST_LABELS,
  STATION_LABELS,
  ALLE_STATIONEN,
  type Artikel,
  type ArtikelInput,
  type Kategorie,
  type MwStSatz,
  type Station,
} from '@kassa/shared'

// ---------------------------------------------------------------------------
// Mappings MwSt
// ---------------------------------------------------------------------------

/** Excel-Label → interner Code (case-insensitiv, diverse Aliasnamen) */
const MWST_LABEL_ZU_CODE: Record<string, MwStSatz> = {
  // Offizielle Labels aus MWST_LABELS
  [MWST_LABELS.normal]:      'normal',
  [MWST_LABELS.ermaessigt1]: 'ermaessigt1',
  [MWST_LABELS.ermaessigt2]: 'ermaessigt2',
  [MWST_LABELS.null]:        'null',
  [MWST_LABELS.besonders]:   'besonders',
  // Kurzformen
  '20%':       'normal',
  '20 %':      'normal',
  '10%':       'ermaessigt1',
  '10 %':      'ermaessigt1',
  '13%':       'ermaessigt2',
  '13 %':      'ermaessigt2',
  '0%':        'null',
  '0 %':       'null',
  // Interne Codes direkt
  normal:      'normal',
  ermaessigt1: 'ermaessigt1',
  ermaessigt2: 'ermaessigt2',
  null:        'null',
  besonders:   'besonders',
}

// ---------------------------------------------------------------------------
// Mappings Station
// ---------------------------------------------------------------------------

/** Excel-Label → interner Code */
const STATION_LABEL_ZU_CODE: Record<string, Station> = {
  ...Object.fromEntries(ALLE_STATIONEN.map(s => [STATION_LABELS[s], s])),
  // Interne Codes direkt
  ...Object.fromEntries(ALLE_STATIONEN.map(s => [s, s])),
}

// ---------------------------------------------------------------------------
// Spaltendefinition  (A–G, ohne Artikelnummer — wird auto-generiert)
// ---------------------------------------------------------------------------

const SPALTEN = [
  { header: 'Bezeichnung',    wch: 30 },
  { header: 'Preis (EUR)',    wch: 13 },
  { header: 'MwSt-Satz',     wch: 24 },
  { header: 'KDS-Station',   wch: 16 },
  { header: 'Kategorie',     wch: 22 },
  { header: 'Lagerstand',    wch: 13 },
  { header: 'Anfangsbestand', wch: 15 },
  { header: 'Mindestbestand', wch: 15 },
]

const BEISPIEL_ZEILE = [
  'Espresso',
  '3,50',
  MWST_LABELS.normal,
  STATION_LABELS.schank,
  'Getränke',
  'Nein',
  '',
  '',
]

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Exportiert eine Excel-Vorlage.
 * @param existingArtikel  Wenn übergeben, werden die bestehenden Artikel eingefügt.
 *                         Sonst nur ein Beispiel-Datensatz (grau, als Referenz).
 * @param kategorien       Für die Kategorie-Namen bei bestehendem Export.
 */
export function exportArtikelVorlage(
  existingArtikel?: Artikel[],
  kategorien?: Kategorie[],
): void {
  const wb = XLSX.utils.book_new()

  // ---- Hauptblatt ----
  const headers = SPALTEN.map(s => s.header)

  let dataRows: (string | number)[][]
  if (existingArtikel && existingArtikel.length > 0) {
    const katMap = new Map((kategorien ?? []).map(k => [k.id, k.name]))
    dataRows = existingArtikel.map(a => [
      a.bezeichnung,
      (a.preisBruttoCent / 100).toFixed(2).replace('.', ','),
      MWST_LABELS[a.mwstSatz],
      a.station ? STATION_LABELS[a.station] : '',
      a.kategorieId ? (katMap.get(a.kategorieId) ?? '') : '',
      a.lagerstandAktiv ? 'Ja' : 'Nein',
      a.lagerstandMenge    !== null ? a.lagerstandMenge    : '',
      a.mindestbestand     !== null ? a.mindestbestand     : '',
    ])
  } else {
    // Leere Vorlage mit einem Beispiel-Datensatz
    dataRows = [BEISPIEL_ZEILE]
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
  ws['!cols'] = SPALTEN.map(s => ({ wch: s.wch }))

  XLSX.utils.book_append_sheet(wb, ws, 'Artikel')

  // ---- Listen-Blatt (für Dropdown-Validierung) ----
  // Spalten: A = MwSt-Sätze, B = KDS-Stationen, C = Kategorien
  const aktiveKategorien = (kategorien ?? []).filter(k => k.aktiv).sort((a, b) => a.name.localeCompare(b.name))
  const mwstWerte        = Object.values(MWST_LABELS)
  const stationWerte     = ALLE_STATIONEN.map(s => STATION_LABELS[s])
  const katWerte         = aktiveKategorien.map(k => k.name)

  const maxLen   = Math.max(mwstWerte.length, stationWerte.length, katWerte.length)
  const listenRows: (string | '')[][] = []
  listenRows.push(['MwSt-Satz', 'KDS-Station', 'Kategorie'])
  for (let i = 0; i < maxLen; i++) {
    listenRows.push([
      mwstWerte[i]    ?? '',
      stationWerte[i] ?? '',
      katWerte[i]     ?? '',
    ])
  }

  const wsL = XLSX.utils.aoa_to_sheet(listenRows)
  wsL['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 28 }]
  XLSX.utils.book_append_sheet(wb, wsL, '_Listen')

  // ---- Excel-Dropdown-Validierung (SheetJS 0.19+) ----
  // Spalten (ohne Artikelnummer):
  //   A = Bezeichnung, B = Preis, C = MwSt-Satz, D = KDS-Station, E = Kategorie
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dv: any[] = []

  // Spalte C: MwSt-Satz
  dv.push({
    sqref: `C2:C10000`,
    type:  'list',
    formula1: `_Listen!$A$2:$A$${1 + mwstWerte.length}`,
    showDropDown:    false,
    showErrorMessage: true,
    errorTitle:      'Ungültiger MwSt-Satz',
    error:           `Bitte einen der folgenden Werte wählen: ${mwstWerte.join(', ')}`,
  })

  // Spalte D: KDS-Station
  dv.push({
    sqref: `D2:D10000`,
    type:  'list',
    formula1: `_Listen!$B$2:$B$${1 + stationWerte.length}`,
    showDropDown:    false,
    showErrorMessage: false,  // Station ist optional, Fehler wäre zu streng
  })

  // Spalte E: Kategorie (nur wenn Kategorien vorhanden)
  if (katWerte.length > 0) {
    dv.push({
      sqref: `E2:E10000`,
      type:  'list',
      formula1: `_Listen!$C$2:$C$${1 + katWerte.length}`,
      showDropDown:    false,
      showErrorMessage: false,  // freie Eingabe → neue Warengruppe wird beim Import angelegt
      showInputMessage: true,
      promptTitle: 'Kategorie',
      prompt: 'Verfügbare Kategorien findest du im Sheet „_Listen", Spalte C. Neue Namen werden beim Import automatisch angelegt.',
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(ws as any)['!dataValidation'] = dv

  // ---- Hinweise-Blatt ----
  const mwstOptionen = mwstWerte.join(' | ')
  const statOptionen = stationWerte.join(' | ')
  const katHinweis   = katWerte.length > 0
    ? `Dropdown im Sheet → Spalte C. Verfügbar: ${katWerte.join(', ')}. Neue Namen werden beim Import automatisch als Warengruppe angelegt.`
    : 'Noch keine Kategorien angelegt — beliebigen Namen eintragen, er wird beim Import automatisch angelegt.'

  const hinweise = [
    ['Feld',            'Pflicht', 'Gültige Werte / Hinweis'],
    ['Bezeichnung',     'Ja',      'Frei wählbarer Artikelname'],
    ['Preis (EUR)',     'Ja',      'Dezimalzahl, z. B. 3,50 oder 3.50'],
    ['MwSt-Satz',      'Ja',      `Dropdown verfügbar ↓ — ${mwstOptionen}`],
    ['KDS-Station',    'Nein',    `Dropdown verfügbar ↓ — ${statOptionen} — oder leer lassen`],
    ['Kategorie',      'Nein',    katHinweis],
    ['Lagerstand',     'Nein',    'Ja oder Nein (Standard: Nein)'],
    ['Anfangsbestand', 'Nein',    'Ganzzahl ≥ 0, nur sinnvoll wenn Lagerstand = Ja'],
    ['Mindestbestand', 'Nein',    'Ganzzahl ≥ 0 — Warnung im Lagerstand wenn Bestand darunter fällt'],
    ['Artikelnummer',  '—',       'Wird automatisch vergeben — bitte keine Spalte dafür eintragen'],
  ]
  const wsH = XLSX.utils.aoa_to_sheet(hinweise)
  wsH['!cols'] = [{ wch: 16 }, { wch: 8 }, { wch: 90 }]
  XLSX.utils.book_append_sheet(wb, wsH, 'Hinweise')

  const dateiname = existingArtikel?.length
    ? 'artikel-export.xlsx'
    : 'artikel-vorlage.xlsx'
  XLSX.writeFile(wb, dateiname)
}

// ---------------------------------------------------------------------------
// Import / Parse
// ---------------------------------------------------------------------------

export interface GeparsterArtikel {
  zeile:        number
  gueltig:      boolean
  fehler:       string[]
  warnungen:    string[]
  /** Roher Kategoriename aus der Excel-Datei (leer wenn keine angegeben). */
  kategorieStr: string
  daten?:       Omit<ArtikelInput, 'mandantId'>
}

/**
 * Parst eine Excel-Datei (als ArrayBuffer) und validiert jede Datenzeile.
 * Leere Zeilen werden übersprungen.
 * Unbekannte Kategorienamen werden NICHT als Fehler gewertet –
 * das Modal kann sie automatisch anlegen.
 */
export function parseArtikelExcel(
  buffer: ArrayBuffer,
  kategorien: Kategorie[],
): GeparsterArtikel[] {
  const wb = XLSX.read(buffer, { type: 'array' })
  const wsName = wb.SheetNames[0]
  if (!wsName) return []
  const ws = wb.Sheets[wsName]
  if (!ws) return []

  // raw: false → alles als String → einfacher zu parsen
  const rows = XLSX.utils.sheet_to_json<(string | number | undefined)[]>(ws, {
    header: 1,
    defval: '',
    raw:    false,
  }) as string[][]

  if (rows.length < 2) return []

  // Erste Zeile = Header → ab Zeile 2 (Index 1)
  return rows
    .slice(1)
    .map((row, idx) => parseZeile(row, idx + 2, kategorien))
    .filter(e => e !== null) as GeparsterArtikel[]
}

function parseZeile(
  row:        string[],
  zeile:      number,
  kategorien: Kategorie[],
): GeparsterArtikel | null {
  // Spalten: A=Bezeichnung, B=Preis, C=MwSt, D=Station, E=Kategorie, F=Lagerstand, G=Anfangsbestand, H=Mindestbestand
  const [
    bezeichnungRaw  = '',
    preisRaw        = '',
    mwstRaw         = '',
    stationRaw      = '',
    kategorieRaw    = '',
    lagerstandRaw   = '',
    bestandRaw      = '',
    mindestRaw      = '',
  ] = row

  const bezeichnung   = bezeichnungRaw.trim()
  const preisStr      = preisRaw.trim()
  const mwstStr       = mwstRaw.trim()
  const stationStr    = stationRaw.trim()
  const kategorieStr  = kategorieRaw.trim()
  const lagerstandStr = lagerstandRaw.trim().toLowerCase()
  const bestandStr    = bestandRaw.trim()
  const mindestStr    = mindestRaw.trim()

  // Vollständig leere Zeile → überspringen
  if (!bezeichnung && !preisStr && !mwstStr) return null

  const fehler:    string[] = []
  const warnungen: string[] = []

  // ---- Bezeichnung ----
  if (!bezeichnung) fehler.push('Bezeichnung fehlt')

  // ---- Preis ----
  const preisFormatted = preisStr.replace(',', '.')
  const preisCent      = Math.round(parseFloat(preisFormatted) * 100)
  if (!preisStr || isNaN(preisCent) || preisCent < 0) {
    fehler.push(`Preis ungültig: "${preisStr}"`)
  }

  // ---- MwSt-Satz ----
  const mwstSatz = MWST_LABEL_ZU_CODE[mwstStr] ?? MWST_LABEL_ZU_CODE[mwstStr.toLowerCase()]
  if (!mwstSatz) {
    fehler.push(`MwSt-Satz ungültig: "${mwstStr}" — gültige Werte: ${Object.values(MWST_LABELS).join(', ')}`)
  }

  // ---- Station (optional) ----
  let station: Station | null = null
  if (stationStr) {
    station = STATION_LABEL_ZU_CODE[stationStr] ?? STATION_LABEL_ZU_CODE[stationStr.toLowerCase()] ?? null
    if (!station) {
      fehler.push(`KDS-Station ungültig: "${stationStr}" — gültige Werte: ${ALLE_STATIONEN.map(s => STATION_LABELS[s]).join(', ')}`)
    }
  }

  // ---- Kategorie (optional) ----
  // Bekannte Namen → ID setzen; unbekannte Namen → kategorieId=null, aber kategorieStr weiterreichen.
  // Das Import-Modal entscheidet, ob eine neue Warengruppe angelegt wird.
  let kategorieId: string | null = null
  if (kategorieStr) {
    const kat = kategorien.find(k => k.name.toLowerCase() === kategorieStr.toLowerCase() && k.aktiv)
    if (kat) {
      kategorieId = kat.id
    }
    // Unbekannte Namen erzeugen bewusst KEINE Warnung – sie werden im Modal behandelt
  }

  // ---- Lagerstand ----
  const lagerstandAktiv = ['ja', 'yes', '1', 'true', 'wahr'].includes(lagerstandStr)
  let lagerstandMenge: number | null = null
  if (lagerstandAktiv && bestandStr) {
    const n = parseInt(bestandStr, 10)
    if (!isNaN(n) && n >= 0) lagerstandMenge = n
    else warnungen.push(`Anfangsbestand "${bestandStr}" ungültig — wird als leer behandelt`)
  }
  let mindestbestand: number | null = null
  if (lagerstandAktiv && mindestStr) {
    const n = parseInt(mindestStr, 10)
    if (!isNaN(n) && n >= 0) mindestbestand = n
    else warnungen.push(`Mindestbestand "${mindestStr}" ungültig — wird ignoriert`)
  }

  if (fehler.length > 0) {
    return { zeile, gueltig: false, fehler, warnungen, kategorieStr }
  }

  return {
    zeile,
    gueltig: true,
    fehler:  [],
    warnungen,
    kategorieStr,
    daten: {
      bezeichnung,
      preisBruttoCent: preisCent,
      mwstSatz:        mwstSatz as MwStSatz,
      station,
      kategorieId,
      istFavorit:      false,
      lagerstandAktiv,
      lagerstandMenge,
      mindestbestand,
    },
  }
}
