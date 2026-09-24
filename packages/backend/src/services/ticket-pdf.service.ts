/**
 * Ticket-PDF (A4) — eine Seite je Ticket, im Aufbau der Ticketseite:
 * dunkler Kopf mit Event/Datum/Ort/Hinweis, darunter Ticketart, Band, Status,
 * QR-Code, Code und der Hinweis zur Gültigkeit.
 *
 * Der QR-Code wird als Vektor gezeichnet (kein Bild) — gestochen scharf in
 * jeder Druckgröße. Schrift ist Helvetica (WinAnsi): Umlaute, €, „–" und „·"
 * sind abgedeckt, Emojis bewusst nicht verwendet.
 */

import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import {
  eventZeitText,
  ticketTitel,
  ticketGueltigkeitsHinweis,
  TICKET_ANZEIGE_STATUS_LABELS,
  type TicketAnzeigeStatus,
  type TicketBandAnzeige,
  type TicketEventStatus,
  type TicketTyp,
} from '@kassa/shared'

export interface TicketPdfDaten {
  /** QR-Inhalt: Link zur Ticketseite */
  url:           string
  code:          string
  typ:           TicketTyp
  bezeichnung:   string
  name:          string | null
  anzeigeStatus: TicketAnzeigeStatus
  band:          TicketBandAnzeige | null
  event: {
    titel:        string
    beginn:       string
    ort:          string
    adresse:      string | null
    hinweis:      string | null
    status:       TicketEventStatus
    veranstalter: string
  }
  verkaeufer:    string
}

// Farben der Vorlage
const KOPF_BLAU   = '#1f2a52'
const KOPF_TEXT   = '#ffffff'
const KOPF_LEISE  = '#c7cde0'
const HINWEIS_BG  = '#d4a72c'
const TEXT        = '#1a2027'
const TEXT_LEISE  = '#6b7280'
const RAHMEN      = '#e2e6ea'
const WARN_BG     = '#fef3c7'
const WARN_RAND   = '#fcd34d'
const WARN_TEXT   = '#78350f'

const STATUS_FARBEN: Record<TicketAnzeigeStatus, { bg: string; text: string }> = {
  gueltig:    { bg: '#dcfce7', text: '#166534' },
  eingeloest: { bg: '#e5e7eb', text: '#374151' },
  storniert:  { bg: '#fee2e2', text: '#991b1b' },
  abgesagt:   { bg: '#fee2e2', text: '#991b1b' },
}

/** Pille mit Hintergrundfarbe; liefert die Breite zurück. */
function pille(
  doc: PDFKit.PDFDocument, text: string, x: number, y: number,
  opts: { bg: string; farbe: string; groesse: number; fett?: boolean; rechtsBuendigAn?: number },
): number {
  doc.font(opts.fett === false ? 'Helvetica' : 'Helvetica-Bold').fontSize(opts.groesse)
  const breite = doc.widthOfString(text) + opts.groesse * 1.4
  const hoehe  = opts.groesse * 1.9
  const links  = opts.rechtsBuendigAn !== undefined ? opts.rechtsBuendigAn - breite : x
  doc.roundedRect(links, y, breite, hoehe, hoehe / 2).fill(opts.bg)
  doc.fillColor(opts.farbe).text(text, links + opts.groesse * 0.7, y + opts.groesse * 0.5, { lineBreak: false })
  return breite
}

/** QR-Code als Vektor: alle dunklen Module in einem Pfad, einmal gefüllt. */
function zeichneQr(doc: PDFKit.PDFDocument, inhalt: string, x: number, y: number, groesse: number): void {
  const qr     = QRCode.create(inhalt, { errorCorrectionLevel: 'M' })
  const anzahl = qr.modules.size
  const modul  = groesse / anzahl
  for (let zeile = 0; zeile < anzahl; zeile++) {
    for (let spalte = 0; spalte < anzahl; spalte++) {
      if (qr.modules.get(zeile, spalte)) {
        // minimal überlappen, damit zwischen Modulen keine Haarlinien entstehen
        doc.rect(x + spalte * modul, y + zeile * modul, modul + 0.2, modul + 0.2)
      }
    }
  }
  doc.fill('#000000')
}

/** Rechteck mit nur oben gerundeten Ecken (Kopf der Ticketkarte). */
function obenGerundet(doc: PDFKit.PDFDocument, x: number, y: number, b: number, h: number, r: number): void {
  doc.moveTo(x, y + h)
    .lineTo(x, y + r)
    .quadraticCurveTo(x, y, x + r, y)
    .lineTo(x + b - r, y)
    .quadraticCurveTo(x + b, y, x + b, y + r)
    .lineTo(x + b, y + h)
    .closePath()
}

function zeichneTicket(doc: PDFKit.PDFDocument, t: TicketPdfDaten): void {
  const kartenB = 420
  const x0      = (doc.page.width - kartenB) / 2
  const innen   = 28
  const textB   = kartenB - innen * 2
  const oben    = 60
  const ort     = t.event.adresse ? `${t.event.ort}, ${t.event.adresse}` : t.event.ort

  // ---- Kopf: erst messen, dann Hintergrund, dann Text ----
  const PAD_OBEN = 22, PAD_UNTEN = 18, PILLE_H = 11 * 1.9
  doc.font('Helvetica-Bold').fontSize(20)
  const titelH = doc.heightOfString(t.event.titel, { width: textB })
  doc.font('Helvetica').fontSize(12)
  const ortH = doc.heightOfString(ort, { width: textB })
  const kopfH = PAD_OBEN
    + (t.event.status === 'test' ? 18 : 0)
    + titelH + 8
    + 18 + ortH
    + (t.event.hinweis ? 10 + PILLE_H : 0)
    + PAD_UNTEN

  obenGerundet(doc, x0, oben, kartenB, kopfH, 14)
  doc.fill(KOPF_BLAU)

  let y = oben + PAD_OBEN
  if (t.event.status === 'test') {
    doc.font('Helvetica').fontSize(10).fillColor(KOPF_LEISE)
      .text('Interner Test · nicht veröffentlichen', x0 + innen, y, { width: textB })
    y += 18
  }
  doc.font('Helvetica-Bold').fontSize(20).fillColor(KOPF_TEXT)
    .text(t.event.titel, x0 + innen, y, { width: textB })
  y += titelH + 8
  doc.font('Helvetica').fontSize(12).fillColor(KOPF_TEXT)
    .text(eventZeitText(t.event.beginn), x0 + innen, y, { width: textB })
  y += 18
  doc.text(ort, x0 + innen, y, { width: textB })
  y += ortH
  if (t.event.hinweis) {
    y += 10
    pille(doc, t.event.hinweis, x0 + innen, y, { bg: HINWEIS_BG, farbe: '#1a1a1a', groesse: 11 })
  }
  y = oben + kopfH

  // Perforation zwischen Kopf und Körper
  doc.save()
  doc.moveTo(x0, y).lineTo(x0 + kartenB, y).dash(5, { space: 4 }).lineWidth(1).stroke('#9aa3b5')
  doc.undash()
  doc.restore()
  y += 20

  // ---- Ticketart + Status ----
  doc.font('Helvetica-Bold').fontSize(14).fillColor(TEXT)
    .text(ticketTitel(t), x0 + innen, y, { width: textB - 90 })
  const statusFarbe = STATUS_FARBEN[t.anzeigeStatus]
  pille(doc, TICKET_ANZEIGE_STATUS_LABELS[t.anzeigeStatus], 0, y - 2, {
    bg: statusFarbe.bg, farbe: statusFarbe.text, groesse: 10, rechtsBuendigAn: x0 + kartenB - innen,
  })
  y += 22

  if (t.band) {
    pille(doc, `Band ${t.band.bezeichnung} · ${t.band.altersText}`, x0 + innen, y, {
      bg: t.band.farbe, farbe: '#ffffff', groesse: 10,
    })
    y += 24
  }
  if (t.name) {
    doc.font('Helvetica').fontSize(11).fillColor(TEXT_LEISE)
      .text(t.name, x0 + innen, y, { width: textB })
    y += 16
  }

  // ---- QR + Code ----
  y += 8
  const qrGroesse = 190
  zeichneQr(doc, t.url, x0 + (kartenB - qrGroesse) / 2, y, qrGroesse)
  y += qrGroesse + 12

  doc.font('Courier').fontSize(11)
  const codeB = doc.widthOfString(t.code) + 16
  doc.roundedRect(x0 + (kartenB - codeB) / 2, y, codeB, 18, 5).fill('#eceef1')
  doc.fillColor(TEXT).text(t.code, x0 + (kartenB - codeB) / 2 + 8, y + 4, { lineBreak: false })
  y += 34

  // ---- Gültigkeitshinweis ----
  const hinweis = ticketGueltigkeitsHinweis(t.typ)
  doc.font('Helvetica').fontSize(10)
  const warnH = doc.heightOfString(`${hinweis.titel} ${hinweis.text}`, { width: textB - 24 }) + 20
  doc.roundedRect(x0 + innen, y, textB, warnH, 8).fillAndStroke(WARN_BG, WARN_RAND)
  doc.fillColor(WARN_TEXT).font('Helvetica-Bold').fontSize(10)
    .text(hinweis.titel, x0 + innen + 12, y + 10, { width: textB - 24, continued: true })
    .font('Helvetica').text(` ${hinweis.text}`)
  y += warnH + 18

  // ---- Fußzeile ----
  doc.moveTo(x0, y).lineTo(x0 + kartenB, y).lineWidth(0.8).stroke(RAHMEN)
  y += 12
  const fuss = t.event.veranstalter === t.verkaeufer
    ? `Veranstalter & Verkäufer: ${t.verkaeufer}`
    : `Veranstalter: ${t.event.veranstalter} · Verkauf: ${t.verkaeufer}`
  doc.font('Helvetica').fontSize(9).fillColor(TEXT_LEISE)
    .text(fuss, x0 + innen, y, { width: textB, align: 'center' })
  y += 22

  // Rahmen um die ganze Karte
  doc.roundedRect(x0, oben, kartenB, y - oben, 14).lineWidth(1).stroke(RAHMEN)
}

/** Ein PDF mit einer A4-Seite je Ticket. */
export async function erzeugeTicketPdf(tickets: TicketPdfDaten[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: {
    Title:   tickets.length === 1 ? `Ticket ${tickets[0]!.code}` : `Tickets (${tickets.length})`,
    Creator: 'Kassa Ticketing',
  } })
  const teile: Buffer[] = []
  doc.on('data', (b: Buffer) => teile.push(b))
  const fertig = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(teile)))
    doc.on('error', reject)
  })
  for (const t of tickets) {
    doc.addPage()
    zeichneTicket(doc, t)
  }
  doc.end()
  return fertig
}

/** QR-Code als PNG (für E-Mails — dort sind Vektoren nicht verlässlich darstellbar). */
export async function erzeugeQrPng(inhalt: string, pixel = 360): Promise<Buffer> {
  return QRCode.toBuffer(inhalt, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: pixel })
}
