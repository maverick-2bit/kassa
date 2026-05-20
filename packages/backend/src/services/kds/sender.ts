/**
 * Sender für KDS-Bonierbons via TCP.
 * Identisches Pattern wie drucker.service.ts sendBytes(), nur mit latin1-Text.
 */

import { Socket } from 'node:net'

export interface KdsZiel {
  ip:        string
  port:      number
  timeoutMs?: number
}

export async function sendeBonierbon(text: string, ziel: KdsZiel): Promise<void> {
  const timeoutMs = ziel.timeoutMs ?? 5000

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
    socket.on('error',   (err) => fail(new Error(`KDS-Verbindung: ${err.message}`)))
    socket.on('timeout', ()    => fail(new Error(`KDS-Timeout (${timeoutMs}ms)`)))

    socket.connect(ziel.port, ziel.ip, () => {
      socket.write(text, 'latin1', (err) => {
        if (err) return fail(new Error(`KDS-Schreibfehler: ${err.message}`))
        // KDS sendet 0x12 als Handshake — kurz warten dann schließen
        setTimeout(done, 200)
      })
    })
  })
}
