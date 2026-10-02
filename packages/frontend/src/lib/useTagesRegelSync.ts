import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { mandantApi } from './api'
import { getAuth, updateMandantTagesRegel } from './auth'

/**
 * Hält die Tagesbeginn-Historie auf diesem Gerät aktuell. Sie kommt mit der
 * Anmeldung, doch eine Änderung an einem anderen Gerät (oder ein Wechsel am
 * Stichtag) soll auch ohne neue Anmeldung ankommen: beim Start, beim Zurückkehren
 * zum Fenster und alle 15 Minuten ein kleiner Abgleich. Gleicher Query-Key wie die
 * Einstellungsseite — eine Änderung dort erreicht so auch alle anderen Ansichten.
 *
 * Die Seiten lesen die Historie beim Rendern (z. B. als Startwert von „heute"). Hat der
 * Abgleich etwas Neues gebracht, zählt die Rückgabe hoch — das Layout setzt sie als Key
 * der aktuellen Seite, damit sie mit den neuen Werten neu startet (kommt selten vor).
 */
export function useTagesRegelSync(): number {
  const [version, setVersion] = useState(0)
  const angemeldet = getAuth() !== null
  const { data } = useQuery({
    queryKey:        ['mandant-tagesbeginn'],
    queryFn:         mandantApi.getTagesbeginn,
    enabled:         angemeldet,
    staleTime:       5 * 60_000,
    refetchInterval: 15 * 60_000,
  })
  useEffect(() => {
    if (data && updateMandantTagesRegel(data.eintraege.map(e => ({ gueltigAb: e.gueltigAb, beginn: e.beginn })))) {
      setVersion(v => v + 1)
    }
  }, [data])
  return version
}
