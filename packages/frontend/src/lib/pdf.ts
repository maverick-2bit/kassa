/**
 * PDF-Generierung — Z-Bon / Tagesabschluss
 *
 * jsPDF wird per dynamic import lazy-geladen (nur beim ersten Klick auf
 * „PDF herunterladen" wird das ~300 kB große Bundle nachgeladen).
 */

import type { Tagesabschluss } from '@kassa/shared'

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
