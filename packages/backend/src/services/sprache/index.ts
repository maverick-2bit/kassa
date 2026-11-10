/**
 * Sprachbestellung (optionales Modul `modulSpracheAktiv`) — reine Text-Logik.
 *
 * Dieser Ordner hat KEINE Abhängigkeit auf Datenbank, Fastify oder Spracherkennung. Er wird nur
 * von der (späteren) Sprach-Route geladen, und zwar erst bei aktivem Modul (dynamischer Import),
 * damit Mandanten ohne Modul nichts davon im Speicher haben.
 */

export { baueKatalog } from './katalog.js'
export type { SprachArtikel, SprachModifikator, SprachKatalog } from './katalog.js'
export { parseBestellung, parseBestellungAusArtikeln, SCHWELLEN } from './parser.js'
export type { ParseErgebnis, Vorschlag, VorschlagStatus, VorschlagModifikator, VorschlagAlternative } from './parser.js'
export { leseVor } from './vorlesen.js'
export { KatalogCache, KATALOG_TTL_MS, KATALOG_MAX_MANDANTEN } from './katalog-cache.js'
export type { KatalogCacheOptionen } from './katalog-cache.js'
