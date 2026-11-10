/**
 * Sprachbestellung (optionales Modul) — Datenzugriff: Synonyme je Artikel und der Katalog für den Parser.
 *
 * Das Modul `modulSpracheAktiv` ist je Mandant schaltbar; alle Schreib-/Lese-Endpunkte prüfen es
 * (403, wenn aus). Die reine Text-Logik liegt in services/sprache/ und kennt keine Datenbank.
 */

import { and, asc, eq, ne } from 'drizzle-orm'
import type { ArtikelSynonyme, ArtikelSynonymeErgebnis } from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  artikel, artikelModifikatorGruppen, artikelSynonyme, mandanten, modifikatoren, modifikatorGruppen,
} from '../db/schema.js'
import type { SprachArtikel, SprachModifikator } from './sprache/index.js'
import {
  bereinigeSynonyme, findeKonflikte, synonymSchluessel, type AndererArtikelName,
} from './sprache/synonyme.js'

export class SpracheError extends Error {
  constructor(public httpStatus: number, message: string) {
    super(message)
    this.name = 'SpracheError'
  }
}

/** 403, wenn das Modul für den Mandanten nicht aktiv ist. */
export async function pruefeSpracheModul(db: Db, mandantId: string): Promise<void> {
  const [m] = await db
    .select({ aktiv: mandanten.modulSpracheAktiv })
    .from(mandanten)
    .where(eq(mandanten.id, mandantId))
    .limit(1)
  if (!m?.aktiv) throw new SpracheError(403, 'Sprachbestellung ist für diesen Betrieb nicht aktiviert')
}

/** Alle Artikel des Mandanten, die mindestens ein Synonym haben (nach Bezeichnung sortiert). */
export async function listeSynonyme(db: Db, mandantId: string): Promise<ArtikelSynonyme[]> {
  const rows = await db
    .select({ artikelId: artikelSynonyme.artikelId, bezeichnung: artikel.bezeichnung, text: artikelSynonyme.text })
    .from(artikelSynonyme)
    .innerJoin(artikel, eq(artikel.id, artikelSynonyme.artikelId))
    .where(eq(artikelSynonyme.mandantId, mandantId))
    .orderBy(asc(artikel.bezeichnung), asc(artikelSynonyme.position))

  const proArtikel = new Map<string, ArtikelSynonyme>()
  for (const r of rows) {
    const e = proArtikel.get(r.artikelId)
    if (e) e.synonyme.push(r.text)
    else proArtikel.set(r.artikelId, { artikelId: r.artikelId, bezeichnung: r.bezeichnung, synonyme: [r.text] })
  }
  return [...proArtikel.values()]
}

/** Synonyme EINES Artikels (404, wenn der Artikel nicht zum Mandanten gehört). */
export async function holeSynonyme(db: Db, mandantId: string, artikelId: string): Promise<ArtikelSynonymeErgebnis> {
  const [a] = await db
    .select({ id: artikel.id })
    .from(artikel)
    .where(and(eq(artikel.id, artikelId), eq(artikel.mandantId, mandantId)))
    .limit(1)
  if (!a) throw new SpracheError(404, 'Artikel nicht gefunden')

  const rows = await db
    .select({ text: artikelSynonyme.text })
    .from(artikelSynonyme)
    .where(and(eq(artikelSynonyme.artikelId, artikelId), eq(artikelSynonyme.mandantId, mandantId)))
    .orderBy(asc(artikelSynonyme.position))
  return { artikelId, synonyme: rows.map(r => r.text), konflikte: [] }
}

/**
 * Ersetzt die Synonyme eines Artikels. Bereinigt (Dubletten, eigene Bezeichnung) und meldet Synonyme,
 * die auch einen anderen Artikel meinen — gespeichert werden sie trotzdem (der Betrieb entscheidet),
 * die Spracherkennung fragt dann aber nach.
 */
export async function setzeSynonyme(
  db: Db,
  mandantId: string,
  artikelId: string,
  texte: string[],
): Promise<ArtikelSynonymeErgebnis> {
  const [a] = await db
    .select({ id: artikel.id, bezeichnung: artikel.bezeichnung })
    .from(artikel)
    .where(and(eq(artikel.id, artikelId), eq(artikel.mandantId, mandantId)))
    .limit(1)
  if (!a) throw new SpracheError(404, 'Artikel nicht gefunden')

  const bereinigt = bereinigeSynonyme(texte, a.bezeichnung)

  // Konflikte: andere Artikel (Bezeichnung) und deren Synonyme
  const andereArtikel = await db
    .select({ id: artikel.id, bezeichnung: artikel.bezeichnung })
    .from(artikel)
    .where(and(eq(artikel.mandantId, mandantId), eq(artikel.aktiv, true), eq(artikel.istBestandteil, false), ne(artikel.id, artikelId)))
  const andereSynonyme = await db
    .select({ artikelId: artikelSynonyme.artikelId, bezeichnung: artikel.bezeichnung, textNorm: artikelSynonyme.textNorm })
    .from(artikelSynonyme)
    .innerJoin(artikel, eq(artikel.id, artikelSynonyme.artikelId))
    .where(and(eq(artikelSynonyme.mandantId, mandantId), ne(artikelSynonyme.artikelId, artikelId)))
  const andere: AndererArtikelName[] = [
    ...andereArtikel.map(x => ({ artikelId: x.id, bezeichnung: x.bezeichnung, textNorm: synonymSchluessel(x.bezeichnung), art: 'bezeichnung' as const })),
    ...andereSynonyme.map(x => ({ artikelId: x.artikelId, bezeichnung: x.bezeichnung, textNorm: x.textNorm, art: 'synonym' as const })),
  ]
  const konflikte = findeKonflikte(bereinigt, andere)

  await db.transaction(async (tx) => {
    await tx.delete(artikelSynonyme).where(and(eq(artikelSynonyme.artikelId, artikelId), eq(artikelSynonyme.mandantId, mandantId)))
    if (bereinigt.length > 0) {
      await tx.insert(artikelSynonyme).values(
        bereinigt.map((s, position) => ({ mandantId, artikelId, text: s.text, textNorm: s.textNorm, position })),
      )
    }
  })

  return { artikelId, synonyme: bereinigt.map(s => s.text), konflikte }
}

/**
 * Katalog für den Parser: aktive, verkäufliche Artikel mit Synonymen und den Optionen
 * (Modifikatoren) ihrer aktiven Gruppen. Drei schlanke Abfragen, kein Join-Produkt.
 */
export async function ladeSprachArtikel(db: Db, mandantId: string): Promise<SprachArtikel[]> {
  const artikelRows = await db
    .select({ id: artikel.id, bezeichnung: artikel.bezeichnung })
    .from(artikel)
    .where(and(eq(artikel.mandantId, mandantId), eq(artikel.aktiv, true), eq(artikel.istBestandteil, false)))
    .orderBy(asc(artikel.bezeichnung))

  const synonymRows = await db
    .select({ artikelId: artikelSynonyme.artikelId, text: artikelSynonyme.text })
    .from(artikelSynonyme)
    .where(eq(artikelSynonyme.mandantId, mandantId))
    .orderBy(asc(artikelSynonyme.position))

  const modRows = await db
    .select({
      artikelId: artikelModifikatorGruppen.artikelId,
      id:        modifikatoren.id,
      gruppeId:  modifikatoren.gruppeId,
      name:      modifikatoren.name,
    })
    .from(artikelModifikatorGruppen)
    .innerJoin(modifikatorGruppen, eq(modifikatorGruppen.id, artikelModifikatorGruppen.gruppeId))
    .innerJoin(modifikatoren, eq(modifikatoren.gruppeId, modifikatorGruppen.id))
    .where(and(eq(modifikatorGruppen.mandantId, mandantId), eq(modifikatorGruppen.aktiv, true), eq(modifikatoren.aktiv, true)))

  const synonymeJe = new Map<string, string[]>()
  for (const s of synonymRows) {
    const liste = synonymeJe.get(s.artikelId)
    if (liste) liste.push(s.text)
    else synonymeJe.set(s.artikelId, [s.text])
  }
  const modsJe = new Map<string, SprachModifikator[]>()
  for (const m of modRows) {
    const eintrag: SprachModifikator = { id: m.id, gruppeId: m.gruppeId, name: m.name }
    const liste = modsJe.get(m.artikelId)
    if (liste) liste.push(eintrag)
    else modsJe.set(m.artikelId, [eintrag])
  }

  return artikelRows.map(a => ({
    id: a.id,
    bezeichnung: a.bezeichnung,
    ...(synonymeJe.has(a.id) ? { synonyme: synonymeJe.get(a.id)! } : {}),
    ...(modsJe.has(a.id) ? { modifikatoren: modsJe.get(a.id)! } : {}),
  }))
}
