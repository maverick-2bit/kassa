/**
 * Worker-Diagnose, Hauptprozess-Seite (wird aus vitest.integration.config.ts geladen).
 *
 * Anlass: Volle Integrationsläufe enden unter Windows immer wieder mit
 * „Error: Worker exited unexpectedly" (tinypool). tinypool verwirft dabei
 * Exit-Code und Signal des Kindprozesses — genau die Information, die zwischen
 * „Node ist abgestürzt", „jemand hat den Prozess beendet" und „der Prozess hat
 * sich selbst beendet" unterscheidet.
 *
 * Diese Datei hängt sich an child_process.fork (tinypool importiert `fork`
 * als benannten Import aus node:child_process; syncBuiltinESMExports() aktualisiert
 * diese Live-Bindung) und protokolliert für jeden Worker-Prozess Start und Ende
 * nach test-results/worker-diagnose.jsonl. Endet ein Worker, ohne dass der Pool
 * ihn beendet hat (kein .kill() vorher), steht auf stderr eine deutliche Meldung
 * mit Exit-Code, Signal, letzter Testdatei und dem letzten Lebenszeichen des Kindes.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { dirname } from 'node:path'
import type { ChildProcess } from 'node:child_process'

const require = createRequire(import.meta.url)

export const DIAGNOSE_DATEI_ENV = 'KASSA_WORKER_DIAGNOSE_DATEI'

function zeile(datei: string, eintrag: Record<string, unknown>): void {
  try {
    appendFileSync(datei, JSON.stringify({ t: new Date().toISOString(), ...eintrag }) + '\n')
  } catch { /* Diagnose darf den Lauf nie stören */ }
}

/** Windows-NTSTATUS-Codes, die bei abgestürzten Node-Prozessen vorkommen. */
function deuteExitCode(code: number | null): string | undefined {
  if (code === null) return undefined
  const hex = '0x' + (code >>> 0).toString(16).toUpperCase().padStart(8, '0')
  const bekannt: Record<string, string> = {
    '0xC0000005': 'STATUS_ACCESS_VIOLATION (nativer Absturz)',
    '0xC00000FD': 'STATUS_STACK_OVERFLOW',
    '0xC0000409': 'STATUS_STACK_BUFFER_OVERRUN / __fastfail — nativer Abbruch ohne Meldung; ' +
      'unter Windows + Node 24.0–24.15 der libuv-Fehler nodejs/node#63620, siehe nodeBetroffen()',
    '0xC000013A': 'STATUS_CONTROL_C_EXIT (Strg+C/Konsolen-Ereignis)',
    '0xC0000142': 'STATUS_DLL_INIT_FAILED (Desktop-Heap erschöpft?)',
    '0xC0000017': 'STATUS_NO_MEMORY',
    '0xC000012D': 'STATUS_COMMITMENT_LIMIT (Auslagerungsdatei voll)',
    '0x00000086': '134 = abort()',
  }
  return bekannt[hex] ?? (code > 255 ? hex : undefined)
}

/**
 * Node 24.0–24.15 unter Windows (libuv 1.50/1.51): Stack-Überlauf in
 * uv__tcp_connect, den /GS per __fastfail in einen stillen Prozesstod
 * (0xC0000409) verwandelt — kein exit-Ereignis, kein Report, kein WER-Eintrag.
 * Ausgelöst durch viele kurzlebige ausgehende TCP-Verbindungen (hier: je Testdatei
 * Admin-, Migrations-, Pool- und Aufräum-Verbindungen zu PostgreSQL).
 * Behoben ab 24.16.0. https://github.com/nodejs/node/issues/63620
 * Auf diesem Fehler beruhten die „Worker exited unexpectedly"-Abbrüche der Suite
 * (nachgewiesen 2026-11-16: Exit-Code 0xC0000409, Repro aus dem Issue stirbt
 * auf 24.15.0 in 3 von 4 Versuchen). CI und Produktion (Node 22, Linux) betrifft er nicht.
 */
export function nodeBetroffen(plattform: string = process.platform, version = process.versions.node): boolean {
  if (plattform !== 'win32') return false
  const [major, minor] = version.split('.').map(Number)
  return major === 24 && (minor ?? 0) < 16
}

function letzteKindZeilen(datei: string, pid: number, anzahl = 6): unknown[] {
  try {
    return readFileSync(datei, 'utf8').split('\n').filter(Boolean)
      .map(z => { try { return JSON.parse(z) as { pid?: number } } catch { return null } })
      .filter((e): e is { pid?: number } => e !== null && e.pid === pid)
      .slice(-anzahl)
  } catch { return [] }
}

export function installiereWorkerDiagnose(datei: string): void {
  const g = globalThis as { __kassaWorkerDiagnose?: boolean }
  if (g.__kassaWorkerDiagnose) return
  g.__kassaWorkerDiagnose = true

  mkdirSync(dirname(datei), { recursive: true })
  writeFileSync(datei, '')
  process.env[DIAGNOSE_DATEI_ENV] = datei
  zeile(datei, { rolle: 'haupt', ereignis: 'start', pid: process.pid, node: process.version, argv: process.argv.slice(1) })
  if (nodeBetroffen()) {
    process.stderr.write(
      `\n[worker-diagnose] WARNUNG: Node ${process.version} unter Windows hat den libuv-Fehler nodejs/node#63620 ` +
      `(stiller Prozesstod 0xC0000409 beim TCP-Verbindungsaufbau). Einzelne Worker sterben dann mit ` +
      `„Worker exited unexpectedly". Abhilfe: Node >= 24.16.0 (oder Node 22 wie CI) installieren.\n\n`,
    )
  }

  const cp = require('node:child_process') as typeof import('node:child_process')
  const originalFork = cp.fork
  const startZeit = new Map<number, number>()

  const umhuellt = function (this: unknown, ...args: Parameters<typeof originalFork>): ChildProcess {
    const kind = (originalFork as (...a: unknown[]) => ChildProcess).apply(this, args)
    const pid = kind.pid ?? -1
    let vomPoolBeendet = false
    startZeit.set(pid, Date.now())
    zeile(datei, { rolle: 'haupt', ereignis: 'fork', pid })

    const originalKill = kind.kill.bind(kind)
    kind.kill = (signal?: NodeJS.Signals | number) => {
      vomPoolBeendet = true
      return originalKill(signal)
    }

    kind.on('exit', (code, signal) => {
      const lebensdauerMs = Date.now() - (startZeit.get(pid) ?? Date.now())
      startZeit.delete(pid)
      const eintrag = {
        rolle: 'haupt', ereignis: 'exit', pid, code, signal, vomPoolBeendet, lebensdauerMs,
        deutung: deuteExitCode(code),
      }
      zeile(datei, eintrag)
      if (!vomPoolBeendet) {
        const kindZeilen = letzteKindZeilen(datei, pid)
        process.stderr.write(
          `\n[worker-diagnose] Worker pid ${pid} endete UNERWARTET: code=${code} signal=${signal}` +
          `${eintrag.deutung ? ` (${eintrag.deutung})` : ''}, lebte ${lebensdauerMs} ms.\n` +
          `[worker-diagnose] Letzte Lebenszeichen des Kindes (${datei}):\n` +
          kindZeilen.map(z => `  ${JSON.stringify(z)}`).join('\n') + '\n\n',
        )
      }
    })
    return kind
  }
  cp.fork = umhuellt as typeof originalFork
  syncBuiltinESMExports()
}
