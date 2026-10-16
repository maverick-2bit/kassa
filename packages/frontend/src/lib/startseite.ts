/**
 * startseite.ts — auf welche Seite führt die Anmeldung? Die Startseite ist je Kasse einstellbar
 * (Einstellungen → Kassen & Drucker). Genutzt von der Anmeldeseite und vom Mandanten-Wechsel.
 */

import type { Startseite } from '@kassa/shared'
import { posConfigApi } from './api'

const STARTSEITE_PFAD: Record<Startseite, string> = {
  tische:          '/tische',
  kasse:           '/kasse',
  kasse_favoriten: '/kasse?tab=favoriten',
  dashboard:       '/dashboard',
}

/** Die Startseite der Kasse als Pfad; ohne Antwort die Tischübersicht. */
export async function leseStartseitePfad(kasseId: string): Promise<string> {
  try {
    const cfg = await posConfigApi.get(kasseId)
    return STARTSEITE_PFAD[cfg.startseite] ?? '/tische'
  } catch {
    return '/tische'
  }
}
