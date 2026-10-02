/**
 * Geschäftstag-Service: Tagesbeginn je Mandant (Historie mit Stichtagen).
 *
 * Der „Tag" eines Betriebs beginnt nicht zwingend um 00:00 — mit z. B. 06:00 liegt
 * eine Schicht von 18:00 bis 02:00 auf EINEM Tag. Eine Änderung gilt AB EINEM
 * STICHTAG; vergangene Tage und alte Tagesabschlüsse bleiben unverändert (siehe
 * @kassa/shared, geschaeftstag.ts — dort steht die Definition).
 *
 * Dieser Service lädt die Historie (`ladeTagesRegel`, für alle Auswertungen) und
 * pflegt sie (nur Admin, siehe mandant.route.ts). Der Mandant kommt immer aus dem
 * Login, nie aus dem Body.
 */

import { and, asc, eq, sql } from 'drizzle-orm'
import {
  addTage,
  beginnFuer,
  geschaeftstagVon,
  heuteKalendertagWien,
  normalisiereRegel,
  tagesGrenzen,
  type TagesbeginnEintrag,
  type TagesbeginnInput,
  type TagesbeginnStand,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import { mandantTagesbeginn } from '../db/schema.js'

/** Fachfehler mit HTTP-Status — die Route gibt Status und Meldung weiter. */
export class GeschaeftstagError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

/** 'TT.MM.JJJJ' aus YYYY-MM-DD */
function datumAnzeige(datum: string): string {
  const [j, m, t] = datum.split('-')
  return `${t}.${m}.${j}`
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/**
 * Tagesbeginn-Historie des Mandanten (aufsteigend nach Stichtag; leer = 00:00).
 *
 * Eine kleine, indexierte Abfrage — bewusst ohne Cache: ein Cache je Mandant
 * müsste bei jeder Änderung und in jedem Prozess invalidiert werden, die Abfrage
 * kostet unter einer Millisekunde.
 */
export async function ladeTagesRegel(db: Db, mandantId: string): Promise<TagesbeginnEintrag[]> {
  const zeilen = await db
    .select({ gueltigAb: mandantTagesbeginn.gueltigAb, beginn: mandantTagesbeginn.beginn })
    .from(mandantTagesbeginn)
    .where(eq(mandantTagesbeginn.mandantId, mandantId))
  return normalisiereRegel(zeilen)
}

/** Aktueller Geschäftstag des Mandanten (YYYY-MM-DD). */
export async function aktuellerGeschaeftstag(db: Db, mandantId: string, jetzt: Date = new Date()): Promise<string> {
  return geschaeftstagVon(await ladeTagesRegel(db, mandantId), jetzt)
}

/** Einstellung samt Vorschau „heute ist Geschäftstag X" — für die Einstellungsseite. */
export async function holeTagesbeginnStand(
  db:        Db,
  mandantId: string,
  jetzt:     Date = new Date(),
): Promise<TagesbeginnStand> {
  const zeilen = await db
    .select()
    .from(mandantTagesbeginn)
    .where(eq(mandantTagesbeginn.mandantId, mandantId))
    .orderBy(asc(mandantTagesbeginn.gueltigAb))

  const regel         = normalisiereRegel(zeilen)
  const kalendertag   = heuteKalendertagWien(jetzt)
  const geschaeftstag = geschaeftstagVon(regel, jetzt)
  const grenzen       = tagesGrenzen(regel, geschaeftstag)

  return {
    eintraege: zeilen.map(z => ({
      id:        z.id,
      gueltigAb: z.gueltigAb,
      beginn:    z.beginn,
      createdAt: z.createdAt.toISOString(),
    })),
    heute: {
      kalendertag,
      geschaeftstag,
      beginn: beginnFuer(regel, kalendertag),
      von:    grenzen.von.toISOString(),
      bis:    grenzen.bis.toISOString(),
    },
  }
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

/**
 * Gibt es für den Mandanten schon Daten, die auf Tage ab `gueltigAb` (Beginn des
 * Wiener Kalendertags) fallen und deren Tageszuordnung sich mit einem anderen
 * Tagesbeginn ändern würde?
 *
 * Das sind alle Datensätze, die Auswertungen nach Tagen gruppieren: Umsatzbelege
 * (Barzahlung/Storno — Start-, Monats-, Jahres- und Nullbelege zählen in keinem
 * Bericht), Arbeitszeiten, KDS-Bons und Gutschein-Buchungen. Der Beginn eines
 * Geschäftstags liegt immer auf seinem Kalendertag; was VOR 00:00 des Stichtags
 * liegt, ändert seinen Tag also nie.
 */
async function hatDatenAb(db: Db, mandantId: string, gueltigAb: string): Promise<boolean> {
  const ab = sql`(${gueltigAb}::date)::timestamp at time zone 'Europe/Vienna'`
  const zeilen = await db.execute<{ vorhanden: boolean }>(sql`
    SELECT (
      EXISTS (SELECT 1 FROM belege
               WHERE mandant_id = ${mandantId}::uuid
                 AND beleg_typ IN ('Barzahlungsbeleg', 'Stornobeleg')
                 AND beleg_datum >= ${ab})
      OR EXISTS (SELECT 1 FROM arbeitszeiten
                  WHERE mandant_id = ${mandantId}::uuid AND beginn >= ${ab})
      OR EXISTS (SELECT 1 FROM kds_bons
                  WHERE mandant_id = ${mandantId}::uuid AND erstellt_at >= ${ab})
      OR EXISTS (SELECT 1 FROM gutschein_buchungen
                  WHERE mandant_id = ${mandantId}::uuid AND created_at >= ${ab})
    ) AS vorhanden
  `)
  return [...zeilen][0]?.vorhanden === true
}

export interface TagesbeginnAnlegenErgebnis {
  stand:  TagesbeginnStand
  /** Tagesbeginn, der am Stichtag vorher gegolten hätte (fürs Audit-Log) */
  vorher: string
}

/**
 * Neuen Tagesbeginn ab einem Stichtag festlegen.
 *
 *  - frühestens ab morgen (Wiener Kalenderdatum) — vergangene und heutige Tage
 *    bleiben unverändert; AUSNAHME: noch keine Daten ab dem Beginn des Stichtags
 *    (Test-/Neuaufbau) → Sofort-Wirkung erlaubt
 *  - gleicher Beginn wie der zuletzt gültige → 400 „keine Änderung"
 *  - ein bereits gültiger Eintrag lässt sich nicht ändern; ein GEPLANTER (Stichtag
 *    in der Zukunft) wird ersetzt
 */
export async function legeTagesbeginnAn(
  db:        Db,
  mandantId: string,
  input:     TagesbeginnInput,
  jetzt:     Date = new Date(),
): Promise<TagesbeginnAnlegenErgebnis> {
  const heute  = heuteKalendertagWien(jetzt)
  const morgen = addTage(heute, 1)
  const regel  = await ladeTagesRegel(db, mandantId)

  const gleicherStichtag = regel.find(e => e.gueltigAb === input.gueltigAb)
  if (gleicherStichtag && input.gueltigAb <= heute) {
    throw new GeschaeftstagError(409,
      `Für den ${datumAnzeige(input.gueltigAb)} gibt es schon einen Tagesbeginn, der bereits gilt — er lässt sich nicht mehr ändern.`)
  }

  // Was würde am Stichtag ohne diesen Eintrag gelten? (Ein geplanter Eintrag zum
  // selben Stichtag wird ja ersetzt.)
  const ohneGleichen = regel.filter(e => e.gueltigAb !== input.gueltigAb)
  const vorher = beginnFuer(ohneGleichen, input.gueltigAb)
  if (vorher === input.beginn) {
    throw new GeschaeftstagError(400,
      `Keine Änderung: Ab dem ${datumAnzeige(input.gueltigAb)} beginnt der Tag bereits um ${input.beginn} Uhr.`)
  }

  if (input.gueltigAb < morgen && await hatDatenAb(db, mandantId, input.gueltigAb)) {
    throw new GeschaeftstagError(400,
      `Der Tagesbeginn kann nur für zukünftige Tage geändert werden — frühestens ab morgen (${datumAnzeige(morgen)}). ` +
      `Seit dem ${datumAnzeige(input.gueltigAb)} liegen bereits Belege oder Arbeitszeiten vor, vergangene Tage bleiben unverändert.`)
  }

  await db
    .insert(mandantTagesbeginn)
    .values({ mandantId, gueltigAb: input.gueltigAb, beginn: input.beginn })
    .onConflictDoUpdate({
      target: [mandantTagesbeginn.mandantId, mandantTagesbeginn.gueltigAb],
      set:    { beginn: input.beginn, createdAt: new Date() },
    })

  return { stand: await holeTagesbeginnStand(db, mandantId, jetzt), vorher }
}

export interface TagesbeginnLoeschenErgebnis {
  stand:     TagesbeginnStand
  geloescht: TagesbeginnEintrag
}

/**
 * Einen GEPLANTEN Wechsel (Stichtag in der Zukunft) zurücknehmen. Ein bereits
 * gültiger oder vergangener Eintrag bleibt — sonst würden vergangene Tage
 * nachträglich neu zugeordnet.
 */
export async function loescheTagesbeginn(
  db:        Db,
  mandantId: string,
  id:        string,
  jetzt:     Date = new Date(),
): Promise<TagesbeginnLoeschenErgebnis> {
  const heute = heuteKalendertagWien(jetzt)

  // Mandant im WHERE: eine fremde ID findet nichts (404), nicht „gehört mir nicht"
  const [zeile] = await db
    .select()
    .from(mandantTagesbeginn)
    .where(and(eq(mandantTagesbeginn.id, id), eq(mandantTagesbeginn.mandantId, mandantId)))
    .limit(1)
  if (!zeile) throw new GeschaeftstagError(404, 'Eintrag nicht gefunden')

  if (zeile.gueltigAb <= heute) {
    throw new GeschaeftstagError(409,
      'Dieser Tagesbeginn gilt bereits (oder galt schon) und lässt sich nicht mehr zurücknehmen — ' +
      'vergangene Tage bleiben unverändert. Zurücknehmen lassen sich nur geplante Wechsel.')
  }

  await db
    .delete(mandantTagesbeginn)
    .where(and(eq(mandantTagesbeginn.id, id), eq(mandantTagesbeginn.mandantId, mandantId)))

  return {
    stand:     await holeTagesbeginnStand(db, mandantId, jetzt),
    geloescht: { gueltigAb: zeile.gueltigAb, beginn: zeile.beginn },
  }
}
