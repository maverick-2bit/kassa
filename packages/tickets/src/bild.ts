/**
 * „Als Foto speichern": zeichnet das Ticket auf ein Canvas (1080 px breit).
 *
 * Bewusst gezeichnet statt vom DOM abfotografiert — DOM-zu-Bild-Bibliotheken
 * stolpern am Handy über Schriften und Emojis; hier ist jedes Pixel bestimmt.
 */

import {
  TICKET_ANZEIGE_STATUS_LABELS,
  eventZeitText,
  ticketGueltigkeitsHinweis,
  ticketTitel,
  type TicketOeffentlich,
} from '@kassa/shared'

const B = 1080          // Bildbreite
const RAND = 48         // Außenrand ums Ticket
const KB = B - 2 * RAND // Kartenbreite
const PAD = 64          // Innenabstand
const TB = KB - 2 * PAD // Textbreite

const SCHRIFT = '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

const STATUS_FARBEN = {
  gueltig:    ['#dcfce7', '#166534'],
  eingeloest: ['#e5e7eb', '#374151'],
  storniert:  ['#fee2e2', '#991b1b'],
  abgesagt:   ['#fee2e2', '#991b1b'],
} as const

function rundRechteck(ctx: CanvasRenderingContext2D, x: number, y: number, b: number, h: number, r: number | [number, number, number, number]) {
  const [ol, or, ur, ul] = Array.isArray(r) ? r : [r, r, r, r]
  ctx.beginPath()
  ctx.moveTo(x + ol, y)
  ctx.lineTo(x + b - or, y); ctx.quadraticCurveTo(x + b, y, x + b, y + or)
  ctx.lineTo(x + b, y + h - ur); ctx.quadraticCurveTo(x + b, y + h, x + b - ur, y + h)
  ctx.lineTo(x + ul, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - ul)
  ctx.lineTo(x, y + ol); ctx.quadraticCurveTo(x, y, x + ol, y)
  ctx.closePath()
}

/** Zeilenumbruch nach Wörtern für eine maximale Breite. */
function umbrechen(ctx: CanvasRenderingContext2D, text: string, breite: number): string[] {
  const zeilen: string[] = []
  let zeile = ''
  for (const wort of text.split(/\s+/)) {
    const versuch = zeile ? `${zeile} ${wort}` : wort
    if (ctx.measureText(versuch).width > breite && zeile) { zeilen.push(zeile); zeile = wort }
    else zeile = versuch
  }
  if (zeile) zeilen.push(zeile)
  return zeilen
}

function pille(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, farbe: string, px: number, rechtsBuendig = false): number {
  ctx.font = `700 ${px}px ${SCHRIFT}`
  const b = ctx.measureText(text).width + px * 1.4
  const h = px * 1.9
  const links = rechtsBuendig ? x - b : x
  ctx.fillStyle = bg
  rundRechteck(ctx, links, y, b, h, h / 2)
  ctx.fill()
  ctx.fillStyle = farbe
  ctx.textBaseline = 'middle'
  ctx.fillText(text, links + px * 0.7, y + h / 2 + 1)
  ctx.textBaseline = 'alphabetic'
  return h
}

export async function ticketAlsBild(t: TicketOeffentlich, qr: HTMLCanvasElement): Promise<Blob> {
  await document.fonts?.ready

  // Messdurchgang auf einem Hilfs-Canvas, damit die Höhe vorher feststeht
  const mess = document.createElement('canvas').getContext('2d')!
  mess.font = `700 52px ${SCHRIFT}`
  const titelZeilen = umbrechen(mess, t.event.titel, TB)
  const hinweis = ticketGueltigkeitsHinweis(t.typ)
  mess.font = `400 30px ${SCHRIFT}`
  const warnZeilen = umbrechen(mess, `${hinweis.titel} ${hinweis.text}`, TB - 56)
  const ort = t.event.adresse ? `${t.event.ort}, ${t.event.adresse}` : t.event.ort

  const kopfH = 56 + (t.event.status === 'test' ? 44 : 0) + titelZeilen.length * 62 + 20 + 2 * 46
    + (t.event.hinweis ? 24 + 30 * 1.9 : 0) + 48
  const qrGroesse = 560
  const koerperH = 56 + 50 + (t.name ? 40 : 0) + (t.band ? 70 : 0) + 30 + qrGroesse + 30 + 56
    + 40 + warnZeilen.length * 42 + 48 + 40
  const fussH = 110
  const H = RAND * 2 + kopfH + koerperH + fussH

  const canvas = document.createElement('canvas')
  canvas.width = B
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  // Seite + Karte
  ctx.fillStyle = '#f3f1ee'
  ctx.fillRect(0, 0, B, H)
  ctx.fillStyle = '#ffffff'
  rundRechteck(ctx, RAND, RAND, KB, H - 2 * RAND, 36)
  ctx.fill()

  // Kopf
  ctx.fillStyle = '#1f2a52'
  rundRechteck(ctx, RAND, RAND, KB, kopfH, [36, 36, 0, 0])
  ctx.fill()
  let y = RAND + 56
  const x = RAND + PAD
  if (t.event.status === 'test') {
    ctx.fillStyle = '#c7cde0'; ctx.font = `400 28px ${SCHRIFT}`
    ctx.fillText('Interner Test · nicht veröffentlichen', x, y + 8)
    y += 44
  }
  ctx.fillStyle = '#ffffff'; ctx.font = `700 52px ${SCHRIFT}`
  for (const z of titelZeilen) { y += 52; ctx.fillText(z, x, y); y += 10 }
  y += 20
  ctx.font = `400 34px ${SCHRIFT}`
  y += 40; ctx.fillText(eventZeitText(t.event.beginn), x, y)
  y += 46; ctx.fillText(ort, x, y)
  if (t.event.hinweis) {
    y += 24
    pille(ctx, t.event.hinweis, x, y, '#d4a72c', '#1a1a1a', 30)
  }
  y = RAND + kopfH

  // Perforation
  ctx.strokeStyle = '#9aa3b5'; ctx.lineWidth = 3; ctx.setLineDash([14, 10])
  ctx.beginPath(); ctx.moveTo(RAND, y); ctx.lineTo(RAND + KB, y); ctx.stroke()
  ctx.setLineDash([])

  // Ticketart + Status
  y += 56
  ctx.fillStyle = '#1a2027'; ctx.font = `700 40px ${SCHRIFT}`
  ctx.fillText(ticketTitel(t), x, y + 30)
  const [sBg, sText] = STATUS_FARBEN[t.anzeigeStatus]
  pille(ctx, TICKET_ANZEIGE_STATUS_LABELS[t.anzeigeStatus], RAND + KB - PAD, y - 4, sBg, sText, 28, true)
  y += 50
  if (t.name) {
    ctx.fillStyle = '#5f6b76'; ctx.font = `400 30px ${SCHRIFT}`
    ctx.fillText(t.name, x, y + 24)
    y += 40
  }
  if (t.band) {
    y += 14
    pille(ctx, `Band ${t.band.bezeichnung} · ${t.band.altersText}`, x, y, t.band.farbe, '#ffffff', 28)
    y += 56
  }

  // QR
  y += 30
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(qr, RAND + (KB - qrGroesse) / 2, y, qrGroesse, qrGroesse)
  y += qrGroesse + 30

  // Code
  ctx.font = `500 32px ui-monospace, Consolas, monospace`
  const codeB = ctx.measureText(t.code).width + 36
  ctx.fillStyle = '#eceef1'
  rundRechteck(ctx, RAND + (KB - codeB) / 2, y, codeB, 52, 12)
  ctx.fill()
  ctx.fillStyle = '#1a2027'; ctx.textBaseline = 'middle'
  ctx.fillText(t.code, RAND + (KB - codeB) / 2 + 18, y + 27)
  ctx.textBaseline = 'alphabetic'
  y += 56 + 40

  // Gültigkeitshinweis
  const warnH = warnZeilen.length * 42 + 48
  ctx.fillStyle = '#fef3c7'; ctx.strokeStyle = '#fcd34d'; ctx.lineWidth = 3
  rundRechteck(ctx, x, y, TB, warnH, 20)
  ctx.fill(); ctx.stroke()
  ctx.fillStyle = '#78350f'
  let wy = y + 24 + 30
  warnZeilen.forEach((zeile, i) => {
    if (i === 0 && zeile.startsWith(hinweis.titel)) {
      ctx.font = `700 30px ${SCHRIFT}`
      ctx.fillText(hinweis.titel, x + 28, wy)
      const b = ctx.measureText(hinweis.titel + ' ').width
      ctx.font = `400 30px ${SCHRIFT}`
      ctx.fillText(zeile.slice(hinweis.titel.length + 1), x + 28 + b, wy)
    } else {
      ctx.font = `400 30px ${SCHRIFT}`
      ctx.fillText(zeile, x + 28, wy)
    }
    wy += 42
  })
  y += warnH + 40

  // Fußzeile
  ctx.strokeStyle = '#e2e6ea'; ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(RAND, y); ctx.lineTo(RAND + KB, y); ctx.stroke()
  ctx.fillStyle = '#5f6b76'; ctx.font = `400 26px ${SCHRIFT}`; ctx.textAlign = 'center'
  const fuss = t.event.veranstalter === t.verkaeufer
    ? `Veranstalter & Verkäufer: ${t.verkaeufer}`
    : `Veranstalter: ${t.event.veranstalter} · Verkauf: ${t.verkaeufer}`
  ctx.fillText(fuss, B / 2, y + 60)
  ctx.textAlign = 'left'

  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Bild konnte nicht erstellt werden'))), 'image/png'))
}
