/**
 * PDF-Generierung — Z-Bon / Tagesabschluss + Kassensturz
 *
 * jsPDF wird per dynamic import lazy-geladen (nur beim ersten Klick auf
 * „PDF herunterladen" wird das ~300 kB große Bundle nachgeladen).
 */

import type { Tagesabschluss, KassenbuchResponse } from '@kassa/shared'
import type { KassensturzDruckInput } from './api'

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

/** Cent-Betrag → lesbares Währungsformat, z. B. "€ 12,50" */
function cent(c: number): string {
  const sign = c < 0 ? '-' : ''
  const abs  = Math.abs(c)
  return `${sign}€ ${(abs / 100).toFixed(2).replace('.', ',')}`
}

/** YYYY-MM-DD → DD.MM.YYYY */
function fmt(d: string): string {
  const [y, m, day] = d.split('-')
  return `${day}.${m}.${y}`
}

// ---------------------------------------------------------------------------
// Haupt-Funktion
// ---------------------------------------------------------------------------

export async function downloadZBonPdf(
  data:              Tagesabschluss,
  firmenname:        string,
  kassenBezeichnung: string,
  kassenbuch?:       KassenbuchResponse,
  belegFusstext?:    string | null,
): Promise<void> {
  // Lazy-Load — lädt jsPDF + Plugin nur beim ersten Aufruf
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])

  const doc    = new jsPDF({ unit: 'mm', format: 'a4', putOnlyUsedFonts: true })
  const pageW  = doc.internal.pageSize.getWidth()
  const pageH  = doc.internal.pageSize.getHeight()
  const mL     = 20   // margin left
  const mR     = 20   // margin right
  const grau   = [243, 244, 246] as [number, number, number]

  let y = 22

  // ── Kopfzeile ──────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('Z-Bon / Tagesabschluss', mL, y)
  y += 7

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(90)
  doc.text(firmenname,                            mL, y); y += 4.5
  doc.text(`Kasse: ${kassenBezeichnung}`,         mL, y); y += 4.5
  doc.text(`Datum: ${fmt(data.datum)}`,           mL, y)

  // Kassen-Info rechtsbündig
  doc.text(
    `Erstellt: ${new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' })}`,
    pageW - mR, y - 4.5,
    { align: 'right' },
  )
  doc.setTextColor(0)
  y += 8

  // Trennlinie
  doc.setDrawColor(210)
  doc.line(mL, y, pageW - mR, y)
  y += 8

  // ── Übersicht ──────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text('Übersicht', mL, y)
  y += 4

  autoTable(doc, {
    startY: y,
    margin: { left: mL, right: mR },
    body:   [
      ['Barzahlungsbelege',  String(data.anzahlBarzahlungsbelege)],
      ...(data.anzahlStornobelege > 0
        ? [['Stornobelege', String(data.anzahlStornobelege)]]
        : []),
      ['Netto-Umsatz',       cent(data.nettoUmsatzCent)],
    ],
    columnStyles: { 0: { cellWidth: 70 }, 1: { halign: 'right' } },
    styles:       { fontSize: 10, cellPadding: 2.5 },
    theme:        'plain',
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8

  // ── Zahlungsarten ──────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text('Zahlungsarten', mL, y)
  y += 4

  const zahlungszeilen: [string, string][] = []
  if (data.barCent      !== 0) zahlungszeilen.push(['Bar',       cent(data.barCent)])
  if (data.karteCent    !== 0) zahlungszeilen.push(['Karte',     cent(data.karteCent)])
  if (data.sonstigCent  !== 0) zahlungszeilen.push(['Sonstige',  cent(data.sonstigCent)])

  autoTable(doc, {
    startY:      y,
    margin:      { left: mL, right: mR },
    head:        [['Zahlungsart', 'Betrag']],
    body:        zahlungszeilen,
    foot:        [['Gesamt', cent(data.nettoUmsatzCent)]],
    columnStyles: { 0: { cellWidth: 70 }, 1: { halign: 'right' } },
    styles:       { fontSize: 10, cellPadding: 2.5 },
    headStyles:   { fillColor: grau, textColor: 50, fontStyle: 'bold', fontSize: 9 },
    footStyles:   { fillColor: [255, 255, 255], fontStyle: 'bold', fontSize: 10 },
    theme:        'striped',
    showFoot:     'lastPage',
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8

  // ── USt-Aufteilung ─────────────────────────────────────────────────────────
  if (data.mwst.length > 0) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.text('USt-Aufteilung', mL, y)
    y += 4

    const mwstBody = data.mwst.map(z => [
      z.label,
      cent(z.bruttoCent),
      cent(z.nettoCent),
      cent(z.ustCent),
    ])

    const mwstFoot = data.mwst.length > 1
      ? [[
          'Gesamt',
          cent(data.mwst.reduce((s, z) => s + z.bruttoCent, 0)),
          cent(data.mwst.reduce((s, z) => s + z.nettoCent,  0)),
          cent(data.mwst.reduce((s, z) => s + z.ustCent,    0)),
        ]]
      : []

    autoTable(doc, {
      startY:      y,
      margin:      { left: mL, right: mR },
      head:        [['Steuersatz', 'Brutto', 'Netto', 'USt']],
      body:        mwstBody,
      foot:        mwstFoot,
      columnStyles: {
        0: { cellWidth: 50 },
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right' },
      },
      styles:     { fontSize: 10, cellPadding: 2.5 },
      headStyles: { fillColor: grau, textColor: 50, fontStyle: 'bold', fontSize: 9 },
      footStyles: { fillColor: [255, 255, 255], fontStyle: 'bold', fontSize: 10 },
      theme:      'striped',
      showFoot:   'lastPage',
    })
  }

  // ── Kassenbuch (optional) ──────────────────────────────────────────────────
  if (kassenbuch && kassenbuch.buchungen.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable?.finalY ?? y
    y += 8

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(0)
    doc.text('Kassenbuch (Einlagen / Entnahmen)', mL, y)
    y += 4

    const kbBody = kassenbuch.buchungen.map(b => [
      b.datum,
      b.typ === 'einlage' ? 'Einlage' : 'Entnahme',
      b.grund ?? '',
      b.userName ?? '',
      (b.typ === 'einlage' ? '+' : '-') + cent(b.betragCent),
    ])

    autoTable(doc, {
      startY:      y,
      margin:      { left: mL, right: mR },
      head:        [['Datum', 'Art', 'Grund', 'Benutzer', 'Betrag']],
      body:        kbBody,
      foot:        [[
        '', '', '', 'Saldo',
        (kassenbuch.saldoCent >= 0 ? '+' : '') + cent(kassenbuch.saldoCent),
      ]],
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 22 },
        2: { cellWidth: 'auto' },
        3: { cellWidth: 30 },
        4: { halign: 'right', cellWidth: 28 },
      },
      styles:     { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: grau, textColor: 50, fontStyle: 'bold', fontSize: 8 },
      footStyles: { fillColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
      theme:      'striped',
      showFoot:   'lastPage',
    })
  }

  // ── Belegfußtext (optional) ────────────────────────────────────────────────
  if (belegFusstext && belegFusstext.trim()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastY = (doc as any).lastAutoTable?.finalY ?? y
    const fussBeginn = lastY + 10

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(80)

    const zeilen = doc.splitTextToSize(belegFusstext.trim(), pageW - mL - mR)
    doc.text(zeilen, mL, fussBeginn)
  }

  // ── Fußzeile ───────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(150)
  doc.text('Kassa — RKSV-konformes Kassensystem', mL, pageH - 10)
  doc.text(`Kassa v${__APP_VERSION__}`, pageW - mR, pageH - 10, { align: 'right' })

  // ── Datei-Download ─────────────────────────────────────────────────────────
  const dateiname = `zbon_${data.datum}_${kassenBezeichnung.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`
  doc.save(dateiname)
}

// ---------------------------------------------------------------------------
// Kassensturz-PDF
// ---------------------------------------------------------------------------

export async function downloadKassensturzPdf(
  input:             KassensturzDruckInput,
  firmenname:        string,
  kassenBezeichnung: string,
): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])

  const doc   = new jsPDF({ unit: 'mm', format: 'a4', putOnlyUsedFonts: true })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const mL    = 20
  const mR    = 20
  const grau  = [243, 244, 246] as [number, number, number]

  let y = 22

  // ── Kopfzeile ──────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('Kassensturz', mL, y)
  y += 7

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(90)
  doc.text(firmenname,                              mL, y); y += 4.5
  doc.text(`Kasse: ${kassenBezeichnung}`,           mL, y); y += 4.5
  doc.text(`Datum: ${fmt(input.datum)}`,            mL, y)
  doc.text(
    `Erstellt: ${new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' })}`,
    pageW - mR, y - 4.5,
    { align: 'right' },
  )
  doc.setTextColor(0)
  y += 8

  doc.setDrawColor(210)
  doc.line(mL, y, pageW - mR, y)
  y += 8

  // ── Stückelung ─────────────────────────────────────────────────────────────
  const aktiveStueck = input.stueck.filter(s => s.anzahl > 0)
  if (aktiveStueck.length > 0) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.text('Stückelung', mL, y)
    y += 4

    autoTable(doc, {
      startY:      y,
      margin:      { left: mL, right: mR },
      head:        [['Stückelung', 'Anzahl', 'Summe']],
      body:        aktiveStueck.map(s => [s.label, `× ${s.anzahl}`, cent(s.summeCent)]),
      foot:        [['Gesamt gezählt', '', cent(input.istCent)]],
      columnStyles: { 0: { cellWidth: 50 }, 1: { halign: 'center' }, 2: { halign: 'right' } },
      styles:       { fontSize: 10, cellPadding: 2.5 },
      headStyles:   { fillColor: grau, textColor: 50, fontStyle: 'bold', fontSize: 9 },
      footStyles:   { fillColor: [255, 255, 255], fontStyle: 'bold', fontSize: 10 },
      theme:        'striped',
      showFoot:     'lastPage',
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 8
  }

  // ── Ergebnis ───────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text('Ergebnis', mL, y)
  y += 4

  const ergebnisBody: [string, string][] = [
    ['Gezählt (IST)', cent(input.istCent)],
  ]
  if (input.startgeldCent > 0) {
    ergebnisBody.push(['  davon Startgeld', cent(input.startgeldCent)])
  }
  ergebnisBody.push([
    `Bar-Umsatz laut Belegen (SOLL)${input.startgeldCent > 0 ? ' inkl. Startgeld' : ''}`,
    cent(input.sollCent),
  ])

  const diff     = input.differenzCent
  const diffText = diff === 0
    ? 'Ausgeglichen'
    : diff > 0 ? `Überschuss (+${cent(diff)})`
    : `Fehlbetrag (${cent(diff)})`

  autoTable(doc, {
    startY:      y,
    margin:      { left: mL, right: mR },
    body:        ergebnisBody,
    foot:        [['DIFFERENZ', diff >= 0 ? `+${cent(diff)}` : cent(diff)]],
    columnStyles: { 0: { cellWidth: 100 }, 1: { halign: 'right' } },
    styles:       { fontSize: 10, cellPadding: 2.5 },
    footStyles:   {
      fillColor: diff === 0
        ? ([220, 252, 231] as [number, number, number])
        : ([254, 226, 226] as [number, number, number]),
      textColor:  diff === 0 ? 22 : 153,
      fontStyle:  'bold',
      fontSize:   11,
    },
    theme:    'plain',
    showFoot: 'lastPage',
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 6

  // Ergebnis-Hinweis
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(diff === 0 ? 21 : diff > 0 ? 29 : 153)
  doc.text(
    diff === 0 ? '✓ ' + diffText : diffText,
    doc.internal.pageSize.getWidth() / 2, y,
    { align: 'center' },
  )
  doc.setTextColor(0)

  // ── Fußzeile ───────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(150)
  doc.text('Kassa — RKSV-konformes Kassensystem', mL, pageH - 10)
  doc.text(`Kassa v${__APP_VERSION__}`, pageW - mR, pageH - 10, { align: 'right' })

  doc.save(`kassensturz_${input.datum}_${kassenBezeichnung.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`)
}

// ---------------------------------------------------------------------------
// Kassenbuch-PDF
// ---------------------------------------------------------------------------

export async function downloadKassenbuchPdf(
  data:              KassenbuchResponse,
  firmenname:        string,
  kassenBezeichnung: string,
): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])

  const doc   = new jsPDF({ unit: 'mm', format: 'a4', putOnlyUsedFonts: true })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const mL    = 20
  const mR    = 20
  const grau  = [243, 244, 246] as [number, number, number]

  let y = 22

  // ── Kopfzeile ──────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('Kassenbuch', mL, y)
  y += 7

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(90)
  doc.text(firmenname,                              mL, y); y += 4.5
  doc.text(`Kasse: ${kassenBezeichnung}`,           mL, y); y += 4.5
  doc.text(`Zeitraum: ${fmt(data.von)} – ${fmt(data.bis)}`, mL, y)
  doc.text(
    `Erstellt: ${new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' })}`,
    pageW - mR, y,
    { align: 'right' },
  )
  doc.setTextColor(0)
  y += 8

  doc.setDrawColor(210)
  doc.line(mL, y, pageW - mR, y)
  y += 8

  // ── Übersicht ──────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text('Übersicht', mL, y)
  y += 4

  autoTable(doc, {
    startY:       y,
    margin:       { left: mL, right: mR },
    body:         [
      ['Einlagen',  cent(data.einlagenCent)],
      ['Entnahmen', `- ${cent(data.entnahmenCent)}`],
    ],
    foot:         [['Saldo', (data.saldoCent >= 0 ? '+' : '') + cent(data.saldoCent)]],
    columnStyles: { 0: { cellWidth: 60 }, 1: { halign: 'right' } },
    styles:       { fontSize: 10, cellPadding: 2.5 },
    footStyles:   {
      fillColor: data.saldoCent >= 0
        ? ([220, 252, 231] as [number, number, number])
        : ([254, 226, 226] as [number, number, number]),
      textColor:  data.saldoCent >= 0 ? 22 : 153,
      fontStyle:  'bold',
      fontSize:   10,
    },
    theme:    'plain',
    showFoot: 'lastPage',
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8

  // ── Buchungsliste ──────────────────────────────────────────────────────────
  if (data.buchungen.length > 0) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.text('Buchungen', mL, y)
    y += 4

    autoTable(doc, {
      startY:  y,
      margin:  { left: mL, right: mR },
      head:    [['Datum', 'Art', 'Grund', 'Benutzer', 'Betrag']],
      body:    data.buchungen.map(b => [
        fmt(b.datum),
        b.typ === 'einlage' ? 'Einlage' : 'Entnahme',
        b.grund ?? '',
        b.userName ?? '',
        (b.typ === 'einlage' ? '+' : '-') + cent(b.betragCent),
      ]),
      columnStyles: {
        0: { cellWidth: 24 },
        1: { cellWidth: 24 },
        2: { cellWidth: 'auto' },
        3: { cellWidth: 35 },
        4: { halign: 'right', cellWidth: 30 },
      },
      styles:     { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: grau, textColor: 50, fontStyle: 'bold', fontSize: 8 },
      theme:      'striped',
    })
  }

  // ── Fußzeile ───────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(150)
  doc.text('Kassa — RKSV-konformes Kassensystem', mL, pageH - 10)
  doc.text(`Kassa v${__APP_VERSION__}`, pageW - mR, pageH - 10, { align: 'right' })

  doc.save(`kassenbuch_${data.von}_${data.bis}_${kassenBezeichnung.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`)
}
