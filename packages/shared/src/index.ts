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

// Beleg
export {
  BarzahlungsbelegInputSchema,
  BelegResponseSchema,
  BelegPositionSchema,
} from './schemas/beleg.js'
export type {
  BarzahlungsbelegInput,
  BelegResponse,
  BelegPositionDto,
} from './schemas/beleg.js'
