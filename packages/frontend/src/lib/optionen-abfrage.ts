/**
 * Optionen-Abfrage im Direktverkauf — Umrechnung zwischen der Wahl (null / true / false) und den Werten der
 * Auswahlfelder in den Formularen von Artikel und Warengruppe. Die Regel selbst (Artikel → Warengruppe → Kasse)
 * steht in @kassa/shared (fragtNachOptionen).
 */

import type { OptionenAbfrageWahl } from '@kassa/shared'

export type OptionenAbfrageFeld = '' | 'ja' | 'nein'

export const optionenAbfrageFeld = (wahl: OptionenAbfrageWahl | undefined): OptionenAbfrageFeld =>
  wahl === true ? 'ja' : wahl === false ? 'nein' : ''

export const optionenAbfrageWahl = (feld: OptionenAbfrageFeld): OptionenAbfrageWahl =>
  feld === 'ja' ? true : feld === 'nein' ? false : null

/** Texte der drei Auswahlpunkte; `erbt` benennt, woher „wie …" kommt (Warengruppe bzw. Kasse). */
export const optionenAbfrageTexte = (erbt: 'Warengruppe' | 'Kasse') => ({
  '':     `Wie ${erbt}`,
  'ja':   'Immer fragen',
  'nein': 'Nie fragen',
}) as const satisfies Record<OptionenAbfrageFeld, string>

export const OPTIONEN_ABFRAGE_HINWEIS =
  'Gilt nur im Direktverkauf (Kasse, Kellner-App im Theken-Modus). Tisch-Bestellungen fragen immer nach Optionen/Varianten.'
