/**
 * Drizzle ORM Schema – PostgreSQL
 *
 * Multi-Tenant-fähig: Jede relevante Tabelle hat mandant_id.
 * RKSV-konform: Belege sind unveränderlich (kein UPDATE, kein DELETE).
 * Lückenlose Belegnummern werden auf Service-Ebene durchgesetzt.
 */

import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  bigint,
  real,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Mandanten (Firmen / Unternehmen)
// ---------------------------------------------------------------------------

export const mandanten = pgTable('mandanten', {
  id:           uuid('id').primaryKey().defaultRandom(),
  firmenname:   text('firmenname').notNull(),
  /** Österr. UID: ATU + 8 Ziffern */
  uid:          varchar('uid', { length: 11 }).notNull(),
  /** Nachfolger eines früheren Mandanten (Betreiberwechsel) */
  vorgaengerId: uuid('vorgaenger_id'),
  status:       varchar('status', { length: 20 }).notNull().default('aktiv'),

  /** Freitext-Fußzeile auf Belegen / PDFs — z. B. Adresse, Dankestext, Website */
  belegFusstext:            text('beleg_fusstext'),
  /** Optionaler Kopftext unterhalb des Firmennamens (Adresse, Slogan o. ä.) */
  belegKopftext:            text('beleg_kopftext'),
  /** Steuertabelle (Normal/Ermäßigt/Null) am Ende des Belegs anzeigen */
  belegZeigeSteuertabelle:  boolean('beleg_zeige_steuertabelle').notNull().default(true),
  /** QR-Code für digitalen Beleg am Ende drucken */
  belegZeigeQr:             boolean('beleg_zeige_qr').notNull().default(false),

  // Gebuchte / aktivierte Funktions-Module
  /** Gastro-Betrieb: Tische, Tisch-Tabs, grafischer Tischplan, Bonierdrucker */
  modulGastroAktiv:    boolean('modul_gastro_aktiv').notNull().default(true),
  /** Angebotswesen: Angebote, Lieferscheine, Zielrechnungen */
  modulAngeboteAktiv:  boolean('modul_angebote_aktiv').notNull().default(false),
  /** Lieferservice-Integration: Lieferando, Mergeport und eigene Webhooks */
  modulMergeportAktiv:      boolean('modul_mergeport_aktiv').notNull().default(false),
  /** Tischreservierungen: intern + optionaler Online-Buchungslink */
  modulReservierungenAktiv: boolean('modul_reservierungen_aktiv').notNull().default(false),
  /** Personalzeiterfassung: PIN-Stempeluhr + Stundenauswertung */
  modulZeiterfassungAktiv:  boolean('modul_zeiterfassung_aktiv').notNull().default(false),

  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uidIdx: uniqueIndex('mandanten_uid_idx').on(t.uid).where(sql`status = 'aktiv'`),
}))

// ---------------------------------------------------------------------------
// Kassen (Cash Registers)
// ---------------------------------------------------------------------------

export const kassen = pgTable('kassen', {
  id:        uuid('id').primaryKey().defaultRandom(),
  mandantId: uuid('mandant_id').notNull().references(() => mandanten.id),

  /** Kassen-Identifikationsnummer (gemäß RKSV, eindeutig pro Mandant) */
  kassenId:    varchar('kassen_id', { length: 40 }).notNull(),
  bezeichnung: text('bezeichnung'),

  /** Status: aktiv | ausser_betrieb */
  status:    varchar('status', { length: 20 }).notNull().default('aktiv'),
  umgebung:  varchar('umgebung', { length: 20 }).notNull().default('produktion'),

  // SEE-Daten
  seeZertifikatDer:      text('see_zertifikat_der').notNull(),          // base64 DER
  /** AES-256-GCM verschlüsselter privater Schlüssel (siehe crypto/master-key.ts) */
  seePrivateKeyEnc:      text('see_private_key_enc').notNull(),
  seeZertifikatSn:       text('see_zertifikat_sn').notNull(),
  seeGueltigBis:         timestamp('see_gueltig_bis', { withTimezone: true }).notNull(),

  // RKSV-Laufzeitdaten
  umsatzzaehlerCent:     bigint('umsatzzaehler_cent', { mode: 'bigint' }).notNull().default(sql`0`),
  letzteBelegNummer:     integer('letzte_beleg_nummer').notNull().default(0),
  letzterSignaturwert:   text('letzter_signaturwert'),

  /** Gesetzt, solange die SEE ausgefallen ist (Belege tragen den Ausfallmarker, statt signiert zu sein). NULL = SEE in Betrieb. */
  seeAusgefallenSeit:    timestamp('see_ausgefallen_seit', { withTimezone: true }),

  /** Zeitpunkt der Außerbetriebnahme (Schlussbeleg erstellt, status='ausser_betrieb'). NULL = in Betrieb. */
  ausserBetriebAm:       timestamp('ausser_betrieb_am', { withTimezone: true }),

  // FinanzOnline-Status
  bei_fo_registriert:    boolean('bei_fo_registriert').notNull().default(false),
  fo_pruefwert:          text('fo_pruefwert'),
  registriert_am:        timestamp('registriert_am', { withTimezone: true }),

  // Drucker-Konfiguration (ESC/POS via TCP — z. B. Epson TM-T20, Star TSP100)
  druckerIp:             varchar('drucker_ip',   { length: 64 }),
  druckerPort:           integer('drucker_port').notNull().default(9100),
  druckerAktiv:          boolean('drucker_aktiv').notNull().default(false),
  /** Zeichen pro Zeile — 32 für 58mm-Papier, 42 oder 48 für 80mm */
  druckerBreite:         integer('drucker_breite_zeichen').notNull().default(42),
  /** TCP-Timeout in Sekunden (Standard: 5) */
  druckerTimeoutSek:     integer('drucker_timeout_sek').notNull().default(5),

  // KDS-Konfiguration (Küchen-Display-System)
  /** Mapping Stations-Slug → IP-Adresse, z. B. { kueche: "192.168.192.210" } */
  kdsStationen:          jsonb('kds_stationen').notNull().default({}),
  kdsPort:               integer('kds_port').notNull().default(9100),
  kdsAktiv:              boolean('kds_aktiv').notNull().default(false),

  // POS-Konfiguration (Zahlungsarten + Darstellung)
  /** Erlaubte Zahlungsarten: ["bar", "karte", "sonstige"] — Subset davon pro Kasse */
  erlaubteZahlungsarten: jsonb('erlaubte_zahlungsarten').notNull().default(['bar', 'karte', 'sonstige']),
  /** Artikelbilder im Kassen-Raster anzeigen */
  artikelbilderAktiv:    boolean('artikel_bilder_aktiv').notNull().default(true),
  /** Startseite nach Login: tische | kasse | kasse_favoriten | dashboard */
  startseite:            varchar('startseite', { length: 20 }).notNull().default('tische'),

  // ZVT-Kartenterminal-Konfiguration (Hobex/Payroc & kompatible über Standard-ZVT-Protokoll)
  zvtIp:                 varchar('zvt_ip',   { length: 64 }),
  zvtPort:               integer('zvt_port').notNull().default(20007),
  /** Optionales Terminal-Passwort (manche Geräte verlangen es bei Authorization) */
  zvtPasswort:           varchar('zvt_passwort', { length: 16 }),
  zvtAktiv:              boolean('zvt_aktiv').notNull().default(false),

  /** Geheimnis für eingehende Lieferando/Mergeport-Webhooks (URL-Parameter secret=…) */
  webhookSecret:         text('webhook_secret').notNull().$defaultFn(() => randomUUID()),
  /** Öffentlichen Online-Buchungslink für Gäste freischalten */
  onlineBuchungAktiv:    boolean('online_buchung_aktiv').notNull().default(false),

  /** E-Mail-Adresse für automatische Tagesabschluss-Zusammenfassung (Feature 7) */
  abschlussEmail:        text('abschluss_email'),
  /** Self-Checkout via QR — Gäste können offene Rechnung einsehen und Zahlung anfordern */
  selfCheckoutAktiv:     boolean('self_checkout_aktiv').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kassenIdIdx: uniqueIndex('kassen_mandant_kassenid_idx').on(t.mandantId, t.kassenId),
}))

// ---------------------------------------------------------------------------
// Belege (Receipts) – UNVERÄNDERLICH (append-only)
// ---------------------------------------------------------------------------

export const belege = pgTable('belege', {
  id:          uuid('id').primaryKey().defaultRandom(),
  mandantId:   uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:     uuid('kasse_id').notNull().references(() => kassen.id),

  /** Lückenlose laufende Nummer pro Kasse */
  belegNummer: integer('beleg_nummer').notNull(),
  belegDatum:  timestamp('beleg_datum', { withTimezone: true }).notNull(),
  belegTyp:    varchar('beleg_typ', { length: 30 }).notNull(),

  // Beträge pro Steuersatz (in Cent)
  betragNormalCent:      integer('betrag_normal_cent').notNull().default(0),
  betragErmaessigt1Cent: integer('betrag_ermaessigt1_cent').notNull().default(0),
  betragErmaessigt2Cent: integer('betrag_ermaessigt2_cent').notNull().default(0),
  betragNullCent:        integer('betrag_null_cent').notNull().default(0),
  betragBesondersCent:   integer('betrag_besonders_cent').notNull().default(0),

  // Zahlungsaufteilung
  summeBarCent:      integer('summe_bar_cent').notNull().default(0),
  summeKarteCent:    integer('summe_karte_cent').notNull().default(0),
  summeSonstigeCent: integer('summe_sonstige_cent').notNull().default(0),

  // RKSV-Signaturfelder
  umsatzzaehlerVerschluesselt: text('umsatzzaehler_verschluesselt').notNull(),
  zertifikatSn:                text('zertifikat_sn').notNull(),
  sigVorbeleg:                 text('sig_vorbeleg').notNull(),
  signaturwert:                text('signaturwert').notNull(),
  maschinenlesbareCode:        text('maschinenlesbare_code').notNull(),

  /** Original-Positionen als JSON (für Storno und Reporting) */
  positionen: jsonb('positionen').notNull(),

  /** Verweis auf den Original-Beleg (nur bei Stornobeleg gesetzt) */
  verweisBelegId: uuid('verweis_beleg_id').references((): AnyPgColumn => belege.id),

  /** Kunde (optional) — FK auf kunden-Tabelle */
  kundeId: uuid('kunde_id').references(() => kunden.id, { onDelete: 'set null' }),
  /** Eingefrierter Kunden-Snapshot zum Zeitpunkt der Buchung */
  kundeSnapshot: jsonb('kunde_snapshot'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  belegNrIdx:     uniqueIndex('belege_kasse_belegnr_idx').on(t.kasseId, t.belegNummer),
  datumIdx:       index('belege_datum_idx').on(t.belegDatum),
  verweisIdx:     index('belege_verweis_idx').on(t.verweisBelegId),
}))

// ---------------------------------------------------------------------------
// Kunden (CRM) — Kundenstammdaten pro Mandant
// ---------------------------------------------------------------------------

export const kunden = pgTable('kunden', {
  id:        uuid('id').primaryKey().defaultRandom(),
  mandantId: uuid('mandant_id').notNull().references(() => mandanten.id),

  /** Laufende Kundennummer pro Mandant (1, 2, 3, …) */
  nummer:    integer('nummer').notNull(),

  firma:    varchar('firma',    { length: 200 }),
  vorname:  varchar('vorname',  { length: 100 }),
  nachname: varchar('nachname', { length: 100 }),
  email:    varchar('email',    { length: 200 }),
  telefon:  varchar('telefon',  { length: 50  }),
  strasse:  varchar('strasse',  { length: 200 }),
  plz:      varchar('plz',      { length: 20  }),
  ort:      varchar('ort',      { length: 100 }),
  land:     varchar('land',     { length: 2   }).notNull().default('AT'),
  uid:      varchar('uid',      { length: 30  }),

  aktiv:       boolean('aktiv').notNull().default(true),
  /** Kreditkunde: darf "Auf Kredit" buchen */
  kreditAktiv: boolean('kredit_aktiv').notNull().default(false),
  /** Freitext-Notizen zum Kunden (intern, erscheint nicht auf Belegen) */
  notizen:     text('notizen'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nummerIdx:  uniqueIndex('kunden_mandant_nummer_idx').on(t.mandantId, t.nummer),
  sucheIdx:   index('kunden_suche_idx').on(t.mandantId, t.aktiv),
}))

export type Kunde    = typeof kunden.$inferSelect
export type NewKunde = typeof kunden.$inferInsert

// ---------------------------------------------------------------------------
// Angebote — nicht RKSV-relevant, kein Lagerstand
// ---------------------------------------------------------------------------

export const angebote = pgTable('angebote', {
  id:        uuid('id').primaryKey().defaultRandom(),
  mandantId: uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:   uuid('kasse_id').notNull().references(() => kassen.id),

  /** Laufende Angebotsnummer pro Mandant */
  nummer:    integer('nummer').notNull(),

  datum:     timestamp('datum', { withTimezone: true }).notNull().defaultNow(),
  gueltigBis: varchar('gueltig_bis', { length: 10 }),   // YYYY-MM-DD
  status:    varchar('status', { length: 20 }).notNull().default('offen'),
  notiz:     text('notiz'),

  /** Positionen als JSON (aufgelöst: bezeichnung, menge, preis, mwstSatz) */
  positionen:       jsonb('positionen').notNull(),
  gesamtbetragCent: integer('gesamtbetrag_cent').notNull(),

  /** Kunde (optional) */
  kundeId:       uuid('kunde_id').references(() => kunden.id, { onDelete: 'set null' }),
  kundeSnapshot: jsonb('kunde_snapshot'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nummerIdx: uniqueIndex('angebote_mandant_nummer_idx').on(t.mandantId, t.nummer),
  statusIdx: index('angebote_status_idx').on(t.mandantId, t.status),
}))

export type Angebot    = typeof angebote.$inferSelect
export type NewAngebot = typeof angebote.$inferInsert

// ---------------------------------------------------------------------------
// Lieferscheine — abgeleitet aus Angeboten, nicht RKSV-relevant
// ---------------------------------------------------------------------------

export const lieferscheine = pgTable('lieferscheine', {
  id:        uuid('id').primaryKey().defaultRandom(),
  mandantId: uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:   uuid('kasse_id').notNull().references(() => kassen.id),
  angebotId: uuid('angebot_id').notNull().references(() => angebote.id),

  /** Laufende Lieferscheinnummer pro Mandant */
  nummer: integer('nummer').notNull(),

  datum:  timestamp('datum', { withTimezone: true }).notNull().defaultNow(),
  status: varchar('status', { length: 20 }).notNull().default('offen'),
  notiz:  text('notiz'),

  /** Positionen-Snapshot aus dem Angebot (bezeichnung, menge, preis, mwstSatz) */
  positionen: jsonb('positionen').notNull(),

  /** Kunde (optional, übernommen vom Angebot) */
  kundeId:       uuid('kunde_id').references(() => kunden.id, { onDelete: 'set null' }),
  kundeSnapshot: jsonb('kunde_snapshot'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nummerIdx: uniqueIndex('lieferscheine_mandant_nummer_idx').on(t.mandantId, t.nummer),
  kundeIdx:  index('lieferscheine_kunde_idx').on(t.mandantId, t.kundeId),
  statusIdx: index('lieferscheine_status_idx').on(t.mandantId, t.status),
}))

export type Lieferschein    = typeof lieferscheine.$inferSelect
export type NewLiferschein  = typeof lieferscheine.$inferInsert

// ---------------------------------------------------------------------------
// Sammelrechnungen — fasst mehrere Lieferscheine zu einer Rechnung zusammen
// ---------------------------------------------------------------------------

export const sammelrechnungen = pgTable('sammelrechnungen', {
  id:        uuid('id').primaryKey().defaultRandom(),
  mandantId: uuid('mandant_id').notNull().references(() => mandanten.id),

  /** Laufende Sammelrechnungsnummer pro Mandant */
  nummer: integer('nummer').notNull(),

  datum: timestamp('datum', { withTimezone: true }).notNull().defaultNow(),

  /** IDs der enthaltenen Lieferscheine (als JSON-Array) */
  lieferscheinIds: jsonb('lieferschein_ids').notNull(),

  gesamtbetragCent: integer('gesamtbetrag_cent').notNull(),

  /** Kundebezug (vom ersten LS übernommen — alle müssen demselben Kunden gehören) */
  kundeId:       uuid('kunde_id').references(() => kunden.id, { onDelete: 'set null' }),
  kundeSnapshot: jsonb('kunde_snapshot'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nummerIdx: uniqueIndex('sammelrechnungen_mandant_nummer_idx').on(t.mandantId, t.nummer),
  kundeIdx:  index('sammelrechnungen_kunde_idx').on(t.mandantId, t.kundeId),
}))

export type Sammelrechnung    = typeof sammelrechnungen.$inferSelect
export type NewSammelrechnung = typeof sammelrechnungen.$inferInsert

// ---------------------------------------------------------------------------
// Gutscheine — Ausgabe und Einlösung
// ---------------------------------------------------------------------------

export const gutscheine = pgTable('gutscheine', {
  id:        uuid('id').primaryKey().defaultRandom(),
  mandantId: uuid('mandant_id').notNull().references(() => mandanten.id),

  /** Eindeutiger Code pro Mandant (z. B. "GS-A3B7-X2Y9") */
  code:   varchar('code', { length: 20 }).notNull(),
  nummer: integer('nummer').notNull(),
  datum:  timestamp('datum', { withTimezone: true }).notNull().defaultNow(),

  /** aktiv | teileingeloest | eingeloest | storniert */
  status: varchar('status', { length: 20 }).notNull().default('aktiv'),

  betragCent:  integer('betrag_cent').notNull(),
  bezahltCent: integer('bezahlt_cent').notNull().default(0),

  /** Optionales Ablaufdatum (YYYY-MM-DD) */
  gueltigBis: varchar('gueltig_bis', { length: 10 }),

  kundeId:       uuid('kunde_id').references(() => kunden.id, { onDelete: 'set null' }),
  kundeSnapshot: jsonb('kunde_snapshot'),

  notiz:     text('notiz'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx:   uniqueIndex('gutscheine_mandant_code_idx').on(t.mandantId, t.code),
  nummerIdx: uniqueIndex('gutscheine_mandant_nummer_idx').on(t.mandantId, t.nummer),
  statusIdx: index('gutscheine_status_idx').on(t.mandantId, t.status),
}))

export type Gutschein    = typeof gutscheine.$inferSelect
export type NewGutschein = typeof gutscheine.$inferInsert

// ---------------------------------------------------------------------------
// Gutschein-Buchungen — lückenlose Transaktionshistorie pro Gutschein
// ---------------------------------------------------------------------------

export const gutscheinBuchungen = pgTable('gutschein_buchungen', {
  id:          uuid('id').primaryKey().defaultRandom(),
  gutscheinId: uuid('gutschein_id').notNull().references(() => gutscheine.id, { onDelete: 'cascade' }),
  mandantId:   uuid('mandant_id').notNull(),

  /** ausstellung | einloesung | restgutschein | storno */
  typ: varchar('typ', { length: 20 }).notNull(),

  /** Positiv = Guthaben (Ausstellung), negativ = Verbrauch (Einlösung, Storno) */
  betragCent:   integer('betrag_cent').notNull(),
  /** Restwert des Gutscheins nach dieser Buchung */
  restCentNach: integer('rest_cent_nach').notNull(),

  /** Optionaler Beleg-Bezug (Einlösung am Kassatisch) */
  belegId: uuid('beleg_id').references(() => belege.id, { onDelete: 'set null' }),

  /** Bei typ = 'restgutschein': ID des neu erstellten Gutscheins */
  verknuepfterGutscheinId: uuid('verknuepfter_gutschein_id'),

  notiz:     text('notiz'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  gutscheinIdx: index('gutschein_buchungen_gutschein_idx').on(t.gutscheinId),
  mandantIdx:   index('gutschein_buchungen_mandant_idx').on(t.mandantId),
}))

export type GutscheinBuchung    = typeof gutscheinBuchungen.$inferSelect
export type NewGutscheinBuchung = typeof gutscheinBuchungen.$inferInsert

// ---------------------------------------------------------------------------
// Offene Posten — Kreditverkäufe, die später bezahlt werden
// ---------------------------------------------------------------------------

export const offenePosten = pgTable('offene_posten', {
  id:        uuid('id').primaryKey().defaultRandom(),
  mandantId: uuid('mandant_id').notNull().references(() => mandanten.id),

  /** Laufende Nummer pro Mandant */
  nummer: integer('nummer').notNull(),

  datum:  timestamp('datum', { withTimezone: true }).notNull().defaultNow(),
  /** offen | teilbezahlt | bezahlt */
  status: varchar('status', { length: 20 }).notNull().default('offen'),

  /** Kunden-FK + Snapshot */
  kundeId:       uuid('kunde_id').references(() => kunden.id, { onDelete: 'set null' }),
  kundeSnapshot: jsonb('kunde_snapshot'),

  /** Optionaler Verweis auf den auslösenden Beleg */
  belegId: uuid('beleg_id').references(() => belege.id, { onDelete: 'set null' }),

  /** Ursprungsbetrag in Cent */
  betragCent:  integer('betrag_cent').notNull(),
  /** Bereits bezahlter Betrag in Cent */
  bezahltCent: integer('bezahlt_cent').notNull().default(0),

  notiz: text('notiz'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nummerIdx: uniqueIndex('offene_posten_mandant_nummer_idx').on(t.mandantId, t.nummer),
  kundeIdx:  index('offene_posten_kunde_idx').on(t.mandantId, t.kundeId),
  statusIdx: index('offene_posten_status_idx').on(t.mandantId, t.status),
}))

export type OffenerPosten    = typeof offenePosten.$inferSelect
export type NewOffenerPosten = typeof offenePosten.$inferInsert

// ---------------------------------------------------------------------------
// Benutzer (Auth) — pro Mandant
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id:             uuid('id').primaryKey().defaultRandom(),
  mandantId:      uuid('mandant_id').notNull().references(() => mandanten.id),
  email:          varchar('email', { length: 200 }).notNull(),
  passwordHash:   text('password_hash').notNull(),
  /** bcrypt-Hash des 4-stelligen PINs — null = kein PIN gesetzt */
  pinHash:        text('pin_hash'),
  name:           text('name').notNull(),
  /** admin | kellner */
  rolle:          varchar('rolle', { length: 20 }).notNull().default('kellner'),
  /** Fein-granulare Berechtigungen als JSON-Array (z. B. ["tische","kasse"]) */
  berechtigungen: jsonb('berechtigungen').notNull(),
  aktiv:          boolean('aktiv').notNull().default(true),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex('users_email_idx').on(t.email),
}))

export type User    = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

// ---------------------------------------------------------------------------
// User ↔ Kassen (Zuordnung welche Kellner an welchen Kassen arbeiten)
// ---------------------------------------------------------------------------

export const userKassen = pgTable('user_kassen', {
  userId:  uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kasseId: uuid('kasse_id').notNull().references(() => kassen.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.kasseId] }),
}))

// ---------------------------------------------------------------------------
// Bonierdrucker — ESC/POS-Drucker für Bonierzettel (mandantenweit)
// ---------------------------------------------------------------------------

export const bonierdrucker = pgTable('bonierdrucker', {
  id:          uuid('id').primaryKey().defaultRandom(),
  mandantId:   uuid('mandant_id').notNull().references(() => mandanten.id),
  name:        text('name').notNull(),
  ip:          varchar('ip', { length: 64 }).notNull(),
  port:        integer('port').notNull().default(9100),
  /** Backup-Drucker: empfängt automatisch eine Kopie jedes Bonierbons */
  istBackup:   boolean('ist_backup').notNull().default(false),
  /** Fallback-Drucker: wird verwendet wenn dieser Drucker nicht erreichbar ist */
  fallbackId:  uuid('fallback_id').references((): AnyPgColumn => bonierdrucker.id, { onDelete: 'set null' }),
  aktiv:       boolean('aktiv').notNull().default(true),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantIdx: index('bonierdrucker_mandant_idx').on(t.mandantId),
}))

// ---------------------------------------------------------------------------
// Artikel-Kategorien — optionale Gruppierung für POS-Ansicht
// ---------------------------------------------------------------------------

export const kategorien = pgTable('kategorien', {
  id:              uuid('id').primaryKey().defaultRandom(),
  mandantId:       uuid('mandant_id').notNull().references(() => mandanten.id),
  name:            text('name').notNull(),
  /** Farbschlüssel für Tab-Darstellung (grau | rot | orange | ...) */
  farbe:           varchar('farbe', { length: 20 }).notNull().default('grau'),
  reihenfolge:     integer('reihenfolge').notNull().default(0),
  aktiv:           boolean('aktiv').notNull().default(true),
  /** Standard-Bonierdrucker für alle Artikel dieser Kategorie */
  bonierdruckerId: uuid('bonierdrucker_id').references(() => bonierdrucker.id, { onDelete: 'set null' }),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantIdx: index('kategorien_mandant_idx').on(t.mandantId),
}))

// ---------------------------------------------------------------------------
// Artikel (Produkte) – für späteren Bestellprozess
// ---------------------------------------------------------------------------

export const artikel = pgTable('artikel', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  mandantId:           uuid('mandant_id').notNull().references(() => mandanten.id),
  bezeichnung:         text('bezeichnung').notNull(),
  preisBruttoCent:     integer('preis_brutto_cent').notNull(),
  mwstSatz:            varchar('mwst_satz', { length: 20 }).notNull(),
  artikelnummer:       varchar('artikelnummer', { length: 40 }),
  /** KDS-Station für Bonierbon-Routing (null = nicht bonieren, z.B. Pfand) */
  station:             varchar('station', { length: 20 }),
  /** Optionale Kategorie-Zuordnung für Tab-Gruppierung in der POS-Ansicht */
  kategorieId:         uuid('kategorie_id').references(() => kategorien.id),
  aktiv:               boolean('aktiv').notNull().default(true),
  /** Countdown-Artikel: Lagerstand wird bei jeder Buchung automatisch reduziert */
  lagerstandAktiv:     boolean('lagerstand_aktiv').notNull().default(false),
  /** Aktueller Lagerstand (null wenn lagerstandAktiv=false) */
  lagerstandMenge:     integer('lagerstand_menge'),
  /** Mindestbestand – Alarm wenn lagerstandMenge ≤ mindestbestand */
  mindestbestand:      integer('mindestbestand'),
  /** Erscheint im Favoriten-Tab der POS-Ansicht */
  istFavorit:          boolean('ist_favorit').notNull().default(false),
  /** Sortierung innerhalb der Kategorie (global, für alle Kassen gleich) */
  reihenfolge:         integer('reihenfolge').notNull().default(0),
  /** Sortierung im Favoriten-Tab (global) */
  favoritenReihenfolge: integer('favoriten_reihenfolge').notNull().default(0),
  /** Override: Bonierdrucker für diesen Artikel (überschreibt Kategorie-Einstellung) */
  bonierdruckerId:     uuid('bonierdrucker_id').references(() => bonierdrucker.id, { onDelete: 'set null' }),
  /** Lieferant für Bestellliste und Einkauf */
  lieferantId:         uuid('lieferant_id').references((): AnyPgColumn => lieferanten.id, { onDelete: 'set null' }),
  /** Artikelbild als Data-URL (max. 200×200 px JPEG, client-seitig komprimiert) */
  bild:                text('bild'),
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:           timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantNummerIdx: uniqueIndex('artikel_mandant_nummer_idx').on(t.mandantId, t.artikelnummer),
  kategorieIdx:     index('artikel_kategorie_idx').on(t.kategorieId),
}))

// ---------------------------------------------------------------------------
// Kasse ↔ Kategorien-Sichtbarkeit — welche Warengruppen im POS erscheinen
// ---------------------------------------------------------------------------

export const kassekategorieSichtbarkeit = pgTable('kasse_kategorie_sichtbarkeit', {
  kasseId:    uuid('kasse_id').notNull().references(() => kassen.id, { onDelete: 'cascade' }),
  kategorieId: uuid('kategorie_id').notNull().references(() => kategorien.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk:       primaryKey({ columns: [t.kasseId, t.kategorieId] }),
  kasseIdx: index('kks_kasse_idx').on(t.kasseId),
}))

/**
 * Bonierdrucker-Sichtbarkeit pro Kasse. Bonierdrucker sind mandantweite Geräte;
 * dieser Join wählt, welche für eine bestimmte Kasse aktiv sind. Existiert für
 * eine Kasse KEIN Eintrag, gelten (abwärtskompatibel) alle Bonierdrucker.
 */
export const kasseBonierdruckerSichtbarkeit = pgTable('kasse_bonierdrucker_sichtbarkeit', {
  kasseId:        uuid('kasse_id').notNull().references(() => kassen.id, { onDelete: 'cascade' }),
  bonierdruckerId: uuid('bonierdrucker_id').notNull().references(() => bonierdrucker.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk:       primaryKey({ columns: [t.kasseId, t.bonierdruckerId] }),
  kasseIdx: index('kbs_kasse_idx').on(t.kasseId),
}))

// ---------------------------------------------------------------------------
// Tisch-Tabs — offene Tische mit akkumulierten Positionen
// ---------------------------------------------------------------------------

export const tischTabs = pgTable('tisch_tabs', {
  id:           uuid('id').primaryKey().defaultRandom(),
  mandantId:    uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:      uuid('kasse_id').notNull().references(() => kassen.id),
  tischNummer:  varchar('tisch_nummer', { length: 40 }).notNull(),
  kellner:      varchar('kellner', { length: 100 }).notNull().default('Service'),
  /** Akkumulierte Positionen als JSON-Array [{artikelId, bezeichnung, preisBruttoCent, menge, station?}] */
  positionen:   jsonb('positionen').notNull(),
  /** offen | bezahlt */
  status:       varchar('status', { length: 20 }).notNull().default('offen'),
  geoffnetAm:   timestamp('geoffnet_am', { withTimezone: true }).notNull().defaultNow(),
  geschlossenAm: timestamp('geschlossen_am', { withTimezone: true }),
  belegId:      uuid('beleg_id'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kasseStatusIdx: index('tisch_tabs_kasse_status_idx').on(t.kasseId, t.status),
}))

// ---------------------------------------------------------------------------
// Tab-Ereignisse — Audit-Log aller Aktionen am offenen Tisch
// ---------------------------------------------------------------------------

export const tabEreignisse = pgTable('tab_ereignisse', {
  id:        uuid('id').primaryKey().defaultRandom(),
  mandantId: uuid('mandant_id').notNull().references(() => mandanten.id),
  tabId:     uuid('tab_id').notNull().references(() => tischTabs.id),
  /** geoeffnet | bonierung | positionen_aktualisiert | tisch_gewechselt | kellner_umbenannt | bezahlt | gesplittet */
  typ:       varchar('typ', { length: 40 }).notNull(),
  /** Typ-spezifische Nutzdaten */
  details:   jsonb('details').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tabIdx: index('tab_ereignisse_tab_idx').on(t.tabId),
}))

export type TabEreignis    = typeof tabEreignisse.$inferSelect
export type NewTabEreignis = typeof tabEreignisse.$inferInsert

// ---------------------------------------------------------------------------
// Modifikator-Gruppen (Varianten-Gruppen für Artikel, z. B. "Größe", "Sauce")
// ---------------------------------------------------------------------------

export const modifikatorGruppen = pgTable('modifikator_gruppen', {
  id:          uuid('id').primaryKey().defaultRandom(),
  mandantId:   uuid('mandant_id').notNull().references(() => mandanten.id),
  name:        text('name').notNull(),
  /** 'pflicht' = mindestens eine Auswahl nötig | 'optional' = Auswahl optional */
  typ:         varchar('typ', { length: 20 }).notNull().default('optional'),
  /** Maximale Anzahl auswählbarer Optionen (null = unbegrenzt) */
  maxAuswahl:  integer('max_auswahl'),
  reihenfolge: integer('reihenfolge').notNull().default(0),
  aktiv:       boolean('aktiv').notNull().default(true),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantIdx: index('modifikator_gruppen_mandant_idx').on(t.mandantId),
}))

// ---------------------------------------------------------------------------
// Modifikatoren (Optionen innerhalb einer Gruppe, z. B. "Klein", "Groß")
// ---------------------------------------------------------------------------

export const modifikatoren = pgTable('modifikatoren', {
  id:             uuid('id').primaryKey().defaultRandom(),
  mandantId:      uuid('mandant_id').notNull().references(() => mandanten.id),
  gruppeId:       uuid('gruppe_id').notNull().references(() => modifikatorGruppen.id, { onDelete: 'cascade' }),
  name:           text('name').notNull(),
  /** Preisaufschlag in Cent (0 = kostenlos, negative Werte = Rabatt) */
  aufschlagCent:  integer('aufschlag_cent').notNull().default(0),
  reihenfolge:    integer('reihenfolge').notNull().default(0),
  aktiv:          boolean('aktiv').notNull().default(true),
  /** Lagerstand für diese Variante (null = kein Countdown) */
  lagerstandMenge: integer('lagerstand_menge'),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  gruppeIdx: index('modifikatoren_gruppe_idx').on(t.gruppeId),
}))

// ---------------------------------------------------------------------------
// Artikel ↔ Modifikator-Gruppen (welche Gruppen gelten für welchen Artikel)
// ---------------------------------------------------------------------------

export const artikelModifikatorGruppen = pgTable('artikel_modifikator_gruppen', {
  artikelId:   uuid('artikel_id').notNull().references(() => artikel.id, { onDelete: 'cascade' }),
  gruppeId:    uuid('gruppe_id').notNull().references(() => modifikatorGruppen.id, { onDelete: 'cascade' }),
  reihenfolge: integer('reihenfolge').notNull().default(0),
}, (t) => ({
  pk:         primaryKey({ columns: [t.artikelId, t.gruppeId] }),
  artikelIdx: index('amg_artikel_idx').on(t.artikelId),
}))

// ---------------------------------------------------------------------------
// Tischplan-Bereiche (Räume / Zonen)
// ---------------------------------------------------------------------------

export const tischplanBereiche = pgTable('tischplan_bereiche', {
  id:          uuid('id').primaryKey().defaultRandom(),
  mandantId:   uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:     uuid('kasse_id').notNull().references(() => kassen.id),
  name:        text('name').notNull(),
  reihenfolge: integer('reihenfolge').notNull().default(0),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kasseIdx: index('tischplan_bereiche_kasse_idx').on(t.kasseId),
}))

// ---------------------------------------------------------------------------
// Tischplan-Elemente (Tisch-Symbole auf der Planfläche)
// ---------------------------------------------------------------------------

export const tischplanElemente = pgTable('tischplan_elemente', {
  id:          uuid('id').primaryKey().defaultRandom(),
  mandantId:   uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:     uuid('kasse_id').notNull().references(() => kassen.id),
  bereichId:   uuid('bereich_id').notNull().references(() => tischplanBereiche.id, { onDelete: 'cascade' }),
  /** Muss tischNummer eines TischTabs entsprechen — so wird der offene Tab gefunden */
  bezeichnung: text('bezeichnung').notNull(),
  /** 'rechteck' | 'rund' */
  form:        varchar('form', { length: 20 }).notNull().default('rechteck'),
  /** Farbschlüssel (grau | rot | orange | gelb | gruen | blau | lila | pink) */
  farbe:       varchar('farbe', { length: 20 }).notNull().default('grau'),
  /** Position und Größe als Prozentsatz der Canvas-Fläche (0–100) */
  x:           real('x').notNull().default(10),
  y:           real('y').notNull().default(10),
  breite:      real('breite').notNull().default(10),
  hoehe:       real('hoehe').notNull().default(8),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bereichIdx: index('tischplan_elemente_bereich_idx').on(t.bereichId),
}))

// ---------------------------------------------------------------------------
// Type-Exports (für Service-Layer)
// ---------------------------------------------------------------------------

export type Mandant     = typeof mandanten.$inferSelect
export type NewMandant  = typeof mandanten.$inferInsert
export type Kasse       = typeof kassen.$inferSelect
export type NewKasse    = typeof kassen.$inferInsert
export type Beleg       = typeof belege.$inferSelect
export type NewBeleg    = typeof belege.$inferInsert
export type Kategorie   = typeof kategorien.$inferSelect
export type NewKategorie = typeof kategorien.$inferInsert
export type Artikel     = typeof artikel.$inferSelect
export type NewArtikel  = typeof artikel.$inferInsert
export type TischTab    = typeof tischTabs.$inferSelect
export type NewTischTab = typeof tischTabs.$inferInsert

export type Bonierdrucker    = typeof bonierdrucker.$inferSelect
export type NewBonierdrucker = typeof bonierdrucker.$inferInsert

export type TischplanBereich    = typeof tischplanBereiche.$inferSelect
export type NewTischplanBereich = typeof tischplanBereiche.$inferInsert
export type TischplanElement    = typeof tischplanElemente.$inferSelect
export type NewTischplanElement = typeof tischplanElemente.$inferInsert

export type ModifikatorGruppe    = typeof modifikatorGruppen.$inferSelect
export type NewModifikatorGruppe = typeof modifikatorGruppen.$inferInsert
export type Modifikator          = typeof modifikatoren.$inferSelect
export type NewModifikator       = typeof modifikatoren.$inferInsert

// ---------------------------------------------------------------------------
// Lieferbestellungen (Lieferando / Mergeport Webhook-Eingang)
// ---------------------------------------------------------------------------

export const lieferbestellungen = pgTable('lieferbestellungen', {
  id:               uuid('id').primaryKey().defaultRandom(),
  mandantId:        uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:          uuid('kasse_id').notNull().references(() => kassen.id, { onDelete: 'cascade' }),

  /** Externe Bestell-ID des Lieferdiensts */
  externeId:        text('externe_id').notNull(),
  /** Lieferdienst-Bezeichnung: 'lieferando' | 'mergeport' | 'custom' */
  provider:         varchar('provider', { length: 40 }).notNull(),

  /** Status: neu | bestaetigt | fertig | abgelehnt | storniert */
  status:           varchar('status', { length: 20 }).notNull().default('neu'),

  /** Bestellpositionen (normalisiert) */
  positionen:       jsonb('positionen').notNull(),
  /** Gesamtbetrag in Cent */
  gesamtbetragCent: integer('gesamtbetrag_cent').notNull(),

  // Lieferadresse / Kundendaten
  lieferName:       text('liefer_name'),
  lieferTelefon:    text('liefer_telefon'),
  lieferAdresse:    text('liefer_adresse'),
  notiz:            text('notiz'),

  /** Vollständiger Original-Payload für Debugging/Audit */
  rohDaten:         jsonb('roh_daten').notNull().default({}),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kasseIdx:    index('lieferbestellungen_kasse_idx').on(t.kasseId),
  statusIdx:   index('lieferbestellungen_status_idx').on(t.mandantId, t.status),
  externeIdx:  uniqueIndex('lieferbestellungen_externe_idx').on(t.provider, t.externeId),
}))

export type Lieferbestellung    = typeof lieferbestellungen.$inferSelect
export type NewLieferbestellung = typeof lieferbestellungen.$inferInsert

// ---------------------------------------------------------------------------
// Kassenbuch — Bar-Einlagen und -Entnahmen (nicht umsatzbezogen)
// ---------------------------------------------------------------------------

export const kassenbuchBuchungen = pgTable('kassenbuch_buchungen', {
  id:         uuid('id').primaryKey().defaultRandom(),
  kasseId:    uuid('kasse_id').notNull().references(() => kassen.id),
  typ:        varchar('typ', { length: 20 }).notNull(), // 'einlage' | 'entnahme'
  betragCent: integer('betrag_cent').notNull(),
  grund:      text('grund'),
  userId:     uuid('user_id'),
  datum:      varchar('datum', { length: 10 }).notNull(), // YYYY-MM-DD
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kasseIdx: index('kassenbuch_kasse_idx').on(t.kasseId, t.datum),
}))

export type KassenbuchBuchungRow    = typeof kassenbuchBuchungen.$inferSelect
export type NewKassenbuchBuchungRow = typeof kassenbuchBuchungen.$inferInsert

// ---------------------------------------------------------------------------
// Audit-Log — Protokoll sicherheitsrelevanter Aktionen
// ---------------------------------------------------------------------------

export const auditLogs = pgTable('audit_logs', {
  id:        uuid('id').primaryKey().$defaultFn(() => randomUUID()),
  /** Mandant — null bei Pre-Auth-Ereignissen (z. B. Login-Fehlschlag unbekannter User) */
  mandantId: uuid('mandant_id'),
  /** Benutzer — null bei fehlgeschlagenen Logins (User evtl. nicht gefunden) */
  userId:    uuid('user_id'),
  /** Strukturierter Aktions-Schlüssel, z. B. "login.erfolg" */
  aktion:    varchar('aktion', { length: 80 }).notNull(),
  /** Zusätzliche kontextabhängige Details */
  details:   jsonb('details'),
  /** IP-Adresse des Clients (IPv4 oder IPv6, max. 45 Zeichen) */
  ipAdresse: varchar('ip_adresse', { length: 45 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Komposit deckt den einzigen Reader (Filter mandantId + Sortierung createdAt
  // DESC, siehe audit.route.ts) ohne separaten Sort-Schritt ab und ersetzt die
  // beiden vormaligen Einzel-Indizes (mandantId allein = Präfix; createdAt
  // allein hatte keinen Reader). Weniger Index-Pflege bei jedem Audit-Insert.
  mandantCreatedIdx: index('audit_logs_mandant_created_idx').on(t.mandantId, t.createdAt),
}))

export type AuditLog    = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert

// ---------------------------------------------------------------------------
// DEP-Sicherungen — Protokoll automatischer und manueller Archiv-Exporte
// ---------------------------------------------------------------------------

export const depSicherungen = pgTable('dep_sicherungen', {
  id:            uuid('id').primaryKey().defaultRandom(),
  mandantId:     uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:       uuid('kasse_id').notNull().references(() => kassen.id),
  erstelltAm:   timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow(),
  /** 'dep7' | 'dep131' */
  format:        varchar('format', { length: 10 }).notNull(),
  anzahlBelege:  integer('anzahl_belege').notNull(),
  dateipfad:     text('dateipfad').notNull(),
  dateiname:     text('dateiname').notNull(),
  /** true = Cron, false = manuell ausgelöst */
  automatisch:   boolean('automatisch').notNull().default(false),
}, (t) => ({
  kasseIdx: index('dep_sicherungen_kasse_idx').on(t.kasseId, t.erstelltAm),
}))

export type DepSicherung    = typeof depSicherungen.$inferSelect
export type NewDepSicherung = typeof depSicherungen.$inferInsert

// ---------------------------------------------------------------------------
// Prüfungs-Tokens — zeitlich begrenzte Read-only-Links für Finanzprüfer
// ---------------------------------------------------------------------------

export const pruefungsTokens = pgTable('pruefungs_tokens', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  mandantId:          uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:            uuid('kasse_id').notNull().references(() => kassen.id),
  /** 32 zufällige Bytes als Hex-String (64 Zeichen) */
  token:              varchar('token', { length: 64 }).notNull(),
  erstelltAm:        timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow(),
  gueltigBis:         timestamp('gueltig_bis', { withTimezone: true }).notNull(),
  erstelltVonUserId:  uuid('erstellt_von_user_id').references(() => users.id, { onDelete: 'set null' }),
  beschreibung:       text('beschreibung'),
  widerrufen:         boolean('widerrufen').notNull().default(false),
  letzteVerwendung:   timestamp('letzte_verwendung', { withTimezone: true }),
}, (t) => ({
  tokenIdx: uniqueIndex('pruefungs_tokens_token_idx').on(t.token),
  kasseIdx: index('pruefungs_tokens_kasse_idx').on(t.kasseId),
}))

export type PruefungsToken    = typeof pruefungsTokens.$inferSelect
export type NewPruefungsToken = typeof pruefungsTokens.$inferInsert

// ---------------------------------------------------------------------------
// Lieferanten — Stammdaten für Einkauf + Bestellliste
// ---------------------------------------------------------------------------

export const lieferanten = pgTable('lieferanten', {
  id:          uuid('id').primaryKey().defaultRandom(),
  mandantId:   uuid('mandant_id').notNull().references(() => mandanten.id),
  name:        text('name').notNull(),
  kontakt:     text('kontakt'),
  email:       varchar('email', { length: 200 }),
  telefon:     varchar('telefon', { length: 50 }),
  notiz:       text('notiz'),
  aktiv:       boolean('aktiv').notNull().default(true),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantIdx: index('lieferanten_mandant_idx').on(t.mandantId),
}))

export type Lieferant    = typeof lieferanten.$inferSelect
export type NewLieferant = typeof lieferanten.$inferInsert

// ---------------------------------------------------------------------------
// KDS-Bons — aktive Bonierbons für Browser-basiertes Küchen-Display
// ---------------------------------------------------------------------------

export const kdsBons = pgTable('kds_bons', {
  id:         uuid('id').primaryKey().defaultRandom(),
  mandantId:  uuid('mandant_id').notNull().references(() => mandanten.id, { onDelete: 'cascade' }),
  bonNummer:  varchar('bon_nummer', { length: 20 }).notNull(),
  station:    varchar('station', { length: 20 }).notNull(),
  tisch:      varchar('tisch', { length: 40 }).notNull(),
  bereich:    varchar('bereich', { length: 60 }),
  kellner:    varchar('kellner', { length: 60 }).notNull(),
  /** [{id, bezeichnung, menge, details?, erledigt}] */
  positionen: jsonb('positionen').notNull().$type<KdsPosition[]>(),
  /** 'offen' | 'erledigt' */
  status:     varchar('status', { length: 20 }).notNull().default('offen'),
  erstelltAt: timestamp('erstellt_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantStationIdx: index('kds_bons_mandant_station_idx').on(t.mandantId, t.station, t.status),
}))

export interface KdsPosition {
  id:             string
  bezeichnung:    string
  menge:          number
  erledigtMenge?: number
  details?:       string
  erledigt:       boolean
}

export type KdsBon    = typeof kdsBons.$inferSelect
export type NewKdsBon = typeof kdsBons.$inferInsert

// ---------------------------------------------------------------------------
// Druck-Log — Protokoll aller Druckversuche (Bon, Bonierbon, Test)
// ---------------------------------------------------------------------------

export const druckLog = pgTable('druck_log', {
  id:          uuid('id').primaryKey().defaultRandom(),
  mandantId:   uuid('mandant_id').notNull().references(() => mandanten.id, { onDelete: 'cascade' }),
  kasseId:     uuid('kasse_id').references(() => kassen.id, { onDelete: 'set null' }),
  druckerIp:   varchar('drucker_ip', { length: 64 }).notNull(),
  /** 'bon' | 'bonierbon' | 'test' */
  druckerTyp:  varchar('drucker_typ', { length: 20 }).notNull(),
  belegId:     uuid('beleg_id'),
  erfolg:      boolean('erfolg').notNull(),
  fehlerText:  text('fehler_text'),
  erstelltAt:  timestamp('erstellt_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantIdx: index('druck_log_mandant_idx').on(t.mandantId, t.erstelltAt),
  kasseIdx:   index('druck_log_kasse_idx').on(t.kasseId,   t.erstelltAt),
}))

export type DruckLogEintrag    = typeof druckLog.$inferSelect
export type NewDruckLogEintrag = typeof druckLog.$inferInsert

// ---------------------------------------------------------------------------
// DB-Sicherungen — PostgreSQL-Dump-Protokoll
// ---------------------------------------------------------------------------

export const dbSicherungen = pgTable('db_sicherungen', {
  id:           uuid('id').primaryKey().defaultRandom(),
  erstelltAm:   timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow(),
  dateiname:    text('dateiname').notNull(),
  dateipfad:    text('dateipfad').notNull(),
  dateigroesse: bigint('dateigroesse', { mode: 'number' }).notNull().default(0),
  automatisch:  boolean('automatisch').notNull().default(false),
  erfolgreich:  boolean('erfolgreich').notNull().default(true),
  fehler:       text('fehler'),
}, (t) => ({
  erstelltIdx: index('db_sicherungen_erstellt_idx').on(t.erstelltAm),
}))

export type DbSicherung    = typeof dbSicherungen.$inferSelect
export type NewDbSicherung = typeof dbSicherungen.$inferInsert

// ---------------------------------------------------------------------------
// Tischreservierungen
// ---------------------------------------------------------------------------

export const reservierungen = pgTable('reservierungen', {
  id:             uuid('id').primaryKey().defaultRandom(),
  mandantId:      uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:        uuid('kasse_id').notNull().references(() => kassen.id, { onDelete: 'cascade' }),

  datum:          varchar('datum', { length: 10 }).notNull(),  // YYYY-MM-DD
  zeitVon:        varchar('zeit_von', { length: 5 }).notNull(), // HH:MM
  dauer:          integer('dauer').notNull().default(90),       // Minuten

  personenAnzahl: integer('personen_anzahl').notNull(),
  name:           text('name').notNull(),
  telefon:        text('telefon'),
  email:          text('email'),
  notiz:          text('notiz'),
  tischLabel:     text('tisch_label'),

  /** wartend | bestaetigt | erschienen | nicht_erschienen | storniert */
  status:         varchar('status', { length: 20 }).notNull().default('bestaetigt'),
  /** intern | online */
  quelle:         varchar('quelle', { length: 10 }).notNull().default('intern'),
  onlineToken:    uuid('online_token').notNull().$defaultFn(() => randomUUID()),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantDatumIdx: index('reservierungen_mandant_datum_idx').on(t.mandantId, t.datum),
  kasseDatumIdx:   index('reservierungen_kasse_datum_idx').on(t.kasseId, t.datum),
  onlineTokenIdx:  uniqueIndex('reservierungen_online_token_idx').on(t.onlineToken),
}))

export type Reservierung    = typeof reservierungen.$inferSelect
export type NewReservierung = typeof reservierungen.$inferInsert

// ---------------------------------------------------------------------------
// Personalzeiterfassung — Arbeitszeiten (Schichten)
// ---------------------------------------------------------------------------

export const arbeitszeiten = pgTable('arbeitszeiten', {
  id:           uuid('id').primaryKey().defaultRandom(),
  mandantId:    uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:      uuid('kasse_id').notNull().references(() => kassen.id, { onDelete: 'cascade' }),
  userId:       uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Denormalisiert für Anzeige/Export, auch wenn User gelöscht wird */
  userName:     text('user_name').notNull(),

  beginn:       timestamp('beginn', { withTimezone: true }).notNull(),
  ende:         timestamp('ende',   { withTimezone: true }),
  pauseMinuten: integer('pause_minuten').notNull().default(0),

  notiz:        text('notiz'),
  /** pin = Stempel via PIN-Terminal; admin = manueller Eintrag */
  quelle:       varchar('quelle', { length: 10 }).notNull().default('pin'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantUserIdx: index('arbeitszeiten_mandant_user_idx').on(t.mandantId, t.userId),
  mandantBeginnIdx: index('arbeitszeiten_mandant_beginn_idx').on(t.mandantId, t.beginn),
  offenesIdx: index('arbeitszeiten_offenes_idx').on(t.mandantId, t.userId, t.ende),
}))

export type Arbeitszeit    = typeof arbeitszeiten.$inferSelect
export type NewArbeitszeit = typeof arbeitszeiten.$inferInsert

// ---------------------------------------------------------------------------
// Werbefolien — Slideshow-Inhalte für Kundendisplay im Leerlauf (Feature 6)
// ---------------------------------------------------------------------------

export const werbefolien = pgTable('werbefolien', {
  id:               uuid('id').primaryKey().defaultRandom(),
  mandantId:        uuid('mandant_id').notNull().references(() => mandanten.id),
  titel:            text('titel').notNull().default(''),
  bildBase64:       text('bild_base64').notNull(),
  mimeType:         varchar('mime_type', { length: 50 }).notNull().default('image/jpeg'),
  reihenfolge:      integer('reihenfolge').notNull().default(0),
  aktiv:            boolean('aktiv').notNull().default(true),
  anzeigedauerSek:  integer('anzeigedauer_sek').notNull().default(8),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantReihenfolgeIdx: index('werbefolien_mandant_idx').on(t.mandantId, t.reihenfolge),
}))

export type Werbefolie    = typeof werbefolien.$inferSelect
export type NewWerbefolie = typeof werbefolien.$inferInsert

// ---------------------------------------------------------------------------
// Dienstplan-Schichten (Feature 3)
// ---------------------------------------------------------------------------

export const dienstplanSchichten = pgTable('dienstplan_schichten', {
  id:             uuid('id').primaryKey().defaultRandom(),
  mandantId:      uuid('mandant_id').notNull().references(() => mandanten.id),
  kasseId:        uuid('kasse_id').notNull().references(() => kassen.id, { onDelete: 'cascade' }),
  userId:         uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  userName:       text('user_name').notNull(),
  datum:          varchar('datum', { length: 10 }).notNull(),  // YYYY-MM-DD
  beginnGeplant:  varchar('beginn_geplant', { length: 5 }).notNull(), // HH:MM
  endeGeplant:    varchar('ende_geplant',   { length: 5 }).notNull(), // HH:MM
  position:       text('position'),
  notiz:          text('notiz'),
  /** geplant | bestaetigt | krank | abwesend */
  status:         varchar('status', { length: 20 }).notNull().default('geplant'),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantDatumIdx: index('dienstplan_mandant_datum_idx').on(t.mandantId, t.datum),
  kasseDatumIdx:   index('dienstplan_kasse_datum_idx').on(t.kasseId,   t.datum),
}))

export type DienstplanSchicht    = typeof dienstplanSchichten.$inferSelect
export type NewDienstplanSchicht = typeof dienstplanSchichten.$inferInsert
