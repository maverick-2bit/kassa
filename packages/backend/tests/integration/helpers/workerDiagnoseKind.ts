/**
 * Worker-Diagnose, Kindprozess-Seite (setupFiles in vitest.integration.config.ts).
 *
 * Gegenstück zu workerDiagnoseHaupt.ts: schreibt ein Lebenszeichen je Sekunde
 * (Testdatei, laufender Test, Speicher, offene Handles) und hält jeden Weg
 * fest, auf dem ein Worker von sich aus endet (exit-Ereignis, process.reallyExit
 * mit Stack, nicht abgefangene Ausnahme, Verlust des IPC-Kanals, Konsolen-Signale).
 * Fehlt beim unerwarteten Ende jede dieser Zeilen, wurde der Prozess von außen
 * beendet oder ist nativ abgestürzt — dann sagt der Exit-Code im Hauptprozess mehr.
 */
import { appendFileSync } from 'node:fs'
import { freemem } from 'node:os'
import { beforeEach, afterEach, expect } from 'vitest'

const DATEI = process.env.KASSA_WORKER_DIAGNOSE_DATEI

function zeile(eintrag: Record<string, unknown>): void {
  if (!DATEI) return
  try {
    appendFileSync(DATEI, JSON.stringify({ t: new Date().toISOString(), rolle: 'kind', pid: process.pid, ...eintrag }) + '\n')
  } catch { /* nie stören */ }
}

const zustand: { datei: string; test: string | undefined } = { datei: '', test: undefined }

function speicher(): Record<string, number> {
  const m = process.memoryUsage()
  const mb = (n: number) => Math.round(n / 1048576)
  return { rssMb: mb(m.rss), heapMb: mb(m.heapUsed), externalMb: mb(m.external), freiSystemMb: mb(freemem()) }
}

const g = globalThis as { __kassaWorkerDiagnoseKind?: boolean }
if (DATEI && !g.__kassaWorkerDiagnoseKind) {
  g.__kassaWorkerDiagnoseKind = true
  zustand.datei = expect.getState().testPath ?? ''
  zeile({ ereignis: 'start', datei: zustand.datei, ppid: process.ppid, ...speicher() })

  const herz = setInterval(() => {
    const handles = process.getActiveResourcesInfo()
    const zaehler: Record<string, number> = {}
    for (const h of handles) zaehler[h] = (zaehler[h] ?? 0) + 1
    zeile({ ereignis: 'puls', datei: zustand.datei, test: zustand.test, ...speicher(), handles: zaehler })
  }, 1000)
  herz.unref()

  const echtesReallyExit = (process as unknown as { reallyExit: (code?: number) => never }).reallyExit
  ;(process as unknown as { reallyExit: (code?: number) => never }).reallyExit = function (code?: number) {
    zeile({ ereignis: 'reallyExit', code, test: zustand.test, stack: new Error('reallyExit').stack })
    return echtesReallyExit.call(process, code)
  }
  const echtesAbort = process.abort
  process.abort = function () {
    zeile({ ereignis: 'abort', test: zustand.test, stack: new Error('abort').stack })
    return echtesAbort.call(process)
  }

  process.on('exit', code => zeile({ ereignis: 'exit', code, test: zustand.test }))
  process.on('disconnect', () => zeile({ ereignis: 'ipc-disconnect', test: zustand.test }))
  process.on('uncaughtExceptionMonitor', (err, origin) =>
    zeile({ ereignis: 'uncaught', origin, test: zustand.test, fehler: err instanceof Error ? err.stack : String(err) }))
  process.on('warning', w => zeile({ ereignis: 'warning', name: w.name, nachricht: w.message }))

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
    const handler = (): void => {
      zeile({ ereignis: 'signal', signal: sig, test: zustand.test })
      process.off(sig, handler)
      // Standardverhalten wiederherstellen, wenn sonst niemand zuhört
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig)
    }
    process.on(sig, handler)
  }
}

beforeEach(ctx => { zustand.test = ctx.task.name; zeile({ ereignis: 'test-start', test: ctx.task.name }) })
afterEach(ctx => { zeile({ ereignis: 'test-ende', test: ctx.task.name, status: ctx.task.result?.state }); zustand.test = undefined })
