/**
 * Fehler-Sammler: merkt sich unerwartete Serverfehler (die der globale Fehler-Handler als 500 beantwortet) gruppiert
 * und bereinigt, damit der Portal-Melder sie mitschicken kann.
 *
 * Datenschutz: eine Fehlermeldung kann Werte enthalten — drizzle-orm schreibt z. B. „Failed query: <SQL> params:
 * <Werte>". Gesammelt wird deshalb nur ein bereinigter Text: Kennungen (UUID), E-Mail-Adressen, lange Zahlen und
 * Tokens werden ersetzt, SQL und Parameter abgeschnitten, die Länge begrenzt. Stack und Anfrage-Inhalt kommen nie mit.
 */

import { createHash } from 'node:crypto'
import type { PortalFehler } from '@kassa/shared'

const MAX_GRUPPEN = 200
const MAX_MELDUNG = 300

const UUID    = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const MAIL    = /[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi
const ZAHL    = /\b\d{6,}\b/g
const TOKEN   = /\b(Bearer\s+)?[A-Za-z0-9_-]{24,}\b/g

/** Macht aus einer Fehlermeldung einen Text ohne Werte, Kennungen und SQL. */
export function bereinigeFehlertext(text: string): string {
  let t = text.split('\n')[0] ?? ''
  // drizzle-orm: „Failed query: SELECT … params: a,b" — SQL und Werte nie mitnehmen
  if (/^Failed query:/i.test(t)) return 'Datenbankabfrage fehlgeschlagen'
  t = t.replace(/\bparams:.*$/i, '')
  t = t.replace(UUID, '<id>').replace(MAIL, '<mail>').replace(ZAHL, '<zahl>').replace(TOKEN, '<token>')
  t = t.replace(/\s+/g, ' ').trim()
  return t.length > MAX_MELDUNG ? `${t.slice(0, MAX_MELDUNG - 1)}…` : t
}

/** Pfad ohne Kennungen: /api/belege/123e4567-… → /api/belege/:id */
export function bereinigeRoute(url: string | undefined): string | null {
  if (!url) return null
  const pfad = (url.split('?')[0] ?? '').replace(UUID, ':id').replace(/\/\d+(?=\/|$)/g, '/:zahl')
  return pfad.slice(0, 200)
}

interface Gruppe extends PortalFehler { _schluessel: string }

const gruppen = new Map<string, Gruppe>()

export interface FehlerKontext {
  /** Route (Muster oder URL) */
  route?:     string | undefined
  mandantId?: string | undefined
}

/** Merkt einen Fehler vor. Wirft nie — der Fehler-Handler darf daran nicht scheitern. */
export function meldeFehler(error: unknown, kontext: FehlerKontext = {}, jetzt: Date = new Date()): void {
  try {
    const name    = (error instanceof Error ? error.name : typeof error).slice(0, 100)
    const meldung = bereinigeFehlertext(error instanceof Error ? error.message : String(error))
    const route   = bereinigeRoute(kontext.route)
    const mandantId = kontext.mandantId && /^[0-9a-f-]{36}$/i.test(kontext.mandantId) ? kontext.mandantId : null
    const hash = createHash('sha1').update(`${name}|${meldung}|${route ?? ''}`).digest('hex').slice(0, 16)
    const schluessel = `${hash}|${mandantId ?? ''}`

    const vorhanden = gruppen.get(schluessel)
    if (vorhanden) {
      vorhanden.anzahl += 1
      vorhanden.letzterAm = jetzt.toISOString()
      return
    }
    if (gruppen.size >= MAX_GRUPPEN) {
      // Älteste Gruppe verwerfen — ein Fehlersturm soll weder Speicher noch Meldung sprengen
      const aelteste = [...gruppen.entries()].sort((a, b) => a[1].letzterAm.localeCompare(b[1].letzterAm))[0]
      if (aelteste) gruppen.delete(aelteste[0])
    }
    gruppen.set(schluessel, {
      _schluessel: schluessel, hash, name, meldung, route, mandantId,
      anzahl: 1, ersterAm: jetzt.toISOString(), letzterAm: jetzt.toISOString(),
    })
  } catch { /* Sammeln darf nie stören */ }
}

/** Entnimmt alle gesammelten Fehler (leert den Sammler). */
export function entnehmeFehler(): PortalFehler[] {
  const liste = [...gruppen.values()].map(({ _schluessel: _unused, ...rest }) => rest)
  gruppen.clear()
  return liste
}

/** Legt Fehler zurück, wenn die Meldung nicht ankam — sie gehen dann mit der nächsten raus. */
export function gibFehlerZurueck(liste: PortalFehler[]): void {
  for (const f of liste) {
    const schluessel = `${f.hash}|${f.mandantId ?? ''}`
    const vorhanden = gruppen.get(schluessel)
    if (vorhanden) {
      vorhanden.anzahl += f.anzahl
      if (f.ersterAm < vorhanden.ersterAm) vorhanden.ersterAm = f.ersterAm
      continue
    }
    if (gruppen.size < MAX_GRUPPEN) gruppen.set(schluessel, { ...f, _schluessel: schluessel })
  }
}

/** Nur für Tests */
export function _leereFehlerSammler(): void { gruppen.clear() }
