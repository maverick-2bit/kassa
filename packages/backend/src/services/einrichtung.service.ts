/**
 * Einrichtungs-Übersicht (Einstellungen → Kassen): alle Kassen mit Druckern, Warengruppen und KDS
 * auf einen Blick, Kassen-Ausnahmen beim Bon-Routing setzen und die Einrichtung einer Kasse auf
 * eine andere übernehmen.
 *
 * Gelesen wird in EINER Anfrage (statt vier je Kasse); geschrieben wird weiter über die
 * bestehenden Endpunkte je Kasse (Drucker, KDS, POS-Konfiguration) — neu sind nur die Ausnahmen
 * und das Kopieren.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type {
  Einrichtung,
  EinrichtungKasse,
  RoutingAenderung,
  RoutingAusnahme,
} from '@kassa/shared'
import type { Db } from '../db/client.js'
import {
  artikel,
  bonierdrucker,
  kassekategorieSichtbarkeit,
  kasseBonierdruckerSichtbarkeit,
  kasseRouting,
  kassen,
  kategorien,
} from '../db/schema.js'

export class EinrichtungError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

const ohneDoppelte = <T>(liste: readonly T[]): T[] => [...new Set(liste)]

/** Alle Kassen des Mandanten mit allem, was die Übersicht zeigt, plus alle Kassen-Ausnahmen. */
export async function ladeEinrichtung(db: Db, mandantId: string): Promise<Einrichtung> {
  const kassenRows = await db
    .select()
    .from(kassen)
    .where(eq(kassen.mandantId, mandantId))
    .orderBy(kassen.createdAt)

  // Nur Warengruppen/Bonierdrucker des eigenen Mandanten (Altbestand aus der Zeit vor der Prüfung im
  // PUT der POS-Konfiguration): eine fremde ID darf die Übersicht nicht verfälschen.
  const sichtKategorien = await db
    .select({ kasseId: kassekategorieSichtbarkeit.kasseId, kategorieId: kassekategorieSichtbarkeit.kategorieId })
    .from(kassekategorieSichtbarkeit)
    .innerJoin(kategorien, eq(kategorien.id, kassekategorieSichtbarkeit.kategorieId))
    .innerJoin(kassen, eq(kassen.id, kassekategorieSichtbarkeit.kasseId))
    .where(and(eq(kategorien.mandantId, mandantId), eq(kassen.mandantId, mandantId)))

  const sichtDrucker = await db
    .select({ kasseId: kasseBonierdruckerSichtbarkeit.kasseId, bonierdruckerId: kasseBonierdruckerSichtbarkeit.bonierdruckerId })
    .from(kasseBonierdruckerSichtbarkeit)
    .innerJoin(bonierdrucker, eq(bonierdrucker.id, kasseBonierdruckerSichtbarkeit.bonierdruckerId))
    .innerJoin(kassen, eq(kassen.id, kasseBonierdruckerSichtbarkeit.kasseId))
    .where(and(eq(bonierdrucker.mandantId, mandantId), eq(kassen.mandantId, mandantId)))

  const ausnahmenRows = await db
    .select()
    .from(kasseRouting)
    .where(eq(kasseRouting.mandantId, mandantId))

  const kategorienJeKasse = new Map<string, string[]>()
  for (const r of sichtKategorien) kategorienJeKasse.set(r.kasseId, [...(kategorienJeKasse.get(r.kasseId) ?? []), r.kategorieId])
  const druckerJeKasse = new Map<string, string[]>()
  for (const r of sichtDrucker) druckerJeKasse.set(r.kasseId, [...(druckerJeKasse.get(r.kasseId) ?? []), r.bonierdruckerId])

  const liste: EinrichtungKasse[] = kassenRows.map(k => ({
    id:               k.id,
    kassenId:         k.kassenId,
    bezeichnung:      k.bezeichnung,
    status:           k.status,
    umgebung:         k.umgebung,
    seeGueltigBis:    k.seeGueltigBis.toISOString(),
    beiFoRegistriert: k.bei_fo_registriert,
    ausserBetriebAm:  k.ausserBetriebAm ? k.ausserBetriebAm.toISOString() : null,

    belegModus: k.belegModus as EinrichtungKasse['belegModus'],
    druckerId:  k.druckerId,

    gastModus:    k.gastModus as EinrichtungKasse['gastModus'],
    gastBasisUrl: k.gastBasisUrl,

    kdsAktiv:     k.kdsAktiv,
    kdsPort:      k.kdsPort,
    kdsStationen: k.kdsStationen as EinrichtungKasse['kdsStationen'],

    startseite:            k.startseite as EinrichtungKasse['startseite'],
    erlaubteZahlungsarten: k.erlaubteZahlungsarten as EinrichtungKasse['erlaubteZahlungsarten'],

    sichtbareKategorieIds:     kategorienJeKasse.get(k.id) ?? [],
    sichtbareBonierdruckerIds: druckerJeKasse.get(k.id) ?? [],
  }))

  const ausnahmen: RoutingAusnahme[] = ausnahmenRows.map(r => ({
    kasseId:         r.kasseId,
    kategorieId:     r.kategorieId,
    artikelId:       r.artikelId,
    bonierdruckerId: r.bonierdruckerId,
    keinDrucker:     r.keinDrucker,
    station:         r.station as RoutingAusnahme['station'],
    keineStation:    r.keineStation,
  }))

  return { kassen: liste, ausnahmen }
}

/** Zustand einer Ausnahme-Zeile (ohne Schlüssel) — Bearbeitungsstand beim Anwenden einer Stapel-Änderung. */
interface AusnahmeStand {
  bonierdruckerId: string | null
  keinDrucker:     boolean
  station:         string | null
  keineStation:    boolean
}

const schluessel = (kasseId: string, kategorieId: string | null | undefined, artikelId: string | null | undefined) =>
  `${kasseId}|${kategorieId ? `k:${kategorieId}` : `a:${artikelId}`}`

/**
 * Stapel-Änderung der Kassen-Ausnahmen. Alles oder nichts: erst werden Kassen, Warengruppen, Artikel und
 * Drucker auf den Mandanten geprüft, dann läuft alles in einer Transaktion. Mehrere Änderungen derselben
 * Zelle werden der Reihe nach angewendet. Eine Ausnahme ohne jede Angabe wird gelöscht.
 */
export async function setzeRoutingAusnahmen(db: Db, mandantId: string, aenderungen: readonly RoutingAenderung[]): Promise<void> {
  const kasseIds     = ohneDoppelte(aenderungen.map(a => a.kasseId))
  const kategorieIds = ohneDoppelte(aenderungen.flatMap(a => (a.kategorieId ? [a.kategorieId] : [])))
  const artikelIds   = ohneDoppelte(aenderungen.flatMap(a => (a.artikelId ? [a.artikelId] : [])))
  const druckerIds   = ohneDoppelte(aenderungen.flatMap(a => (a.drucker && a.drucker !== 'keiner' ? [a.drucker] : [])))

  // Mandanten-Prüfung (die Tabelle kennt keinen Mandanten-Bezug der Ziele — fremde IDs würden klaglos gespeichert)
  const pruefe = async (ids: string[], liste: Promise<{ id: string }[]>, fehler: string) => {
    if (ids.length === 0) return
    if ((await liste).length !== ids.length) throw new EinrichtungError(404, fehler)
  }
  await pruefe(kasseIds,
    db.select({ id: kassen.id }).from(kassen).where(and(inArray(kassen.id, kasseIds), eq(kassen.mandantId, mandantId))),
    'Kasse nicht gefunden')
  await pruefe(kategorieIds,
    db.select({ id: kategorien.id }).from(kategorien).where(and(inArray(kategorien.id, kategorieIds), eq(kategorien.mandantId, mandantId))),
    'Warengruppe nicht gefunden')
  await pruefe(artikelIds,
    db.select({ id: artikel.id }).from(artikel).where(and(inArray(artikel.id, artikelIds), eq(artikel.mandantId, mandantId))),
    'Artikel nicht gefunden')
  if (druckerIds.length > 0) {
    const gefunden = await db
      .select({ id: bonierdrucker.id, istBackup: bonierdrucker.istBackup })
      .from(bonierdrucker)
      .where(and(inArray(bonierdrucker.id, druckerIds), eq(bonierdrucker.mandantId, mandantId)))
    if (gefunden.length !== druckerIds.length) throw new EinrichtungError(404, 'Bonierdrucker nicht gefunden')
    // Ein Backup-Drucker bekommt jeden Bon als Kopie, aber nie als Ziel einer Zuordnung — er würde hier still nichts drucken
    if (gefunden.some(d => d.istBackup)) {
      throw new EinrichtungError(400, 'Ein Backup-Drucker kann keiner Warengruppe oder keinem Artikel zugeordnet werden')
    }
  }

  await db.transaction(async (tx) => {
    // Bestehende Ausnahmen der betroffenen Kassen — Bearbeitungsstand je Zelle
    const bestehend = await tx.select().from(kasseRouting).where(inArray(kasseRouting.kasseId, kasseIds))
    const alt   = new Map<string, string>()                       // Zellen-Schlüssel → Zeilen-ID
    const stand = new Map<string, AusnahmeStand>()
    for (const r of bestehend) {
      const s = schluessel(r.kasseId, r.kategorieId, r.artikelId)
      alt.set(s, r.id)
      stand.set(s, { bonierdruckerId: r.bonierdruckerId, keinDrucker: r.keinDrucker, station: r.station, keineStation: r.keineStation })
    }

    const beruehrt = new Map<string, { kasseId: string; kategorieId: string | null; artikelId: string | null }>()
    for (const a of aenderungen) {
      const s = schluessel(a.kasseId, a.kategorieId, a.artikelId)
      beruehrt.set(s, { kasseId: a.kasseId, kategorieId: a.kategorieId ?? null, artikelId: a.artikelId ?? null })
      const z: AusnahmeStand = stand.get(s) ?? { bonierdruckerId: null, keinDrucker: false, station: null, keineStation: false }
      if (a.drucker !== undefined) {
        z.bonierdruckerId = a.drucker !== null && a.drucker !== 'keiner' ? a.drucker : null
        z.keinDrucker     = a.drucker === 'keiner'
      }
      if (a.station !== undefined) {
        z.station      = a.station !== null && a.station !== 'keine' ? a.station : null
        z.keineStation = a.station === 'keine'
      }
      stand.set(s, z)
    }

    // Berührte Zellen ganz neu schreiben: erst die alten Zeilen weg, dann die nicht-leeren Stände neu
    const zuLoeschen = [...beruehrt.keys()].flatMap(s => (alt.has(s) ? [alt.get(s)!] : []))
    for (let i = 0; i < zuLoeschen.length; i += 500) {
      await tx.delete(kasseRouting).where(inArray(kasseRouting.id, zuLoeschen.slice(i, i + 500)))
    }
    const neu = [...beruehrt.entries()].flatMap(([s, ziel]) => {
      const z = stand.get(s)!
      const leer = z.bonierdruckerId === null && !z.keinDrucker && z.station === null && !z.keineStation
      return leer ? [] : [{ mandantId, ...ziel, ...z }]
    })
    for (let i = 0; i < neu.length; i += 500) {
      await tx.insert(kasseRouting).values(neu.slice(i, i + 500))
    }
  })
}

/**
 * Übernimmt die Einrichtung einer Kasse auf eine andere — damit eine neue Kasse „wie Kasse 3" startet.
 * Übernommen werden: sichtbare Warengruppen, aktive Bonierdrucker, Kassen-Ausnahmen (Warengruppen und
 * Artikel), Rechnungsdrucker, Belegausgabe, KDS (aktiv, Port, TCP-Stationen), Startseite, Zahlungsarten
 * und die Gast-Bestellung. NICHT übernommen: Kartenterminal (ein Gerät gehört einer Kasse), Favoriten,
 * Artikel-Anordnung und Kellner-App-Einstellungen.
 */
export async function kopiereEinrichtung(db: Db, mandantId: string, zielKasseId: string, vonKasseId: string): Promise<void> {
  if (zielKasseId === vonKasseId) throw new EinrichtungError(400, 'Quelle und Ziel sind dieselbe Kasse')

  const rows = await db
    .select()
    .from(kassen)
    .where(and(inArray(kassen.id, [zielKasseId, vonKasseId]), eq(kassen.mandantId, mandantId)))
  const ziel = rows.find(k => k.id === zielKasseId)
  const von  = rows.find(k => k.id === vonKasseId)
  if (!ziel || !von) throw new EinrichtungError(404, 'Kasse nicht gefunden')
  if (ziel.status !== 'aktiv') throw new EinrichtungError(409, 'Eine außer Betrieb genommene Kasse lässt sich nicht mehr einrichten')

  await db.transaction(async (tx) => {
    await tx.update(kassen).set({
      // Rechnungsdrucker samt aufgelöstem Snapshot (der Druckpfad liest nur diese Felder)
      druckerId:         von.druckerId,
      druckerIp:         von.druckerIp,
      druckerPort:       von.druckerPort,
      druckerAktiv:      von.druckerAktiv,
      druckerBreite:     von.druckerBreite,
      druckerTimeoutSek: von.druckerTimeoutSek,
      belegModus:        von.belegModus,
      kdsAktiv:          von.kdsAktiv,
      kdsPort:           von.kdsPort,
      kdsStationen:      von.kdsStationen,
      startseite:        von.startseite,
      erlaubteZahlungsarten: von.erlaubteZahlungsarten,
      gastModus:         von.gastModus,
      gastBasisUrl:      von.gastBasisUrl,
      updatedAt:         new Date(),
    }).where(eq(kassen.id, ziel.id))

    // Sichtbarkeiten + Ausnahmen: beim Ziel komplett ersetzen
    await tx.delete(kassekategorieSichtbarkeit).where(eq(kassekategorieSichtbarkeit.kasseId, ziel.id))
    const sichtKat = await tx
      .select({ kategorieId: kassekategorieSichtbarkeit.kategorieId })
      .from(kassekategorieSichtbarkeit)
      .innerJoin(kategorien, eq(kategorien.id, kassekategorieSichtbarkeit.kategorieId))
      .where(and(eq(kassekategorieSichtbarkeit.kasseId, von.id), eq(kategorien.mandantId, mandantId)))
    if (sichtKat.length > 0) {
      await tx.insert(kassekategorieSichtbarkeit).values(sichtKat.map(r => ({ kasseId: ziel.id, kategorieId: r.kategorieId })))
    }

    await tx.delete(kasseBonierdruckerSichtbarkeit).where(eq(kasseBonierdruckerSichtbarkeit.kasseId, ziel.id))
    const sichtDrucker = await tx
      .select({ bonierdruckerId: kasseBonierdruckerSichtbarkeit.bonierdruckerId })
      .from(kasseBonierdruckerSichtbarkeit)
      .innerJoin(bonierdrucker, eq(bonierdrucker.id, kasseBonierdruckerSichtbarkeit.bonierdruckerId))
      .where(and(eq(kasseBonierdruckerSichtbarkeit.kasseId, von.id), eq(bonierdrucker.mandantId, mandantId)))
    if (sichtDrucker.length > 0) {
      await tx.insert(kasseBonierdruckerSichtbarkeit).values(sichtDrucker.map(r => ({ kasseId: ziel.id, bonierdruckerId: r.bonierdruckerId })))
    }

    await tx.delete(kasseRouting).where(eq(kasseRouting.kasseId, ziel.id))
    const ausnahmen = await tx.select().from(kasseRouting).where(eq(kasseRouting.kasseId, von.id))
    if (ausnahmen.length > 0) {
      await tx.insert(kasseRouting).values(ausnahmen.map(r => ({
        mandantId,
        kasseId:         ziel.id,
        kategorieId:     r.kategorieId,
        artikelId:       r.artikelId,
        bonierdruckerId: r.bonierdruckerId,
        keinDrucker:     r.keinDrucker,
        station:         r.station,
        keineStation:    r.keineStation,
      })))
    }
  })
}
