import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { sha256Hex, ticketCodeHash } from './sha256.js'
import { TICKET_CODE_ALPHABET } from './schemas/ticket.js'

const node = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

describe('sha256Hex (reines JS, gleich wie node:crypto)', () => {
  it('bekannte Prüfwerte', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('Blockgrenzen (55/56/63/64/65 Byte) und lange Texte', () => {
    for (const n of [55, 56, 63, 64, 65, 119, 120, 1000]) {
      const text = 'x'.repeat(n)
      expect(sha256Hex(text)).toBe(node(text))
    }
  })

  it('UTF-8 (Umlaute, Emoji)', () => {
    for (const text of ['Grüße aus Österreich', 'ß€✓🎫', 'Tracht & Lederhose']) {
      expect(sha256Hex(text)).toBe(node(text))
    }
  })

  it('zufällige Ticket-Codes', () => {
    for (let i = 0; i < 200; i++) {
      const code = Array.from(randomBytes(16), b => TICKET_CODE_ALPHABET[b % TICKET_CODE_ALPHABET.length]).join('')
      expect(ticketCodeHash(code)).toBe(node(code))
    }
  })
})
