/**
 * Boolescher Query-Parameter, z. B. `?nurAktive=true|false`.
 *
 * Query-Werte kommen immer als String an. `z.coerce.boolean()` taugt dafür
 * NICHT: es rechnet `Boolean("false")`, und das ist `true` — `?nurAktive=false`
 * lieferte so still nur aktive Einträge. Query-Booleans daher immer hierüber
 * parsen, nie über `z.coerce.boolean()`.
 *
 * Erlaubt sind genau "true" und "false" (alles andere, auch "", "1", "TRUE"
 * oder ein mehrfach gesetzter Parameter → Validierungsfehler → 400); fehlt der
 * Parameter, gilt `standard`.
 */

import { z } from 'zod'

export const queryBool = (standard: boolean) =>
  z.enum(['true', 'false']).default(standard ? 'true' : 'false').transform(v => v === 'true')
