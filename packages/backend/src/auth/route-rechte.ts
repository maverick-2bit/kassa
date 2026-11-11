/**
 * Zugriffsrechte je Route — die vollständige Rechte-Tabelle der API.
 *
 * Prüfbericht 2026-11, Befund 3: Die Berechtigungen (Berechtigung) galten fast nur im UI. Wer ein Token hatte (Kellner am
 * Handy), konnte über die API Gutscheine ausstellen, Artikel ändern, Berichte und Exporte lesen. Jetzt steht hier für JEDE
 * Route, wer sie darf; server.ts hängt den passenden Wächter beim Start automatisch an (onRoute-Hook).
 *
 * Aufbau: Jede Route kommt in genau eine Liste —
 *   - ROUTEN_RECHTE: Route braucht ein Recht (eines der genannten genügt; Admins dürfen immer), die Rolle „admin" oder
 *     darf ausdrücklich jeder Angemeldete (mit Begründung). Routen mit eigenem Wächter in der Route-Datei
 *     (requireRolle, requireBerechtigung, requireBetreiber, Geräte-Wächter) stehen NICHT hier.
 *   - OEFFENTLICHE_ROUTEN: Routen ganz ohne Wächter am Hook (Gäste, Geräte, Webhooks) — mit Begründung, wer sie schützt.
 *
 * tests/route-schutz.test.ts liest die tatsächlich registrierten Routen aus und schlägt fehl, wenn eine Route in keiner
 * Liste steht (neue Route ohne Rechteprüfung), in zwei Listen steht oder hier steht, aber nicht mehr existiert.
 * Wer eine Route anlegt, trägt sie hier ein.
 *
 * Maßstab für die Einträge: Wer die Seite im UI erreicht, die die Route aufruft, darf sie auch hier (Seiten-Recht in
 * frontend/src/App.tsx). Dienen mehrere Seiten, genügt eines ihrer Rechte.
 */

import type { Berechtigung } from '@kassa/shared'

export type Zugriff =
  | { art: 'berechtigung'; berechtigungen: readonly Berechtigung[] }
  | { art: 'admin' }
  | { art: 'jeder'; grund: string }

const recht = (...berechtigungen: Berechtigung[]): Zugriff => ({ art: 'berechtigung', berechtigungen })
const admin: Zugriff = { art: 'admin' }
const jeder = (grund: string): Zugriff => ({ art: 'jeder', grund })

/** Schlüssel einer Route: `METHODE /voller/pfad` genau wie registriert (mit /api und Parameternamen). */
export type RoutenSchluessel = string

export const ROUTEN_RECHTE: ReadonlyArray<readonly [Zugriff, readonly RoutenSchluessel[]]> = [
  // Nur Administratoren (Rolle) — diese Routen prüfen die Rolle zusätzlich selbst im Handler.
  [
    admin,
    [
      'GET /api/admin/monitoring',
      'PATCH /api/admin/monitoring/keep-alive',
      'POST /api/admin/monitoring/keep-alive/pruefen',
      'POST /api/mandant-uebergabe/export',
      'POST /api/mandant-uebergabe/sperre-aufheben',
      'GET /api/mandant-uebergabe/status',
      'GET /api/rksv/signatur-selbsttest',
      'GET /api/rksv/signatur-selbsttest.csv',
    ],
  ],
  // Recht „Einstellungen": Drucker, Kassen, KDS, Sicherungen, Prüfer-Zugänge, Mandant, Werbung, Zeiterfassung, Exporte.
  [
    recht('einstellungen'),
    [
      'POST /api/artikel/kds-zuruecksetzen',
      'GET /api/audit-log',
      'GET /api/belege/dep131',
      'GET /api/belege/dep7',
      'POST /api/belege/fo-registrierung',
      'POST /api/belege/see-ausfall',
      'POST /api/bonierdrucker',
      'DELETE /api/bonierdrucker/:id',
      'PATCH /api/bonierdrucker/:id',
      'GET /api/bonierdrucker/:id/status',
      'POST /api/bonierdrucker/:id/test',
      'GET /api/dep-sicherungen',
      'POST /api/dep-sicherungen',
      'GET /api/dep-sicherungen/:id/download',
      'GET /api/dienstplan',
      'POST /api/dienstplan',
      'DELETE /api/dienstplan/:id',
      'PATCH /api/dienstplan/:id',
      'POST /api/drucker',
      'DELETE /api/drucker/:id',
      'PATCH /api/drucker/:id',
      'GET /api/drucker/:id/status',
      'POST /api/drucker/:id/test',
      'PUT /api/einrichtung/ausnahmen',
      'GET /api/export/bmd',
      'GET /api/finanzpruefung/tokens',
      'POST /api/finanzpruefung/tokens',
      'DELETE /api/finanzpruefung/tokens/:id',
      'POST /api/kassen',
      'POST /api/kassen/:id/ausser-betrieb',
      'PATCH /api/kassen/:id/bezeichnung',
      'PATCH /api/kassen/:id/drucker',
      'GET /api/kassen/:id/drucker/log',
      'GET /api/kassen/:id/drucker/status',
      'POST /api/kassen/:id/drucker/test',
      'POST /api/kassen/:id/einrichtung-kopieren',
      'GET /api/kassen/:id/kds',
      'PATCH /api/kassen/:id/kds',
      'GET /api/kassen/:id/see',
      'PATCH /api/kassen/:id/see',
      'POST /api/kassen/:id/see/test',
      'PATCH /api/kassen/:id/zvt',
      'GET /api/kassen/:kasseId/abschluss-email',
      'PATCH /api/kassen/:kasseId/abschluss-email',
      'PUT /api/kassen/:kasseId/favoriten',
      'PUT /api/kassen/:kasseId/pos-config',
      'GET /api/kassen/:kasseId/self-checkout',
      'PATCH /api/kassen/:kasseId/self-checkout',
      'POST /api/kassenbuch',
      'POST /api/kassenbuch/drucken',
      'GET /api/kds/fallback-drucker',
      'PUT /api/kds/fallback-drucker',
      'GET /api/kds/station-drucker',
      'PUT /api/kds/station-drucker',
      'GET /api/mandanten/freigaben',
      'PATCH /api/mandanten/freigaben',
      'GET /api/mandanten/module',
      'PATCH /api/mandanten/module',
      'PATCH /api/mandanten/stammdaten',
      'GET /api/mandanten/stripe',
      'PATCH /api/mandanten/stripe',
      'POST /api/mandanten/stripe/test',
      'GET /api/werbefolien',
      'POST /api/werbefolien',
      'DELETE /api/werbefolien/:id',
      'PATCH /api/werbefolien/:id',
      'GET /api/zeiterfassung',
      'POST /api/zeiterfassung',
      'DELETE /api/zeiterfassung/:id',
      'PATCH /api/zeiterfassung/:id',
      'GET /api/zeiterfassung/aktuell',
    ],
  ],
  // Recht „Artikel verwalten": Artikel, Warengruppen, Optionen, Lager, Inventur, Einkauf, Preislisten.
  [
    recht('artikel.verwalten'),
    [
      'POST /api/artikel',
      'GET /api/artikel-varianten-erledigt',
      'PUT /api/artikel/:artikelId/modifikator-gruppen',
      'POST /api/artikel/:artikelId/varianten-aufloesen',
      'DELETE /api/artikel/:artikelId/varianten-erledigt/:modifikatorId',
      'DELETE /api/artikel/:id',
      'POST /api/artikel/bulk',
      'POST /api/artikel/lager-aktivieren',
      'PATCH /api/artikel/reihenfolge',
      'GET /api/einkauf/bestellungen',
      'POST /api/einkauf/bestellungen',
      'DELETE /api/einkauf/bestellungen/:id',
      'GET /api/einkauf/bestellungen/:id',
      'PUT /api/einkauf/bestellungen/:id',
      'POST /api/einkauf/bestellungen/:id/email',
      'GET /api/einkauf/bestellungen/:id/pdf',
      'POST /api/einkauf/bestellungen/:id/status',
      'GET /api/inventuren',
      'POST /api/inventuren',
      'DELETE /api/inventuren/:id',
      'GET /api/inventuren/:id',
      'POST /api/inventuren/:id/abschliessen',
      'POST /api/inventuren/:id/drucken',
      'POST /api/inventuren/:id/email',
      'GET /api/inventuren/:id/protokoll.csv',
      'PATCH /api/inventuren/:id/zaehlung',
      'POST /api/kategorien',
      'DELETE /api/kategorien/:id',
      'POST /api/lagerstand/bulk',
      'POST /api/lagerstand/wareneingang-ausgabe',
      'POST /api/lagerstand/wareneingang-email',
      'GET /api/lieferanten',
      'POST /api/lieferanten',
      'DELETE /api/lieferanten/:id',
      'PUT /api/lieferanten/:id',
      'POST /api/modifikator-gruppen',
      'POST /api/modifikator-gruppen/:gruppeId/modifikatoren',
      'DELETE /api/modifikator-gruppen/:id',
      'PATCH /api/modifikator-gruppen/:id',
      'POST /api/modifikator-gruppen/import',
      'DELETE /api/modifikatoren/:id',
      'PATCH /api/modifikatoren/:id',
      'POST /api/preislisten',
      'DELETE /api/preislisten/:id',
      'GET /api/preislisten/:id',
      'PUT /api/preislisten/:id',
      'PUT /api/preislisten/:id/preise',
      'DELETE /api/preislisten/:id/preise/:artikelId',
      'POST /api/preisregeln',
      'DELETE /api/preisregeln/:id',
      'PATCH /api/preisregeln/:id',
      'POST /api/seriennummern',
      'DELETE /api/seriennummern/:id',
      'GET /api/sprache/artikel/:id/synonyme',
      'PUT /api/sprache/artikel/:id/synonyme',
      'GET /api/sprache/synonyme',
    ],
  ],
  // Recht „Schnellkasse": Verkauf, Gutscheine, Angebote, Wartungsverträge, Reservierungen, Lieferungen.
  [
    recht('kasse'),
    [
      'GET /api/angebote',
      'POST /api/angebote',
      'GET /api/angebote/:id',
      'PATCH /api/angebote/:id',
      'POST /api/belege/barzahlung',
      'POST /api/display',
      'GET /api/gutscheine',
      'POST /api/gutscheine',
      'GET /api/gutscheine/:id',
      'GET /api/gutscheine/:id/buchungen',
      'POST /api/gutscheine/:id/drucken',
      'POST /api/gutscheine/:id/einloesen',
      'POST /api/gutscheine/:id/stornieren',
      'GET /api/gutscheine/code/:code',
      'GET /api/gutscheine/journal',
      'GET /api/gutscheine/journal.csv',
      'GET /api/kassen/:kasseId/online-buchung',
      'PATCH /api/kassen/:kasseId/online-buchung',
      'GET /api/kassen/:kasseId/webhook-url',
      'GET /api/lieferbestellungen',
      'PATCH /api/lieferbestellungen/:id',
      'POST /api/lieferbestellungen/:id/drucken',
      'GET /api/preislisten/fuer-kunde/:kundeId',
      'GET /api/reservierungen',
      'POST /api/reservierungen',
      'DELETE /api/reservierungen/:id',
      'PATCH /api/reservierungen/:id',
      'GET /api/reservierungen/tische',
      'POST /api/sb-bestellungen/:id/bereit',
      'GET /api/wartungsvertraege',
      'POST /api/wartungsvertraege',
      'GET /api/wartungsvertraege/:id',
      'PATCH /api/wartungsvertraege/:id',
      'POST /api/wartungsvertraege/:id/abrechnen',
      'GET /api/wartungsvertraege/faellige-rechnungen',
      'POST /api/wartungsvertraege/lauf',
      'GET /api/wartungsvertraege/rechnungen',
    ],
  ],
  // Recht „Kreditverkauf": ein offener Posten entsteht nur durch den Kredit-Modus der Kasse.
  [
    recht('kasse.kredit'),
    [
      'POST /api/offene-posten',
    ],
  ],
  // Recht „Belege einsehen": Berichte, Tagesabschluss, Monats-/Jahresbeleg.
  [
    recht('belege.lesen'),
    [
      'POST /api/belege/jahresbeleg',
      'POST /api/belege/monatsbeleg',
      'GET /api/belege/tagesabschluss',
      'POST /api/belege/tagesabschluss/drucken',
      'GET /api/berichte/artikel',
      'GET /api/berichte/buchungsjournal',
      'POST /api/berichte/drucken',
      'GET /api/berichte/kassen-vergleich',
      'GET /api/berichte/kellner',
      'GET /api/berichte/kueche',
      'GET /api/berichte/stunden',
      'GET /api/berichte/umsatz',
      'GET /api/berichte/warengruppe',
      'GET /api/kassen/:id/status',
      'GET /api/kds/uebersicht',
    ],
  ],
  // Recht „Belege stornieren".
  [
    recht('belege.stornieren'),
    [
      'POST /api/belege/storno',
    ],
  ],
  // Recht „Kunden (CRM)".
  [
    recht('kunden.verwalten'),
    [
      'DELETE /api/kunden/:id',
      'PUT /api/kunden/:id',
      'GET /api/kunden/:id/belege',
      'GET /api/offene-posten',
      'GET /api/offene-posten/:id',
      'POST /api/offene-posten/:id/zahlung',
    ],
  ],
  // Eines dieser Rechte genügt: „Artikel verwalten", „Schnellkasse".
  [
    recht('artikel.verwalten', 'kasse'),
    [
      'GET /api/seriennummern',
    ],
  ],
  // Eines dieser Rechte genügt: „Artikel verwalten", „Schnellkasse", „Belege einsehen", „Kunden (CRM)".
  [
    recht('artikel.verwalten', 'kasse', 'belege.lesen', 'kunden.verwalten'),
    [
      'GET /api/kunden',
      'GET /api/kunden/:id',
    ],
  ],
  // Eines dieser Rechte genügt: „Artikel verwalten", „Schnellkasse", „Tische".
  [
    recht('artikel.verwalten', 'kasse', 'tische'),
    [
      'GET /api/artikel-modifikator-gruppen',
      'GET /api/modifikator-gruppen',
      'GET /api/preisregeln',
    ],
  ],
  // Eines dieser Rechte genügt: „Artikel verwalten", „Kunden (CRM)".
  [
    recht('artikel.verwalten', 'kunden.verwalten'),
    [
      'POST /api/kunden',
      'GET /api/preislisten',
    ],
  ],
  // Eines dieser Rechte genügt: „Belege einsehen", „Kunden (CRM)".
  [
    recht('belege.lesen', 'kunden.verwalten'),
    [
      'GET /api/offene-posten/statistik',
    ],
  ],
  // Eines dieser Rechte genügt: „Belege einsehen", „Tische".
  [
    recht('belege.lesen', 'tische'),
    [
      'GET /api/belege',
    ],
  ],
  // Eines dieser Rechte genügt: „Einstellungen", „Artikel verwalten".
  [
    recht('einstellungen', 'artikel.verwalten'),
    [
      'PUT /api/artikel/:id',
      'PATCH /api/artikel/favoriten-reihenfolge',
      'GET /api/bonierdrucker',
      'GET /api/einrichtung',
      'PUT /api/kategorien/:id',
      'PATCH /api/kategorien/reihenfolge',
    ],
  ],
  // Eines dieser Rechte genügt: „Einstellungen", „Belege einsehen".
  [
    recht('einstellungen', 'belege.lesen'),
    [
      'GET /api/kassenbuch',
      'POST /api/kassensturz/drucken',
    ],
  ],
  // Eines dieser Rechte genügt: „Einstellungen", „Belege einsehen", „Tickets".
  [
    recht('einstellungen', 'belege.lesen', 'tickets'),
    [
      'GET /api/system/netzwerk',
    ],
  ],
  // Eines dieser Rechte genügt: „Einstellungen", „Tische".
  [
    recht('einstellungen', 'tische'),
    [
      'POST /api/kassen/:id/tisch-etiketten',
    ],
  ],
  // Eines dieser Rechte genügt: „Schnellkasse", „Belege einsehen".
  [
    recht('kasse', 'belege.lesen'),
    [
      'POST /api/belege/nullbeleg',
    ],
  ],
  // Eines dieser Rechte genügt: „Schnellkasse", „Belege einsehen", „Tische".
  [
    recht('kasse', 'belege.lesen', 'tische'),
    [
      'POST /api/belege/:id/email',
    ],
  ],
  // Eines dieser Rechte genügt: „Schnellkasse", „Kunden (CRM)".
  [
    recht('kasse', 'kunden.verwalten'),
    [
      'GET /api/lieferscheine',
      'POST /api/lieferscheine',
      'GET /api/lieferscheine/:id',
      'PATCH /api/lieferscheine/:id',
      'POST /api/lieferscheine/:id/drucken',
      'POST /api/lieferscheine/:id/email',
      'GET /api/sammelrechnungen',
      'POST /api/sammelrechnungen',
      'GET /api/sammelrechnungen/:id',
      'POST /api/sammelrechnungen/:id/drucken',
      'POST /api/sammelrechnungen/:id/email',
      'POST /api/sammelrechnungen/:id/stornieren',
      'GET /api/sammelrechnungen/buchhaltung',
      'POST /api/sammelrechnungen/buchhaltung/gedruckt',
      'POST /api/sammelrechnungen/freigeben',
    ],
  ],
  // Eines dieser Rechte genügt: „Schnellkasse", „Tische".
  [
    recht('kasse', 'tische'),
    [
      'POST /api/sprache/bestellung',
    ],
  ],
  // Von jeder angemeldeten Seite geladen (Statusleisten, Kassen-Umschalter) — das UI zeigt sie allen Benutzern.
  // Die Wiederinbetriebnahme der Signatur ist betriebsnotwendig; die Kassa stellt sie bei Verbindung außerdem selbst wieder her.
  [
    jeder(
      'Von jeder angemeldeten Seite geladen (Statusleisten, Kassen-Umschalter) — das UI zeigt sie allen Benutzern. Die Wiederinbetriebnahme der Signatur ist betriebsnotwendig; die Kassa stellt sie bei Verbindung außerdem selbst wieder her.',
    ),
    [
      'GET /api/belege/fo-status',
      'GET /api/belege/see-status',
      'POST /api/belege/see-wiederherstellung',
      'GET /api/kassen',
      'GET /api/kassen/:kasseId/jahresbeleg-status',
    ],
  ],
  // Küchenbildschirm (KDS) und Abholung: Das Geräte-Token des Bildschirms gilt nur für /api/kds/ und zählt nirgends als Recht.
  [
    jeder(
      'Küchenbildschirm (KDS) und Abholung: Das Geräte-Token des Bildschirms gilt nur für /api/kds/ und zählt nirgends als Recht.',
    ),
    [
      'GET /api/kds/archiv',
      'POST /api/kds/bon/:id/erledigt',
      'POST /api/kds/bon/:id/haken',
      'POST /api/kds/bon/:id/nachdrucken',
      'POST /api/kds/bon/:id/teilbon',
      'GET /api/kds/bons',
      'GET /api/kds/kassen',
      'POST /api/kds/nachricht',
      'GET /api/kds/sb/:id/rechnung',
      'GET /api/sb-bestellungen',
      'POST /api/sb-bestellungen/:id/abgeholt',
    ],
  ],
  // Kellner-App und Tisch-Seiten: Die Kellner-App (Handy) prüft selbst keine Rechte — Tische öffnen, bonieren, bezahlen, Karte und Konfiguration lesen.
  // Ein Recht wie „Tische" hier zu verlangen, sperrt Kellner-Konten aus, die es nie bekommen haben, weil die App es nicht brauchte.
  // Wer diese Wege schließen will: Kellner-Konten prüfen (ops/DEPLOYMENT.md, Abschnitt „Rechte"), dann die Einträge unten auf recht('tische', 'kasse') umstellen.
  [
    jeder(
      'Kellner-App und Tisch-Seiten: Die Kellner-App (Handy) prüft selbst keine Rechte — Tische öffnen, bonieren, bezahlen, Karte und Konfiguration lesen. Ein Recht wie „Tische" hier zu verlangen, sperrt Kellner-Konten aus, die es nie bekommen haben, weil die App es nicht brauchte. Wer diese Wege schließen will: Kellner-Konten prüfen (ops/DEPLOYMENT.md, Abschnitt „Rechte"), dann die Einträge unten auf recht(\'tische\', \'kasse\') umstellen.',
    ),
    [
      'GET /api/artikel',
      'GET /api/artikel/:artikelId/modifikator-gruppen',
      'POST /api/belege/:id/drucken',
      'POST /api/bestellung/bonieren',
      'POST /api/bon-probleme/:id/nochmal',
      'POST /api/bon-probleme/:id/verstanden',
      'GET /api/kassen/:id/bon-probleme',
      'GET /api/kassen/:id/drucker',
      'GET /api/kassen/:id/druckprobleme',
      'GET /api/kassen/:id/zvt',
      'GET /api/kassen/:kasseId/artikel-layouts',
      'GET /api/kassen/:kasseId/favoriten',
      'GET /api/kassen/:kasseId/pos-config',
      'GET /api/kategorien',
      'POST /api/kds/antwort',
      'GET /api/tisch-tabs',
      'POST /api/tisch-tabs',
      'GET /api/tisch-tabs/:id',
      'POST /api/tisch-tabs/:id/bezahlen',
      'POST /api/tisch-tabs/:id/gang-abrufen',
      'PATCH /api/tisch-tabs/:id/kellner',
      'POST /api/tisch-tabs/:id/position-nachschicken',
      'PUT /api/tisch-tabs/:id/positionen',
      'POST /api/tisch-tabs/:id/splitten',
      'PATCH /api/tisch-tabs/:id/tisch',
      'GET /api/tisch-tabs/:id/verlauf',
      'POST /api/tisch-tabs/:id/verschieben',
      'POST /api/tisch-tabs/:id/verwerfen',
      'POST /api/tisch-tabs/:id/zusammenfuehren',
      'GET /api/tischplan/bereiche',
      'POST /api/zvt/zahlung',
      'GET /api/zvt/zahlung/:jobId',
      'POST /api/zvt/zahlung/:jobId/abbrechen',
    ],
  ],
  // Referenzdaten, die jeder Dialog braucht (Druckerliste, Firmendaten auf Belegen, Tagesbeginn, eigenes Konto, Systemstatus).
  [
    jeder(
      'Referenzdaten, die jeder Dialog braucht (Druckerliste, Firmendaten auf Belegen, Tagesbeginn, eigenes Konto, Systemstatus).',
    ),
    [
      'GET /api/auth/me',
      'GET /api/drucker',
      'GET /api/mandanten/stammdaten',
      'GET /api/mandanten/tagesbeginn',
      'GET /api/system/status',
    ],
  ],
]

export const OEFFENTLICHE_ROUTEN: ReadonlyArray<readonly [grund: string, routen: readonly RoutenSchluessel[]]> = [
  [
    'Anmeldung und Einrichtung vor dem Login (die Einrichtung prüft Erlaubnis und Limit selbst: setup.route.ts).',
    [
      'POST /api/auth/login',
      'GET /api/auth/pin-info',
      'POST /api/auth/pin-login',
      'GET /api/health',
      'GET /api/kassen/auswahl',
      'POST /api/setup',
      'GET /api/setup/status',
    ],
  ],
  [
    'Überwachung (Uptime-Dienst): prüft das MONITORING_TOKEN im Query selbst.',
    [
      'GET /api/monitoring/status',
    ],
  ],
  [
    'Echtzeit-Streams (SSE): prüfen ihr Token im Query selbst; Anzeigen (Kundendisplay, Abholmonitor) laufen ohne Login über die Kassen-ID.',
    [
      'GET /api/kds/events',
      'GET /sse/abholung',
      'GET /sse/display',
      'GET /sse/events',
    ],
  ],
  [
    'Gäste-Bestellung per QR am Tisch (öffentlich, Modul-Schalter + Tisch-Token im Handler).',
    [
      'POST /api/gast/bestellung',
      'GET /api/gast/bestellung/:id',
      'POST /api/gast/checkout',
      'GET /api/gast/karte',
    ],
  ],
  [
    'SB-Terminal, Self-Checkout, Abholung: öffentliche Kunden-Oberflächen am Gerät.',
    [
      'GET /api/selfcheckout',
      'POST /api/selfcheckout/zahlung-anfordern',
      'POST /api/terminal/bestellung',
      'GET /api/terminal/bestellung/:id',
      'POST /api/terminal/bestellung/:id/abbrechen',
      'POST /api/terminal/bestellung/:id/bestaetigen',
      'GET /api/terminal/sortiment',
    ],
  ],
  [
    'Online-Reservierung für Gäste (Buchungsseite).',
    [
      'GET /api/buchung/:kasseId',
      'POST /api/buchung/:kasseId',
      'POST /api/buchung/:kasseId/stornieren/:token',
      'GET /api/buchung/:kasseId/tische',
    ],
  ],
  [
    'Ticketshop (öffentlich): Bestellungen, Tickets, Veranstalterseite.',
    [
      'POST /api/ticketshop/bestellungen',
      'GET /api/ticketshop/bestellungen/:id',
      'POST /api/ticketshop/bestellungen/:id/abbrechen',
      'GET /api/ticketshop/bestellungen/:id/pdf',
      'GET /api/ticketshop/bestellungen/:id/rechnung',
      'GET /api/ticketshop/events/:eventId',
      'GET /api/ticketshop/ticket/:code',
      'GET /api/ticketshop/ticket/:code/pdf',
      'GET /api/ticketshop/veranstalter/:mandantId',
    ],
  ],
  [
    'Prüfer-Link (Token in der Adresse) und öffentlicher Beleg (nicht erratbare Beleg-ID).',
    [
      'GET /api/oeffentlich/beleg/:belegId',
      'GET /api/pruefung/:token',
      'GET /api/pruefung/:token/dep7',
    ],
  ],
  [
    'Webhooks von außen: Stripe-Signatur bzw. geheimer Schlüssel im Query.',
    [
      'POST /api/stripe/webhook',
      'POST /api/stripe/webhook/:mandantId',
      'POST /api/webhooks/:provider/:kasseId',
    ],
  ],
  [
    'Werbefolien für das Kundendisplay (öffentlich, Mandanten-ID als Schlüssel).',
    [
      'GET /api/werbefolien/public/:mandantId',
    ],
  ],
  [
    'Zeiterfassung: Stempeln per PIN am Gerät (kein Login).',
    [
      'POST /api/zeiterfassung/stempeln',
    ],
  ],
  [
    'KDS-Einrichtung: Bildschirm löst einen Einrichtungscode ein.',
    [
      'POST /api/kds/einrichtungscode/einloesen',
    ],
  ],
]

const INDEX = new Map<RoutenSchluessel, Zugriff>()
for (const [zugriff, liste] of ROUTEN_RECHTE) {
  for (const route of liste) {
    if (INDEX.has(route)) throw new Error(`Route steht doppelt in der Rechte-Tabelle: ${route}`)
    INDEX.set(route, zugriff)
  }
}

/**
 * Schlüssel einer Route in den Tabellen. Zu jedem GET legt Fastify selbst eine HEAD-Route an und führt dafür den
 * GET-Handler aus (nur der Body entfällt) — für HEAD gilt deshalb der Eintrag des GET. Ohne diese Gleichstellung
 * umginge `HEAD /api/berichte/umsatz` den Wächter (gefunden am 2026-11-11, bevor es veröffentlicht war).
 */
export function tabellenSchluessel(methode: string, url: string): RoutenSchluessel {
  return `${methode === 'HEAD' ? 'GET' : methode} ${url}`
}

/** Zugriff für eine Route laut Tabelle — undefined, wenn sie nicht darin steht. */
export function zugriffFuerRoute(methode: string, url: string): Zugriff | undefined {
  return INDEX.get(tabellenSchluessel(methode, url))
}
