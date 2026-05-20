/**
 * @kassa/shared – Geteilte Typen und Zod-Schemas
 *
 * Wird von Backend (Validierung der API-Eingaben) und Frontend (Formular-Validierung)
 * gemeinsam verwendet. Single source of truth.
 */

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
