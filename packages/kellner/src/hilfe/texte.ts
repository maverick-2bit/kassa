/**
 * Hilfetexte der Kellner-App: je Bildschirm ein Thema, kurz und in der Reihenfolge der Handgriffe.
 * Die Beschriftungen entsprechen dem Bildschirm („+ Tisch", „🍳 Bonieren", „💶 Bar"). Wird eine Beschriftung geändert,
 * gehört der Text hier mit angepasst. Die Zuordnung zur Seite steht in `pfade` (Adressen wie in App.tsx).
 */

import type { HilfeThema } from '@kassa/shared'

export const HILFE_START = 'erste-schritte'

export const HILFE_THEMEN: HilfeThema[] = [
  {
    id: HILFE_START,
    titel: 'Erste Schritte',
    zweck: 'So bedienst du einen Tisch von der Bestellung bis zur Zahlung.',
    schritte: [
      'Mit deiner PIN anmelden.',
      'In der Übersicht „+ Tisch" tippen, die Tischnummer eintippen und „Öffnen".',
      '„+ Artikel" tippen, Artikel antippen — jeder Tipp bucht einen dazu.',
      '„🍳 Bonieren" schickt die Bestellung an Küche oder Schank.',
      'Zum Kassieren am Ende „💶 Bar" oder „💳 Karte".',
    ],
    tipps: [
      'Das ⏏ in der Kopfzeile meldet dich ab. Der Tisch bleibt offen und ist dann bei jedem Kollegen sichtbar.',
      'Hakt etwas, hilft oft das Neuladen der Seite (Seite nach unten ziehen oder im Browser neu laden).',
    ],
    stichworte: ['anfang', 'einstieg', 'anleitung', 'mieter'],
  },
  {
    id: 'anmelden',
    titel: 'Anmelden und Gerät einrichten',
    zweck: 'Mit der PIN anmelden; beim ersten Mal das Gerät einer Kasse zuordnen.',
    pfade: ['/login'],
    stichworte: ['pin', 'qr', 'kasse auswählen', 'gerät'],
    schritte: [
      'Steht „Dieses Gerät ist noch nicht eingerichtet", scanne den QR-Code der Kellner-App: In der Kassa unter „Einstellungen → Geräte".',
      'Gibt es mehrere Kassen, wähle unter „Kasse auswählen" die richtige.',
      'Dann die PIN über die Zifferntasten eingeben.',
    ],
    tipps: ['PIN vergessen? Die Chefin oder der Chef legt unter „Personal → Benutzer" in der Kassa eine neue an.'],
  },
  {
    id: 'tische',
    titel: 'Tische',
    zweck: 'Alle offenen Tische auf einen Blick.',
    pfade: ['/'],
    stichworte: ['tisch öffnen', 'übersicht', 'theke'],
    schritte: [
      'Neuer Tisch: „+ Tisch", Nummer oder Namen eintippen (z. B. „Tisch 3" oder „Bar"), „Öffnen".',
      'Einen offenen Tisch antippen, um zu bestellen oder zu kassieren.',
      'Wählt die Kassa die Tische per Liste oder Plan, tippst du den Tisch dort an.',
    ],
    abschnitte: [
      {
        titel: 'Mehrere Rechnungen an einem Tisch',
        schritte: ['„+ Neue Gruppe am selben Tisch" legt eine zweite Rechnung am selben Tisch an (z. B. getrennte Zahler).'],
      },
    ],
    tipps: [
      'Rote Hinweise oben (z. B. ein Bon, der nicht angekommen ist, oder ein nicht gedruckter Beleg) bleiben, bis das Problem behoben ist.',
      'Ist die Kasse als Theke eingerichtet, gibt es keine Tischliste, sondern eine Startseite für den direkten Verkauf ohne Tisch.',
    ],
  },
  {
    id: 'tisch',
    titel: 'Tisch bedienen und kassieren',
    zweck: 'Die Positionen eines Tisches, Bonieren, Zahlen und Tisch-Aktionen.',
    pfade: ['/tab/:tabId'],
    stichworte: ['bonieren', 'bezahlen', 'bar', 'karte', 'umbuchen', 'teilen', 'storno', 'gang', 'rechnung'],
    schritte: [
      '„+ Artikel" öffnet die Artikelwahl.',
      '„🍳 Bonieren" (bei Gängen: „Sofort bonieren") schickt neue Positionen an Küche oder Schank. Danach steht „✓ Bon wurde gesendet".',
      'Kassieren: „💶 Bar · …" oder „💳 Karte · …". Bei Karte läuft die Zahlung über das Kartenterminal, falls eines eingerichtet ist.',
      'Nach der Zahlung zeigt die App den digitalen Beleg zum Abfotografieren oder druckt ihn, je nach Einrichtung.',
    ],
    abschnitte: [
      {
        titel: 'Gänge abrufen',
        schritte: ['Arbeitet ihr mit Gängen, steht unten „🔔 N. Gang abrufen": ein Tipp schickt den nächsten Gang an die Küche.'],
      },
      {
        titel: 'Position entfernen oder stornieren',
        schritte: [
          'Die Position in der Liste verkleinern oder entfernen.',
          'Liegt der Storno über der Schwelle, erscheint „Freigabe erforderlich": Eine berechtigte Person tippt ihre PIN ein, dann „Freigeben".',
        ],
      },
      {
        titel: 'Tisch-Aktionen (⋯)',
        schritte: [
          'Das ⋯ oben rechts öffnet: Umbuchen (Positionen auf einen anderen Tisch), Aufteilen (Rechnung auf mehrere Zahler), Zusammenführen, Kellner ändern, Verlauf und Verwerfen.',
          'Beim Umbuchen wählst du die Positionen, dann den Zieltisch — gibt es ihn noch nicht, wird er neu angelegt.',
        ],
      },
    ],
    tipps: ['Der Bon läuft über den eingerichteten Drucker. Kommt er nicht an, zeigt die App eine rote Meldung.'],
  },
  {
    id: 'artikel-waehlen',
    titel: 'Artikel wählen',
    zweck: 'Artikel für den Tisch (oder die Theke) antippen.',
    pfade: ['/tab/:tabId/artikel'],
    stichworte: ['reiter', 'wischen', 'favoriten', 'optionen', 'menge', 'warengruppe'],
    schritte: [
      'Oben die Warengruppe wählen („★ Favoriten" zeigt die häufigsten) — oder einfach nach links oder rechts wischen.',
      'Artikel antippen: jeder Tipp bucht +1. Das kleine − nimmt wieder eins weg.',
      'Hat ein Artikel Optionen (z. B. pur/gespritzt), öffnet sich „Optionen & Menge": Option wählen, Menge einstellen, „Buchen & weiter".',
      'Fertig? Oben rechts auf den Knopf mit der Summe tippen (Übersicht) — dort bonierst und kassierst du.',
    ],
    tipps: [
      'Bei einer Theken-Kasse heißt der Knopf oben „Kassieren" und ihr bucht ohne Tisch.',
      'Optionen, bei denen „jede Auswahl ein eigener Artikel" ist (z. B. Spritzer süß/Sommer/weiß), werden getrennte Positionen.',
    ],
  },
]
