/**
 * Bestellvorschlag aus dem Verbrauch der letzten Tage (Artikel & Lager → Bestellliste).
 *
 * Verbrauch je Artikel = Verkäufe − Stornos im Zeitraum, aus den Belegen ALLER Kassen des Mandanten, dazu der Bedarf
 * an Bestandteilen über die Rezepturen (eine Ebene, wie die Lagerabbuchung). Unterwegs = Menge aus Einkaufs-
 * bestellungen „gesendet"/„teilgeliefert", die noch nicht geliefert ist. Die Rechnung selbst: berechneVorschlag.
 *
 * Zuordnung Belegposition → Artikel: Seit 2026-11 speichert jede Position die Artikel-ID (artikelId). Ältere
 * Positionen kennen nur den Artikelnamen (artikelName); sie werden über den Namen zugeordnet, wenn er im Mandanten
 * eindeutig ist (ein umbenannter Artikel verliert diese ältere Vorgeschichte).
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import { berechneVorschlag, type Bestellvorschlag, type BestellvorschlagQuery } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, einkaufBestellpositionen, einkaufBestellungen } from '../db/schema.js'
import { ladeRezepte, summiereBedarf } from './bestandteil.service.js'

const STORNO_VORSILBE = 'Storno: '

export async function holeBestellvorschlag(
  db: Db,
  mandantId: string,
  q: BestellvorschlagQuery,
  jetzt: Date = new Date(),
): Promise<Bestellvorschlag> {
  const tage = q.tage
  const reichweite = q.reichweite ?? tage
  const seit = new Date(jetzt.getTime() - tage * 24 * 60 * 60 * 1000)

  const alle = await db.select({
    id:                       artikel.id,
    bezeichnung:              artikel.bezeichnung,
    artikelnummer:            artikel.artikelnummer,
    aktiv:                    artikel.aktiv,
    lagerstandAktiv:          artikel.lagerstandAktiv,
    lagerstandMenge:          artikel.lagerstandMenge,
    mindestbestand:           artikel.mindestbestand,
    lieferantId:              artikel.lieferantId,
    lieferantenArtikelnummer: artikel.lieferantenArtikelnummer,
    einkaufspreisCent:        artikel.einkaufspreisCent,
  }).from(artikel).where(eq(artikel.mandantId, mandantId))

  const nachId = new Map(alle.map(a => [a.id, a]))
  // Name → Artikel, nur wenn eindeutig (sonst lieber nicht zählen als falsch zählen)
  const nachName = new Map<string, string | null>()
  for (const a of alle) nachName.set(a.bezeichnung, nachName.has(a.bezeichnung) ? null : a.id)

  // Verkäufe und Stornos je (artikelId, artikelName) — nur Artikelpositionen (freie Positionen und Rabatte haben
  // keinen artikelName)
  const rows = await db.execute<{ artikel_id: string | null; artikel_name: string; storno: boolean; menge: string }>(sql`
    SELECT pos->>'artikelId'                AS artikel_id,
           pos->>'artikelName'              AS artikel_name,
           (beleg_typ = 'Stornobeleg')      AS storno,
           SUM((pos->>'menge')::numeric)    AS menge
    FROM belege, jsonb_array_elements(positionen) AS pos
    WHERE mandant_id = ${mandantId}
      AND beleg_datum >= ${seit.toISOString()}
      AND beleg_datum <= ${jetzt.toISOString()}
      AND beleg_typ IN ('Barzahlungsbeleg', 'Stornobeleg')
      AND pos ? 'artikelName'
    GROUP BY 1, 2, 3
  `)

  const verkauft = new Map<string, number>()
  for (const r of rows) {
    let id: string | null = r.artikel_id && nachId.has(r.artikel_id) ? r.artikel_id : null
    if (!id) {
      const name = r.storno && r.artikel_name.startsWith(STORNO_VORSILBE) ? r.artikel_name.slice(STORNO_VORSILBE.length) : r.artikel_name
      id = nachName.get(name) ?? null
    }
    if (!id) continue
    const menge = Number(r.menge) * (r.storno ? -1 : 1)
    verkauft.set(id, (verkauft.get(id) ?? 0) + menge)
  }

  // Bestandteile: Verbrauch der Verkaufsartikel über die Rezepturen auf die Rohstoffe umlegen
  const verbrauch = new Map(verkauft)
  const rezepte = await ladeRezepte(db, mandantId, [...verkauft.keys()])
  const bedarf = summiereBedarf([...verkauft].map(([artikelId, delta]) => ({ artikelId, delta })), rezepte)
  for (const [id, menge] of bedarf) verbrauch.set(id, (verbrauch.get(id) ?? 0) + menge)

  // Unterwegs: bestellt, noch nicht geliefert
  const lagerArtikel = alle.filter(a => a.aktiv && a.lagerstandAktiv)
  const unterwegs = new Map<string, number>()
  if (lagerArtikel.length > 0) {
    const offen = await db.select({
      artikelId: einkaufBestellpositionen.artikelId,
      offen:     sql<string>`SUM(GREATEST(0, ${einkaufBestellpositionen.menge} - ${einkaufBestellpositionen.gelieferteMenge}))`,
    })
      .from(einkaufBestellpositionen)
      .innerJoin(einkaufBestellungen, eq(einkaufBestellungen.id, einkaufBestellpositionen.bestellungId))
      .where(and(
        eq(einkaufBestellungen.mandantId, mandantId),
        inArray(einkaufBestellungen.status, ['gesendet', 'teilgeliefert']),
        inArray(einkaufBestellpositionen.artikelId, lagerArtikel.map(a => a.id)),
      ))
      .groupBy(einkaufBestellpositionen.artikelId)
    for (const o of offen) if (o.artikelId) unterwegs.set(o.artikelId, Number(o.offen))
  }

  const zeilen = lagerArtikel.map(a => {
    const bestand = a.lagerstandMenge ?? 0
    const z = {
      artikelId:                a.id,
      bezeichnung:              a.bezeichnung,
      artikelnummer:            a.artikelnummer,
      lieferantId:              a.lieferantId,
      lieferantenArtikelnummer: a.lieferantenArtikelnummer,
      einkaufspreisCent:        a.einkaufspreisCent,
      bestand,
      unterwegs:                unterwegs.get(a.id) ?? 0,
      mindestbestand:           a.mindestbestand,
      verbrauch:                Math.max(0, verbrauch.get(a.id) ?? 0),
    }
    return { ...z, ...berechneVorschlag({ ...z, tage, reichweite }) }
  }).sort((x, y) => y.vorschlag - x.vorschlag || x.bezeichnung.localeCompare(y.bezeichnung, 'de'))

  return { tage, reichweite, seit: seit.toISOString(), zeilen }
}
