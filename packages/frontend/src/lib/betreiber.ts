/**
 * Ist der angemeldete Benutzer der Betreiber dieser Installation?
 *
 * Betreiber sind die Konten, die den Rechner betreiben (nicht ein Mandant unter vielen): nur sie sehen
 * und dürfen Datenbank-Sicherung, Update, Systemwerte und weitere Mandanten. Die Wahrheit steht auf
 * dem Server und wird bei jedem Aufruf dort geprüft — das hier steuert nur, was die Oberfläche zeigt.
 *
 * Der Stand kommt frisch vom Server (System-Status), nicht aus der gespeicherten Anmeldung: Direkt
 * nach der Umstellung weiß eine alte Anmeldung noch nichts davon und würde dem Betreiber das Update
 * verstecken. Bis die Antwort da ist, gilt der Wert aus der Anmeldung.
 */

import { useQuery } from '@tanstack/react-query'
import { systemApi } from './api'
import { getAuth } from './auth'

export function useIstBetreiber(): boolean {
  const status = useQuery({
    queryKey:  ['system-status'],
    queryFn:   () => systemApi.status(),
    staleTime: 30_000,
    retry:     false,
  })
  return status.data?.istBetreiber ?? getAuth()?.user.istBetreiber ?? false
}
