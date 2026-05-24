/**
 * Drizzle ORM Schema – PostgreSQL
 *
 * Multi-Tenant-fähig: Jede relevante Tabelle hat mandant_id.
 * RKSV-konform: Belege sind unveränderlich (kein UPDATE, kein DELETE).
 * Lückenlose Belegnummern werden auf Service-Ebene durchgesetzt.
 */

import { sql } from 'drizzle-orm'
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

  // POS-Konfiguration (Zahlungsarten)
  /** Erlaubte Zahlungsarten: ["bar", "karte", "sonstige"] — Subset davon pro Kasse */
  erlaubteZahlungsarten: jsonb('erlaubte_zahlungsarten').notNull().default(['bar', 'karte', 'sonstige']),

  // ZVT-Kartenterminal-Konfiguration (Hobex/Payroc & kompatible über Standard-ZVT-Protokoll)
  zvtIp:                 varchar('zvt_ip',   { length: 64 }),
  zvtPort:               integer('zvt_port').notNull().default(20007),
  /** Optionales Terminal-Passwort (manche Geräte verlangen es bei Authorization) */
  zvtPasswort:           varchar('zvt_passwort', { length: 16 }),
  zvtAktiv:              boolean('zvt_aktiv').notNull().default(false),

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

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  belegNrIdx:     uniqueIndex('belege_kasse_belegnr_idx').on(t.kasseId, t.belegNummer),
  datumIdx:       index('belege_datum_idx').on(t.belegDatum),
  verweisIdx:     index('belege_verweis_idx').on(t.verweisBelegId),
}))

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
  /** Erscheint im Favoriten-Tab der POS-Ansicht */
  istFavorit:          boolean('ist_favorit').notNull().default(false),
  /** Sortierung innerhalb der Kategorie (global, für alle Kassen gleich) */
  reihenfolge:         integer('reihenfolge').notNull().default(0),
  /** Sortierung im Favoriten-Tab (global) */
  favoritenReihenfolge: integer('favoriten_reihenfolge').notNull().default(0),
  /** Override: Bonierdrucker für diesen Artikel (überschreibt Kategorie-Einstellung) */
  bonierdruckerId:     uuid('bonierdrucker_id').references(() => bonierdrucker.id, { onDelete: 'set null' }),
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
