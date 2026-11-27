import { describe, it, expect } from 'vitest'
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query'
import { SEE_STATUS_SCHLUESSEL, SEE_TAKT_AUSFALL_MS, SEE_TAKT_NORMAL_MS, seeAbfrageTakt, seeStatusNachAktion } from './seeStatus'

describe('SEE-Status nach einer Aktion', () => {
  it('nach jeder erfolgreichen Aktion (z. B. Verkauf) wird der Status sofort neu abgefragt', async () => {
    let client: QueryClient
    client = new QueryClient({ mutationCache: seeStatusNachAktion(() => client), defaultOptions: { queries: { retry: false } } })
    let abfragen = 0
    let ausgefallen = false
    const beobachter = new QueryObserver(client, {
      queryKey: [SEE_STATUS_SCHLUESSEL, 'kasse-1'],
      queryFn:  () => { abfragen++; return Promise.resolve({ ausgefallen }) },
      staleTime: Infinity,
    })
    const ende = beobachter.subscribe(() => {})
    try {
      await client.fetchQuery({ queryKey: [SEE_STATUS_SCHLUESSEL, 'kasse-1'] })
      await vi_warte(() => beobachter.getCurrentResult().data !== undefined)
      const vorher = abfragen

      // Verkauf: der Server erkennt dabei den Ausfall (Stick gezogen)
      ausgefallen = true
      await new MutationObserver(client, { mutationFn: () => Promise.resolve({ belegNummer: 5 }) }).mutate()

      await vi_warte(() => (beobachter.getCurrentResult().data as { ausgefallen: boolean } | undefined)?.ausgefallen === true)
      expect(abfragen).toBeGreaterThan(vorher)
    } finally { ende() }
  })

  it('eine fehlgeschlagene Aktion fragt nicht extra ab', async () => {
    let client: QueryClient
    client = new QueryClient({ mutationCache: seeStatusNachAktion(() => client), defaultOptions: { queries: { retry: false } } })
    let abfragen = 0
    const ende = new QueryObserver(client, {
      queryKey: [SEE_STATUS_SCHLUESSEL, 'kasse-1'], queryFn: () => { abfragen++; return Promise.resolve({ ausgefallen: false }) }, staleTime: Infinity,
    }).subscribe(() => {})
    try {
      await vi_warte(() => abfragen === 1)
      await new MutationObserver(client, { mutationFn: () => Promise.reject(new Error('kaputt')) }).mutate().catch(() => {})
      await new Promise(r => setTimeout(r, 20))
      expect(abfragen).toBe(1)
    } finally { ende() }
  })

  it('im Ausfall öfter abfragen, sonst im ruhigen Takt', () => {
    expect(seeAbfrageTakt(true)).toBe(SEE_TAKT_AUSFALL_MS)
    expect(seeAbfrageTakt(false)).toBe(SEE_TAKT_NORMAL_MS)
    expect(seeAbfrageTakt(undefined)).toBe(SEE_TAKT_NORMAL_MS)
    expect(SEE_TAKT_AUSFALL_MS).toBeLessThan(SEE_TAKT_NORMAL_MS)
  })
})

async function vi_warte(bedingung: () => boolean, ms = 1_000): Promise<void> {
  const bis = Date.now() + ms
  while (!bedingung()) {
    if (Date.now() > bis) throw new Error('Bedingung nicht erfüllt')
    await new Promise(r => setTimeout(r, 5))
  }
}
