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
import { MWST_LABELS, LIEFERBESTELLUNG_PROVIDER_LABELS } from '@kassa/shared'
import type { BelegResponse, KassenbuchResponse, LieferbestellungResponse, MwStSatz, Tagesabschluss } from '@kassa/shared'
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
  // Nur doppelte Höhe (nicht doppelte Breite) → Zeichen bleiben 1 Spalte breit,
  // daher die volle Breite W nutzen, damit der Betrag rechtsbündig unter den
  // Positionsbeträgen steht (nicht W/2 = Zeilenmitte).
  add(ep.font({ bold: true, doubleHeight: true }))
  add(ep.textLine(zweispaltig('GESAMT', formatCent(beleg.gesamtbetragCent), W)))
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
// Z-Bon (Tagesabschluss)
// ---------------------------------------------------------------------------

export interface ZBonOptionen {
  kassenbuch?:    KassenbuchResponse | null | undefined
  belegFusstext?: string | null | undefined
}

export function baueZBon(
  ta:      Tagesabschluss,
  mandant: MandantInfo,
  kontext: DruckerKontext,
  opts:    ZBonOptionen = {},
): Buffer {
  const W = kontext.breite
  const parts: Buffer[] = []
  const add = (b: Buffer): void => { parts.push(b) }

  add(ep.init())
  add(ep.selectCodepage(19))
  add(ep.selectInternational(2))

  // Kopf
  add(ep.align('center'))
  add(ep.font({ bold: true, doubleHeight: true, doubleWidth: true }))
  add(ep.textLine(truncate(mandant.firmenname.toUpperCase(), Math.floor(W / 2))))
  add(ep.font())
  add(ep.textLine(mandant.uid))
  add(ep.textLine(`Kasse: ${mandant.kassenId}`))
  add(ep.newline())

  // Titel
  add(ep.font({ bold: true }))
  add(ep.textLine('TAGESABSCHLUSS (Z-BON)'))
  add(ep.font())
  add(ep.textLine(formatDatumNur(ta.datum)))
  add(trennlinie(W))

  // Beleganzahl
  add(ep.align('left'))
  add(ep.textLine(zweispaltig('Barzahlungsbelege', String(ta.anzahlBarzahlungsbelege), W)))
  if (ta.anzahlStornobelege > 0) {
    add(ep.textLine(zweispaltig('Stornobelege', String(ta.anzahlStornobelege), W)))
  }
  add(trennlinie(W))

  // Netto-Umsatz
  add(ep.font({ bold: true, doubleHeight: true }))
  add(ep.textLine(zweispaltig('NETTO-UMSATZ', formatCent(ta.nettoUmsatzCent), Math.floor(W / 2))))
  add(ep.font())
  add(trennlinie(W))

  // Zahlungsarten
  if (ta.barCent !== 0)      add(ep.textLine(zweispaltig('Bar',      formatCent(ta.barCent),      W)))
  if (ta.karteCent !== 0)    add(ep.textLine(zweispaltig('Karte',    formatCent(ta.karteCent),    W)))
  if (ta.sonstigCent !== 0)  add(ep.textLine(zweispaltig('Sonstige', formatCent(ta.sonstigCent),  W)))
  add(trennlinie(W))

  // MwSt-Aufteilung
  if (ta.mwst.length > 0) {
    add(ep.textLine('USt-Aufteilung:'))
    for (const z of ta.mwst) {
      add(ep.textLine(`  ${z.label}: Netto ${formatCent(z.nettoCent)} USt ${formatCent(z.ustCent)}`))
    }
    add(trennlinie(W))
  }

  // Kassenbuch (optional)
  const kb = opts.kassenbuch
  if (kb && kb.buchungen.length > 0) {
    add(ep.align('left'))
    add(ep.font({ bold: true }))
    add(ep.textLine('KASSENBUCH'))
    add(ep.font())
    add(ep.textLine(zweispaltig('Einlagen',  formatCent(kb.einlagenCent),  W)))
    add(ep.textLine(zweispaltig('Entnahmen', formatCent(kb.entnahmenCent), W)))
    add(ep.font({ bold: true }))
    add(ep.textLine(zweispaltig('Saldo', (kb.saldoCent >= 0 ? '+' : '') + formatCent(kb.saldoCent), W)))
    add(ep.font())
    add(trennlinie(W))
    for (const b of kb.buchungen) {
      const art = b.typ === 'einlage' ? 'Einl' : 'Entn'
      const betrag = (b.typ === 'einlage' ? '+' : '-') + formatCent(b.betragCent)
      const zeile = `${art} ${b.grund ? truncate(b.grund, W - betrag.length - 6) : ''}`
      add(ep.textLine(zweispaltig(zeile, betrag, W)))
    }
    add(trennlinie(W))
  }

  // Belegfußtext (optional)
  if (opts.belegFusstext?.trim()) {
    add(ep.align('center'))
    // Zeilenumbruch auf Druckerbreite
    const worte = opts.belegFusstext.trim().split(/\s+/)
    const zeilen: string[] = []
    let aktZeile = ''
    for (const wort of worte) {
      if (aktZeile.length === 0) {
        aktZeile = wort
      } else if (aktZeile.length + 1 + wort.length <= W) {
        aktZeile += ' ' + wort
      } else {
        zeilen.push(aktZeile)
        aktZeile = wort
      }
    }
    if (aktZeile) zeilen.push(aktZeile)
    for (const z of zeilen) add(ep.textLine(z))
    add(trennlinie(W))
  }

  // Druckzeitpunkt
  add(ep.align('center'))
  add(ep.textLine(`Gedruckt: ${formatDatum(new Date().toISOString())}`))
  add(ep.newline(2))
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

function formatDatumNur(datum: string): string {
  // datum = YYYY-MM-DD
  const [y, m, d] = datum.split('-')
  return `${d}.${m}.${y}`
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
// Kassensturz-Bon
// ---------------------------------------------------------------------------

export interface KassensturzDruckDaten {
  datum:          string   // YYYY-MM-DD
  kassenId:       string
  firmenname:     string
  stueck:         { label: string; anzahl: number; summeCent: number }[]
  istCent:        number
  startgeldCent:  number
  sollCent:       number
  differenzCent:  number
}

export function baueKassensturzBon(
  d:      KassensturzDruckDaten,
  kontext: DruckerKontext,
): Buffer {
  const W    = kontext.breite
  const parts: Buffer[] = []
  const add  = (b: Buffer) => parts.push(b)

  add(ep.init())
  add(ep.selectCodepage(19))
  add(ep.selectInternational(2))

  // Kopf
  add(ep.align('center'))
  add(ep.font({ bold: true }))
  add(ep.textLine(truncate(d.firmenname.toUpperCase(), W)))
  add(ep.font())
  add(ep.textLine(`Kasse: ${d.kassenId}`))
  add(ep.newline())
  add(ep.font({ bold: true }))
  add(ep.textLine('KASSENSTURZ'))
  add(ep.font())
  add(ep.textLine(formatDatumNur(d.datum)))
  add(trennlinie(W))

  // Stückelung
  add(ep.align('left'))
  const aktiveStueck = d.stueck.filter(s => s.anzahl > 0)
  if (aktiveStueck.length > 0) {
    add(ep.textLine('STUECKELUNG:'))
    for (const s of aktiveStueck) {
      const zeile = `${s.label} x${s.anzahl}`
      add(ep.textLine(zweispaltig(zeile, formatCent(s.summeCent), W)))
    }
    add(trennlinie(W))
  }

  // Ergebnis
  add(ep.font({ bold: true, doubleHeight: true }))
  add(ep.textLine(zweispaltig('IST', formatCent(d.istCent), Math.floor(W / 2))))
  add(ep.font())

  if (d.startgeldCent > 0) {
    add(ep.textLine(zweispaltig('  davon Startgeld', formatCent(d.startgeldCent), W)))
  }
  add(ep.textLine(zweispaltig('SOLL', formatCent(d.sollCent), W)))
  add(trennlinie(W))

  // Differenz
  add(ep.align('center'))
  if (d.differenzCent === 0) {
    add(ep.font({ bold: true }))
    add(ep.textLine('Kassensturz ausgeglichen'))
    add(ep.font())
  } else if (d.differenzCent > 0) {
    add(ep.textLine(zweispaltig('Ueberschuss', formatCent(d.differenzCent), W)))
  } else {
    add(ep.font({ bold: true }))
    add(ep.textLine(zweispaltig('FEHLBETRAG', formatCent(Math.abs(d.differenzCent)), W)))
    add(ep.font())
  }

  add(trennlinie(W))
  add(ep.textLine(`Gedruckt: ${formatDatum(new Date().toISOString())}`))
  add(ep.newline(2))
  add(ep.cut())

  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// Kassenbuch-Bon
// ---------------------------------------------------------------------------

export function baueKassenbuchBon(
  kb:      KassenbuchResponse,
  mandant: { firmenname: string; kassenId: string },
  kontext: DruckerKontext,
): Buffer {
  const W = kontext.breite
  const parts: Buffer[] = []
  const add = (b: Buffer): void => { parts.push(b) }

  add(ep.init())
  add(ep.selectCodepage(19))
  add(ep.selectInternational(2))

  // Kopf
  add(ep.align('center'))
  add(ep.font({ bold: true }))
  add(ep.textLine(truncate(mandant.firmenname.toUpperCase(), W)))
  add(ep.font())
  add(ep.textLine(`Kasse: ${mandant.kassenId}`))
  add(ep.newline())
  add(ep.font({ bold: true, doubleHeight: true }))
  add(ep.textLine('KASSENBUCH'))
  add(ep.font())
  const vonStr = formatDatumNur(kb.von)
  const bisStr = formatDatumNur(kb.bis)
  add(ep.textLine(kb.von === kb.bis ? vonStr : `${vonStr} - ${bisStr}`))
  add(trennlinie(W))

  // Übersicht
  add(ep.align('left'))
  add(ep.textLine(zweispaltig('Einlagen',  formatCent(kb.einlagenCent),  W)))
  add(ep.textLine(zweispaltig('Entnahmen', formatCent(kb.entnahmenCent), W)))
  add(ep.font({ bold: true, doubleHeight: true }))
  add(ep.textLine(zweispaltig('SALDO', (kb.saldoCent >= 0 ? '+' : '') + formatCent(kb.saldoCent), Math.floor(W / 2))))
  add(ep.font())
  add(trennlinie(W))

  // Buchungsliste
  if (kb.buchungen.length === 0) {
    add(ep.align('center'))
    add(ep.textLine('Keine Buchungen'))
  } else {
    for (const b of kb.buchungen) {
      const art    = b.typ === 'einlage' ? 'Einl.' : 'Entn.'
      const betrag = (b.typ === 'einlage' ? '+' : '-') + formatCent(b.betragCent)
      // Erste Zeile: Art + Betrag
      add(ep.textLine(zweispaltig(`${art} ${formatDatumNur(b.datum)}`, betrag, W)))
      // Zweite Zeile: Grund (eingerückt), falls vorhanden
      if (b.grund) {
        add(ep.textLine(`  ${truncate(b.grund, W - 2)}`))
      }
    }
    add(trennlinie(W))
  }

  add(ep.align('center'))
  add(ep.textLine(`Gedruckt: ${formatDatum(new Date().toISOString())}`))
  add(ep.newline(2))
  add(ep.cut())

  return Buffer.concat(parts)
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

// ---------------------------------------------------------------------------
// Lieferbestellungs-Bon
// ---------------------------------------------------------------------------

/**
 * Erstellt einen ESC/POS-Bon für eine eingehende Lieferbestellung.
 *
 *   ┌────────────────────────────┐
 *   │  FIRMENNAME                │
 *   │  UID                       │
 *   │  ──────────                │
 *   │  LIEFERBESTELLUNG          │
 *   │  Lieferando  #EXT-123      │
 *   │  15.01.2025  14:32         │
 *   │  ──────────                │
 *   │  Max Mustermann            │
 *   │  Tel: +43 123 456 789      │
 *   │  Adr: Musterstr. 1, Wien   │
 *   │  ──────────                │
 *   │  2x Margherita      12,00  │
 *   │    Notiz: ohne Oliven      │
 *   │  1x Cola             2,50  │
 *   │  ──────────                │
 *   │  GESAMT             14,50  │
 *   │  ──────────                │
 *   │  Notiz: bitte klingeln     │
 *   └────────────────────────────┘
 */
export function baueLieferbestellungBon(
  bestellung: LieferbestellungResponse,
  mandant:    MandantInfo,
  kontext:    DruckerKontext,
): Buffer {
  const W = kontext.breite

  const parts: Buffer[] = []
  const add = (b: Buffer): void => { parts.push(b) }

  add(ep.init())
  add(ep.selectCodepage(19))
  add(ep.selectInternational(2))

  // ----- Kopf -----
  add(ep.align('center'))
  add(ep.font({ bold: true, doubleHeight: true, doubleWidth: true }))
  add(ep.textLine(truncate(mandant.firmenname.toUpperCase(), Math.floor(W / 2))))
  add(ep.font())
  add(ep.textLine(mandant.uid))
  add(ep.newline())

  // ----- Typ -----
  add(ep.font({ bold: true, doubleHeight: true }))
  add(ep.textLine('LIEFERBESTELLUNG'))
  add(ep.font())
  const providerLabel = LIEFERBESTELLUNG_PROVIDER_LABELS[bestellung.provider] ?? bestellung.provider
  add(ep.textLine(`${providerLabel}  #${bestellung.externeId}`))
  add(ep.textLine(formatDatum(bestellung.createdAt)))
  add(trennlinie(W))

  // ----- Kundendaten -----
  add(ep.align('left'))
  if (bestellung.lieferName)    add(ep.textLine(bestellung.lieferName))
  if (bestellung.lieferTelefon) add(ep.textLine(`Tel: ${bestellung.lieferTelefon}`))
  if (bestellung.lieferAdresse) add(ep.textLine(`Adr: ${truncate(bestellung.lieferAdresse, W - 5)}`))
  if (bestellung.lieferName || bestellung.lieferTelefon || bestellung.lieferAdresse) {
    add(trennlinie(W))
  }

  // ----- Positionen -----
  for (const p of bestellung.positionen) {
    const mengeStr = `${p.menge}x ${p.bezeichnung}`
    const preisStr = formatCent(p.einzelpreisBreuttoCent * p.menge)
    add(ep.textLine(zweispaltig(mengeStr, preisStr, W)))
    if (p.notiz) {
      add(ep.textLine(`  Notiz: ${truncate(p.notiz, W - 9)}`))
    }
  }
  add(trennlinie(W))

  // ----- Gesamt -----
  // Volle Breite W (nur doppelte Höhe, normale Zeichenbreite) → Betrag rechtsbündig.
  add(ep.font({ bold: true, doubleHeight: true }))
  add(ep.textLine(zweispaltig('GESAMT', formatCent(bestellung.gesamtbetragCent), W)))
  add(ep.font())

  // ----- Bestellnotiz -----
  if (bestellung.notiz) {
    add(trennlinie(W))
    add(ep.align('left'))
    add(ep.textLine(`Notiz: ${truncate(bestellung.notiz, W - 7)}`))
  }

  add(ep.newline(2))
  add(ep.cut())

  return Buffer.concat(parts)
}
