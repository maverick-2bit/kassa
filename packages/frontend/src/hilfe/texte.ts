/**
 * Hilfetexte der Kassa (Backoffice): je Seite ein Thema mit Zweck, Handgriffen und Tipps.
 *
 * Für Menschen, die die Kassa nicht kennen — z. B. Mieter einer Leih-Kassa. Die Texte nennen die Beschriftungen, die auf
 * dem Bildschirm stehen („+ Neuer Tisch", „Z-Bon drucken"), und die Reihenfolge der Handgriffe. Wird eine Beschriftung in der
 * Oberfläche geändert, gehört der Text hier mit angepasst. Die Zuordnung zur Seite steht in `pfade` (Adressen wie in App.tsx).
 */

import type { HilfeThema } from '@kassa/shared'

export const HILFE_START = 'erste-schritte'

export const HILFE_THEMEN: HilfeThema[] = [
  {
    id: HILFE_START,
    titel: 'Erste Schritte',
    zweck: 'Der Weg durch einen normalen Tag mit der Kassa — vom Anmelden bis zum Tagesabschluss.',
    schritte: [
      'Anmelden: mit E-Mail und Passwort (Chef/Admin) oder mit deiner PIN (Personal).',
      'Oben rechts siehst du die Kasse, an der du arbeitest. Gibt es mehrere, wechselst du dort mit einem Klick.',
      'Verkaufen: im Menü „Verkauf" auf „Kasse" (Direktverkauf) oder auf „Tische" (Gastro, Rechnung am Tisch).',
      'Bezahlen: unten im Warenkorb auf „Bar" oder „Karte". Der Beleg wird gedruckt oder digital ausgegeben, je nach Einstellung.',
      'Falsch gebucht? Unter „Auswertung → Belege" den Beleg öffnen und stornieren (siehe Thema „Belege & Storno").',
      'Am Ende des Tages: „Auswertung → Abschluss" und „Z-Bon drucken" (siehe Thema „Tagesabschluss").',
    ],
    abschnitte: [
      {
        titel: 'Wenn etwas nicht klappt',
        schritte: [
          'Der Bon druckt nicht: „Einstellungen → Kassen & Drucker", beim Drucker auf „Testdruck" klicken. Meldet er einen Fehler, Netzwerkkabel und Strom des Druckers prüfen.',
          'Steht „Kasse arbeitet im Offline-Modus": Es gibt gerade keine Verbindung zum Kassen-PC. Weiter kassieren geht nicht ohne ihn — Verbindung prüfen (WLAN/Kabel).',
          'Die Seite sieht seltsam aus oder zeigt „Neu laden": auf „Neu laden" klicken oder die Seite neu laden (Taste F5).',
          'Ein Menüpunkt fehlt: Dafür fehlt dir die Berechtigung — die Chefin oder der Chef kann sie unter „Personal → Benutzer" vergeben.',
        ],
      },
    ],
    tipps: [
      'Mit dem „? Hilfe"-Knopf oben rechts erreichst du auf jeder Seite die passende Erklärung.',
      'Alle Beträge sind Bruttobeträge (inklusive Steuer).',
    ],
    stichworte: ['anfang', 'einstieg', 'anleitung', 'mieter', 'start'],
  },

  // ── Verkauf ────────────────────────────────────────────────────────────────
  {
    id: 'kasse',
    titel: 'Kasse (Direktverkauf)',
    zweck: 'Artikel antippen, kassieren, Beleg ausgeben — ohne Tisch, wie an einer Bar oder einem Verkaufsstand.',
    pfade: ['/kasse'],
    stichworte: ['kassieren', 'verkaufen', 'bon', 'warenkorb', 'rabatt', 'bar', 'karte'],
    schritte: [
      'Oben im Raster die Warengruppe wählen (oder den Reiter „Favoriten") und die Artikel antippen. Jeder Tipp legt den Artikel in den Warenkorb.',
      'Hat ein Artikel Optionen (z. B. pur/gespritzt), öffnet sich ein Fenster: Optionen antippen. „Pflicht" muss gewählt werden, „Optional" darf leer bleiben. Eine Option mehrfach antippen = mehrfach.',
      'Rechts im „Warenkorb" Menge ändern oder einzelne Zeilen entfernen. Mit dem Papierkorb-Knopf wird der ganze Warenkorb verworfen (mit Rückfrage).',
      'Bezahlen: unten auf „Bar (€ …)" oder „Karte (€ …)". Bei Karte läuft die Zahlung über das Kartenterminal, falls eines eingerichtet ist.',
      'Der Beleg wird gedruckt oder digital ausgegeben (Einstellung der Kasse). Danach ist der Warenkorb leer für den nächsten Gast.',
    ],
    abschnitte: [
      {
        titel: 'Rabatt geben',
        schritte: [
          'Auf eine Artikelzeile den Rabatt-Knopf tippen (nur dieser Artikel) oder unten auf „+ Rabatt hinzufügen" (ganze Rechnung).',
          'Prozent oder Betrag wählen, Wert eingeben, bestätigen. Der Rabatt erscheint als eigene Zeile und kann mit × wieder entfernt werden.',
          'Über einer bestimmten Höhe verlangt die Kassa die PIN einer berechtigten Person.',
        ],
      },
      {
        titel: 'Bar mit Rückgeld oder gemischt bezahlen',
        schritte: [
          'Gibt der Gast mehr Bargeld: Betrag unter dem Bar-Knopf eingeben, die Kassa zeigt das Rückgeld.',
          '„Bar + Karte aufteilen…": Bar-Anteil eingeben, der Rest geht auf Karte.',
        ],
      },
      {
        titel: 'Gutschein einlösen oder Kunde zuordnen',
        schritte: [
          'Gutschein: im Warenkorb den Gutschein-Knopf wählen, Code eingeben, „Prüfen", dann „Einlösen".',
          'Kunde (für Rechnungen auf Namen): im Kopf des Warenkorbs den Kunden suchen oder neu anlegen.',
        ],
      },
    ],
    tipps: [
      'Steht der Artikel nicht im Raster, ist die Warengruppe an dieser Kasse vielleicht ausgeblendet: „Einstellungen → Kassen & Drucker → Warengruppen-Verteilung".',
      'Artikel ohne Optionsfenster? An dieser Kasse ist die Abfrage abgeschaltet (Einstellung „Optionen im Direktverkauf").',
    ],
  },
  {
    id: 'tische',
    titel: 'Tische',
    zweck: 'Offene Tische im Überblick: Tisch öffnen, bestellen, später am Tisch kassieren.',
    pfade: ['/tische'],
    stichworte: ['tisch', 'gastro', 'kellner'],
    schritte: [
      'Neuen Tisch öffnen: „+ Neuer Tisch", Tischnummer oder -bezeichnung eintippen, „Tisch öffnen".',
      'Einen offenen Tisch antippen: dort bestellst du, siehst die Positionen und kassierst.',
      'Ist keiner offen, steht „Keine offenen Tische" da — dann einfach einen neuen öffnen.',
    ],
    abschnitte: [
      {
        titel: 'Tische zusammenlegen oder teilen',
        schritte: [
          '„Gruppen zusammenführen" bzw. „Zusammenführen": mehrere Tische zu einer Rechnung vereinen.',
          '„Tisch teilen (Artikel umbuchen / Rechnung teilen)": einzelne Artikel auf einen anderen Tisch verschieben oder die Rechnung auf mehrere Zahler aufteilen.',
        ],
      },
    ],
    tipps: ['Die Kellner-App am Handy zeigt dieselben Tische — Bestellungen von dort erscheinen hier sofort.'],
  },
  {
    id: 'tisch',
    titel: 'Tisch bedienen und abrechnen',
    zweck: 'Ein offener Tisch: Artikel bestellen, bonieren, umbuchen und bezahlen.',
    pfade: ['/tische/:tabId'],
    stichworte: ['rechnung', 'teilen', 'umbuchen', 'bonieren', 'gang'],
    schritte: [
      'Artikel im Raster antippen — sie landen als Positionen am Tisch (bei Optionen öffnet sich das Fenster; hier fragt die Kassa immer nach).',
      'Die Bestellung geht an Küche oder Schank (Bonierdrucker/KDS) — je nach Einrichtung beim Speichern oder beim Antippen von „Bonieren".',
      'Zum Kassieren: Zahlart wählen — „Bar", „Karte" oder „Bar + Karte". Der Tisch wird danach geschlossen.',
    ],
    abschnitte: [
      {
        titel: 'Artikel auf einen anderen Tisch umbuchen',
        schritte: [
          'Oben „Aktueller Tisch:" prüfen, den Zieltisch wählen.',
          'Positionen mit „Artikel → Tisch" verschieben, mit „Artikel ← Tisch" zurückholen.',
        ],
      },
      {
        titel: 'Rechnung teilen',
        schritte: [
          'Positionen den Zahlern zuordnen, bis nichts mehr als „noch nicht vollständig verteilt" gemeldet wird.',
          'Je Zahler bar oder mit Karte kassieren.',
        ],
      },
    ],
    tipps: ['Mit Namen am Tisch („Name / Kellner") ist später nachvollziehbar, wer bestellt hat.'],
  },
  {
    id: 'gutscheine',
    titel: 'Gutscheine',
    zweck: 'Wertgutscheine ausgeben, den Restwert verwalten und an der Kasse einlösen.',
    pfade: ['/gutscheine'],
    schritte: [
      '„+ Neuer Gutschein": Betrag (oder Schnellbetrag) wählen, optional Code/EAN, Inhaber, Gültig bis und Notiz — speichern.',
      'Der Gutschein lässt sich drucken (Drucker für Gutscheine) und verkaufen wie ein Artikel.',
      'Einlösen: an der Kasse im Warenkorb den Gutschein-Code eingeben, „Prüfen", dann „Einlösen". Bleibt ein Rest, wird ein Restgutschein ausgegeben.',
      'Das Gutschein-Journal zeigt alle Bewegungen und die offenen Gutscheine insgesamt.',
    ],
    tipps: ['Teileingelöste Gutscheine behalten ihren Restwert.'],
  },
  {
    id: 'angebote',
    titel: 'Angebote & Beleg-Archiv',
    zweck: 'Angebote und Lieferscheine erstellen und später in eine Rechnung übernehmen.',
    pfade: ['/angebote', '/beleg-archiv'],
    stichworte: ['lieferschein', 'angebot'],
    schritte: [
      'Ein Angebot erstellst du an der Kasse im Angebot-Modus.',
      'Hier siehst du die Angebote, kannst den Status ändern, „Gültig bis" prüfen und ein Angebot in einen Lieferschein übernehmen.',
      'Im Beleg-Archiv suchst du nach Nummer oder Kunde.',
    ],
  },
  {
    id: 'lieferungen',
    titel: 'Lieferungen',
    zweck: 'Eingehende Bestellungen von Lieferando, Mergeport und eigenen Quellen.',
    pfade: ['/lieferungen'],
    schritte: [
      'Neue Bestellungen erscheinen hier mit Kunde, Telefon, Adresse und Hinweis.',
      'Mit „Drucker für Lieferbons" legst du fest, wo der Bon ausgedruckt wird.',
    ],
  },
  {
    id: 'reservierungen',
    titel: 'Reservierungen',
    zweck: 'Tische für bestimmte Tage und Uhrzeiten reservieren, auch online.',
    pfade: ['/reservierungen'],
    schritte: [
      '„+ Neu": Datum, Uhrzeit, Dauer, Personen und Name eintragen — die Kassa prüft die Verfügbarkeit anhand des Tischplans.',
      'Online-Buchung: Ist sie aktiv, können Gäste über den Buchungs-Link selbst reservieren. Den Link als QR-Code oder auf der Website teilen.',
    ],
    tipps: ['Ohne angelegte Tische im Tischplan (Einstellungen → Gastro) gibt es keine Verfügbarkeit.'],
  },
  {
    id: 'sb-bestellungen',
    titel: 'SB-Bestellungen',
    zweck: 'Bestellungen vom Selbstbedienungs-Terminal im Überblick.',
    pfade: ['/sb-bestellungen'],
    schritte: ['Hier erscheinen die Bestellungen der Gäste vom Terminal. Sie wandern automatisch an Küche oder Schank und auf den Abholmonitor.'],
  },
  {
    id: 'tickets',
    titel: 'Events & Tickets',
    zweck: 'Veranstaltungen anlegen, Tickets ausstellen oder online verkaufen und am Einlass prüfen.',
    pfade: ['/tickets', '/tickets/:eventId'],
    stichworte: ['event', 'einlass', 'veranstaltung'],
    schritte: [
      '„+ Neues Event": Titel, Ort, Datum und Ticketarten (z. B. Stehplatz) anlegen.',
      'Tickets lassen sich im Backoffice ausstellen oder online verkaufen; der Käufer bekommt Tickets und Rechnung per E-Mail.',
      'Am Eingang prüft die Einlass-App (Handy) die Tickets per QR-Code — jedes Ticket gilt nur einmal.',
      'Die Besucherzahl und die Bestellungen siehst du im Event.',
    ],
  },

  // ── Artikel & Lager ────────────────────────────────────────────────────────
  {
    id: 'artikel',
    titel: 'Artikel',
    zweck: 'Artikelstamm pflegen: Bezeichnung, Preis, Steuersatz, Warengruppe, Allergene.',
    pfade: ['/artikel'],
    stichworte: ['preis', 'warengruppe', 'kategorie', 'allergene', 'import', 'excel', 'favorit'],
    schritte: [
      'Neuer Artikel: „+ Neuer Artikel", Bezeichnung und Preis (brutto) eintragen, MwSt-Satz und Warengruppe wählen, speichern.',
      'Allergene: im Artikelfenster die zutreffenden Allergene antippen — sie erscheinen später auf der Kachel und in der Liste.',
      'Bearbeiten: Artikel in der Liste wählen. Mit dem Schalter lässt sich ein Artikel deaktivieren (er verschwindet aus der Kasse, bleibt aber im Stamm).',
      'Suchen: oben „Suchen (Bezeichnung, Nummer)…".',
      'Favoriten: der Stern macht einen Artikel zum Favoriten (Reiter „Favoriten" in der Kasse).',
    ],
    abschnitte: [
      {
        titel: 'Warengruppen',
        schritte: [
          '„+ Neue Kategorie" legt eine Warengruppe an (Name, Farbe, übergeordnete Gruppe). Sie erscheint in der Kasse als Reiter.',
          'Pro Warengruppe lässt sich festlegen, ob nach Optionen gefragt wird („Optionen/Varianten abfragen").',
        ],
      },
      {
        titel: 'Viele Artikel auf einmal',
        schritte: [
          'Excel: „Exportieren" gibt die Liste als Excel aus, „Importieren" liest eine Excel-Datei (Vorlage laden) ein.',
          '„Layout importieren (JSON)": Warengruppen samt Artikeln, Optionen und Anordnung aus einer Layout-Datei übernehmen — fehlende Optionen werden angelegt. „Layout exportieren (JSON)" macht dasselbe in die andere Richtung.',
        ],
      },
    ],
    tipps: ['Die Reihenfolge der Artikel an der Kasse stellst du mit den Pfeilen in der Spalte „Sort." ein.'],
  },
  {
    id: 'optionen',
    titel: 'Optionen (Varianten & Extras)',
    zweck: 'Auswahlmöglichkeiten bei Artikeln: pur/gespritzt, Größe, Beilage, Sauce …',
    pfade: ['/modifikatoren'],
    stichworte: ['variante', 'modifikator', 'beilage', 'aufpreis', 'extra', 'spritzer'],
    schritte: [
      'Gruppe anlegen: „+ Neue Gruppe", Name (z. B. „Beilage"), Typ „Pflicht" (muss gewählt werden) oder „Optional".',
      'Optionen eintragen: Namen oben eintippen und mit der Eingabetaste anlegen; bei Bedarf einen Aufpreis (auch negativ) angeben.',
      'Artikel zuweisen: „Artikel zuweisen →" und die Artikel wählen, bei denen die Gruppe angeboten werden soll.',
      'Fertig: beim Antippen des Artikels in der Kasse erscheint das Optionsfenster.',
    ],
    abschnitte: [
      {
        titel: 'Aus jeder Auswahl einen eigenen Artikel machen',
        schritte: [
          'Beim Spritzer sind „süß", „Sommer" und „weiß" drei Getränke, nicht ein Artikel mit drei Optionen.',
          'Dafür in der Gruppe den Schalter „Jede Auswahl = eigener Artikel" einschalten: dann wird jede gewählte Option (samt Anzahl) eine eigene Position.',
        ],
      },
      {
        titel: 'Nicht fragen, wenn du selbst herrichtest',
        schritte: [
          'An einer Bar-Kasse stellst du unter „Einstellungen → Kassen & Drucker" bei „Optionen im Direktverkauf" auf „Nicht abfragen". Küche oder einzelne Artikel können davon abweichen.',
        ],
      },
    ],
  },
  {
    id: 'preisregeln',
    titel: 'Aktionen (Happy Hour & Co.)',
    zweck: 'Zeitlich begrenzte Preisaktionen: Prozentrabatt oder fixer Aktionspreis.',
    pfade: ['/preisregeln'],
    stichworte: ['happy hour', 'rabatt', 'aktionspreis'],
    schritte: [
      '„+ Neue Aktion": Namen vergeben.',
      'Tage festlegen: Wochentage (wiederkehrend) und/oder konkrete Datumstage, dazu ein Zeitfenster.',
      'Rabatt (%) eintragen oder „Fixer Aktionspreis statt Prozent" wählen und Preise je Artikel setzen.',
      'Warengruppen oder Artikel wählen, für die die Aktion gilt. Ohne Auswahl gilt sie für alle Artikel.',
    ],
    tipps: ['Läuft eine Aktion, zeigt die Kachel in der Kasse ein Aktions-Zeichen und den neuen Preis.'],
  },
  {
    id: 'wareneingang',
    titel: 'Wareneingang & Inventur',
    zweck: 'Lagerstand erhöhen (Lieferung) oder nach Zählung korrigieren.',
    pfade: ['/wareneingang', '/inventur'],
    stichworte: ['bestand', 'lager', 'zählen', 'lieferung'],
    schritte: [
      'Nur Artikel mit aktiviertem Lagerstand erscheinen hier. Lagerstand schaltest du im Artikel ein.',
      'Wareneingang: Artikel oder Variante suchen, gelieferte Menge eintragen, speichern.',
      'Inventur: eine Inventur anlegen, die gezählten Mengen je Artikel eintragen und abschließen — die Kassa korrigiert den Bestand.',
    ],
  },
  {
    id: 'lagerstand',
    titel: 'Lagerstand',
    zweck: 'Übersicht über Bestände und Mindestbestände.',
    pfade: ['/lagerstand'],
    schritte: [
      'Die Liste zeigt je Artikel den aktuellen Bestand. „Suche…" grenzt sie ein.',
      '„Warengruppe in Lagerführung aufnehmen" schaltet den Lagerstand für eine ganze Warengruppe ein.',
      'Fällt der Bestand unter den Mindestbestand, erscheint der Artikel in der Bestellliste.',
    ],
  },
  {
    id: 'bestellliste',
    titel: 'Bestellliste',
    zweck: 'Artikel unter Mindestbestand — was nachbestellt werden muss.',
    pfade: ['/bestellliste'],
    schritte: [
      'Die Liste zeigt automatisch alle Artikel, die den Mindestbestand unterschreiten, samt Lieferant.',
      '„CSV-Export" speichert sie für die Bestellung.',
    ],
    tipps: ['Den Mindestbestand trägst du beim Artikel ein (Lagerstand aktivieren).'],
  },
  {
    id: 'lieferanten',
    titel: 'Lieferanten',
    zweck: 'Kontaktdaten der Lieferanten für Einkauf und Bestellliste.',
    pfade: ['/lieferanten'],
    schritte: [
      '„+ Lieferant anlegen": Name, E-Mail, Telefon und Lieferkonditionen eintragen.',
      'Beim Artikel wählst du den Lieferanten — die Bestellliste gruppiert danach.',
    ],
  },

  // ── Kunden ─────────────────────────────────────────────────────────────────
  {
    id: 'kunden',
    titel: 'Kunden',
    zweck: 'Kundenstamm für Rechnungen, Lieferscheine und offene Posten.',
    pfade: ['/kunden'],
    stichworte: ['crm', 'rechnung', 'uid'],
    schritte: [
      '„+ Neuer Kunde": Name oder Firma, Adresse, E-Mail und bei Firmen die UID eintragen.',
      'Suchen: „Suchen (Name, Firma, E-Mail, Nummer…)".',
      '„Profil →" zeigt Rechnungen, Lieferscheine und offene Posten des Kunden.',
      'An der Kasse ordnest du einen Kunden einer Rechnung zu (Rechnung auf Namen).',
    ],
  },
  {
    id: 'offene-posten',
    titel: 'Offene Posten',
    zweck: 'Rechnungen, die noch nicht bezahlt sind (Zielrechnungen).',
    pfade: ['/offene-posten'],
    schritte: [
      'Suche nach Kunde oder Nummer.',
      'Zahlung erfassen: Posten auswählen („Alle offenen auswählen" bei vielen), Betrag unter „Zahlung (€)" eintragen oder „Vollständig" wählen.',
    ],
  },

  // ── Auswertung ─────────────────────────────────────────────────────────────
  {
    id: 'belege',
    titel: 'Belege & Storno',
    zweck: 'Alle Belege dieser Kasse ansehen, stornieren und die RKSV-Spezialbelege auslösen.',
    pfade: ['/belege'],
    stichworte: ['storno', 'bon', 'rechnung', 'jahresbeleg', 'nullbeleg', 'kontrollbeleg'],
    schritte: [
      'Belege suchen: „Suche…" oder nach Kunde filtern; „Filter zurücksetzen" zeigt wieder alle.',
      'Beleg anklicken, um Details zu sehen und ihn neu zu drucken.',
    ],
    abschnitte: [
      {
        titel: 'Einen Beleg stornieren',
        schritte: [
          'Den falschen Beleg öffnen und „Storno" wählen.',
          'Unter „Storno-Grund" kurz eintragen, warum.',
          'Verlangt die Kassa die „Freigabe — PIN eines Berechtigten", gibt eine berechtigte Person ihre PIN ein.',
          '„Storno bestätigen". Es entsteht ein eigener Stornobeleg — der Originalbeleg wird nie gelöscht (Vorschrift).',
        ],
      },
      {
        titel: 'RKSV-Spezialbelege',
        schritte: [
          '„Kontrollbeleg (Nullbeleg)": ein Beleg über 0 € zum Testen der Signatur.',
          'Jahresbeleg (gesetzlich Pflicht): erstellen, ausdrucken, den QR-Code mit der BMF-FinanzOnline-App prüfen und das Ergebnis auf „OK" bestätigen. Bitte so früh wie möglich im Jahr.',
        ],
      },
    ],
  },
  {
    id: 'tagesabschluss',
    titel: 'Tagesabschluss (Z-Bon)',
    zweck: 'Umsatz des Tages nach Zahlart und Steuersatz — der Kassenschluss.',
    pfade: ['/tagesabschluss'],
    stichworte: ['z-bon', 'abschluss', 'kassensturz', 'tagesumsatz'],
    schritte: [
      'Den Geschäftstag wählen (standardmäßig heute).',
      'Prüfen: Umsatz bar und mit Karte, Steueraufteilung und Anzahl der Belege.',
      '„Z-Bon drucken" druckt den Tagesabschluss (Drucker lässt sich wählen).',
      'Bargeld zählen und mit dem Barumsatz auf dem Z-Bon abgleichen. Einlagen und Entnahmen stehen im Kassenbuch.',
    ],
    tipps: [
      'Der Geschäftstag kann nach Mitternacht noch zum Vortag gehören (Einstellung „Tagesbeginn").',
      'Den Z-Bon aufheben — er gehört zu den Aufzeichnungen.',
    ],
  },
  {
    id: 'berichte',
    titel: 'Berichte',
    zweck: 'Umsätze und Verkäufe auswerten — am Bildschirm ansehen, drucken oder exportieren.',
    pfade: ['/berichte'],
    stichworte: ['umsatz', 'artikel', 'auswertung', 'pdf', 'excel', 'csv', 'statistik'],
    schritte: [
      'Oben den Bericht wählen: Übersicht, Umsatz, Zahlungsart, Warengruppe, Artikel, Tageszeit, Wochentag, Kellner, Küche, Vergleich oder Kassen.',
      'Zeitraum wählen (Heute, Gestern, Woche, Monat …) oder ein eigenes Datum eintragen, bei mehreren Kassen die Kasse(n) wählen.',
      '„Bericht laden" — die Zahlen erscheinen direkt am Bildschirm.',
      'Mit „Ansehen" öffnet sich der Bericht als Seite, mit „Bon drucken" kommt er auf den Bondrucker, „PDF", „CSV" und „Excel" speichern ihn als Datei.',
    ],
    tipps: [
      'Der Artikelbericht zählt den Hauptartikel — egal ob mit Pommes oder Kartoffelsalat, pur oder gespritzt (für Belege ab Version 0.8.63).',
      'Die Übersicht zeigt unter den Umsatzsummen auch gleich die Artikelliste.',
    ],
  },
  {
    id: 'kassenbuch',
    titel: 'Kassenbuch',
    zweck: 'Bar-Einlagen und Entnahmen aus der Kasse festhalten (z. B. Wechselgeld, Trinkgeld, Einkauf).',
    pfade: ['/kassenbuch'],
    stichworte: ['einlage', 'entnahme', 'wechselgeld'],
    schritte: [
      '„+ Neue Buchung": Art wählen (Einlage oder Entnahme), Betrag und Datum eintragen, einen Grund dazuschreiben.',
      'Den Zeitraum oben wählen (Heute, Gestern, Woche, Monat). Die Liste zeigt alle Buchungen und den Saldo.',
      'Ausdruck: auf den Thermodrucker oder als PDF.',
    ],
    tipps: ['Das Kassenbuch erscheint auch im Tagesabschluss desselben Tages.'],
  },
  {
    id: 'dashboard',
    titel: 'Dashboard',
    zweck: 'Der Tag auf einen Blick: Umsatz, Top-Artikel, offene Bons in der Küche.',
    pfade: ['/dashboard'],
    schritte: [
      '„Kassen im Überblick": Umsatz und Belege der heutigen Kassen.',
      '„Top-Artikel heute" und „Umsatz nach Tageszeit" zeigen, was gut läuft.',
      '„KDS — Offene Bons" und „Küche/Schank heute" zeigen die Zubereitung.',
      '„Geräte verbinden" zeigt die Adresse der Kassa und QR-Codes für Handys und Displays.',
    ],
    tipps: ['Erinnert die Kassa an den Jahresbeleg, bitte unter „Belege" erstellen (gesetzliche Pflicht).'],
  },

  // ── Personal ───────────────────────────────────────────────────────────────
  {
    id: 'benutzer',
    titel: 'Benutzer',
    zweck: 'Wer darf mit der Kassa arbeiten und was darf er?',
    pfade: ['/benutzer'],
    stichworte: ['pin', 'berechtigung', 'rolle', 'mitarbeiter'],
    schritte: [
      '„+ Neuer Benutzer": Name eintragen, Rolle und Berechtigungen wählen.',
      'Personal meldet sich mit einer PIN an (zweimal eingeben); Chefs können sich mit E-Mail und Passwort anmelden.',
      '„Kassen-Zuordnung": festlegen, an welchen Kassen der Benutzer arbeiten darf.',
    ],
    tipps: ['Wer einen Menüpunkt nicht sieht, hat dafür keine Berechtigung.'],
  },
  {
    id: 'zeiterfassung',
    titel: 'Zeiterfassung',
    zweck: 'Wer wann gearbeitet hat — Ein- und Ausstempeln und Stundenübersicht.',
    pfade: ['/zeiterfassung'],
    schritte: [
      'Die Übersicht zeigt, wer gerade eingestempelt ist, und die Einträge der Woche.',
      '„+ Manuell anlegen": einen Eintrag nachtragen (Mitarbeiter, Beginn, Ende, Pause in Minuten).',
      'Schichten über Mitternacht zählen zum Tag, an dem sie begonnen haben.',
    ],
  },
  {
    id: 'dienstplan',
    titel: 'Dienstplan',
    zweck: 'Schichten planen.',
    pfade: ['/dienstplan'],
    schritte: [
      'Mitarbeiter wählen, „Schicht hinzufügen" und Zeiten eintragen (optional Position und Notiz).',
      'Schichten lassen sich über „Löschen" wieder entfernen.',
    ],
  },

  // ── Einstellungen ──────────────────────────────────────────────────────────
  {
    id: 'einstellungen',
    titel: 'Einstellungen',
    zweck: 'Kassen, Drucker, Belege, Geräte und Systemeinstellungen.',
    pfade: ['/einstellungen'],
    stichworte: ['drucker', 'ip', 'kasse anlegen', 'geräte', 'qr', 'update', 'sicherung', 'bonierdrucker'],
    schritte: [
      'Oben gibt es die Bereiche: „Kassen & Drucker", „Geräte", „Beleg & Layout", „RKSV", „Gastro", „SB-Terminal" (wenn aktiv) und „System".',
    ],
    abschnitte: [
      {
        titel: 'Kassen & Drucker',
        schritte: [
          'Einen Drucker einrichten: „+ weiteren Drucker einrichten", Name, IP-Adresse und Port (meist 9100) eintragen. Als Anhaltspunkt zeigt die Kassa die Adresse des Kassen-PCs — der Drucker beginnt meist mit denselben drei Zahlen.',
          '„Testdruck" prüft, ob der Drucker antwortet.',
          'In der Tabelle „Kassen" legst du je Kasse Startseite, Belegausgabe, Rechnungsdrucker und Bonierdrucker fest.',
          '„Optionen im Direktverkauf": ob an dieser Kasse nach Optionen gefragt wird.',
          '„Warengruppen-Verteilung": welche Warengruppen an welcher Kasse erscheinen. Dort lassen sich auch Warengruppen und Artikel importieren/exportieren.',
        ],
      },
      {
        titel: 'Geräte',
        schritte: ['QR-Codes für Kellner-Handys, Küchen-Bildschirm (KDS), Kundendisplay und Gast-Bestellung. Handy scannen, fertig.'],
      },
      {
        titel: 'System',
        schritte: [
          'Zeigt die installierte Version. Gibt es eine neuere, erscheint „Neu laden" bzw. „Jetzt aktualisieren".',
          'Hier laufen die Datenbank-Sicherungen und die Systeminfo.',
        ],
      },
    ],
    tipps: ['Änderungen wirken sofort, ein Speichern-Knopf ist meist nicht nötig.'],
  },
  {
    id: 'pos-konfiguration',
    titel: 'POS-Konfiguration',
    zweck: 'Aussehen und Verhalten der Kasse: Zahlungsarten, Raster, Favoriten, Kellner-App.',
    pfade: ['/pos-konfiguration'],
    stichworte: ['favoriten', 'raster', 'zahlungsarten', 'startseite'],
    schritte: [
      'Oben die Kasse wählen, die du einstellen willst.',
      'Zahlungsarten erlauben oder sperren, Anzahl der Artikel je Zeile und Artikelbilder festlegen.',
      'Favoriten und die Anordnung der Artikel je Warengruppe einstellen.',
      'Kellner-App: Betriebsart (Tische oder Theke), Tischauswahl und Favoriten-Reiter.',
    ],
  },
  {
    id: 'module',
    titel: 'Module',
    zweck: 'Zusatzfunktionen ein- und ausschalten und Gänge einstellen.',
    pfade: ['/module'],
    schritte: [
      'Hier siehst du die Module des Betriebs (z. B. Gastro, Angebote, Reservierungen, Tickets, Zeiterfassung).',
      'Bei Gängen die „Anzahl Gänge" und die „Umrüstzeit" einstellen.',
    ],
  },
  {
    id: 'dep-export',
    titel: 'DEP-Export',
    zweck: 'Datenerfassungsprotokoll für die Finanzprüfung (gesetzliche Aufzeichnungen).',
    pfade: ['/dep-export'],
    stichworte: ['finanzamt', 'rksv', 'dep', 'sicherung'],
    schritte: [
      'Die Kasse wählen. Ohne Zeitraum werden alle Belege der Kasse exportiert; mit „Zeitraum (optional)" eingrenzen.',
      'Format wählen (z. B. „Lesbar + strukturiert") und herunterladen.',
      'Frühere Sicherungen stehen in der Liste darunter.',
    ],
    tipps: ['Die Aufzeichnungen sind 7 Jahre aufzubewahren.'],
  },
  {
    id: 'bmd-export',
    titel: 'Buchhaltungs-Export (BMD)',
    zweck: 'Belege im BMD-NTCS-CSV-Format für die Buchhaltung.',
    pfade: ['/bmd-export'],
    stichworte: ['buchhaltung', 'datev', 'steuerberater'],
    schritte: [
      'Zeitraum wählen und exportieren.',
      'Die Konten (z. B. Bar → 2000, Karte → 2600) vorher mit der Buchhaltung abstimmen.',
    ],
  },
  {
    id: 'werbefolien',
    titel: 'Werbefolien',
    zweck: 'Bilder, die das Kundendisplay zeigt, wenn nicht kassiert wird.',
    pfade: ['/werbefolien'],
    schritte: [
      '„Folie hinzufügen": Bild wählen (JPEG, PNG, WebP), optional Titel und Anzeigedauer in Sekunden.',
      'Folien lassen sich mit „Löschen" wieder entfernen.',
    ],
  },
  {
    id: 'finanzpruefung',
    titel: 'Finanzprüfungs-Modus',
    zweck: 'Dem Prüfer einen zeitlich begrenzten Lesezugang geben.',
    pfade: ['/finanzpruefung'],
    stichworte: ['prüfer', 'betriebsprüfung'],
    schritte: [
      '„Neuen Prüfer-Link erstellen": Gültigkeitsdauer und Beschreibung wählen, „Prüfer-Link erstellen".',
      'Den Link dem Prüfer geben. Er sieht die Belege, kann aber nichts ändern.',
      'Mit „Öffnen →" siehst du, was der Prüfer sieht.',
    ],
  },
]
