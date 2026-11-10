import { describe, it, expect, vi } from 'vitest'
import { baueKatalog, KatalogCache } from '../src/services/sprache/index.js'

const katalogMit = (name: string) => baueKatalog([{ id: name, bezeichnung: name }])

function bauCache(opt: { ttlMs?: number; maxMandanten?: number } = {}) {
  let uhr = 1_000
  const lade = vi.fn(async (mandantId: string) => katalogMit(`katalog-${mandantId}`))
  const cache = new KatalogCache({ lade, jetzt: () => uhr, ...opt })
  return { cache, lade, tick: (ms: number) => { uhr += ms } }
}

describe('Sprachbestellung — Katalog-Cache', () => {
  it('lädt je Mandant einmal und liefert danach aus dem Speicher', async () => {
    const { cache, lade } = bauCache()
    const a = await cache.holen('m1')
    const b = await cache.holen('m1')
    expect(b).toBe(a)
    expect(lade).toHaveBeenCalledTimes(1)
    await cache.holen('m2')
    expect(lade).toHaveBeenCalledTimes(2)
  })

  it('gleichzeitige Anfragen teilen sich ein Laden', async () => {
    const { cache, lade } = bauCache()
    const [a, b, c] = await Promise.all([cache.holen('m1'), cache.holen('m1'), cache.holen('m1')])
    expect(a).toBe(b); expect(b).toBe(c)
    expect(lade).toHaveBeenCalledTimes(1)
  })

  it('lädt nach Ablauf der Lebensdauer neu', async () => {
    const { cache, lade, tick } = bauCache({ ttlMs: 30_000 })
    await cache.holen('m1')
    tick(29_999)
    await cache.holen('m1')
    expect(lade).toHaveBeenCalledTimes(1)
    tick(2)
    await cache.holen('m1')
    expect(lade).toHaveBeenCalledTimes(2)
  })

  it('verwerfen: nächster Zugriff lädt sofort neu, andere Mandanten bleiben', async () => {
    const { cache, lade } = bauCache()
    await cache.holen('m1'); await cache.holen('m2')
    cache.verwerfen('m1')
    await cache.holen('m1'); await cache.holen('m2')
    expect(lade.mock.calls.map(c => c[0])).toEqual(['m1', 'm2', 'm1'])
  })

  it('merkt sich ein fehlgeschlagenes Laden nicht', async () => {
    const lade = vi.fn()
      .mockRejectedValueOnce(new Error('DB weg'))
      .mockResolvedValueOnce(katalogMit('ok'))
    const cache = new KatalogCache({ lade })
    await expect(cache.holen('m1')).rejects.toThrow('DB weg')
    await Promise.resolve() // Aufräumen nach dem Fehler abwarten
    expect(cache.groesse).toBe(0)
    await expect(cache.holen('m1')).resolves.toBeDefined()
    expect(lade).toHaveBeenCalledTimes(2)
  })

  it('hält höchstens maxMandanten Betriebe — der älteste fliegt raus', async () => {
    const { cache, lade } = bauCache({ maxMandanten: 2 })
    await cache.holen('m1'); await cache.holen('m2'); await cache.holen('m3')
    expect(cache.groesse).toBe(2)
    await cache.holen('m1') // war rausgeflogen → neu geladen
    expect(lade.mock.calls.map(c => c[0])).toEqual(['m1', 'm2', 'm3', 'm1'])
  })
})
