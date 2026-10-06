import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { neueUuid } from './uuid.js'

describe('neueUuid', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('liefert eine gültige UUID und keine Wiederholung', () => {
    const a = neueUuid(), b = neueUuid()
    expect(z.string().uuid().safeParse(a).success).toBe(true)
    expect(a).not.toBe(b)
  })

  it('funktioniert auch ohne crypto.randomUUID (unsicherer Kontext, z. B. http://<LAN-IP>)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) & 255; return arr },
    })
    const id = neueUuid()
    expect(z.string().uuid().safeParse(id).success).toBe(true)
    expect(id[14]).toBe('4')
  })

  it('funktioniert sogar ganz ohne crypto (Math.random-Rückfall)', () => {
    vi.stubGlobal('crypto', undefined)
    expect(z.string().uuid().safeParse(neueUuid()).success).toBe(true)
  })
})
