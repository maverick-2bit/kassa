/**
 * Hilfetexte der KDS-App (Küchen-/Schank-Bildschirm). Die Beschriftungen entsprechen dem Bildschirm
 * („✓ Erledigt — drucken", „Teilbon", „Großanzeige"). Wird eine Beschriftung geändert, gehört der Text hier mit angepasst.
 * Welches Thema zum Bildschirm gehört, bestimmt die App über `aktuell` (HILFE_EINRICHTUNG / HILFE_BONS).
 */

import type { HilfeThema } from '@kassa/shared'

export const HILFE_START      = 'erste-schritte'
export const HILFE_EINRICHTUNG = 'einrichtung'
export const HILFE_BONS        = 'bons'

export const HILFE_THEMEN: HilfeThema[] = [
  {
    id: HILFE_START,
    titel: 'Erste Schritte',
    zweck: 'So arbeitest du am Küchen- oder Schank-Bildschirm.',
    schritte: [
      'Gerät einmalig verbinden und die Station wählen (siehe „Gerät einrichten").',
      'Neue Bestellungen erscheinen von selbst als Karte und melden sich mit einem Ton.',
      'Ist ein Artikel fertig, tippe ihn an — das markiert 1 Stück mit einem Häkchen.',
      'Ist die Bestellung komplett, tippe unten „✓ Erledigt — drucken". Die Karte verschwindet.',
    ],
    tipps: [
      'Der Punkt neben dem Stationsnamen ist grün, solange die Verbindung steht, und rot, wenn sie fehlt.',
      'Hakt etwas, hilft das Neuladen der Seite.',
    ],
    stichworte: ['anfang', 'einstieg', 'anleitung'],
  },
  {
    id: HILFE_EINRICHTUNG,
    titel: 'Gerät einrichten',
    zweck: 'Das Gerät mit der Kassa verbinden und festlegen, ob es Küche, Schank, Kalte Küche oder Dessert ist.',
    stichworte: ['station', 'qr', 'code', 'verbinden', 'token'],
    schritte: [
      'Tablet oder Handy: An der Kassa unter „Einstellungen → Geräte" den QR-Code „KDS Küche/Schank" mit der Kamera scannen.',
      'PC ohne Kamera: An der Kassa auf „Code für PC-Einrichtung" klicken, den 6-stelligen Code hier eingeben und „Verbinden" tippen.',
      'Erscheint „✓ Gerät verbunden", wähle die Station: Küche, Schank, Kalte Küche oder Dessert.',
      'Dann „… starten" tippen.',
    ],
    tipps: ['Der Bildschirm zeigt nur die Bestellungen seiner Station — ein Getränk landet also nur auf dem Schank-Gerät.'],
  },
  {
    id: HILFE_BONS,
    titel: 'Bestellungen bearbeiten',
    zweck: 'Offene Bons abarbeiten, Teilbons schicken und mit dem Service sprechen.',
    stichworte: ['bon', 'erledigt', 'teilbon', 'fertig', 'drucken', 'archiv', 'großanzeige', 'nachricht', 'abholung', 'quittieren'],
    schritte: [
      'Oben links stehen Station und Anzahl der offenen Bons. Links siehst du die Summe aller offenen Artikel.',
      'Artikel antippen = 1 Stück fertig markieren (Häkchen). Gedruckt wird erst bei „✓ Erledigt — drucken".',
      '„✓ Erledigt — drucken" meldet die Bestellung fertig. Waren nur manche Stücke markiert, steht dort „✓ Teil fertig (n) — drucken".',
    ],
    abschnitte: [
      {
        titel: 'Teilbon: nur einen Teil schicken',
        schritte: [
          'Auf der Karte „Teilbon" tippen.',
          'Bei den Artikeln mit + und − festlegen, wie viele Stück jetzt rausgehen.',
          '„Senden (n)" tippen. Der Rest bleibt auf der Karte offen. „Abbrechen" bricht ab.',
        ],
      },
      {
        titel: 'Nachricht an den Service',
        schritte: [
          'Oben „💬 Nachricht" tippen.',
          'Empfänger wählen (leer = alle Kassen), Text eingeben und mit Enter senden.',
          'Antworten der Kellner erscheinen oben als Meldung — mit „✓ OK" schließen.',
        ],
      },
      {
        titel: 'Großanzeige und Archiv',
        schritte: [
          '„⬛ Großanzeige" zeigt die offenen Bons groß, z. B. für einen Monitor an der Wand. „Zurück" kehrt hierher zurück.',
          '„📋 Archiv" zeigt erledigte Bons, gefiltert nach Station.',
        ],
      },
      {
        titel: 'Zur Abholung bereit (SB-Terminal)',
        schritte: [
          'Ist eine Selbstbedienungs-Bestellung bereit, erscheint die Leiste „Zur Abholung bereit:" mit der Bestellnummer.',
          'Holt der Gast sie ab, tippe die Nummer an: „✓ abgeholt" nimmt sie vom Abholmonitor.',
        ],
      },
    ],
    tipps: [
      'Steht „Geräte-Verbindung ungültig oder abgelaufen", tippe „Neu verbinden" und richte das Gerät wie unter „Gerät einrichten" neu ein.',
      'Mit dem Sonnen-/Mond-Knopf oben wechselt das Farbschema.',
    ],
  },
]
