/**
 * @kassa/shared – Geteilte Typen und Zod-Schemas
 *
 * Wird von Backend (Validierung der API-Eingaben) und Frontend (Formular-Validierung)
 * gemeinsam verwendet. Single source of truth.
 */

// Lieferanten
export {
  LieferantSchema,
  LieferantInputSchema,
  LieferantUpdateSchema,
} from './schemas/lieferant.js'
export type {
  Lieferant,
  LieferantInput,
  LieferantUpdate,
} from './schemas/lieferant.js'

// Mandanten-Module + Stammdaten
export {
  MandantModulSchema,
  MANDANT_MODUL_LABELS,
  MANDANT_MODUL_BESCHREIBUNGEN,
  MandantModuleSchema,
  MandantModuleUpdateSchema,
  MandantStammdatenSchema,
  MandantStammdatenUpdateSchema,
  KasseBezeichnungUpdateSchema,
} from './schemas/mandant.js'
export type {
  MandantModul,
  MandantModule,
  MandantModuleUpdate,
  MandantStammdaten,
  MandantStammdatenUpdate,
  KasseBezeichnungUpdate,
} from './schemas/mandant.js'

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
  SetupModuleSchema,
  SetupInputSchema,
  SetupResponseSchema,
  EinrichtungsSchrittSchema,
  FinanzOnlineCredentialsSchema,
  WeitereKasseInputSchema,
  WeitereKasseResponseSchema,
  KasseListeItemSchema,
} from './schemas/setup.js'

export type {
  SetupModule,
  SetupInput,
  SetupResponse,
  EinrichtungsSchrittDto,
  FinanzOnlineCredentialsInput,
  WeitereKasseInput,
  WeitereKasseResponse,
  KasseListeItem,
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
  TischTabZusammenfuehrenInputSchema,
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
  TischTabZusammenfuehrenInput,
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
  StartseitenEnum,
  ReihenfolgeUpdateSchema,
  FavoritenReihenfolgeUpdateSchema,
} from './schemas/bonierdrucker.js'
export type {
  Bonierdrucker,
  BonierdruckerInput,
  BonierdruckerUpdate,
  PosKonfig,
  PosKonfigUpdate,
  Startseite,
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
  ArtikelBerichtFilterSchema,
  ArtikelBerichtZeileSchema,
  ArtikelBerichtResponseSchema,
  WarengruppeBerichtFilterSchema,
  WarengruppeBerichtZeileSchema,
  WarengruppeBerichtResponseSchema,
  StundenBerichtFilterSchema,
  StundenBerichtZeileSchema,
  StundenBerichtResponseSchema,
  KellnerBerichtFilterSchema,
  KellnerBerichtZeileSchema,
  KellnerBerichtResponseSchema,
  BuchungsjournalFilterSchema,
  KassenVergleichFilterSchema,
  KassenVergleichZeileSchema,
  KassenVergleichResponseSchema,
} from './schemas/bericht.js'
export type {
  BerichtFilter,
  BerichtGruppierung,
  BerichtZeile,
  BerichtGesamt,
  BerichtResponse,
  ArtikelBerichtFilter,
  ArtikelBerichtZeile,
  ArtikelBerichtResponse,
  WarengruppeBerichtZeile,
  WarengruppeBerichtResponse,
  StundenBerichtFilter,
  StundenBerichtZeile,
  StundenBerichtResponse,
  KellnerBerichtFilter,
  KellnerBerichtZeile,
  KellnerBerichtResponse,
  BuchungsjournalFilter,
  KassenVergleichFilter,
  KassenVergleichZeile,
  KassenVergleichResponse,
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
  NeueBestellungEventSchema,
  LagerstandWarnungEventSchema,
  KdsNachrichtEventSchema,
  GastBestellungEventSchema,
  NeueReservierungEventSchema,
  ZahlungAngefordertEventSchema,
  SbBestellungEventSchema,
  KasseEventSchema,
} from './schemas/events.js'
export type {
  BonierbonEvent,
  NeueBestellungEvent,
  LagerstandWarnungEvent,
  KdsNachrichtEvent,
  GastBestellungEvent,
  NeueReservierungEvent,
  ZahlungAngefordertEvent,
  SbBestellungEvent,
  KasseEvent,
} from './schemas/events.js'

// SB-Terminal (Kiosk + Abholmonitor)
export {
  SbBestellungStatusSchema,
  SB_STATUS_LABELS,
  SbPositionSchema,
  SbBestellungSchema,
  formatSbNummer,
  TerminalBestellungInputSchema,
  TerminalArtikelSchema,
  TerminalSortimentSchema,
  TerminalBestellungStatusSchema,
  AbholungEintragSchema,
  AbholungEventSchema,
} from './schemas/sb-terminal.js'
export type {
  SbBestellungStatus,
  SbPosition,
  SbBestellung,
  TerminalBestellungInput,
  TerminalArtikel,
  TerminalSortiment,
  TerminalBestellungStatus,
  AbholungEintrag,
  AbholungEvent,
} from './schemas/sb-terminal.js'

// Kunde (CRM)
export {
  KundeInputSchema,
  KundeUpdateSchema,
  KundeSchema,
  KundeSnapshotSchema,
  KundeBelegVorschauSchema,
  KundeSuchfilterSchema,
  kundeBezeichnung,
} from './schemas/kunde.js'
export type {
  KundeInput,
  KundeUpdate,
  Kunde,
  KundeSnapshot,
  KundeBelegVorschau,
  KundeSuchfilter,
} from './schemas/kunde.js'

// Lieferschein + Sammelrechnung
export {
  LiferscheinStatusSchema,
  LIEFERSCHEIN_STATUS_LABELS,
  LiferscheinInputSchema,
  LiferscheinUpdateSchema,
  LiferscheinResponseSchema,
  SerialZuweisungSchema,
  SammelrechnungInputSchema,
  SammelrechnungResponseSchema,
} from './schemas/lieferschein.js'
export type {
  LiferscheinStatus,
  LiferscheinInput,
  LiferscheinUpdate,
  LiferscheinResponse,
  SerialZuweisung,
  SammelrechnungInput,
  SammelrechnungResponse,
} from './schemas/lieferschein.js'

// Gutscheine
export {
  GutscheinStatusSchema,
  GUTSCHEIN_STATUS_LABELS,
  GutscheinBuchungTypSchema,
  GUTSCHEIN_BUCHUNG_TYP_LABELS,
  GutscheinInputSchema,
  GutscheinEinloesenSchema,
  GutscheinResponseSchema,
  GutscheinBuchungResponseSchema,
  GutscheinEinloesungResultSchema,
} from './schemas/gutschein.js'
export type {
  GutscheinStatus,
  GutscheinBuchungTyp,
  GutscheinInput,
  GutscheinEinloesen,
  GutscheinResponse,
  GutscheinBuchungResponse,
  GutscheinEinloesungResult,
} from './schemas/gutschein.js'

// Offene Posten (Kreditverkauf)
export {
  OffenerPostenStatusSchema,
  OFFENER_POSTEN_STATUS_LABELS,
  OffenerPostenInputSchema,
  OffenerPostenZahlungSchema,
  OffenerPostenResponseSchema,
} from './schemas/offenerPosten.js'
export type {
  OffenerPostenStatus,
  OffenerPostenInput,
  OffenerPostenZahlung,
  OffenerPostenResponse,
} from './schemas/offenerPosten.js'

// Angebot
export {
  AngebotPositionSchema,
  AngebotInputSchema,
  AngebotStatusSchema,
  AngebotUpdateSchema,
  AngebotResponseSchema,
  ANGEBOT_STATUS_LABELS,
} from './schemas/angebot.js'
export type {
  AngebotPosition,
  AngebotInput,
  AngebotStatus,
  AngebotUpdate,
  AngebotResponse,
} from './schemas/angebot.js'

// Beleg
export {
  RabattInputSchema,
  ArtikelPositionSchema,
  FreiePositionSchema,
  BelegInputPositionSchema,
  BarzahlungsbelegInputSchema,
  StornobelegInputSchema,
  NullbelegInputSchema,
  MonatsbelegInputSchema,
  JahresbelegInputSchema,
  BelegResponseSchema,
  BelegPositionSchema,
} from './schemas/beleg.js'
export type {
  RabattInput,
  ArtikelPosition,
  FreiePosition,
  BelegInputPosition,
  BarzahlungsbelegInput,
  StornobelegInput,
  NullbelegInput,
  MonatsbelegInput,
  JahresbelegInput,
  BelegResponse,
  BelegPositionDto,
} from './schemas/beleg.js'

// Kassenbuch
export {
  KassenbuchBuchungTypSchema,
  KASSENBUCH_TYP_LABELS,
  KassenbuchBuchungSchema,
  KassenbuchBuchungInputSchema,
  KassenbuchQuerySchema,
  KassenbuchResponseSchema,
} from './schemas/kassenbuch.js'
export type {
  KassenbuchBuchungTyp,
  KassenbuchBuchung,
  KassenbuchBuchungInput,
  KassenbuchQuery,
  KassenbuchResponse,
} from './schemas/kassenbuch.js'

// Personalzeiterfassung
export {
  Arbeitszeit_QuelleSchema,
  ArbeitszeitInputSchema,
  ArbeitszeitUpdateSchema,
  ArbeitszeitResponseSchema,
  StempelInputSchema,
  StempelResponseSchema,
} from './schemas/zeiterfassung.js'
export type {
  ArbeitszeiteQuelle,
  ArbeitszeitInput,
  ArbeitszeitUpdate,
  ArbeitszeitResponse,
  StempelInput,
  StempelResponse,
} from './schemas/zeiterfassung.js'

// Tischreservierungen
export {
  ReservierungStatusSchema,
  RESERVIERUNG_STATUS_LABELS,
  ReservierungQuelleSchema,
  ReservierungInputSchema,
  ReservierungUpdateSchema,
  ReservierungResponseSchema,
  OnlineBuchungInfoSchema,
  OnlineBuchungInputSchema,
} from './schemas/reservierung.js'
export type {
  ReservierungStatus,
  ReservierungQuelle,
  ReservierungInput,
  ReservierungUpdate,
  ReservierungResponse,
  OnlineBuchungInfo,
  OnlineBuchungInput,
} from './schemas/reservierung.js'

// Dienstplan
export {
  DienstplanStatusSchema,
  DIENSTPLAN_STATUS_LABELS,
  DienstplanSchichtInputSchema,
  DienstplanSchichtUpdateSchema,
  DienstplanSchichtResponseSchema,
} from './schemas/dienstplan.js'
export type {
  DienstplanStatus,
  DienstplanSchichtInput,
  DienstplanSchichtUpdate,
  DienstplanSchichtResponse,
} from './schemas/dienstplan.js'

// Werbefolien
export {
  WerbefolieInputSchema,
  WerbefolieUpdateSchema,
  WerbefolieResponseSchema,
} from './schemas/werbefolien.js'
export type {
  WerbefolieInput,
  WerbefolieUpdate,
  WerbefolieResponse,
} from './schemas/werbefolien.js'

// Lieferbestellungen (Lieferando / Mergeport)
export {
  LieferbestellungStatusSchema,
  LIEFERBESTELLUNG_STATUS_LABELS,
  LIEFERBESTELLUNG_PROVIDER_LABELS,
  LieferbestellungPositionSchema,
  LieferbestellungResponseSchema,
  LieferbestellungUpdateSchema,
} from './schemas/lieferbestellung.js'
export type {
  LieferbestellungStatus,
  LieferbestellungPosition,
  LieferbestellungResponse,
  LieferbestellungUpdate,
} from './schemas/lieferbestellung.js'

// Preisregeln (Happy Hour / zeitgesteuerte Preise)
export {
  WochentagSchema,
  WOCHENTAG_LABELS,
  ZeitfensterSchema,
  PreisregelInputSchema,
  PreisregelUpdateSchema,
  PreisregelSchema,
  imZeitfenster,
  imAnyZeitfenster,
  isoWochentag,
  datumISO,
  regelGiltJetzt,
  aktiverRabattProzent,
  happyHourPreisCent,
} from './schemas/preisregel.js'
export type {
  Zeitfenster,
  PreisregelInput,
  PreisregelUpdate,
  Preisregel,
} from './schemas/preisregel.js'

// Seriennummern (striktes Pool-Modell pro Artikel)
export {
  SeriennummerStatusSchema,
  SeriennummerSchema,
  SeriennummernErfassenInputSchema,
} from './schemas/seriennummer.js'
export type {
  SeriennummerStatus,
  Seriennummer,
  SeriennummernErfassenInput,
} from './schemas/seriennummer.js'
