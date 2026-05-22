/**
 * @kassa/shared – Geteilte Typen und Zod-Schemas
 *
 * Wird von Backend (Validierung der API-Eingaben) und Frontend (Formular-Validierung)
 * gemeinsam verwendet. Single source of truth.
 */

// Auth
export {
  LoginInputSchema,
  PinLoginInputSchema,
  LoginResponseSchema,
  UserSchema,
  UserCreateInputSchema,
  UserUpdateInputSchema,
  RolleSchema,
  ROLLE_LABELS,
  BerechtigungSchema,
  ALLE_BERECHTIGUNGEN,
  BERECHTIGUNG_LABELS,
  AdminUserInputSchema,
} from './schemas/auth.js'
export type {
  LoginInput,
  PinLoginInput,
  LoginResponse,
  User,
  Rolle,
  Berechtigung,
  UserCreateInput,
  UserUpdateInput,
  AdminUserInput,
} from './schemas/auth.js'

// Setup
export {
  SetupInputSchema,
  SetupResponseSchema,
  EinrichtungsSchrittSchema,
  FinanzOnlineCredentialsSchema,
} from './schemas/setup.js'

export type {
  SetupInput,
  SetupResponse,
  EinrichtungsSchrittDto,
  FinanzOnlineCredentialsInput,
} from './schemas/setup.js'

// Artikel
export {
  ArtikelSchema,
  ArtikelInputSchema,
  ArtikelUpdateSchema,
  MwStSatzSchema,
  MWST_LABELS,
} from './schemas/artikel.js'
export type {
  Artikel,
  ArtikelInput,
  ArtikelUpdate,
  MwStSatz,
} from './schemas/artikel.js'

// Stationen + Bonierung
export {
  StationSchema,
  STATION_LABELS,
  ALLE_STATIONEN,
} from './schemas/station.js'
export type { Station } from './schemas/station.js'

export {
  BonierungInputSchema,
  BonierungErgebnisSchema,
  BonierungPositionSchema,
} from './schemas/bonierung.js'
export type {
  BonierungInput,
  BonierungErgebnis,
} from './schemas/bonierung.js'

// ZVT-Kartenterminal
export {
  ZvtConfigSchema,
  ZvtConfigUpdateSchema,
  ZvtJobStatusSchema,
  ZvtErgebnisSchema,
  ZvtJobSchema,
  ZvtZahlungInputSchema,
} from './schemas/zvt.js'
export type {
  ZvtConfig,
  ZvtConfigUpdate,
  ZvtJobStatus,
  ZvtErgebnis,
  ZvtJob,
  ZvtZahlungInput,
} from './schemas/zvt.js'

// Tisch-Tab
export {
  TabPositionSchema,
  TischTabErstellenInputSchema,
  TischTabPositionenUpdateSchema,
  TischTabBezahlenInputSchema,
  TischTabResponseSchema,
} from './schemas/tisch-tab.js'
export type {
  TabPosition,
  TischTabErstellenInput,
  TischTabPositionenUpdate,
  TischTabBezahlenInput,
  TischTabResponse,
} from './schemas/tisch-tab.js'

// Bericht
export {
  BerichtFilterSchema,
  BerichtGruppierungSchema,
  BerichtZeileSchema,
  BerichtGesamtSchema,
  BerichtResponseSchema,
} from './schemas/bericht.js'
export type {
  BerichtFilter,
  BerichtGruppierung,
  BerichtZeile,
  BerichtGesamt,
  BerichtResponse,
} from './schemas/bericht.js'

// Tagesabschluss
export {
  TagesabschlussSchema,
  TagesabschlussQuerySchema,
  MwStZeileSchema,
} from './schemas/tagesabschluss.js'
export type {
  Tagesabschluss,
  TagesabschlussQuery,
  MwStZeile,
} from './schemas/tagesabschluss.js'

// Beleg
export {
  BarzahlungsbelegInputSchema,
  StornobelegInputSchema,
  NullbelegInputSchema,
  MonatsbelegInputSchema,
  JahresbelegInputSchema,
  BelegResponseSchema,
  BelegPositionSchema,
} from './schemas/beleg.js'
export type {
  BarzahlungsbelegInput,
  StornobelegInput,
  NullbelegInput,
  MonatsbelegInput,
  JahresbelegInput,
  BelegResponse,
  BelegPositionDto,
} from './schemas/beleg.js'
