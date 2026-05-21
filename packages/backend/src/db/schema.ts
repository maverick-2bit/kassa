/**
 * Drizzle ORM Schema – PostgreSQL
 *
 * Multi-Tenant-fähig: Jede relevante Tabelle hat mandant_id.
 * RKSV-konform: Belege sind unveränderlich (kein UPDATE, kein DELETE).
 * Lückenlose Belegnummern werden auf Service-Ebene durchgesetzt.
 */

import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  bigint,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
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
  umsatzzaehlerCent:     bigint('umsatzzaehler_cent', { mode: 'bigint' }).notNull().default(0n),
  letzteBelegNummer:     integer('letzte_beleg_nummer').notNull().default(0),
  letzterSignaturwert:   text('letzter_signaturwert'),

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

  // KDS-Konfiguration (Küchen-Display-System)
  /** Mapping Stations-Slug → IP-Adresse, z. B. { kueche: "192.168.192.210" } */
  kdsStationen:          jsonb('kds_stationen').notNull().default({}),
  kdsPort:               integer('kds_port').notNull().default(9100),
  kdsAktiv:              boolean('kds_aktiv').notNull().default(false),

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

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  belegNrIdx: uniqueIndex('belege_kasse_belegnr_idx').on(t.kasseId, t.belegNummer),
  datumIdx:   index('belege_datum_idx').on(t.belegDatum),
}))

// ---------------------------------------------------------------------------
// Benutzer (Auth) — pro Mandant
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  mandantId:    uuid('mandant_id').notNull().references(() => mandanten.id),
  email:        varchar('email', { length: 200 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  name:         text('name').notNull(),
  /** admin | kellner — erweiterbar */
  rolle:        varchar('rolle', { length: 20 }).notNull().default('kellner'),
  aktiv:        boolean('aktiv').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex('users_email_idx').on(t.email),
}))

export type User    = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

// ---------------------------------------------------------------------------
// Artikel (Produkte) – für späteren Bestellprozess
// ---------------------------------------------------------------------------

export const artikel = pgTable('artikel', {
  id:                uuid('id').primaryKey().defaultRandom(),
  mandantId:         uuid('mandant_id').notNull().references(() => mandanten.id),
  bezeichnung:       text('bezeichnung').notNull(),
  preisBruttoCent:   integer('preis_brutto_cent').notNull(),
  mwstSatz:          varchar('mwst_satz', { length: 20 }).notNull(),
  artikelnummer:     varchar('artikelnummer', { length: 40 }),
  /** KDS-Station für Bonierbon-Routing (null = nicht bonieren, z.B. Pfand) */
  station:           varchar('station', { length: 20 }),
  aktiv:             boolean('aktiv').notNull().default(true),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  mandantNummerIdx: uniqueIndex('artikel_mandant_nummer_idx').on(t.mandantId, t.artikelnummer),
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
export type Artikel     = typeof artikel.$inferSelect
export type NewArtikel  = typeof artikel.$inferInsert
