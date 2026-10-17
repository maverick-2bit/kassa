/**
 * Bepreiste Varianten auflösen.
 *
 * Artikel aus dem Altsystem haben ihren Preis in der Option („Bier" 0,00 mit „0,33l" +4,00 / „0,5l" +5,00).
 * Ist die Optionen-Abfrage abgeschaltet (Artikel → Warengruppe → Kasse, Migration 0066), fällt die
 * Preisauswahl weg und es wird mit dem Basispreis — beim Bier also 0,00 — boniert. Die Verwaltung listet
 * solche Artikel (Erkennung in @kassa/shared, bepreiste-varianten.ts) und löst sie hier auf: aus einer
 * Option wird ein eigener Artikel, oder die Variante wird verworfen.
 *
 * Optionsgruppen sind GETEILT — dieselbe Gruppe „Variante (0,33l / 0,5l)" hängt oft an allen Bieren, weil
 * der Import inhaltsgleiche Gruppen wiederverwendet. Darum wird hier nie eine Option gelöscht, sondern am
 * Ende nur die Gruppe von DIESEM Artikel gelöst; an den anderen Artikeln bleibt sie unberührt.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { planeVariantenArtikel, ursprungDeaktivieren } from '@kassa/shared'
import type {
  VarianteErledigt,
  VariantenAufloesen,
  VariantenAufloesenErgebnis,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  artikel,
  artikelModifikatorGruppen,
  artikelVarianteErledigt,
  modifikatoren,
} from '../db/schema.js'
import { generiereArtikelNummer } from './artikel.service.js'
import { fetchGruppenMitModifikatoren, ModifikatorError } from './modifikator.service.js'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Alle schon getroffenen Entscheidungen des Mandanten — die Übersicht trennt damit offen von erledigt. */
export async function listeVariantenErledigt(mandantId: string, db: Db): Promise<VarianteErledigt[]> {
  const rows = await db
    .select({
      artikelId:     artikelVarianteErledigt.artikelId,
      modifikatorId: artikelVarianteErledigt.modifikatorId,
      art:           artikelVarianteErledigt.art,
      artikelNeuId:  artikelVarianteErledigt.artikelNeuId,
    })
    .from(artikelVarianteErledigt)
    .innerJoin(artikel, eq(artikelVarianteErledigt.artikelId, artikel.id))
    .where(eq(artikel.mandantId, mandantId))

  return rows.map(r => ({
    artikelId:     r.artikelId,
    modifikatorId: r.modifikatorId,
    art:           r.art === 'angelegt' ? 'angelegt' : 'verworfen',
    artikelNeuId:  r.artikelNeuId,
  }))
}

/** Entscheidung festhalten; ein zweiter Klick überschreibt sie, statt zu scheitern. */
async function merkeErledigt(
  tx: Tx,
  artikelId: string,
  modifikatorId: string,
  art: 'angelegt' | 'verworfen',
  artikelNeuId: string | null,
): Promise<void> {
  await tx.insert(artikelVarianteErledigt)
    .values({ artikelId, modifikatorId, art, artikelNeuId })
    .onConflictDoUpdate({
      target: [artikelVarianteErledigt.artikelId, artikelVarianteErledigt.modifikatorId],
      set:    { art, artikelNeuId },
    })
}

/**
 * Löst die bepreisten Varianten eines Artikels in EINER Optionsgruppe auf.
 *
 * `anlegen` macht aus jeder genannten Option einen eigenen Artikel; Bezeichnung und Preis rechnet
 * `planeVariantenArtikel` aus @kassa/shared — dieselbe Rechnung zeigt die Vorschau in der Verwaltung. Der
 * neue Artikel übernimmt Warengruppe, MwSt, KDS-Station, Allergene, Farbe, Bonierdrucker, Bild und
 * Lieferant des Ursprungsartikels samt dessen ÜBRIGEN Optionsgruppen. Gibt es einen Artikel gleichen Namens
 * in der Warengruppe schon, wird er nicht noch einmal angelegt — die Variante gilt aber als erledigt, sonst
 * klickt man ins Leere.
 *
 * `verwerfen` hält nur die Entscheidung fest; die Option selbst bleibt für die anderen Artikel bestehen.
 *
 * Danach: sind alle aktiven bepreisten Optionen der Gruppe für diesen Artikel erledigt, wird die Gruppe von
 * ihm gelöst. Ist damit keine bepreiste Gruppe mehr an ihm und sein Basispreis 0,00, wird er deaktiviert
 * (`ursprungDeaktivieren`) — „Bier" für 0,00 ist als Kachel sonst eine Fehlerquelle; „Spritzer" 4,00 bleibt.
 *
 * Alles in einer Transaktion: ein Fehler hinterlässt keine halb aufgelöste Gruppe.
 */
export async function loeseVariantenAuf(
  artikelId: string,
  input: VariantenAufloesen,
  mandantId: string,
  db: Db,
): Promise<VariantenAufloesenErgebnis> {
  const [ursprung] = await db
    .select()
    .from(artikel)
    .where(and(eq(artikel.id, artikelId), eq(artikel.mandantId, mandantId)))
    .limit(1)
  if (!ursprung) throw new ModifikatorError(404, 'Artikel nicht gefunden')

  const [gruppe] = await fetchGruppenMitModifikatoren(mandantId, db, { gruppenIds: [input.gruppeId] })
  if (!gruppe) throw new ModifikatorError(404, 'Optionsgruppe nicht gefunden')

  const [zuweisung] = await db
    .select({ gruppeId: artikelModifikatorGruppen.gruppeId })
    .from(artikelModifikatorGruppen)
    .where(and(
      eq(artikelModifikatorGruppen.artikelId, artikelId),
      eq(artikelModifikatorGruppen.gruppeId, input.gruppeId),
    ))
    .limit(1)
  if (!zuweisung) throw new ModifikatorError(400, 'Diese Optionsgruppe gehört nicht zu diesem Artikel')

  const optionById = new Map(gruppe.modifikatoren.map(m => [m.id, m] as const))
  const genannte   = [...input.anlegen, ...input.verwerfen]
  for (const id of genannte) {
    if (!optionById.has(id)) throw new ModifikatorError(400, 'Option gehört nicht zu dieser Optionsgruppe')
  }
  if (new Set(genannte).size !== genannte.length) {
    throw new ModifikatorError(400, 'Eine Option steht gleichzeitig unter Anlegen und Verwerfen')
  }

  // Vorhandene Artikel für die Doppelt-Prüfung (gleicher Name in derselben Warengruppe)
  const vorhandene = await db
    .select({ bezeichnung: artikel.bezeichnung, kategorieId: artikel.kategorieId })
    .from(artikel)
    .where(eq(artikel.mandantId, mandantId))

  const anzulegen = input.anlegen
    .map(id => optionById.get(id)!)
    .map(m => ({ id: m.id, name: m.name, aufschlagCent: m.aufschlagCent }))
  const plan = planeVariantenArtikel(ursprung, anzulegen, vorhandene)

  // Die übrigen Optionsgruppen des Ursprungsartikels erbt der neue Artikel
  const uebrigeGruppen = (await db
    .select({
      gruppeId:    artikelModifikatorGruppen.gruppeId,
      reihenfolge: artikelModifikatorGruppen.reihenfolge,
    })
    .from(artikelModifikatorGruppen)
    .where(eq(artikelModifikatorGruppen.artikelId, artikelId))
    .orderBy(asc(artikelModifikatorGruppen.reihenfolge)))
    .filter(z => z.gruppeId !== input.gruppeId)

  const ergebnis: VariantenAufloesenErgebnis = {
    angelegt: [], uebersprungen: [], verworfen: 0, gruppeGeloest: false, ursprungDeaktiviert: false,
  }

  await db.transaction(async (tx) => {
    for (const eintrag of plan) {
      if (eintrag.vorhanden) {
        // Schon da (zweiter Klick oder aus dem Altbestand) — erledigt, aber ohne neuen Artikel
        const [treffer] = await tx
          .select({ id: artikel.id })
          .from(artikel)
          .where(and(
            eq(artikel.mandantId, mandantId),
            sql`lower(${artikel.bezeichnung}) = lower(${eintrag.bezeichnung})`,
            ursprung.kategorieId === null
              ? isNull(artikel.kategorieId)
              : eq(artikel.kategorieId, ursprung.kategorieId),
          ))
          .limit(1)
        ergebnis.uebersprungen.push({
          modifikatorId: eintrag.modifikatorId,
          bezeichnung:   eintrag.bezeichnung,
          grund:         'Artikel gleichen Namens ist in dieser Warengruppe schon vorhanden',
        })
        await merkeErledigt(tx, artikelId, eintrag.modifikatorId, 'angelegt', treffer?.id ?? null)
        continue
      }

      const artikelnummer = await generiereArtikelNummer(tx, mandantId)
      const [neu] = await tx.insert(artikel).values({
        mandantId,
        bezeichnung:     eintrag.bezeichnung,
        preisBruttoCent: eintrag.preisBruttoCent,
        mwstSatz:        ursprung.mwstSatz,
        artikelnummer,
        allergene:       ursprung.allergene,
        station:         ursprung.station,
        farbe:           ursprung.farbe,
        kategorieId:     ursprung.kategorieId,
        // rasterPosition bleibt leer → der Artikel hängt sich hinten an das Kassen-Raster an
        bonierdruckerId: ursprung.bonierdruckerId,
        bonierBeiDirektverkauf: ursprung.bonierBeiDirektverkauf,
        terminalSichtbar: ursprung.terminalSichtbar,
        lieferantId:     ursprung.lieferantId,
        // optionenAbfrage NICHT übernehmen: der neue Artikel hat keine preisbestimmende Option mehr
        ...(ursprung.bild != null && { bild: ursprung.bild }),
      }).returning({ id: artikel.id })
      if (!neu) throw new ModifikatorError(500, `Artikel "${eintrag.bezeichnung}" konnte nicht angelegt werden`)

      if (uebrigeGruppen.length > 0) {
        await tx.insert(artikelModifikatorGruppen)
          .values(uebrigeGruppen.map((z, i) => ({ artikelId: neu.id, gruppeId: z.gruppeId, reihenfolge: i })))
          .onConflictDoNothing()
      }

      await merkeErledigt(tx, artikelId, eintrag.modifikatorId, 'angelegt', neu.id)
      ergebnis.angelegt.push({
        modifikatorId:   eintrag.modifikatorId,
        artikelId:       neu.id,
        bezeichnung:     eintrag.bezeichnung,
        preisBruttoCent: eintrag.preisBruttoCent,
      })
    }

    for (const modId of input.verwerfen) {
      await merkeErledigt(tx, artikelId, modId, 'verworfen', null)
      ergebnis.verworfen++
    }

    // Gruppe lösen, sobald für diesen Artikel keine bepreiste Option mehr offen ist
    const erledigt = new Set(
      (await tx
        .select({ modifikatorId: artikelVarianteErledigt.modifikatorId })
        .from(artikelVarianteErledigt)
        .where(eq(artikelVarianteErledigt.artikelId, artikelId)))
        .map(r => r.modifikatorId),
    )
    const offen = gruppe.modifikatoren.filter(m => m.aktiv && m.aufschlagCent !== 0 && !erledigt.has(m.id))
    if (offen.length === 0) {
      await tx.delete(artikelModifikatorGruppen).where(and(
        eq(artikelModifikatorGruppen.artikelId, artikelId),
        eq(artikelModifikatorGruppen.gruppeId, input.gruppeId),
      ))
      ergebnis.gruppeGeloest = true

      // Hängt noch eine bepreiste Gruppe am Artikel? Sonst ist er fertig aufgelöst.
      const restIds = uebrigeGruppen.map(z => z.gruppeId)
      const rest = restIds.length > 0
        ? await fetchGruppenMitModifikatoren(mandantId, tx as unknown as Db, { gruppenIds: restIds })
        : []
      const nochBepreist = rest.some(g =>
        g.aktiv && g.modifikatoren.some(m => m.aktiv && m.aufschlagCent !== 0 && !erledigt.has(m.id)))

      if (ursprung.aktiv && ursprungDeaktivieren(ursprung.preisBruttoCent, !nochBepreist)) {
        await tx.update(artikel)
          .set({ aktiv: false, updatedAt: new Date() })
          .where(eq(artikel.id, artikelId))
        ergebnis.ursprungDeaktiviert = true
      }
    }
  })

  return ergebnis
}

/**
 * Nimmt eine Entscheidung zurück — die Variante gilt wieder als offen und erscheint erneut in der Übersicht.
 * Angelegte Artikel bleiben bestehen (die löscht man in der Artikelverwaltung); die Optionsgruppe wird dem
 * Artikel wieder zugeordnet, falls sie beim Auflösen gelöst wurde.
 *
 * War der Artikel beim Auflösen deaktiviert worden (Basispreis 0,00), wird er wieder aktiv — sonst bliebe er
 * deaktiviert, die Übersicht übergeht deaktivierte Artikel, und der zurückgenommene Fall wäre unsichtbar.
 * Deaktiviert wird nur bei Basispreis 0,00, deshalb wird auch nur dieser Fall rückgängig gemacht.
 */
export async function nimmVarianteZurueck(
  artikelId: string,
  modifikatorId: string,
  mandantId: string,
  db: Db,
): Promise<void> {
  const [ursprung] = await db
    .select({ id: artikel.id, aktiv: artikel.aktiv, preisBruttoCent: artikel.preisBruttoCent })
    .from(artikel)
    .where(and(eq(artikel.id, artikelId), eq(artikel.mandantId, mandantId)))
    .limit(1)
  if (!ursprung) throw new ModifikatorError(404, 'Artikel nicht gefunden')

  const [option] = await db
    .select({ gruppeId: modifikatoren.gruppeId })
    .from(modifikatoren)
    .where(and(eq(modifikatoren.id, modifikatorId), eq(modifikatoren.mandantId, mandantId)))
    .limit(1)
  if (!option) throw new ModifikatorError(404, 'Option nicht gefunden')

  await db.transaction(async (tx) => {
    await tx.delete(artikelVarianteErledigt).where(and(
      eq(artikelVarianteErledigt.artikelId, artikelId),
      eq(artikelVarianteErledigt.modifikatorId, modifikatorId),
    ))
    await tx.insert(artikelModifikatorGruppen)
      .values({ artikelId, gruppeId: option.gruppeId, reihenfolge: 0 })
      .onConflictDoNothing()

    if (!ursprung.aktiv && ursprungDeaktivieren(ursprung.preisBruttoCent, true)) {
      await tx.update(artikel)
        .set({ aktiv: true, updatedAt: new Date() })
        .where(eq(artikel.id, artikelId))
    }
  })
}
