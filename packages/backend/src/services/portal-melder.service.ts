/**
 * Portal-Melder: schickt den technischen Zustand dieser Box regelmäßig an das Serviceportal.
 *
 * - nur technischer Zustand (siehe PortalMeldungSchema) — keine Umsätze, Belege, Kunden- oder Mitarbeiterdaten
 * - die Box ruft von sich aus nach außen (HTTPS POST); es wird kein Port geöffnet
 * - ohne PORTAL_URL + PORTAL_TOKEN passiert nichts
 * - jede Meldung wird vor dem Senden gegen das Schema geprüft: was nicht im Schema steht, verlässt die Box nicht
 * - ein Fehlschlag verliert keine Fehlerberichte: sie gehen mit der nächsten Meldung raus
 */

import { createRequire } from 'node:module'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { PortalMeldungSchema, type PortalMeldung, type PortalStatus } from '@kassa/shared'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { bonProbleme, kassen, mandanten } from '../db/schema.js'
import { holeBackupStatus, holeSpeicherStatus } from './monitoring.service.js'
import { holeDruckerKeepAliveStatus } from './drucker-keepalive.service.js'
import { entnehmeFehler, gibFehlerZurueck } from './fehler-sammler.js'

const require = createRequire(import.meta.url)
const { version: VERSION } = require('../../package.json') as { version: string }

const START = Date.now()
const TIMEOUT_MS = 10_000

type Logger = {
  info:  (msg: string) => void
  warn?: (obj: unknown, msg: string) => void
  error: (obj: unknown, msg: string) => void
}

type PortalConfig = Pick<Config, 'PORTAL_URL' | 'PORTAL_TOKEN' | 'PORTAL_INTERVALL_SEKUNDEN'> &
  Partial<Pick<Config, 'DB_BACKUP_DIR' | 'DB_BACKUP_MAX_AGE_STUNDEN' | 'DEP_BACKUP_MAX_AGE_STUNDEN'>>

export function portalAktiv(config: Pick<Config, 'PORTAL_URL' | 'PORTAL_TOKEN'>): boolean {
  return !!config.PORTAL_URL && !!config.PORTAL_TOKEN
}

const zustand = {
  letzterErfolg:  null as string | null,
  letzterVersuch: null as string | null,
  letzterFehler:  null as string | null,
  fehlerInFolge:  0,
}

/** Stand der Verbindung (für die Anzeige in den Einstellungen) — nie mit Token. */
export function holePortalStatus(config: PortalConfig): PortalStatus {
  let host: string | null = null
  try { host = config.PORTAL_URL ? new URL(config.PORTAL_URL).host : null } catch { host = null }
  return {
    aktiv:             portalAktiv(config),
    host,
    intervallSekunden: portalAktiv(config) ? config.PORTAL_INTERVALL_SEKUNDEN : null,
    letzterErfolg:     zustand.letzterErfolg,
    letzterVersuch:    zustand.letzterVersuch,
    letzterFehler:     zustand.letzterFehler,
    fehlerInFolge:     zustand.fehlerInFolge,
  }
}

/**
 * Baut die Meldung aus dem Ist-Zustand dieser Box. Mit `fehler` werden die gesammelten Fehlerberichte mitgegeben
 * (der Aufrufer entscheidet, ob er sie entnimmt).
 */
export async function baueMeldung(
  db:     Db,
  config: PortalConfig,
  fehler: PortalMeldung['fehler'] = [],
  jetzt:  Date = new Date(),
): Promise<PortalMeldung> {
  let dbOk = false
  let latenzMs: number | null = null
  try {
    const t0 = Date.now()
    await db.execute(sql`SELECT 1`)
    latenzMs = Date.now() - t0
    dbOk = true
  } catch { /* Datenbank nicht erreichbar → ok:false */ }

  const backups  = await holeBackupStatus(db, config.DB_BACKUP_MAX_AGE_STUNDEN ?? 48, config.DEP_BACKUP_MAX_AGE_STUNDEN ?? 48)
  const speicher = await holeSpeicherStatus(config.DB_BACKUP_DIR ?? '/data/db-backups')

  const betriebeRows = await db
    .select({ id: mandanten.id, firmenname: mandanten.firmenname, status: mandanten.status })
    .from(mandanten)
    .where(eq(mandanten.status, 'aktiv'))

  const kassenRows = await db
    .select({
      id:                 kassen.id,
      mandantId:          kassen.mandantId,
      kassenId:           kassen.kassenId,
      bezeichnung:        kassen.bezeichnung,
      status:             kassen.status,
      umgebung:           kassen.umgebung,
      seeTyp:             kassen.seeTyp,
      seeAusgefallenSeit: kassen.seeAusgefallenSeit,
      seeGueltigBis:      kassen.seeGueltigBis,
    })
    .from(kassen)

  const offene = await db
    .select({ kasseId: bonProbleme.kasseId, n: sql<number>`count(*)::int` })
    .from(bonProbleme)
    .where(and(isNull(bonProbleme.erledigtAt)))
    .groupBy(bonProbleme.kasseId)
  const offeneJeKasse = new Map(offene.map(o => [o.kasseId, o.n]))

  const betriebe = betriebeRows.map(b => ({
    id:         b.id,
    firmenname: b.firmenname,
    status:     b.status,
    kassen: kassenRows.filter(k => k.mandantId === b.id).map(k => ({
      id:                 k.id,
      kassenId:           k.kassenId,
      bezeichnung:        k.bezeichnung ?? null,
      status:             k.status,
      umgebung:           k.umgebung,
      seeTyp:             k.seeTyp,
      seeAusgefallenSeit: k.seeAusgefallenSeit ? k.seeAusgefallenSeit.toISOString() : null,
      seeGueltigBis:      k.seeGueltigBis.toISOString(),
      offeneBonProbleme:  offeneJeKasse.get(k.id) ?? 0,
    })),
    // Nur Name und Erreichbarkeit — keine Adresse (IP/Port) des Druckers
    drucker: holeDruckerKeepAliveStatus(b.id).map(d => ({
      quelle:     d.quelle,
      name:       d.name.slice(0, 100),
      erreichbar: d.ok,
      geprueftAm: d.geprueftAm,
      fehler:     d.fehler ? d.fehler.slice(0, 200) : null,
    })),
  }))

  const meldung: PortalMeldung = {
    schema:     1,
    gesendetAm: jetzt.toISOString(),
    version:    VERSION,
    uptimeSek:  Math.floor((jetzt.getTime() - START) / 1000),
    db:         { ok: dbOk, latenzMs },
    backups:    { dbBackup: backups.dbBackup, depBackup: backups.depBackup },
    speicher:   {
      zustand:     speicher.zustand,
      gesamtGb:    speicher.gesamtGb,
      freiGb:      speicher.freiGb,
      freiProzent: speicher.freiProzent,
    },
    betriebe,
    fehler,
  }
  // Das Schema ist die Grenze: Zusatzfelder werden verworfen, Verstöße lassen die Meldung nicht raus
  return PortalMeldungSchema.parse(meldung)
}

/** Eine Meldung senden. Gibt true bei Erfolg zurück; ein Fehlschlag wird vermerkt, wirft aber nie. */
export async function sendeMeldung(
  db:     Db,
  config: PortalConfig,
  log?:   Logger,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!portalAktiv(config)) return false

  const fehler = entnehmeFehler()
  zustand.letzterVersuch = new Date().toISOString()
  try {
    const meldung = await baueMeldung(db, config, fehler)
    const res = await fetchFn(`${config.PORTAL_URL}/api/box/meldung`, {
      method:  'POST',
      headers: {
        'content-type':  'application/json',
        'authorization': `Bearer ${config.PORTAL_TOKEN}`,
        'user-agent':    `kassa-melder/${VERSION}`,
      },
      body:   JSON.stringify(meldung),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Das Portal antwortete mit HTTP ${res.status}`)

    zustand.letzterErfolg = new Date().toISOString()
    zustand.letzterFehler = null
    zustand.fehlerInFolge = 0
    return true
  } catch (err) {
    gibFehlerZurueck(fehler)   // nichts verlieren — mit der nächsten Meldung
    zustand.fehlerInFolge += 1
    zustand.letzterFehler = (err instanceof Error ? err.message : String(err)).slice(0, 200)
    // Erst beim dritten Fehlschlag in Folge (und dann selten) ins Log — ein Portal-Ausfall soll das Log nicht fluten
    if (zustand.fehlerInFolge === 3 || zustand.fehlerInFolge % 60 === 0) {
      log?.error({ err }, `Portal-Meldung fehlgeschlagen (${zustand.fehlerInFolge}× in Folge)`)
    }
    return false
  }
}

/** Nur für Tests */
export function _setzePortalZustandZurueck(): void {
  zustand.letzterErfolg = null
  zustand.letzterVersuch = null
  zustand.letzterFehler = null
  zustand.fehlerInFolge = 0
}
