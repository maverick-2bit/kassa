import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { mandantApi } from './api'
import { getAuth, updateMandantTagesRegel } from './auth'

/**
 * Hält die Tagesbeginn-Historie auf diesem Gerät aktuell. Sie kommt mit der
 * Anmeldung, doch eine Änderung an einem anderen Gerät (oder ein Wechsel am
 * Stichtag) soll auch ohne neue Anmeldung ankommen: beim Start, beim Zurückkehren
 * zum Fenster und alle 15 Minuten ein kleiner Abgleich. Gleicher Query-Key wie die
 * Einstellungsseite — eine Änderung dort erreicht so auch alle anderen Ansichten.
 */
export function useTagesRegelSync(): void {
  const angemeldet = getAuth() !== null
  const { data } = useQuery({
    queryKey:        ['mandant-tagesbeginn'],
    queryFn:         mandantApi.getTagesbeginn,
    enabled:         angemeldet,
    staleTime:       5 * 60_000,
    refetchInterval: 15 * 60_000,
  })
  useEffect(() => {
    if (data) updateMandantTagesRegel(data.eintraege.map(e => ({ gueltigAb: e.gueltigAb, beginn: e.beginn })))
  }, [data])
}
