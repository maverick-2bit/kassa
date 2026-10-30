/**
 * Hilfetexte der Einlass-App (Ticket-Scanner am Eingang). Die Beschriftungen entsprechen dem Bildschirm
 * („Scannen starten", „Prüfen", „Event wechseln"). Wird eine Beschriftung geändert, gehört der Text hier mit angepasst.
 * Welches Thema zum Bildschirm gehört, bestimmt die App über `aktuell` (HILFE_EINRICHTUNG / HILFE_EVENT / HILFE_SCANNER).
 */

import type { HilfeThema } from '@kassa/shared'

export const HILFE_START      = 'erste-schritte'
export const HILFE_EINRICHTUNG = 'einrichtung'
export const HILFE_EVENT       = 'event-waehlen'
export const HILFE_SCANNER     = 'scannen'

export const HILFE_THEMEN: HilfeThema[] = [
  {
    id: HILFE_START,
    titel: 'Erste Schritte',
    zweck: 'So lässt du Gäste mit Ticket am Eingang ein.',
    schritte: [
      'Gerät einmalig einrichten (siehe „Gerät einrichten").',
      'Das Event wählen, für das du am Eingang stehst.',
      '„Scannen starten" tippen und den QR-Code am Ticket vor die Kamera halten.',
      'Grün = Einlass. Rot = kein Einlass. Zum nächsten Gast auf den Bildschirm tippen.',
    ],
    tipps: ['Hakt etwas, hilft das Neuladen der Seite.'],
    stichworte: ['anfang', 'einstieg', 'anleitung'],
  },
  {
    id: HILFE_EINRICHTUNG,
    titel: 'Gerät einrichten',
    zweck: 'Dieses Handy oder Tablet als Einlass-Gerät mit der Kassa verbinden.',
    stichworte: ['qr', 'token', 'verbinden', 'gerät', 'anmelden'],
    schritte: [
      'Im Backoffice unter „Tickets → Events & Tickets → Einlass-Geräte" ein Gerät anlegen.',
      'Den angezeigten QR-Code mit der Kamera dieses Handys scannen — der Link öffnet diese App und das Gerät ist verbunden.',
      'Alternativ den Geräte-Token in das Feld einfügen und „Verbinden" tippen.',
    ],
    tipps: [
      'Für den ersten Start braucht das Gerät Internet. Danach funktioniert der Einlass auch ohne Netz, wenn die Offline-Liste geladen ist.',
      'Steht ein roter Hinweis über dem Feld, wurde das Gerät abgemeldet — einfach neu einrichten.',
    ],
  },
  {
    id: HILFE_EVENT,
    titel: 'Event wählen',
    zweck: 'Festlegen, für welche Veranstaltung gescannt wird.',
    stichworte: ['event', 'veranstaltung', 'abmelden'],
    schritte: [
      'In der Liste „Für welches Event?" das Event antippen.',
      'Das Gerät merkt sich die Wahl. Gewechselt wird später oben links über „Event wechseln".',
      'Mit „Gerät abmelden" unten trennst du das Gerät wieder von der Kassa (danach muss es neu eingerichtet werden).',
    ],
    tipps: [
      'Steht dort „Kein Event mit Einlass", muss das Event im Backoffice auf „Interner Test" oder „Veröffentlicht" stehen.',
      'Wartet noch Scans auf die Übertragung, warnt das Gerät vor dem Abmelden — sonst gehen sie verloren.',
    ],
  },
  {
    id: HILFE_SCANNER,
    titel: 'Tickets scannen',
    zweck: 'Tickets prüfen, Gäste einlassen und den Besucherstand sehen.',
    stichworte: ['scan', 'kamera', 'handscanner', 'code', 'offline', 'konflikt', 'mehrfach', 'besucher', 'prüfen'],
    schritte: [
      '„Scannen starten" tippen (schaltet Kamera und Ton ein) und den QR-Code des Tickets vor die Kamera halten.',
      'Ergebnis lesen: grün = Einlass, rot „KEIN EINLASS" = nicht einlassen. Der Grund steht dabei (z. B. bereits eingelöst).',
      'Zum nächsten Gast auf den Bildschirm tippen („Tippen für den nächsten Gast") — oder kurz warten, die Anzeige schließt sich von selbst.',
    ],
    abschnitte: [
      {
        titel: 'Code von Hand oder mit Handscanner eingeben',
        schritte: [
          'Im Feld „Code eingeben oder Handscanner" den Ticketcode tippen oder mit dem Handscanner auslösen.',
          '„Prüfen" tippen (beim Handscanner reicht dessen Enter).',
        ],
      },
      {
        titel: 'Ohne Internet arbeiten',
        schritte: [
          'Ist die Verbindung weg, prüft das Gerät mit der Offline-Liste weiter. Der Bildschirm zeigt dann „OFFLINE geprüft".',
          'Sobald Netz da ist, werden die Scans automatisch nachgereicht. Wie viele noch warten, steht oben.',
          'Meldet „⚠ n Konflikte beim Nachreichen" Gäste, die der Server abgewiesen hätte (meist eine Ticket-Kopie an einem zweiten Eingang), tippe darauf, schau die Details an und bestätige mit „Gesehen".',
        ],
      },
    ],
    tipps: [
      'Oben rechts steht der Besucherstand; ein „≈" davor heißt: geschätzt, weil das Gerät gerade offline ist.',
      'Meldet der Bildschirm „NICHT GEPRÜFT", wurde das Ticket nicht eingelöst — erneut scannen.',
      'Fehlt das Geburtsdatum am Ticket, steht ein Hinweis da: Alter ggf. per Ausweis prüfen.',
    ],
  },
]
