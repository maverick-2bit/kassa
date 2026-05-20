/**
 * Bonier-Service: Nimmt eine Bestellung (vor RKSV-Rechnung) entgegen,
 * gruppiert Positionen nach KDS-Station und sendet pro Station einen
 * Bonierbon an die jeweilige Station-IP.
 *
 * Dies ist KEIN RKSV-Vorgang — es wird kein Beleg signiert oder persistiert.
 * Bonierbons sind das Vorspiel für den späteren Rechnungsbon.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { BonierungErgebnis, BonierungInput, Station } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, kassen } from '../db/schema.js'
import { baueBonierbon, generiereBonNummer } from './kds/bonierbon.js'
import { sendeBonierbon, type KdsZiel } from './kds/sender.js'

export class BonierError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export interface BonierServiceDeps {
  db: Db
}

export async function bonierBestellung(
  input: BonierungInput,
  deps:  BonierServiceDeps,
): Promise<BonierungErgebnis> {
  // 1. Kasse laden
  const [kasse] = await deps.db.select().from(kassen).where(eq(kassen.id, input.kasseId)).limit(1)
  if (!kasse) throw new BonierError(404, 'Kasse nicht gefunden')
  if (!kasse.kdsAktiv) throw new BonierError(409, 'KDS ist für diese Kasse nicht aktiviert')

  const kdsStationen = kasse.kdsStationen as Record<string, string>
  const kdsPort = kasse.kdsPort

  // 2. Artikel laden
  const artikelIds  = [...new Set(input.positionen.map((p) => p.artikelId))]
  const artikelRows = await deps.db
    .select()
    .from(artikel)
    .where(and(
      inArray(artikel.id, artikelIds),
      eq(artikel.mandantId, kasse.mandantId),
      eq(artikel.aktiv, true),
    ))
  if (artikelRows.length !== artikelIds.length) {
    throw new BonierError(404, 'Mindestens ein Artikel ist nicht (mehr) verfügbar')
  }
  const artikelById = new Map(artikelRows.map((a) => [a.id, a]))

  // 3. Positionen pro Station gruppieren
  const proStation = new Map<Station, BonierbonPosition[]>()
  for (const p of input.positionen) {
    const a = artikelById.get(p.artikelId)!
    const station = a.station as Station | null
    if (!station) continue // Artikel ohne Station: nicht bonieren

    const liste = proStation.get(station) ?? []
    liste.push({
      menge:       p.menge,
      bezeichnung: a.bezeichnung,
      ...(p.details && { details: p.details }),
    })
    proStation.set(station, liste)
  }

  if (proStation.size === 0) {
    throw new BonierError(400, 'Keine Position hat eine KDS-Station — nichts zu bonieren')
  }

  // 4. Gemeinsame Bonnummer für alle Bonierbons dieser Bestellung
  const bonNummer   = generiereBonNummer()
  const belegnummer = Math.floor(Date.now() / 1000) % 100 // 0..99, nur Anzeige
  const uhrzeit     = new Date()

  // 5. Pro Station einen Bonierbon erzeugen und senden
  const stationenErgebnisse: BonierungErgebnis['stationen'] = []
  for (const [station, positionen] of proStation) {
    const ip = kdsStationen[station]
    if (!ip) {
      stationenErgebnisse.push({
        station,
        ip:          '',
        positionen:  positionen.length,
        erfolgreich: false,
        fehler:      'Keine IP für diese Station konfiguriert',
      })
      continue
    }

    const text = baueBonierbon({
      bonNummer,
      belegnummer,
      uhrzeit,
      tisch:   input.tisch,
      ...(input.bereich && { bereich: input.bereich }),
      kellner: input.kellner,
      positionen,
    })

    const ziel: KdsZiel = { ip, port: kdsPort }
    try {
      await sendeBonierbon(text, ziel)
      stationenErgebnisse.push({
        station,
        ip,
        positionen:  positionen.length,
        erfolgreich: true,
      })
    } catch (err) {
      stationenErgebnisse.push({
        station,
        ip,
        positionen:  positionen.length,
        erfolgreich: false,
        fehler:      err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    bonNummer,
    stationen: stationenErgebnisse,
  }
}

interface BonierbonPosition {
  menge:       number
  bezeichnung: string
  details?:    string
}
