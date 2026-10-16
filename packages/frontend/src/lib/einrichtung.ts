/**
 * einrichtung.ts — reine Logik der Einrichtungs-Übersicht (Einstellungen → Kassen).
 *
 * Die Oberfläche zeigt alle Kassen, Drucker, Warengruppen und KDS-Stationen auf einen Blick. Hier steht,
 * was sich ohne React testen lässt: nächste freie Kassen-ID, Wert und Änderung einer Matrix-Zelle,
 * das wirksame Routing je Kasse und die Verwendung eines Druckers.
 *
 * Die Routing-Regel selbst (Rangfolge Artikel an der Kasse → Artikel → Warengruppe an der Kasse →
 * Warengruppe) lebt in @kassa/shared und wird vom Server beim Bonieren genauso gerechnet.
 */

import {
  baumFlach,
  kategoriePfad,
  wirksamesKategorieRouting,
  type Bonierdrucker,
  type EinrichtungKasse,
  type KasseRoutingAusnahme,
  type Kategorie,
  type KategorieRouting,
  type RoutingAenderung,
  type RoutingAusnahme,
  type Station,
} from '@kassa/shared'
import { kassenAnsicht } from './artikel-reiter'

/** Was die Matrix zeigt: der Bonierdrucker oder die KDS-Station. */
export type RoutingMerkmal = 'drucker' | 'station'

/** Anzeigename einer Kasse: die Bezeichnung, sonst die Kassen-ID. */
export const kassenName = (k: { bezeichnung: string | null; kassenId: string }): string => k.bezeichnung || k.kassenId

// ---------------------------------------------------------------------------
// Neue Kassen: nächste freie ID
// ---------------------------------------------------------------------------

const ID_MUSTER = /^(.*?)(\d+)$/

/**
 * Die nächsten `anzahl` freien Kassen-IDs. Die Schreibweise der vorhandenen IDs wird fortgesetzt
 * (häufigstes Präfix mit Nummer, gleiche Stellenzahl): aus KASSE-001 und KASSE-002 wird KASSE-003. Ohne
 * vorhandene Nummern-IDs beginnt es bei KASSE-001. Belegte IDs (ohne Rücksicht auf Groß-/Kleinschreibung)
 * werden übersprungen.
 */
export function naechsteKassenIds(vorhandene: readonly string[], anzahl: number): string[] {
  const belegt = new Set(vorhandene.map(v => v.toLowerCase()))
  const gruppen = new Map<string, { n: number; max: number; breite: number }>()
  for (const id of vorhandene) {
    const m = ID_MUSTER.exec(id)
    if (!m) continue
    const praefix = m[1]!, zahl = m[2]!
    const g = gruppen.get(praefix) ?? { n: 0, max: 0, breite: 0 }
    g.n += 1
    g.max = Math.max(g.max, parseInt(zahl, 10))
    g.breite = Math.max(g.breite, zahl.length)
    gruppen.set(praefix, g)
  }
  // häufigstes Präfix gewinnt; bei Gleichstand das mit der höchsten Nummer
  const beste = [...gruppen.entries()].sort((a, b) => b[1].n - a[1].n || b[1].max - a[1].max)[0]
  const praefix = beste ? beste[0] : 'KASSE-'
  const breite  = beste ? beste[1].breite : 3
  let nr        = beste ? beste[1].max : 0
  const ergebnis: string[] = []
  while (ergebnis.length < anzahl) {
    nr += 1
    const id = `${praefix}${String(nr).padStart(breite, '0')}`
    if (!belegt.has(id.toLowerCase())) ergebnis.push(id)
  }
  return ergebnis
}

// ---------------------------------------------------------------------------
// Matrix: Warengruppen / Artikel × Kassen
// ---------------------------------------------------------------------------

/** Ziel einer Zeile der Routing-Matrix: eine Warengruppe oder ein Artikel. */
export type RoutingZiel = { kategorieId: string } | { artikelId: string }

/** Schlüssel einer Zelle (Kasse + Ziel) — für das Nachschlagen der Ausnahmen. */
export const zellenSchluessel = (kasseId: string, ziel: RoutingZiel): string =>
  'kategorieId' in ziel ? `${kasseId}|k:${ziel.kategorieId}` : `${kasseId}|a:${ziel.artikelId}`

/** Alle Ausnahmen nach Zelle — damit jede Zelle der Matrix ihre Ausnahme ohne Suchen findet. */
export function ausnahmenNachZelle(ausnahmen: readonly RoutingAusnahme[]): Map<string, RoutingAusnahme> {
  const m = new Map<string, RoutingAusnahme>()
  for (const a of ausnahmen) {
    if (a.kategorieId) m.set(zellenSchluessel(a.kasseId, { kategorieId: a.kategorieId }), a)
    else if (a.artikelId) m.set(zellenSchluessel(a.kasseId, { artikelId: a.artikelId }), a)
  }
  return m
}

/**
 * Wert der Auswahl einer Zelle: '' = Standard (keine Ausnahme), 'keiner' = an dieser Kasse ausdrücklich
 * kein Drucker bzw. keine Station, sonst die Drucker-ID bzw. die Station.
 */
export function zellenWert(
  a: Pick<RoutingAusnahme, 'bonierdruckerId' | 'keinDrucker' | 'station' | 'keineStation'> | undefined,
  merkmal: RoutingMerkmal,
): string {
  if (!a) return ''
  if (merkmal === 'drucker') return a.keinDrucker ? 'keiner' : (a.bonierdruckerId ?? '')
  return a.keineStation ? 'keiner' : (a.station ?? '')
}

/** Die Änderung für den Server, wenn in einer Zelle `wert` gewählt wird (Werte wie bei zellenWert). */
export function routingAenderung(kasseId: string, ziel: RoutingZiel, merkmal: RoutingMerkmal, wert: string): RoutingAenderung {
  const gewaehlt = wert === '' ? null : wert
  if (merkmal === 'drucker') return { kasseId, ...ziel, drucker: gewaehlt }
  return { kasseId, ...ziel, station: gewaehlt === 'keiner' ? 'keine' : (gewaehlt as Station | null) }
}

/** Hat die Ausnahme für das Merkmal eine Angabe? (Zelle ist dann hervorgehoben) */
export const hatAngabe = (a: RoutingAusnahme | undefined, merkmal: RoutingMerkmal): boolean => zellenWert(a, merkmal) !== ''

/** Wirksames Routing je Warengruppe an einer Kasse — die Ausnahmen DIESER Kasse sind eingerechnet. */
export function routingJeKasse(
  kategorien: readonly { id: string; parentId: string | null; station: string | null; bonierdruckerId: string | null }[],
  ausnahmen: readonly RoutingAusnahme[],
  kasseId: string,
): Map<string, KategorieRouting> {
  const eigene: KasseRoutingAusnahme[] = ausnahmen.filter(a => a.kasseId === kasseId)
  return wirksamesKategorieRouting(kategorien, eigene)
}

// ---------------------------------------------------------------------------
// Drucker: wofür wird er verwendet?
// ---------------------------------------------------------------------------

export interface BonierdruckerVerwendung {
  /** Namen der Warengruppen, die allgemein auf diesen Drucker drucken */
  warengruppen: string[]
  /** Anzahl Artikel mit diesem Drucker als eigener Angabe */
  artikel:      number
  /** Anzahl Kassen-Ausnahmen (Warengruppe oder Artikel an einer Kasse) auf diesen Drucker */
  ausnahmen:    number
  /** KDS-Stationen, deren Papierbon hier druckt */
  stationen:    Station[]
  /** Fester Fallback-Drucker? */
  fallback:     boolean
}

export function bonierdruckerVerwendung(
  druckerId: string,
  daten: {
    kategorien:     readonly Pick<Kategorie, 'name' | 'bonierdruckerId'>[]
    artikel:        readonly { bonierdruckerId: string | null }[]
    ausnahmen:      readonly Pick<RoutingAusnahme, 'bonierdruckerId'>[]
    stationDrucker: readonly { station: Station; bonierdruckerId: string }[]
    fallbackId:     string | null
  },
): BonierdruckerVerwendung {
  return {
    warengruppen: daten.kategorien.filter(k => k.bonierdruckerId === druckerId).map(k => k.name),
    artikel:      daten.artikel.filter(a => a.bonierdruckerId === druckerId).length,
    ausnahmen:    daten.ausnahmen.filter(a => a.bonierdruckerId === druckerId).length,
    stationen:    daten.stationDrucker.filter(e => e.bonierdruckerId === druckerId).map(e => e.station),
    fallback:     daten.fallbackId === druckerId,
  }
}

export interface BonierdruckerBackup {
  /** Der Backup-Drucker, der einspringt, wenn dieser Drucker nicht erreichbar ist (null = keiner) */
  backup:     { name: string; aktiv: boolean } | null
  /** Namen der Drucker, für die dieser Drucker der Backup-Drucker ist */
  backupFuer: string[]
}

/**
 * Der Backup-Drucker (Ersatz bei Ausfall) eines Druckers — und für welche Drucker er selbst einspringt.
 * Nicht zu verwechseln mit dem Zweitdrucker (istBackup), der jeden Bon als Kopie bekommt.
 */
export function bonierdruckerBackup(
  druckerId: string,
  drucker:   readonly Pick<Bonierdrucker, 'id' | 'name' | 'aktiv' | 'fallbackId'>[],
): BonierdruckerBackup {
  const eigener = drucker.find(d => d.id === druckerId)
  const backup  = eigener?.fallbackId ? drucker.find(d => d.id === eigener.fallbackId) : undefined
  return {
    backup:     backup ? { name: backup.name, aktiv: backup.aktiv } : null,
    backupFuer: drucker.filter(d => d.fallbackId === druckerId).map(d => d.name),
  }
}

/** Kassen, deren Rechnungs-/Bondrucker (Bibliothek „Drucker") dieser ist. */
export const kassenMitRechnungsdrucker = (druckerId: string, kassen: readonly EinrichtungKasse[]): EinrichtungKasse[] =>
  kassen.filter(k => k.druckerId === druckerId)

/**
 * Wendet Änderungen auf die Ausnahmen an — dieselbe Regel wie der Server (Stapel der Reihe nach, nur
 * angegebene Felder ändern sich, eine Ausnahme ohne jede Angabe verschwindet). Damit zeigt die Oberfläche
 * die Änderung sofort, bevor die Antwort des Servers da ist.
 */
export function wendeAenderungenAn(ausnahmen: readonly RoutingAusnahme[], aenderungen: readonly RoutingAenderung[]): RoutingAusnahme[] {
  const zellen = new Map<string, RoutingAusnahme>()
  for (const a of ausnahmen) {
    const ziel: RoutingZiel | null = a.kategorieId ? { kategorieId: a.kategorieId } : a.artikelId ? { artikelId: a.artikelId } : null
    if (ziel) zellen.set(zellenSchluessel(a.kasseId, ziel), { ...a })
  }
  for (const c of aenderungen) {
    const ziel: RoutingZiel = c.kategorieId ? { kategorieId: c.kategorieId } : { artikelId: c.artikelId! }
    const s = zellenSchluessel(c.kasseId, ziel)
    const z: RoutingAusnahme = zellen.get(s) ?? {
      kasseId: c.kasseId, kategorieId: c.kategorieId ?? null, artikelId: c.artikelId ?? null,
      bonierdruckerId: null, keinDrucker: false, station: null, keineStation: false,
    }
    if (c.drucker !== undefined) {
      z.bonierdruckerId = c.drucker !== null && c.drucker !== 'keiner' ? c.drucker : null
      z.keinDrucker     = c.drucker === 'keiner'
    }
    if (c.station !== undefined) {
      z.station      = c.station !== null && c.station !== 'keine' ? c.station : null
      z.keineStation = c.station === 'keine'
    }
    const leer = z.bonierdruckerId === null && !z.keinDrucker && z.station === null && !z.keineStation
    if (leer) zellen.delete(s)
    else zellen.set(s, z)
  }
  return [...zellen.values()]
}

/**
 * Die Kassen-IDs beim Anlegen mehrerer Kassen auf einmal: ab der eingegebenen ersten ID wird die Endnummer
 * hochgezählt (KASSE-004 → KASSE-004, KASSE-005, …; Stellenzahl bleibt). Hat die erste ID keine Endnummer,
 * wird -1, -2, … angehängt. Bei `anzahl` 1 bleibt die ID genau wie eingegeben.
 */
export function kassenIdsFolge(erste: string, anzahl: number): string[] {
  const id = erste.trim()
  if (anzahl <= 1) return [id]
  const m = ID_MUSTER.exec(id)
  if (!m) return Array.from({ length: anzahl }, (_, i) => `${id}-${i + 1}`)
  const praefix = m[1]!, start = parseInt(m[2]!, 10), breite = m[2]!.length
  return Array.from({ length: anzahl }, (_, i) => `${praefix}${String(start + i).padStart(breite, '0')}`)
}

// ---------------------------------------------------------------------------
// Start-Reiter der Artikelwahl (je Kasse)
// ---------------------------------------------------------------------------

type StartFelder = Pick<EinrichtungKasse, 'startFavoriten' | 'startKategorieId'>

/** Wert der Auswahl „Artikelwahl startet mit": 'favoriten', 'erste' (erste Warengruppe mit Artikeln) oder die ID einer Warengruppe. */
export const startReiterWert = (k: StartFelder): string =>
  k.startFavoriten ? 'favoriten' : (k.startKategorieId ?? 'erste')

/** Die Felder, die zu einem Wert der Auswahl gehören (Gegenstück zu startReiterWert). */
export function startReiterFelder(wert: string): StartFelder {
  if (wert === 'favoriten') return { startFavoriten: true,  startKategorieId: null }
  if (wert === 'erste')     return { startFavoriten: false, startKategorieId: null }
  return { startFavoriten: false, startKategorieId: wert }
}

/**
 * Was die Artikelwahl einer Kasse als Reiter zeigt (so rechnet die Kasse selbst, siehe kassenAnsicht):
 * `gruppen` = alle dort erreichbaren Warengruppen in Baumreihenfolge, mit Pfad — zur Auswahl; `reiter` = deren
 * Hauptgruppen. Genau EIN Reiter heißt: diese Warengruppe öffnet sich beim Start von selbst.
 */
export function startReiterAuswahl(
  kategorien: readonly Kategorie[],
  sichtbareKategorieIds: readonly string[],
): { gruppen: { id: string; pfad: string }[]; reiter: Kategorie[] } {
  const ansicht = kassenAnsicht(kategorien, [], sichtbareKategorieIds)
  return {
    gruppen: baumFlach(ansicht.gruppen).map(({ kategorie: k }) => ({ id: k.id, pfad: kategoriePfad(kategorien, k.id) })),
    reiter:  ansicht.reiter,
  }
}
