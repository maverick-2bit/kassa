/**
 * Fernwartung — Status der Fernwartungs-Anbindung dieser Kasse (TeamViewer Host auf dem
 * Kassen-PC).
 *
 * Das Backend läuft im Docker-Container und sieht weder Registry noch Dienste des Wirts.
 * Der Installer (ops/install.ps1 bzw. ops/install.sh) schreibt deshalb nach erfolgreicher
 * Einrichtung eine Statusdatei `fernwartung-status.json` in das gemeinsame Kontroll-Volume
 * (UPDATE_CONTROL_DIR — dasselbe, über das Updater und Backend ohnehin sprechen). Das
 * Backend LIEST sie hier nur; es gibt keinen Schreibweg, die Datei enthält nie ein Geheimnis.
 *
 * Die Datei ist Fremdeingabe (vom Host geschrieben, von Hand änderbar): sie wird mit Zod
 * geprüft, die ID muss aus Ziffern bestehen, unbekannte Felder werden verworfen (also nie
 * weitergereicht), und JEDER Fehler — fehlende, kaputte, zu große oder unpassende Datei —
 * ergibt „nicht eingerichtet" statt eines 500.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const FERNWARTUNG_DATEINAME = 'fernwartung-status.json'

/** Die Datei ist winzig (< 1 KB) — alles darüber ist nicht von unserem Installer. */
const MAX_DATEI_BYTES = 16 * 1024

/** TeamViewer-IDs haben heute 9–10 Ziffern; großzügig 6–12. */
const ID_MUSTER = /^\d{6,12}$/

const textOptional = z.string().max(200).nullish()

export const FernwartungDateiSchema = z.object({
  anbieter: z.enum(['teamviewer']),
  // Zahl statt Text (von Hand geschrieben) ist verzeihlich; alles andere scheitert am Muster
  id: z.union([z.string(), z.number().int()]).transform(String).pipe(z.string().regex(ID_MUSTER, 'Die ID darf nur aus Ziffern bestehen')),
  alias:  textOptional,
  gruppe: textOptional,
  installiertAm: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'kein Zeitpunkt').nullish(),
})

/** Antwort von GET /api/system/fernwartung */
export interface FernwartungStatus {
  eingerichtet:  boolean
  anbieter:      string | null
  id:            string | null
  alias:         string | null
  gruppe:        string | null
  /** ISO-8601 (UTC) */
  installiertAm: string | null
}

const NICHT_EINGERICHTET: FernwartungStatus = {
  eingerichtet: false, anbieter: null, id: null, alias: null, gruppe: null, installiertAm: null,
}

/**
 * Liest die Statusdatei im Kontroll-Verzeichnis. Wirft nie.
 * `warnung` bekommt den Grund, wenn eine Datei da ist, aber nicht brauchbar (fürs Log).
 */
export async function leseFernwartungStatus(
  verzeichnis: string,
  warnung?: (grund: string) => void,
): Promise<FernwartungStatus> {
  const pfad = join(verzeichnis, FERNWARTUNG_DATEINAME)
  try {
    const info = await stat(pfad)
    if (!info.isFile()) { warnung?.('Statusdatei ist keine Datei'); return { ...NICHT_EINGERICHTET } }
    if (info.size > MAX_DATEI_BYTES) { warnung?.('Statusdatei ist unerwartet groß'); return { ...NICHT_EINGERICHTET } }

    const text = (await readFile(pfad, 'utf8')).replace(/^﻿/, '')
    const geprueft = FernwartungDateiSchema.safeParse(JSON.parse(text))
    if (!geprueft.success) {
      warnung?.('Statusdatei hat ein unerwartetes Format')
      return { ...NICHT_EINGERICHTET }
    }
    const d = geprueft.data
    return {
      eingerichtet:  true,
      anbieter:      d.anbieter,
      id:            d.id,
      alias:         d.alias ?? null,
      gruppe:        d.gruppe ?? null,
      installiertAm: d.installiertAm ? new Date(d.installiertAm).toISOString() : null,
    }
  } catch (err) {
    // Datei fehlt (ENOENT) ist der Normalfall einer Kasse ohne Fernwartung — still.
    // Alles andere (kaputtes JSON, Rechte) ist ein Hinweis fürs Log, aber nie ein 500.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') warnung?.('Statusdatei nicht lesbar')
    return { ...NICHT_EINGERICHTET }
  }
}
