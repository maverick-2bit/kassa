/**
 * Beste bekannte LAN-Adresse des Kassen-Servers — für QR-Codes und die
 * Server-Adresse-Anzeige.
 *
 * Im Docker-Betrieb kann das Backend die LAN-IP des Wirts prinzipiell nicht
 * ermitteln (es sieht nur die Container-Bridge; /api/system/netzwerk meldet
 * dann ehrlich leer). Deshalb eine Kette der besten Quellen:
 *
 *  1. Browser-Host, wenn nicht localhost — wer die Seite über die LAN-Adresse
 *     erreicht hat, hat den Beweis gleich mitgeliefert
 *  2. auf diesem Gerät gemerkte manuelle Eingabe (Geräte-Seite)
 *  3. Host aus der Gast-Bestell-URL der Kasse (dort wurde die erreichbare
 *     Adresse bereits einmal konfiguriert)
 *  4. echte Netzwerkkarten vom Backend (nur außerhalb von Docker vorhanden)
 */

import { useQuery } from '@tanstack/react-query'
import { druckerApi, systemApi } from './api'
import { getKasseIdentity } from './kasse'

const KEY = 'kassa:serverHost'

export function gespeicherterServerHost(): string | null {
  return localStorage.getItem(KEY)
}

export function merkeServerHost(host: string): void {
  const h = host.trim()
  if (h && h !== 'localhost' && h !== '127.0.0.1') localStorage.setItem(KEY, h)
}

export interface ServerHostErgebnis {
  /** null = keine brauchbare Quelle — der Benutzer muss die IP eintragen */
  host: string | null
  /** true, sobald alle Quellen geantwortet haben (sonst noch am Laden) */
  fertig: boolean
}

export function useServerHost(): ServerHostErgebnis {
  const identity = getKasseIdentity()

  const netzwerk = useQuery({
    queryKey:  ['system-netzwerk'],
    queryFn:   systemApi.netzwerk,
    staleTime: 5 * 60_000,
    retry:     false,
  })
  const drucker = useQuery({
    queryKey:  ['drucker', identity?.kasseId],
    queryFn:   () => druckerApi.get(identity!.kasseId),
    enabled:   !!identity,
    staleTime: 5 * 60_000,
    retry:     false,
  })

  const loc = window.location.hostname
  if (loc !== 'localhost' && loc !== '127.0.0.1') return { host: loc, fertig: true }

  const gemerkt = gespeicherterServerHost()
  if (gemerkt) return { host: gemerkt, fertig: true }

  const gastUrl = drucker.data?.gastBasisUrl
  if (gastUrl) {
    try {
      const h = new URL(gastUrl).hostname
      if (h && h !== 'localhost' && h !== '127.0.0.1') return { host: h, fertig: true }
    } catch { /* kaputte URL — nächste Quelle */ }
  }

  const ip = netzwerk.data?.ips[0]
  if (ip) return { host: ip, fertig: true }

  const fertig = !netzwerk.isPending && (!identity || !drucker.isPending)
  return { host: null, fertig }
}
