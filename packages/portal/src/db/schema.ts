/**
 * Datenbankschema des Serviceportals.
 *
 * Bewusst ohne Array- und Enum-Typen (wie beim Backend): postgres.js muss so keine Typ-OIDs abfragen.
 * Listen stehen als jsonb.
 */

import { sql } from 'drizzle-orm'
import {
  bigint, boolean, index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core'
import type { PortalMeldung } from '@kassa/shared'

// ---------------------------------------------------------------------------
// Benutzer des Portals (Betreiber). Anmeldung mit Passwort UND Authenticator-App (TOTP).
// ---------------------------------------------------------------------------

export const portalBenutzer = pgTable('portal_benutzer', {
  id:           uuid('id').primaryKey().defaultRandom(),
  /** Kleingeschrieben gespeichert */
  email:        varchar('email', { length: 200 }).notNull(),
  passwortHash: varchar('passwort_hash', { length: 100 }).notNull(),
  /** AES-256-GCM-verschlüsseltes Base32-Geheimnis (siehe auth/verschluesselung.ts); null = noch keins */
  totpGeheimnis: varchar('totp_geheimnis', { length: 300 }),
  /** true erst, wenn der Benutzer einen Code aus der App bestätigt hat */
  totpAktiv:    boolean('totp_aktiv').notNull().default(false),
  /** Letzter benutzter 30-Sekunden-Schritt — derselbe Code gilt kein zweites Mal (Wiedereinspielung) */
  totpLetzterSchritt: bigint('totp_letzter_schritt', { mode: 'number' }),
  aktiv:        boolean('aktiv').notNull().default(true),
  fehlversuche: integer('fehlversuche').notNull().default(0),
  gesperrtBis:  timestamp('gesperrt_bis', { withTimezone: true }),
  letzterLogin: timestamp('letzter_login', { withTimezone: true }),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex('portal_benutzer_email_idx').on(t.email),
}))

// ---------------------------------------------------------------------------
// Betriebe (Kunden) und ihre Boxen (eine Kassa-Installation beim Kunden)
// ---------------------------------------------------------------------------

export const portalBetriebe = pgTable('portal_betriebe', {
  id:        uuid('id').primaryKey().defaultRandom(),
  name:      varchar('name', { length: 200 }).notNull(),
  notiz:     varchar('notiz', { length: 2000 }),
  aktiv:     boolean('aktiv').notNull().default(true),
  /** Gebuchte Module (Vermerk), Liste von Modulnamen */
  module:    jsonb('module').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nameIdx: uniqueIndex('portal_betriebe_name_idx').on(t.name),
}))

export const portalBoxen = pgTable('portal_boxen', {
  id:         uuid('id').primaryKey().defaultRandom(),
  betriebId:  uuid('betrieb_id').notNull().references(() => portalBetriebe.id, { onDelete: 'cascade' }),
  name:       varchar('name', { length: 100 }).notNull(),
  /** SHA-256 des Tokens (hex). Das Token selbst speichert das Portal nie. */
  tokenHash:  varchar('token_hash', { length: 64 }).notNull(),
  /** Letzte vier Zeichen des Tokens — nur zum Wiedererkennen */
  tokenHinweis: varchar('token_hinweis', { length: 8 }).notNull(),
  aktiv:      boolean('aktiv').notNull().default(true),
  tokenErneuertAm: timestamp('token_erneuert_am', { withTimezone: true }),
  // Stand der letzten Meldung
  zuletztGesehen: timestamp('zuletzt_gesehen', { withTimezone: true }),
  version:    varchar('version', { length: 40 }),
  /** Letzte vollständige Meldung (vom Portal beim Empfang gegen das Schema geprüft) */
  meldung:    jsonb('meldung').$type<PortalMeldung>(),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenIdx:   uniqueIndex('portal_boxen_token_idx').on(t.tokenHash),
  betriebIdx: index('portal_boxen_betrieb_idx').on(t.betriebId),
}))

// ---------------------------------------------------------------------------
// Fehlerberichte der Boxen, je Box und Fehlergruppe zusammengezählt
// ---------------------------------------------------------------------------

export const portalFehler = pgTable('portal_fehler', {
  id:        uuid('id').primaryKey().defaultRandom(),
  boxId:     uuid('box_id').notNull().references(() => portalBoxen.id, { onDelete: 'cascade' }),
  hash:      varchar('hash', { length: 40 }).notNull(),
  name:      varchar('name', { length: 100 }).notNull(),
  meldung:   varchar('meldung', { length: 300 }).notNull(),
  route:     varchar('route', { length: 200 }),
  anzahl:    integer('anzahl').notNull(),
  ersterAm:  timestamp('erster_am', { withTimezone: true }).notNull(),
  letzterAm: timestamp('letzter_am', { withTimezone: true }).notNull(),
}, (t) => ({
  eindeutigIdx: uniqueIndex('portal_fehler_box_hash_idx').on(t.boxId, t.hash),
  letzterIdx:   index('portal_fehler_letzter_idx').on(t.boxId, t.letzterAm),
}))
