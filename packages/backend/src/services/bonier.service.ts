/**
 * Bonier-Service: Nimmt eine Bestellung (vor RKSV-Rechnung) entgegen,
 * sendet Bonierbons parallel an:
 *   - KDS-Stationen (Küche/Schank/...) wenn kdsAktiv = true
 *   - ESC/POS-Bonierdrucker je nach Artikel- oder Kategorie-Zuweisung
 *   - Backup-Bonierdrucker (empfangen ALLE Positionen automatisch)
 *
 * Dies ist KEIN RKSV-Vorgang — es wird kein Beleg signiert oder persistiert.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { BonierungErgebnis, BonierungInput, Station } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, bonierdrucker, kategorien, kassen } from '../db/schema.js'
import { baueBonierbon, generiereBonNummer } from './kds/bonierbon.js'
import { sendeBonierbon, type KdsZiel } from './kds/sender.js'
import { druckeBonierbonDirekt } from './bonierdrucker.service.js'
import { emitKasseEvent } from '../sse/event-bus.js'
import { logBonierEreignis } from './tisch-tab.service.js'
import { kdsBonErstellen } from './kds/kds-store.service.js'

export class BonierError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export interface BonierServiceDeps {
  db: Db
}

interface BonierbonPosition {
  menge:       number
  bezeichnung: string
  details?:    string
}

type DruckerRow = typeof bonierdrucker.$inferSelect

export async function bonierBestellung(
  input: BonierungInput,
  deps:  BonierServiceDeps,
): Promise<BonierungErgebnis> {
  // Tisch-Label: leer = Direktverkauf an der Schank (ohne Tisch)
  const tischLabel = input.tisch?.trim() || 'Direkt'

  // 1. Kasse laden
  const [kasse] = await deps.db
    .select()
    .from(kassen)
    .where(eq(kassen.id, input.kasseId))
    .limit(1)
  if (!kasse) throw new BonierError(404, 'Kasse nicht gefunden')

  // 2. Artikel laden (mit kategorieId und bonierdruckerId)
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

  // 3. Kategorien laden (für Drucker-Fallback: artikel → kategorie)
  const kategorieIds = [
    ...new Set(
      artikelRows
        .map(a => a.kategorieId)
        .filter((id): id is string => id !== null),
    ),
  ]
  const kategorieMap = new Map<string, { bonierdruckerId: string | null }>()
  if (kategorieIds.length > 0) {
    const katRows = await deps.db
      .select({ id: kategorien.id, bonierdruckerId: kategorien.bonierdruckerId })
      .from(kategorien)
      .where(inArray(kategorien.id, kategorieIds))
    for (const k of katRows) kategorieMap.set(k.id, { bonierdruckerId: k.bonierdruckerId })
  }

  // 4. Alle aktiven Bonierdrucker laden
  const alleBonierdrucker = await deps.db
    .select()
    .from(bonierdrucker)
    .where(and(
      eq(bonierdrucker.mandantId, kasse.mandantId),
      eq(bonierdrucker.aktiv, true),
    ))
  const backupDrucker     = alleBonierdrucker.filter(d => d.istBackup)
  const nichtBackupMap    = new Map<string, DruckerRow>(
    alleBonierdrucker.filter(d => !d.istBackup).map(d => [d.id, d]),
  )

  // 5. Bonnummer + Zeitstempel (gemeinsam für alle Bons dieser Bestellung)
  const bonNummer   = generiereBonNummer()
  const belegnummer = Math.floor(Date.now() / 1000) % 100
  const uhrzeit     = new Date()

  // 6. Positionen aufbereiten + Routing bestimmen
  const kdsStationen = kasse.kdsStationen as Record<string, string>
  const kdsPort      = kasse.kdsPort

  const proStation = new Map<Station, BonierbonPosition[]>()
  const proDrucker = new Map<string, { drucker: DruckerRow; positionen: BonierbonPosition[] }>()
  const allePositionen: BonierbonPosition[] = []

  for (const p of input.positionen) {
    const a   = artikelById.get(p.artikelId)!
    const pos: BonierbonPosition = {
      menge:       p.menge,
      bezeichnung: a.bezeichnung,
      ...(p.details && { details: p.details }),
    }
    allePositionen.push(pos)

    // KDS-Routing (nur wenn kdsAktiv und Artikel eine Station hat)
    if (kasse.kdsAktiv) {
      const station = a.station as Station | null
      if (station) {
        const liste = proStation.get(station) ?? []
        liste.push(pos)
        proStation.set(station, liste)
      }
    }

    // Bonierdrucker-Routing: artikel.bonierdruckerId → kategorie.bonierdruckerId → nichts
    const effektiverDruckerId =
      a.bonierdruckerId ??
      (a.kategorieId ? (kategorieMap.get(a.kategorieId)?.bonierdruckerId ?? null) : null)

    if (effektiverDruckerId) {
      const drucker = nichtBackupMap.get(effektiverDruckerId)
      if (drucker) {
        const entry = proDrucker.get(effektiverDruckerId) ?? { drucker, positionen: [] }
        entry.positionen.push(pos)
        proDrucker.set(effektiverDruckerId, entry)
      }
    }
  }

  // Mindestens etwas zu tun?
  if (proStation.size === 0 && proDrucker.size === 0 && backupDrucker.length === 0) {
    throw new BonierError(
      400,
      'Kein Artikel hat eine KDS-Station oder einen Bonierdrucker — nichts zu bonieren',
    )
  }

  // 7. KDS senden (pro Station)
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
      tisch:   tischLabel,
      ...(input.bereich && { bereich: input.bereich }),
      kellner: input.kellner,
      positionen,
    })
    const ziel: KdsZiel = { ip, port: kdsPort }
    try {
      await sendeBonierbon(text, ziel)
      stationenErgebnisse.push({ station, ip, positionen: positionen.length, erfolgreich: true })
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

  // 8. Bonierdrucker senden (nicht-Backup, je nach Zuweisung)
  const druckerErgebnisse: BonierungErgebnis['drucker'] = []

  const sendeAnDrucker = async (drucker: DruckerRow, positionen: BonierbonPosition[], istBackup: boolean) => {
    const zeilen = positionen.map(p => ({
      menge:       p.menge,
      bezeichnung: p.bezeichnung,
      preisLabel:  '',
    }))
    try {
      await druckeBonierbonDirekt(drucker.ip, drucker.port, tischLabel, input.kellner, zeilen)
      druckerErgebnisse.push({
        druckerId:   drucker.id,
        name:        drucker.name,
        ip:          drucker.ip,
        positionen:  positionen.length,
        erfolgreich: true,
        istBackup,
      })
    } catch (err) {
      druckerErgebnisse.push({
        druckerId:   drucker.id,
        name:        drucker.name,
        ip:          drucker.ip,
        positionen:  positionen.length,
        erfolgreich: false,
        fehler:      err instanceof Error ? err.message : String(err),
        istBackup,
      })
    }
  }

  for (const [, { drucker, positionen }] of proDrucker) {
    await sendeAnDrucker(drucker, positionen, false)
  }

  // 9. Backup-Drucker: erhalten alle Positionen
  for (const backup of backupDrucker) {
    await sendeAnDrucker(backup, allePositionen, true)
  }

  // 10. Lagerstand dekrementieren (atomar, direkt in der DB)
  //     Countdown-Artikel: Menge beim Bonieren abziehen, nicht erst beim Kassieren.
  //     SQL GREATEST(0, …) verhindert negative Bestände.
  const zuDekrementieren = input.positionen
    .map(p => ({ a: artikelById.get(p.artikelId)!, menge: p.menge }))
    .filter(({ a }) => a.lagerstandAktiv && a.lagerstandMenge !== null)

  if (zuDekrementieren.length > 0) {
    await deps.db.transaction(async (tx) => {
      for (const { a, menge } of zuDekrementieren) {
        await tx
          .update(artikel)
          .set({
            lagerstandMenge: sql`GREATEST(0, COALESCE(${artikel.lagerstandMenge}, 0) - ${menge})`,
            updatedAt:       new Date(),
          })
          .where(eq(artikel.id, a.id))
      }
    })

    // Lagerstand-Warnungen emittieren wenn Bestand ≤ Mindestbestand nach Dekrement
    for (const { a, menge } of zuDekrementieren) {
      const neueMenge = Math.max(0, (a.lagerstandMenge ?? 0) - menge)
      if (a.mindestbestand !== null && neueMenge <= a.mindestbestand) {
        emitKasseEvent(kasse.mandantId, {
          typ:            'lagerstand_warnung',
          artikelId:      a.id,
          bezeichnung:    a.bezeichnung,
          menge:          neueMenge,
          mindestbestand: a.mindestbestand,
          ausverkauft:    neueMenge === 0,
        })
      }
    }
  }

  // 11. Ergebnis zusammenbauen + Events
  const ergebnis: BonierungErgebnis = {
    bonNummer,
    stationen: stationenErgebnisse,
    drucker:   druckerErgebnisse,
  }

  // 11a. KDS-Bons in DB schreiben (Browser-Display) — parallel, Fehler nicht fatal
  if (kasse.kdsAktiv && proStation.size > 0) {
    const schreibPromises = [...proStation.entries()].map(([station, positionen]) =>
      kdsBonErstellen(deps.db, {
        mandantId:  kasse.mandantId,
        bonNummer,
        station,
        tisch:      tischLabel,
        ...(input.bereich ? { bereich: input.bereich } : {}),
        kellner:    input.kellner,
        positionen: positionen.map(p => ({
          bezeichnung: p.bezeichnung,
          menge:       p.menge,
          ...(p.details ? { details: p.details } : {}),
        })),
      }).catch(err => { console.error('KDS-DB-Fehler:', err) })
    )
    await Promise.all(schreibPromises)
  }

  emitKasseEvent(kasse.mandantId, {
    typ:       'bonierbon',
    bonNummer,
    tisch:     tischLabel,
    kellner:   input.kellner,
    stationen: stationenErgebnisse,
  })

  // Verlauf-Eintrag wenn Bonierung einem Tab zugeordnet ist
  if (input.tabId) {
    const positionen = input.positionen.map(p => ({
      bezeichnung: artikelById.get(p.artikelId)?.bezeichnung ?? p.artikelId,
      menge:       p.menge,
    }))
    await logBonierEreignis(input.tabId, kasse.mandantId, {
      bonNummer,
      positionen,
      stationen: stationenErgebnisse,
    }, deps.db)
  }

  return ergebnis
}
