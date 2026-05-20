/**
 * Bon-Layout: Assembliert die ESC/POS-Bytes für einen vollständigen Bon
 * aus Beleg-Daten, Mandantendaten und Drucker-Konfiguration.
 *
 * Aufbau:
 *   ┌──────────────────────────┐
 *   │  FIRMENNAME (groß)       │
 *   │  UID                     │
 *   │  Kasse-ID                │
 *   │  ──────────────          │
 *   │  Belegtyp #Nr            │
 *   │  Datum  Uhrzeit          │
 *   │  ──────────────          │
 *   │  2x Espresso       7,00  │
 *   │  1x Apfelstrudel   4,50  │
 *   │  ──────────────          │
 *   │  GESAMT           11,50  │
 *   │  ──────────────          │
 *   │  Bar              15,00  │
 *   │  Rückgeld          3,50  │
 *   │  ──────────────          │
 *   │  USt-Aufteilung          │
 *   │  10%: 10,45 + 1,05 USt   │
 *   │  ──────────────          │
 *   │       [QR-CODE]          │
 *   │       _R1-AT_...         │
 *   │  ──────────────          │
 *   │  Vielen Dank!            │
 *   └──────────────────────────┘
 */

import { Buffer } from 'node:buffer'
import { MWST_LABELS } from '@kassa/shared'
import type { BelegResponse, MwStSatz } from '@kassa/shared'
import * as ep from './commands.js'

/** Steuersätze in Prozent gemäß österr. UStG */
const MWST_SAETZE: Record<MwStSatz, number> = {
  normal:      20,
  ermaessigt1: 10,
  ermaessigt2: 13,
  null:         0,
  besonders:   19,
}

export interface DruckerKontext {
  /** Breite des Druckers in Zeichen (32 für 58mm, 42 oder 48 für 80mm) */
  breite: number
}

export interface MandantInfo {
  firmenname: string
  uid:        string
  kassenId:   string
}

// ---------------------------------------------------------------------------
// Hauptfunktion: Bon-Bytes erstellen
// ---------------------------------------------------------------------------

export function baueBon(
  beleg:    BelegResponse,
  mandant:  MandantInfo,
  kontext:  DruckerKontext,
): Buffer {
  const W = kontext.breite

  const parts: Buffer[] = []
  const add = (b: Buffer): void => { parts.push(b) }

  // Initialisierung
  add(ep.init())
  add(ep.selectCodepage(19))      // CP858 (Deutsch + €)
  add(ep.selectInternational(2))   // Deutsch

  // ----- Kopf: Firmenname & UID -----
  add(ep.align('center'))
  add(ep.font({ bold: true, doubleHeight: true, doubleWidth: true }))
  add(ep.textLine(truncate(mandant.firmenname.toUpperCase(), Math.floor(W / 2))))
  add(ep.font())
  add(ep.textLine(mandant.uid))
  add(ep.textLine(`Kasse: ${mandant.kassenId}`))
  add(ep.newline())

  // ----- Belegtyp & Nummer -----
  add(ep.align('center'))
  add(ep.font({ bold: true }))
  add(ep.textLine(beleg.belegTyp))
  add(ep.font())
  add(ep.textLine(`Beleg-Nr. ${beleg.belegNummer}`))
  add(ep.textLine(formatDatum(beleg.belegDatum)))
  add(trennlinie(W))

  // ----- Positionen -----
  add(ep.align('left'))
  if (beleg.positionen.length === 0) {
    add(ep.textLine('(keine Positionen)'))
  } else {
    for (const p of beleg.positionen) {
      const mengeStr = `${formatMenge(p.menge)}x ${p.bezeichnung}`
      const preisStr = formatCent(p.einzelpreisBreutto * p.menge)
      add(ep.textLine(zweispaltig(mengeStr, preisStr, W)))
    }
  }
  add(trennlinie(W))

  // ----- Gesamt -----
  add(ep.font({ bold: true, doubleHeight: true }))
  add(ep.textLine(zweispaltig('GESAMT', formatCent(beleg.gesamtbetragCent), Math.floor(W / 2))))
  add(ep.font())
  add(trennlinie(W))

  // ----- Zahlungsaufteilung -----
  const zahlungen: [string, number][] = []
  if (beleg.summeBarCent      !== 0) zahlungen.push(['Bar',      beleg.summeBarCent])
  if (beleg.summeKarteCent    !== 0) zahlungen.push(['Karte',    beleg.summeKarteCent])
  if (beleg.summeSonstigeCent !== 0) zahlungen.push(['Sonstige', beleg.summeSonstigeCent])
  if (zahlungen.length > 0) {
    for (const [label, cent] of zahlungen) {
      add(ep.textLine(zweispaltig(label, formatCent(cent), W)))
    }
    add(trennlinie(W))
  }

  // ----- USt-Aufteilung (nur wenn relevant) -----
  const ustEintraege = ustAufteilung(beleg)
  if (ustEintraege.length > 0) {
    add(ep.textLine('USt-Aufteilung:'))
    for (const e of ustEintraege) {
      add(ep.textLine(`  ${e.label}: Netto ${formatCent(e.netto)} USt ${formatCent(e.ust)}`))
    }
    add(trennlinie(W))
  }

  // ----- QR-Code (RKSV maschinenlesbarer Code) -----
  add(ep.align('center'))
  add(ep.qrCode(beleg.maschinenlesbareCode, qrSizeFuerBreite(W), 'L'))
  add(ep.newline())

  // ----- Footer -----
  add(ep.textLine('Vielen Dank!'))
  add(ep.newline(2))

  // ----- Schneiden -----
  add(ep.cut())

  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// Layout-Helfer
// ---------------------------------------------------------------------------

/** Voller Trennstrich aus '-' */
function trennlinie(breite: number): Buffer {
  return ep.textLine('-'.repeat(breite))
}

/** Links-Rechts: 'links            rechts' */
export function zweispaltig(links: string, rechts: string, breite: number): string {
  const verfuegbar = breite - rechts.length - 1
  if (verfuegbar < 1) return `${links} ${rechts}`
  const links_ = truncate(links, verfuegbar)
  const lueck  = ' '.repeat(Math.max(1, breite - links_.length - rechts.length))
  return `${links_}${lueck}${rechts}`
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, Math.max(0, maxLen - 1)) + '…'
}

function formatDatum(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatMenge(m: number): string {
  return Number.isInteger(m) ? m.toString() : m.toFixed(2).replace('.', ',')
}

function formatCent(c: number): string {
  const sign = c < 0 ? '-' : ''
  const abs  = Math.abs(c)
  const euro = Math.floor(abs / 100)
  const rest = abs % 100
  return `${sign}${euro},${rest.toString().padStart(2, '0')} EUR`
}

/** QR-Code-Modulgröße abhängig von Papierbreite */
function qrSizeFuerBreite(breite: number): number {
  return breite >= 42 ? 6 : 4
}

// ---------------------------------------------------------------------------
// USt-Aufteilung berechnen
// ---------------------------------------------------------------------------

interface UStEintrag {
  label: string
  netto: number
  ust:   number
}

function ustAufteilung(beleg: BelegResponse): UStEintrag[] {
  const eintraege: UStEintrag[] = []
  const saetze: [MwStSatz, number][] = [
    ['normal',      beleg.betraege.normal],
    ['ermaessigt1', beleg.betraege.ermaessigt1],
    ['ermaessigt2', beleg.betraege.ermaessigt2],
    ['null',        beleg.betraege.null],
    ['besonders',   beleg.betraege.besonders],
  ]
  for (const [satz, brutto] of saetze) {
    if (brutto === 0) continue
    const prozent = MWST_SAETZE[satz]
    // Brutto = Netto + USt = Netto * (1 + p/100)
    const netto = Math.round(brutto / (1 + prozent / 100))
    const ust   = brutto - netto
    eintraege.push({
      label: MWST_LABELS[satz],
      netto,
      ust,
    })
  }
  return eintraege
}
