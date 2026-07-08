/**
 * Drucker-Service: Sendet Bons via TCP an ESC/POS-Drucker.
 *
 * Features:
 *   - sendBytes()         Low-Level TCP-Übertragung mit konfigurierbarem Timeout
 *   - druckeBeleg()       DB-Lookup + Bon-Aufbau + Senden + Druck-Log
 *   - tryDruckeBeleg()    Fire-and-forget mit automatischem Retry (3 Versuche)
 *   - DruckerStatusCache  Periodischer Connectivity-Check (alle 30s) pro IP
 *
 * Druckfehler propagieren NICHT zum Beleg-Endpoint — der Beleg ist bereits
 * signiert und persistiert. Eine Druckpanne ist ein Hardware-Problem,
 * kein RKSV-Problem.
 */

import { Socket } from 'node:net'
import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import type { BelegResponse, MwStSatz } from '@kassa/shared'
import type { BelegPosition } from '@kassa/rksv'
import type { Db } from '../db/client.js'
import { belege, druckLog, kassen, mandanten } from '../db/schema.js'
import { baueBon, type DruckerKontext, type MandantInfo } from './escpos/layout.js'

export interface DruckerConfig {
  ip:        string
  port:      number
  breite:    number
  timeoutMs?: number
}

export class DruckerError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Status-Cache: hält den letzten bekannten Online-Status je Drucker-IP
// ---------------------------------------------------------------------------

interface DruckerStatus {
  online:    boolean
  geprüftAm: Date
}

const statusCache = new Map<string, DruckerStatus>()

/** Gibt den letzten bekannten Status zurück (oder undefined wenn noch nie geprüft) */
export function getDruckerStatus(ip: string): DruckerStatus | undefined {
  return statusCache.get(ip)
}

/** Alle gecachten Status-Einträge (für Status-Endpoint) */
export function getAlleDruckerStatus(): Record<string, DruckerStatus> {
  return Object.fromEntries(statusCache)
}

/** TCP-Verbindungstest ohne Daten zu senden */
async function prüfeVerbindung(ip: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new Socket()
    let settled  = false

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }

    socket.setTimeout(timeoutMs)
    socket.on('connect', () => finish(true))
    socket.on('error',   () => finish(false))
    socket.on('timeout', () => finish(false))
    socket.connect(port, ip)
  })
}

/** Drucker-Status prüfen und Cache aktualisieren */
export async function aktualisiereStatus(ip: string, port: number): Promise<boolean> {
  const online = await prüfeVerbindung(ip, port)
  statusCache.set(ip, { online, geprüftAm: new Date() })
  return online
}

// ---------------------------------------------------------------------------
// Retry-Queue: gescheiterte Druckjobs werden automatisch wiederholt
// ---------------------------------------------------------------------------

interface RetryJob {
  bytes:      Buffer
  config:     DruckerConfig
  versuch:    number
  logFn?:     (ok: boolean, fehler?: string) => Promise<void>
  logger:     { warn?: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }
}

const RETRY_DELAYS_MS = [2_000, 10_000, 30_000]   // 3 Versuche
const retryQueue      = new Map<string, RetryJob[]>()

function planRetry(job: RetryJob): void {
  const delay = RETRY_DELAYS_MS[job.versuch]
  if (delay === undefined) {
    job.logger.error({ ip: job.config.ip, versuch: job.versuch }, 'Drucker-Retry erschöpft — Druckjob endgültig gescheitert')
    void job.logFn?.(false, `Alle ${RETRY_DELAYS_MS.length + 1} Versuche fehlgeschlagen`)
    return
  }

  const queue = retryQueue.get(job.config.ip) ?? []
  queue.push({ ...job, versuch: job.versuch + 1 })
  retryQueue.set(job.config.ip, queue)

  setTimeout(async () => {
    const q = retryQueue.get(job.config.ip) ?? []
    const idx = q.findIndex(j => j === job || (j.versuch === job.versuch + 1))
    if (idx !== -1) q.splice(idx, 1)
    if (q.length === 0) retryQueue.delete(job.config.ip)

    job.logger.warn?.({ ip: job.config.ip, versuch: job.versuch + 1 }, `Drucker-Retry Versuch ${job.versuch + 1}`)
    try {
      await sendBytes(job.bytes, job.config)
      statusCache.set(job.config.ip, { online: true, geprüftAm: new Date() })
      void job.logFn?.(true)
    } catch {
      planRetry({ ...job, versuch: job.versuch + 1 })
    }
  }, delay)
}

// ---------------------------------------------------------------------------
// Low-Level: Buffer via TCP an Drucker senden
// ---------------------------------------------------------------------------

export async function sendBytes(bytes: Buffer, config: DruckerConfig): Promise<void> {
  const timeoutMs = config.timeoutMs ?? 5000

  return new Promise((resolve, reject) => {
    const socket = new Socket()
    let settled  = false

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      statusCache.set(config.ip, { online: false, geprüftAm: new Date() })
      reject(err)
    }

    const done = () => {
      if (settled) return
      settled = true
      socket.end()
      statusCache.set(config.ip, { online: true, geprüftAm: new Date() })
      resolve()
    }

    socket.setTimeout(timeoutMs)
    socket.on('error',   (err) => fail(new DruckerError(502, `Drucker-Fehler: ${err.message}`)))
    socket.on('timeout', ()    => fail(new DruckerError(504, `Drucker-Timeout (${timeoutMs}ms)`)))

    socket.connect(config.port, config.ip, () => {
      socket.write(bytes, (err) => {
        if (err) return fail(new DruckerError(502, `Schreibfehler: ${err.message}`))
        setTimeout(done, 100)
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Druck-Log Helper
// ---------------------------------------------------------------------------

async function logDruck(
  db:        Db,
  mandantId: string,
  ip:        string,
  typ:       'bon' | 'bonierbon' | 'test',
  erfolg:    boolean,
  opts?:     { kasseId?: string; belegId?: string; fehlerText?: string },
): Promise<void> {
  try {
    await db.insert(druckLog).values({
      mandantId,
      druckerIp:  ip,
      druckerTyp: typ,
      erfolg,
      ...(opts?.kasseId    ? { kasseId:    opts.kasseId    } : {}),
      ...(opts?.belegId    ? { belegId:    opts.belegId    } : {}),
      ...(opts?.fehlerText ? { fehlerText: opts.fehlerText } : {}),
    })
  } catch { /* Log-Fehler nie nach oben propagieren */ }
}

// ---------------------------------------------------------------------------
// Konvenz: Druck-Konfiguration aus Kasse extrahieren
// ---------------------------------------------------------------------------

export function druckerConfigVonKasse(kasse: {
  druckerIp:         string | null
  druckerPort:       number
  druckerAktiv:      boolean
  druckerBreite:     number
  druckerTimeoutSek: number
  belegModus?:       string
}, opts?: { ignoreBelegModus?: boolean }): DruckerConfig | null {
  // Reiner Digital-Modus (QR) → normal gar nicht drucken. Ausnahme: Ausweich-Druck
  // („Nicht akzeptiert") setzt ignoreBelegModus und druckt auf den Kassa-Bondrucker.
  if (!opts?.ignoreBelegModus && kasse.belegModus === 'digital') return null
  if (!kasse.druckerAktiv || !kasse.druckerIp) return null
  return {
    ip:        kasse.druckerIp,
    port:      kasse.druckerPort,
    breite:    kasse.druckerBreite,
    timeoutMs: kasse.druckerTimeoutSek * 1000,
  }
}

// ---------------------------------------------------------------------------
// High-Level: Beleg drucken (DB-Lookup + Bon-Aufbau + Senden + Log)
// ---------------------------------------------------------------------------

export async function druckeBeleg(db: Db, belegId: string, opts?: { ignoreModus?: boolean }): Promise<void> {
  const [beleg] = await db.select().from(belege).where(eq(belege.id, belegId)).limit(1)
  if (!beleg) throw new DruckerError(404, 'Beleg nicht gefunden')

  const [kasse] = await db.select().from(kassen).where(eq(kassen.id, beleg.kasseId)).limit(1)
  if (!kasse) throw new DruckerError(404, 'Kasse nicht gefunden')

  const druckerConfig = druckerConfigVonKasse(kasse, { ignoreBelegModus: opts?.ignoreModus ?? false })
  if (!druckerConfig) throw new DruckerError(409, 'Drucker nicht konfiguriert oder deaktiviert')

  const [mandant] = await db.select().from(mandanten).where(eq(mandanten.id, beleg.mandantId)).limit(1)
  if (!mandant) throw new DruckerError(404, 'Mandant nicht gefunden')

  const belegDto: BelegResponse  = belegRowZuDto(beleg)
  const mandantInfo: MandantInfo = { firmenname: mandant.firmenname, uid: mandant.uid, kassenId: kasse.kassenId }
  const kontext: DruckerKontext  = { breite: druckerConfig.breite }
  const bytes = baueBon(belegDto, mandantInfo, kontext)

  try {
    await sendBytes(bytes, druckerConfig)
    await logDruck(db, beleg.mandantId, druckerConfig.ip, 'bon', true, { kasseId: kasse.id, belegId })
  } catch (err) {
    await logDruck(db, beleg.mandantId, druckerConfig.ip, 'bon', false, {
      kasseId:    kasse.id,
      belegId,
      fehlerText: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/**
 * Fire-and-forget mit Retry (3 Versuche: 2s, 10s, 30s).
 * Blockiert den Beleg-Endpoint nie.
 */
export function tryDruckeBeleg(
  db:      Db,
  belegId: string,
  logger:  { warn?: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void },
): void {
  druckeBeleg(db, belegId).catch(async (err) => {
    logger.warn?.({ err, belegId }, 'Beleg-Druck fehlgeschlagen — starte Retry-Queue')

    // Config nochmal laden für Retry
    try {
      const [beleg] = await db.select({ kasseId: belege.kasseId, mandantId: belege.mandantId })
        .from(belege).where(eq(belege.id, belegId)).limit(1)
      if (!beleg) return

      const [kasse] = await db.select().from(kassen).where(eq(kassen.id, beleg.kasseId)).limit(1)
      if (!kasse) return

      const config = druckerConfigVonKasse(kasse)
      if (!config) return

      const [mandant] = await db.select().from(mandanten).where(eq(mandanten.id, beleg.mandantId)).limit(1)
      if (!mandant) return

      const bytes = baueBon(
        belegRowZuDto((await db.select().from(belege).where(eq(belege.id, belegId)).limit(1))[0]!),
        { firmenname: mandant.firmenname, uid: mandant.uid, kassenId: kasse.kassenId },
        { breite: config.breite },
      )

      planRetry({
        bytes,
        config,
        versuch: 0,
        logger,
        logFn: (ok, fehlerText) => logDruck(db, beleg.mandantId, config.ip, 'bon', ok, {
          kasseId: kasse.id, belegId, ...(fehlerText ? { fehlerText } : {}),
        }),
      })
    } catch (retryErr) {
      logger.error({ retryErr, belegId }, 'Retry-Vorbereitung fehlgeschlagen')
    }
  })
}

// ---------------------------------------------------------------------------
// Helfer: DB-Row → BelegResponse (für Druck-Layout)
// ---------------------------------------------------------------------------

export function belegRowZuDto(row: typeof belege.$inferSelect): BelegResponse {
  const betraege = {
    normal:      row.betragNormalCent,
    ermaessigt1: row.betragErmaessigt1Cent,
    ermaessigt2: row.betragErmaessigt2Cent,
    null:        row.betragNullCent,
    besonders:   row.betragBesondersCent,
  }
  const gesamtbetragCent =
    betraege.normal + betraege.ermaessigt1 + betraege.ermaessigt2 + betraege.null + betraege.besonders

  return {
    id:                          row.id,
    belegNummer:                 row.belegNummer,
    belegDatum:                  row.belegDatum.toISOString(),
    belegTyp:                    row.belegTyp,
    betraege,
    summeBarCent:                row.summeBarCent,
    summeKarteCent:              row.summeKarteCent,
    summeSonstigeCent:           row.summeSonstigeCent,
    gesamtbetragCent,
    positionen:                  (row.positionen as BelegPosition[]).map((p) => ({
      bezeichnung:        p.bezeichnung,
      menge:              p.menge,
      einzelpreisBreutto: p.einzelpreisBreutto,
      mwstSatz:           p.mwstSatz as MwStSatz,
    })),
    zertifikatSn:                row.zertifikatSn,
    sigVorbeleg:                 row.sigVorbeleg,
    signaturwert:                row.signaturwert,
    umsatzzaehlerVerschluesselt: row.umsatzzaehlerVerschluesselt,
    maschinenlesbareCode:        row.maschinenlesbareCode,
    createdAt:                   row.createdAt.toISOString(),
  }
}
