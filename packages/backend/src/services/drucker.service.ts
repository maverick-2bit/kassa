/**
 * Drucker-Service: Sendet Bons via TCP an ESC/POS-Drucker.
 *
 * Verhalten:
 *   - sendBytes() ist die Low-Level-Funktion (Buffer → Socket)
 *   - druckeBeleg() lädt Beleg/Kasse/Mandant aus der DB, baut den Bon und sendet
 *   - tryDruckeBeleg() ist die "fire-and-forget"-Variante für Auto-Print
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
import { belege, kassen, mandanten } from '../db/schema.js'
import { baueBon, type DruckerKontext, type MandantInfo } from './escpos/layout.js'

export interface DruckerConfig {
  ip:      string
  port:    number
  breite:  number
  timeoutMs?: number
}

export class DruckerError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
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
      reject(err)
    }

    const done = () => {
      if (settled) return
      settled = true
      socket.end()
      resolve()
    }

    socket.setTimeout(timeoutMs)
    socket.on('error',   (err) => fail(new DruckerError(502, `Drucker-Fehler: ${err.message}`)))
    socket.on('timeout', ()    => fail(new DruckerError(504, `Drucker-Timeout (${timeoutMs}ms)`)))

    socket.connect(config.port, config.ip, () => {
      socket.write(bytes, (err) => {
        if (err) return fail(new DruckerError(502, `Schreibfehler: ${err.message}`))
        // Kurz warten damit der Drucker alles verarbeitet, dann schließen
        setTimeout(done, 100)
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Konvenz: Druck-Konfiguration aus Kasse extrahieren
// ---------------------------------------------------------------------------

export function druckerConfigVonKasse(kasse: {
  druckerIp:     string | null
  druckerPort:   number
  druckerAktiv:  boolean
  druckerBreite: number
}): DruckerConfig | null {
  if (!kasse.druckerAktiv || !kasse.druckerIp) return null
  return {
    ip:     kasse.druckerIp,
    port:   kasse.druckerPort,
    breite: kasse.druckerBreite,
  }
}

// ---------------------------------------------------------------------------
// High-Level: Beleg drucken (DB-Lookup + Bon-Aufbau + Senden)
// ---------------------------------------------------------------------------

export async function druckeBeleg(db: Db, belegId: string): Promise<void> {
  // Beleg laden
  const [beleg] = await db
    .select()
    .from(belege)
    .where(eq(belege.id, belegId))
    .limit(1)
  if (!beleg) throw new DruckerError(404, 'Beleg nicht gefunden')

  // Kasse laden
  const [kasse] = await db
    .select()
    .from(kassen)
    .where(eq(kassen.id, beleg.kasseId))
    .limit(1)
  if (!kasse) throw new DruckerError(404, 'Kasse nicht gefunden')

  const druckerConfig = druckerConfigVonKasse(kasse)
  if (!druckerConfig) {
    throw new DruckerError(409, 'Drucker für diese Kasse ist nicht konfiguriert oder deaktiviert')
  }

  // Mandant laden
  const [mandant] = await db
    .select()
    .from(mandanten)
    .where(eq(mandanten.id, beleg.mandantId))
    .limit(1)
  if (!mandant) throw new DruckerError(404, 'Mandant nicht gefunden')

  // Bon-Bytes aufbauen
  const belegDto: BelegResponse = belegRowZuDto(beleg)
  const mandantInfo: MandantInfo = {
    firmenname: mandant.firmenname,
    uid:        mandant.uid,
    kassenId:   kasse.kassenId,
  }
  const kontext: DruckerKontext = { breite: druckerConfig.breite }
  const bytes = baueBon(belegDto, mandantInfo, kontext)

  // Senden
  await sendBytes(bytes, druckerConfig)
}

/**
 * "Fire-and-forget"-Variante für Auto-Print nach Beleg-Erstellung.
 * Loggt Fehler, wirft aber nichts. Niemals den Beleg-Endpoint blockieren.
 */
export function tryDruckeBeleg(
  db:     Db,
  belegId: string,
  logger:  { error: (obj: unknown, msg?: string) => void },
): void {
  druckeBeleg(db, belegId).catch((err) => {
    logger.error({ err, belegId }, 'Beleg-Druck fehlgeschlagen (Beleg bleibt gültig signiert)')
  })
}

// ---------------------------------------------------------------------------
// Helfer: DB-Row → BelegResponse (für Druck-Layout)
// ---------------------------------------------------------------------------

function belegRowZuDto(row: typeof belege.$inferSelect): BelegResponse {
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
