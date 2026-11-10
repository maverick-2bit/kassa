/**
 * Bestell-PDF (A4) einer Einkaufsbestellung — geht an den Lieferanten.
 *
 * Aufbau: Briefkopf (eigene Firma), Anschrift des Lieferanten, Titel mit Nummer/Datum/Wunschtermin,
 * Positionstabelle (Pos., Art.-Nr. beim Lieferanten, Bezeichnung, Menge, EK netto, Summe), Gesamtsumme,
 * Bemerkung, Zahlungsbedingung, Fußtext. Schrift Helvetica (WinAnsi: Umlaute und „€" sind abgedeckt).
 * Seitenumbruch mit wiederholtem Tabellenkopf.
 */

import PDFDocument from 'pdfkit'
import type { EinkaufBestellung } from '@kassa/shared'

export interface BestellPdfFirma {
  firmenname: string
  uid?:       string | null
  kopftext?:  string | null
  fusstext?:  string | null
}

export interface BestellPdfLieferant {
  name:               string
  kontakt?:           string | null
  strasse?:           string | null
  plz?:               string | null
  ort?:               string | null
  land?:              string | null
  uid?:               string | null
  /** Unsere Kundennummer beim Lieferanten */
  kundennummer?:      string | null
  zahlungsbedingung?: string | null
}

const SEITE_B = 595.28
const SEITE_H = 841.89
const RAND = 50
const INHALT_B = SEITE_B - 2 * RAND
const UNTEN = SEITE_H - 70

/** 1250 → „12,50 €" (Tausenderpunkte) */
export function formatEuro(cent: number): string {
  const neg = cent < 0
  const abs = Math.abs(cent)
  const euro = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const rest = String(abs % 100).padStart(2, '0')
  return `${neg ? '-' : ''}${euro},${rest} €`
}

/** YYYY-MM-DD bzw. ISO-Zeitpunkt → 31.12.2026 (Wiener Zeit für Zeitpunkte) */
export function formatDatum(wert: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(wert)) {
    const [j, m, t] = wert.split('-')
    return `${t}.${m}.${j}`
  }
  return new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(wert))
}

export async function erzeugeBestellungPdf(
  bestellung: EinkaufBestellung, firma: BestellPdfFirma, lieferant: BestellPdfLieferant,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4', margin: RAND, bufferPages: true,
    info: { Title: `Bestellung ${bestellung.nummer}`, Author: firma.firmenname, Creator: 'Kassa' },
  })
  const teile: Buffer[] = []
  doc.on('data', (b: Buffer) => teile.push(b))
  const fertig = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(teile)))
    doc.on('error', reject)
  })

  // ---- Briefkopf
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#111111').text(firma.firmenname, RAND, RAND)
  doc.font('Helvetica').fontSize(9).fillColor('#444444')
  if (firma.kopftext) doc.text(firma.kopftext, { width: INHALT_B * 0.6 })
  if (firma.uid) doc.text(`UID: ${firma.uid}`)

  // ---- Anschrift Lieferant
  let y = Math.max(doc.y + 24, 150)
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(lieferant.name, RAND, y, { width: INHALT_B * 0.55 })
  doc.font('Helvetica').fontSize(10)
  if (lieferant.kontakt) doc.text(`z. H. ${lieferant.kontakt}`)
  if (lieferant.strasse) doc.text(lieferant.strasse)
  const ortZeile = [lieferant.plz, lieferant.ort].filter(Boolean).join(' ')
  if (ortZeile) doc.text(ortZeile)
  if (lieferant.land && lieferant.land !== 'AT') doc.text(lieferant.land)

  // ---- Titel + Eckdaten (rechts neben der Anschrift)
  const xr = RAND + INHALT_B * 0.6
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111').text('BESTELLUNG', xr, y, { width: INHALT_B * 0.4, align: 'right' })
  doc.font('Helvetica').fontSize(10).fillColor('#222222')
  const eck: [string, string][] = [
    ['Nummer', bestellung.nummer],
    ['Datum', formatDatum(bestellung.createdAt)],
  ]
  if (bestellung.liefertermin) eck.push(['Wunschtermin', formatDatum(bestellung.liefertermin)])
  if (lieferant.kundennummer) eck.push(['Unsere Kd.-Nr.', lieferant.kundennummer])
  let ye = doc.y + 4
  for (const [k, v] of eck) {
    doc.font('Helvetica').fillColor('#666666').text(k, xr, ye, { width: INHALT_B * 0.2, align: 'left', lineBreak: false })
    doc.font('Helvetica-Bold').fillColor('#111111').text(v, xr + INHALT_B * 0.2, ye, { width: INHALT_B * 0.2, align: 'right', lineBreak: false })
    ye += 14
  }

  y = Math.max(doc.y, ye) + 28
  doc.font('Helvetica').fontSize(10).fillColor('#222222')
    .text('Wir bestellen bei Ihnen folgende Artikel:', RAND, y)
  y = doc.y + 10

  // ---- Tabelle
  const sp = {
    pos:  { x: RAND,        w: 26 },
    art:  { x: RAND + 26,   w: 88 },
    bez:  { x: RAND + 114,  w: 191 },
    menge:{ x: RAND + 305,  w: 50 },
    ek:   { x: RAND + 355,  w: 70 },
    sum:  { x: RAND + 425,  w: INHALT_B - 425 },
  }
  const kopf = (yy: number): number => {
    doc.rect(RAND, yy, INHALT_B, 18).fill('#EEF1F5')
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#333333')
    doc.text('Pos.', sp.pos.x + 4, yy + 5, { width: sp.pos.w, lineBreak: false })
    doc.text('Art.-Nr.', sp.art.x, yy + 5, { width: sp.art.w, lineBreak: false })
    doc.text('Bezeichnung', sp.bez.x, yy + 5, { width: sp.bez.w, lineBreak: false })
    doc.text('Menge', sp.menge.x, yy + 5, { width: sp.menge.w - 6, align: 'right', lineBreak: false })
    doc.text('EK netto', sp.ek.x, yy + 5, { width: sp.ek.w - 6, align: 'right', lineBreak: false })
    doc.text('Summe', sp.sum.x, yy + 5, { width: sp.sum.w - 4, align: 'right', lineBreak: false })
    return yy + 22
  }
  y = kopf(y)

  doc.font('Helvetica').fontSize(9.5).fillColor('#111111')
  for (const p of bestellung.positionen) {
    const hoehe = Math.max(
      doc.heightOfString(p.bezeichnung, { width: sp.bez.w }),
      doc.heightOfString(p.lieferantenArtikelnummer ?? '', { width: sp.art.w }),
      12,
    ) + 8
    if (y + hoehe > UNTEN) {
      doc.addPage()
      y = kopf(RAND)
      doc.font('Helvetica').fontSize(9.5).fillColor('#111111')
    }
    doc.text(String(p.position), sp.pos.x + 4, y, { width: sp.pos.w, lineBreak: false })
    doc.text(p.lieferantenArtikelnummer ?? '', sp.art.x, y, { width: sp.art.w })
    doc.text(p.bezeichnung, sp.bez.x, y, { width: sp.bez.w })
    doc.text(String(p.menge), sp.menge.x, y, { width: sp.menge.w - 6, align: 'right', lineBreak: false })
    doc.text(p.einkaufspreisCent != null ? formatEuro(p.einkaufspreisCent) : '–', sp.ek.x, y, { width: sp.ek.w - 6, align: 'right', lineBreak: false })
    doc.text(p.einkaufspreisCent != null ? formatEuro(p.menge * p.einkaufspreisCent) : '–', sp.sum.x, y, { width: sp.sum.w - 4, align: 'right', lineBreak: false })
    y += hoehe
    doc.moveTo(RAND, y - 3).lineTo(RAND + INHALT_B, y - 3).lineWidth(0.4).strokeColor('#DDDDDD').stroke()
  }

  // ---- Summe
  if (y + 60 > UNTEN) { doc.addPage(); y = RAND }
  y += 6
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111')
  doc.text(bestellung.summeUnvollstaendig ? 'Summe netto (ohne Positionen ohne Preis)' : 'Summe netto', RAND, y, { width: 330, align: 'right', lineBreak: false })
  doc.text(formatEuro(bestellung.summeNettoCent), sp.sum.x - 20, y, { width: sp.sum.w + 16, align: 'right', lineBreak: false })
  y += 24

  // ---- Bemerkung / Bedingungen
  doc.font('Helvetica').fontSize(9.5).fillColor('#222222')
  if (bestellung.bemerkung) {
    if (y + 40 > UNTEN) { doc.addPage(); y = RAND }
    doc.font('Helvetica-Bold').text('Bemerkung', RAND, y)
    doc.font('Helvetica').text(bestellung.bemerkung, RAND, doc.y + 2, { width: INHALT_B })
    y = doc.y + 10
  }
  if (lieferant.zahlungsbedingung) {
    if (y + 30 > UNTEN) { doc.addPage(); y = RAND }
    doc.font('Helvetica').fillColor('#666666').text(`Zahlungsbedingung laut Vereinbarung: ${lieferant.zahlungsbedingung}`, RAND, y, { width: INHALT_B })
    y = doc.y + 10
  }
  doc.font('Helvetica').fontSize(9.5).fillColor('#222222').text('Bitte bestätigen Sie die Bestellung und den Liefertermin. Vielen Dank!', RAND, y, { width: INHALT_B })

  // ---- Fuß + Seitenzahlen auf allen Seiten
  const seiten = doc.bufferedPageRange()
  for (let i = 0; i < seiten.count; i++) {
    doc.switchToPage(seiten.start + i)
    // Unterer Rand 0: sonst legt pdfkit beim Schreiben im Fußbereich eine neue Seite an
    doc.page.margins.bottom = 0
    doc.font('Helvetica').fontSize(8).fillColor('#888888')
    if (firma.fusstext) doc.text(firma.fusstext, RAND, SEITE_H - 58, { width: INHALT_B, align: 'center', lineBreak: true, height: 24 })
    doc.text(`${bestellung.nummer} · Seite ${i + 1} von ${seiten.count}`, RAND, SEITE_H - 32, { width: INHALT_B, align: 'center', lineBreak: false })
  }
  doc.end()
  return fertig
}
