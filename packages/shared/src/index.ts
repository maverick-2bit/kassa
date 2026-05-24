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

// Modifikatoren
export {
  ModifikatorSchema,
  ModifikatorGruppeSchema,
  ModifikatorGruppeTypSchema,
  ModifikatorGruppeErstellenSchema,
  ModifikatorGruppeAktualisierenSchema,
  ModifikatorErstellenSchema,
  ModifikatorAktualisierenSchema,
  ModifikatorAuswahlSchema,
  ArtikelGruppenZuweisungSchema,
} from './schemas/modifikator.js'
export type {
  Modifikator,
  ModifikatorGruppe,
  ModifikatorGruppeTyp,
  ModifikatorGruppeErstellen,
  ModifikatorGruppeAktualisieren,
  ModifikatorErstellen,
  ModifikatorAktualisieren,
  ModifikatorAuswahl,
  ArtikelGruppenZuweisung,
} from './schemas/modifikator.js'

// Kategorie
export {
  KategorieSchema,
  KategorieInputSchema,
  KategorieUpdateSchema,
  KategorieFarbeSchema,
  KATEGORIE_FARBE_LABELS,
} from './schemas/kategorie.js'
export type {
  Kategorie,
  KategorieInput,
  KategorieUpdate,
  KategorieFarbe,
} from './schemas/kategorie.js'

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
  TabEreignisSchema,
  TischTabErstellenInputSchema,
  TischTabPositionenUpdateSchema,
  TischTabUmbuchenInputSchema,
  TischTabUmbenennenInputSchema,
  TischTabSplittenInputSchema,
  TischTabBezahlenInputSchema,
  TischTabResponseSchema,
} from './schemas/tisch-tab.js'
export type {
  TabPosition,
  TabEreignis,
  TischTabErstellenInput,
  TischTabPositionenUpdate,
  TischTabUmbuchenInput,
  TischTabUmbenennenInput,
  TischTabSplittenInput,
  TischTabBezahlenInput,
  TischTabResponse,
} from './schemas/tisch-tab.js'

// Bonierdrucker + POS-Konfiguration
export {
  BonierdruckerSchema,
  BonierdruckerInputSchema,
  BonierdruckerUpdateSchema,
  PosKonfigSchema,
  PosKonfigUpdateSchema,
  ReihenfolgeUpdateSchema,
  FavoritenReihenfolgeUpdateSchema,
} from './schemas/bonierdrucker.js'
export type {
  Bonierdrucker,
  BonierdruckerInput,
  BonierdruckerUpdate,
  PosKonfig,
  PosKonfigUpdate,
  ReihenfolgeUpdate,
  FavoritenReihenfolgeUpdate,
} from './schemas/bonierdrucker.js'

// Lagerstand (Wareneingang / Inventur)
export {
  LagerstandEintragSchema,
  LagerstandBulkInputSchema,
} from './schemas/lagerstand.js'
export type {
  LagerstandEintrag,
  LagerstandBulkInput,
} from './schemas/lagerstand.js'

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

// Tischplan
export {
  TischplanFormSchema,
  TischplanFarbeSchema,
  TischplanElementSchema,
  TischplanElementErstellenSchema,
  TischplanElementAktualisierenSchema,
  TischplanBereichSchema,
  TischplanBereichErstellenSchema,
  TischplanBereichAktualisierenSchema,
  TISCHPLAN_FORM_LABELS,
  TISCHPLAN_FARBE_LABELS,
} from './schemas/tischplan.js'
export type {
  TischplanForm,
  TischplanFarbe,
  TischplanElement,
  TischplanElementErstellen,
  TischplanElementAktualisieren,
  TischplanBereich,
  TischplanBereichErstellen,
  TischplanBereichAktualisieren,
} from './schemas/tischplan.js'

// SSE-Events
export {
  BonierbonEventSchema,
  KasseEventSchema,
} from './schemas/events.js'
export type {
  BonierbonEvent,
  KasseEvent,
} from './schemas/events.js'

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
