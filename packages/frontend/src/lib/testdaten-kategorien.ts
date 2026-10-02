/**
 * Testdaten: ein Warengruppen-Baum wie nach dem Asello-Import — mit DREI gleichnamigen Gruppen
 * „Alkoholfrei" unter verschiedenen Elterngruppen und zwei „Bier". `reihenfolge` = Position unter Geschwistern.
 * Nur von Unit-Tests benutzt.
 *
 *   Atriumbar                       (0)
 *     Alkoholfrei                   (0)
 *       Limonaden                   (0)
 *       Säfte                       (1)
 *     Bier                          (1)
 *     Wein                          (2)
 *   Kellner Getränke                (1)
 *     Alkoholfrei                   (0)
 *     Bier                          (1)
 *   Eventmanagement                 (2)
 *     Event Getränke & Pakete       (0)
 *       Alkoholfrei                 (0)
 *       Kaffee                      (1)
 *   Grillen                         (3)
 */

import type { Kategorie } from '@kassa/shared'

export const kat = (id: string, name: string, parentId: string | null, reihenfolge: number, aktiv = true): Kategorie => ({
  id, name, parentId, reihenfolge, aktiv,
  mandantId: 'm', farbe: 'grau', bonierdruckerId: null, station: null,
  terminalSichtbar: false, createdAt: '', updatedAt: '',
})

/** Absichtlich NICHT in Baumreihenfolge — die Funktionen müssen selbst sortieren. */
export const asselloBaum = (): Kategorie[] => [
  kat('grillen',   'Grillen',                   null,       3),
  kat('kel-bier',  'Bier',                      'kel',      1),
  kat('ev-alko',   'Alkoholfrei',               'ev-pakete', 0),
  kat('atr',       'Atriumbar',                 null,       0),
  kat('atr-alko',  'Alkoholfrei',               'atr',      0),
  kat('atr-limo',  'Limonaden',                 'atr-alko', 0),
  kat('atr-saft',  'Säfte',                     'atr-alko', 1),
  kat('atr-bier',  'Bier',                      'atr',      1),
  kat('atr-wein',  'Wein',                      'atr',      2),
  kat('kel',       'Kellner Getränke',          null,       1),
  kat('kel-alko',  'Alkoholfrei',               'kel',      0),
  kat('ev',        'Eventmanagement',           null,       2),
  kat('ev-pakete', 'Event Getränke & Pakete',   'ev',       0),
  kat('ev-kaffee', 'Kaffee',                    'ev-pakete', 1),
]

export const ALLE_IDS = asselloBaum().map(k => k.id)

/** Baumreihenfolge der IDs (so, wie die Listen sie anzeigen sollen). */
export const BAUM_REIHENFOLGE = [
  'atr', 'atr-alko', 'atr-limo', 'atr-saft', 'atr-bier', 'atr-wein',
  'kel', 'kel-alko', 'kel-bier',
  'ev', 'ev-pakete', 'ev-alko', 'ev-kaffee',
  'grillen',
]
