/**
 * Beweist, dass die Testdruck-/Sende-Funktionen die ESC/POS-Bytes VOLLSTÄNDIG
 * übertragen (sauberes socket.end statt abruptem destroy — sonst verwirft der
 * Drucker die gerade gesendeten Bytes: „Testdruck gesendet, aber nichts kommt").
 *
 * In-Process-TCP-Server als Fake-Drucker → deterministisch, kein echter Drucker.
 */

import { describe, it, expect, afterEach } from 'vitest'
import net from 'net'
import { sendBytes } from '../../src/services/drucker.service.js'
import { testdruckDrucker } from '../../src/services/drucker-pool.service.js'
import { testdruckBonierdrucker, druckeBonierbonDirekt } from '../../src/services/bonierdrucker.service.js'

let server: net.Server | null = null

afterEach(() => {
  server?.close()
  server = null
})

/** Startet einen Fake-Drucker, der alle empfangenen Bytes sammelt. */
function fakeDrucker(): Promise<{ port: number; empfangen: () => Buffer }> {
  const chunks: Buffer[] = []
  return new Promise((resolve) => {
    server = net.createServer((sock) => {
      sock.on('data', (d) => chunks.push(d))
      sock.on('error', () => { /* ignore */ })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server!.address() as net.AddressInfo).port
      resolve({ port, empfangen: () => Buffer.concat(chunks) })
    })
  })
}

describe('Drucker-Sendepfad überträgt Bytes vollständig', () => {
  it('sendBytes liefert den kompletten Buffer aus', async () => {
    const { port, empfangen } = await fakeDrucker()
    const nutzlast = Buffer.from('HALLO-DRUCKER-1234567890\n', 'utf8')
    await sendBytes(nutzlast, { ip: '127.0.0.1', port, breite: 42, timeoutMs: 3000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(empfangen().equals(nutzlast)).toBe(true)
  })

  it('testdruckDrucker (Bondrucker) sendet TESTDRUCK, genug Vorschub + Cut', async () => {
    const { port, empfangen } = await fakeDrucker()
    await testdruckDrucker('127.0.0.1', port, 3)
    await new Promise((r) => setTimeout(r, 50))
    const buf = empfangen()
    expect(buf.toString('latin1')).toContain('TESTDRUCK')
    expect(buf.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00]))).toBe(true)  // GS V B 0 = Cut
    // Genug Zeilenvorschub, damit der Bon aus dem Gerät kommt (Kopf-zu-Messer-Abstand)
    const cutIdx = buf.indexOf(Buffer.from([0x1d, 0x56, 0x42, 0x00]))
    const lfVorCut = buf.subarray(0, cutIdx).filter((b) => b === 0x0a).length
    expect(lfVorCut).toBeGreaterThanOrEqual(4)
  })

  it('testdruckBonierdrucker sendet den TESTDRUCK-Bon inkl. Cut', async () => {
    const { port, empfangen } = await fakeDrucker()
    await testdruckBonierdrucker('127.0.0.1', port)
    await new Promise((r) => setTimeout(r, 50))
    const buf = empfangen()
    expect(buf.toString('latin1')).toContain('TESTDRUCK')
    expect(buf.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00]))).toBe(true)
  })

  it('druckeBonierbonDirekt sendet den Bonierbon mit genug Vorschub + Cut', async () => {
    const { port, empfangen } = await fakeDrucker()
    await druckeBonierbonDirekt('127.0.0.1', port, '5', 'Chef', [
      { menge: 2, bezeichnung: 'Pommes', preisLabel: '5,00' },
    ])
    await new Promise((r) => setTimeout(r, 50))
    const buf = empfangen()
    expect(buf.toString('latin1')).toContain('Pommes')
    expect(buf.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00]))).toBe(true)  // GS V B 0 = Cut
    const cutIdx = buf.indexOf(Buffer.from([0x1d, 0x56, 0x42, 0x00]))
    const lfVorCut = buf.subarray(0, cutIdx).filter((b) => b === 0x0a).length
    expect(lfVorCut).toBeGreaterThanOrEqual(4)  // sonst bleibt der Bon im Gerät stecken
  })

  it('meldet Fehler wenn der Drucker nicht erreichbar ist (kein falscher Erfolg)', async () => {
    // Port ohne Listener → Verbindung scheitert, Promise rejectet
    await expect(testdruckDrucker('127.0.0.1', 1, 2)).rejects.toBeTruthy()
  })
})
