import { describe, it, expect } from 'vitest'
import { encryptPrivateKey, decryptPrivateKey } from '../src/crypto/master-key.js'

describe('master-key', () => {
  const passphrase = 'eine-sehr-lange-passphrase-fuer-tests'
  const plaintext  = Buffer.from('Geheime SEE-Private-Key-Daten')

  it('Roundtrip: verschlüsseln und entschlüsseln liefert das Original', () => {
    const encrypted = encryptPrivateKey(plaintext, passphrase)
    const decrypted = decryptPrivateKey(encrypted, passphrase)
    expect(decrypted.equals(plaintext)).toBe(true)
  })

  it('verschiedene Aufrufe liefern verschiedene Ciphertexte (zufälliger Salt+IV)', () => {
    const a = encryptPrivateKey(plaintext, passphrase)
    const b = encryptPrivateKey(plaintext, passphrase)
    expect(a).not.toBe(b)
  })

  it('falsche Passphrase wirft Fehler (Auth-Tag-Verifikation)', () => {
    const encrypted = encryptPrivateKey(plaintext, passphrase)
    expect(() => decryptPrivateKey(encrypted, 'falsche-passphrase')).toThrow()
  })

  it('manipulierter Ciphertext wirft Fehler', () => {
    const encrypted = encryptPrivateKey(plaintext, passphrase)
    const tampered  = Buffer.from(encrypted, 'base64')
    // Letztes Byte umflippen (Teil des Ciphertexts)
    const lastByte = tampered[tampered.length - 1]
    if (lastByte === undefined) throw new Error('Container leer')
    tampered[tampered.length - 1] = lastByte ^ 0x01

    expect(() => decryptPrivateKey(tampered.toString('base64'), passphrase)).toThrow()
  })

  it('großer Plaintext (typische Private-Key-Größe ~150 Byte)', () => {
    const big = Buffer.alloc(200)
    for (let i = 0; i < big.length; i++) big[i] = i % 256
    const encrypted = encryptPrivateKey(big, passphrase)
    const decrypted = decryptPrivateKey(encrypted, passphrase)
    expect(decrypted.equals(big)).toBe(true)
  })
})
