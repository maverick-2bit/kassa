import type { SetupInput, SetupResponse } from '@kassa/shared'

/**
 * Ruft den Setup-Endpoint auf und gibt die strukturierte Antwort zurück.
 * Wirft nur bei Netzwerk- oder Parsing-Fehlern.
 * Fachliche Fehler (z. B. ungültige Eingabe) liegen in `SetupResponse.fehler`.
 */
export async function postSetup(input: SetupInput): Promise<SetupResponse> {
  const res = await fetch('/api/setup', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(input),
  })

  // 4xx/5xx liefert ebenfalls eine SetupResponse — wir parsen die in jedem Fall
  const data = (await res.json()) as SetupResponse
  return data
}
