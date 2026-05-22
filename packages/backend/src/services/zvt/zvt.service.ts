/**
 * ZVT-Service — Job-basierte Kartenzahlungs-Orchestrierung.
 *
 * Ablauf:
 *   1. `starteZahlung()` legt einen Job an und gibt sofort die jobId zurück
 *   2. Im Hintergrund: TCP-Connect (3s-Timeout) → Authorization → empfange Pakete
 *   3. Frontend pollt `getJob()` alle ~500 ms und zeigt Status
 *   4. `abbrechen()` schließt Socket sofort — keine Wartezeit auf Terminal-Timeout
 *
 * Jobs werden im Memory gehalten (Map). Beendete Jobs werden nach 10 Minuten
 * automatisch aufgeräumt.
 */

import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import net from 'node:net'
import { and, eq } from 'drizzle-orm'
import type { ZvtErgebnis, ZvtJob, ZvtZahlungInput } from '@kassa/shared'
import type { Db } from '../../db/client.js'
import { kassen } from '../../db/schema.js'
import {
  PAKET_ABBRUCH,
  PAKET_ACK_POSITIV,
  buildAuthorization,
  parseCompletion,
  parsePackets,
  statusMeldung,
} from './protocol.js'

const CONNECT_TIMEOUT_MS    = 3_000
const TRANSACTION_TIMEOUT_MS = 90_000
const JOB_TTL_MS            = 10 * 60_000

export class ZvtError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

interface JobState {
  job:     ZvtJob
  socket:  net.Socket | null
  abgebrochen: boolean
  cleanup: NodeJS.Timeout | null
}

const jobs = new Map<string, JobState>()

export interface ZvtServiceDeps { db: Db }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function starteZahlung(
  input: ZvtZahlungInput,
  mandantId: string,
  deps: ZvtServiceDeps,
): Promise<{ jobId: string }> {
  const [kasse] = await deps.db
    .select()
    .from(kassen)
    .where(and(eq(kassen.id, input.kasseId), eq(kassen.mandantId, mandantId)))
    .limit(1)
  if (!kasse)            throw new ZvtError(404, 'Kasse nicht gefunden')
  if (!kasse.zvtAktiv)   throw new ZvtError(409, 'ZVT-Kartenterminal ist deaktiviert')
  if (!kasse.zvtIp)      throw new ZvtError(409, 'Terminal-IP nicht konfiguriert')

  const id = randomUUID()
  const state: JobState = {
    job: {
      id,
      status:      'verbinde',
      betragCent:  input.betragCent,
      meldung:     'Verbinde mit Terminal…',
      gestartetAm: new Date().toISOString(),
    },
    socket:      null,
    abgebrochen: false,
    cleanup:     null,
  }
  jobs.set(id, state)

  // Stub-Modus: zvtIp === 'stub' → simulierte Transaktion ohne echtes Terminal
  if (kasse.zvtIp.toLowerCase() === 'stub') {
    fuehreStubAus(state)
  } else {
    fuehreTcpAus(state, kasse.zvtIp, kasse.zvtPort, input.betragCent, kasse.zvtPasswort)
  }

  return { jobId: id }
}

export function getJob(id: string): ZvtJob | null {
  return jobs.get(id)?.job ?? null
}

export function abbrechen(id: string): ZvtJob | null {
  const state = jobs.get(id)
  if (!state) return null
  const istBeendet = ['erfolg', 'fehler', 'abgebrochen'].includes(state.job.status)
  if (istBeendet) return state.job

  state.abgebrochen = true
  if (state.socket) {
    // Best-effort Abort an Terminal senden, dann hart trennen
    try { state.socket.write(PAKET_ABBRUCH) } catch { /* ignore */ }
    state.socket.destroy()
  }
  finalisiere(state, 'abgebrochen', 'Vom Kassier abgebrochen')
  return state.job
}

// ---------------------------------------------------------------------------
// Job-Finalisierung + Auto-Cleanup
// ---------------------------------------------------------------------------

function finalisiere(
  state:   JobState,
  status:  'erfolg' | 'fehler' | 'abgebrochen',
  meldung: string,
  ergebnis?: ZvtErgebnis,
): void {
  if (['erfolg', 'fehler', 'abgebrochen'].includes(state.job.status)) return
  state.job.status     = status
  state.job.meldung    = meldung
  state.job.beendetAm  = new Date().toISOString()
  if (ergebnis) state.job.ergebnis = ergebnis
  if (status !== 'erfolg' && !state.job.fehler && status !== 'abgebrochen') {
    state.job.fehler = meldung
  }
  // Auto-Cleanup nach TTL
  state.cleanup = setTimeout(() => jobs.delete(state.job.id), JOB_TTL_MS)
  state.cleanup.unref?.()
}

// ---------------------------------------------------------------------------
// TCP-Implementierung
// ---------------------------------------------------------------------------

function fuehreTcpAus(
  state:        JobState,
  ip:           string,
  port:         number,
  betragCent:   number,
  passwort:     string | null,
): void {
  const socket = new net.Socket()
  state.socket = socket
  let buffer: Buffer = Buffer.alloc(0)
  const ergebnis: ZvtErgebnis = {}

  // Connect-Timeout: 3 Sekunden bis zum Verbindungsaufbau
  socket.setTimeout(CONNECT_TIMEOUT_MS)

  socket.once('timeout', () => {
    if (state.job.status === 'verbinde') {
      socket.destroy()
      finalisiere(state, 'fehler', `Keine Verbindung zum Terminal (${ip}:${port})`)
    } else {
      // Bereits verbunden — Transaktions-Timeout greift jetzt
      socket.destroy()
      finalisiere(state, 'fehler', 'Terminal antwortet nicht (Timeout)')
    }
  })

  socket.once('error', (err) => {
    if (state.abgebrochen) return
    finalisiere(state, 'fehler', `Verbindungsfehler: ${err.message}`)
  })

  socket.once('close', () => {
    // Falls noch nicht finalisiert (z.B. Server hat unerwartet getrennt)
    if (!state.job.beendetAm && !state.abgebrochen) {
      finalisiere(state, 'fehler', 'Verbindung unerwartet getrennt')
    }
  })

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    const { packets, rest } = parsePackets(buffer)
    buffer = Buffer.from(rest)
    for (const p of packets) verarbeitePaket(p, socket, state, ergebnis)
  })

  socket.connect(port, ip, () => {
    socket.setTimeout(TRANSACTION_TIMEOUT_MS)
    state.job.status  = 'autorisiere'
    state.job.meldung = 'Warte auf Karte…'
    socket.write(buildAuthorization(betragCent, passwort ?? undefined))
  })
}

function verarbeitePaket(
  packet:   { cla: number; ins: number; data: Buffer },
  socket:   net.Socket,
  state:    JobState,
  ergebnis: ZvtErgebnis,
): void {
  const { cla, ins, data } = packet

  // ACK / NACK vom Terminal
  if (cla === 0x80) return
  if (cla === 0x84) {
    finalisiere(state, 'fehler', 'Terminal lehnt Anfrage ab (Negativ-ACK)')
    socket.destroy()
    return
  }

  // Quittiere alle anderen Pakete sofort
  try { socket.write(PAKET_ACK_POSITIV) } catch { /* ignore */ }

  if (cla === 0x06 && ins === 0x0F) {
    // Completion → Erfolg
    Object.assign(ergebnis, parseCompletion(data))
    finalisiere(state, 'erfolg', 'Zahlung erfolgreich', ergebnis)
    socket.end()
  } else if (cla === 0x06 && ins === 0x1E) {
    // Abort vom Terminal (Karte abgelehnt, abgebrochen, …)
    finalisiere(state, 'fehler', 'Vorgang vom Terminal abgebrochen')
    socket.end()
  } else if (cla === 0x04 && ins === 0x0F) {
    // Status-Info → Meldung für UI aktualisieren
    const m = statusMeldung(data)
    if (m) state.job.meldung = m
  } else if (cla === 0x06 && ins === 0xD1) {
    // Print Line — Bon-Zeile sammeln (falls vom Terminal mitgeliefert)
    const text = data.toString('latin1').replace(/[\r\n\x00]/g, '').trim()
    if (text) {
      ergebnis.bonZeilen = ergebnis.bonZeilen ?? []
      ergebnis.bonZeilen.push(text)
    }
  }
}

// ---------------------------------------------------------------------------
// Stub-Modus (für Entwicklung ohne Hardware)
// ---------------------------------------------------------------------------

function fuehreStubAus(state: JobState): void {
  const phasen = [
    { delay:  800, meldung: 'Verbunden — warte auf Karte…',  status: 'autorisiere' as const },
    { delay: 1500, meldung: 'Karte eingesteckt — PIN-Eingabe', status: 'autorisiere' as const },
    { delay: 1200, meldung: 'Autorisierung läuft…',           status: 'autorisiere' as const },
  ]
  let i = 0
  const schritt = () => {
    if (state.abgebrochen) return
    if (i >= phasen.length) {
      finalisiere(state, 'erfolg', 'Zahlung erfolgreich (Stub)', {
        traceNummer:   '000001',
        belegnummer:   '0001',
        kartenmarke:   'STUB-CARD',
        autorisierung: 'TEST',
      })
      return
    }
    const p = phasen[i++]!
    setTimeout(() => {
      if (state.abgebrochen) return
      state.job.status  = p.status
      state.job.meldung = p.meldung
      schritt()
    }, p.delay)
  }
  schritt()
}
