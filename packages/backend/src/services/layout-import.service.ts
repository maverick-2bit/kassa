/**
 * Layout-Import: wendet einen Gruppenbaum mit Raster-Slots, Farben und
 * Favoriten (z. B. aus der alten Asello-Kasse) auf die Kassa an.
 *
 * Aufbau:
 *   planeLayout()     reine Logik (kein DB-Zugriff): Matching + Soll-Zustand → Plan + Bericht
 *   wendeLayoutAn()   lädt den Ist-Zustand des Mandanten, plant, schreibt (alles in EINER
 *                     Transaktion); dryRun liefert denselben Bericht ohne zu schreiben
 *
 * Matching (die Kassa enthält die Artikel meist schon in FLACHEN Warengruppen):
 *  - Artikel über den normalisierten Namen; bei Namensgleichheit zählt die Gruppe
 *    („Speisen" ≙ „Kellner Speisen" als Präfix-Variante); jeder Kassa-Artikel wird nur
 *    einmal vergeben; Unklares wird „mehrdeutig" gemeldet und NICHT angefasst.
 *  - Gruppen über Namen (+ Präfix-Variante), bevorzugt die mit den meisten Artikeln
 *    des Knotens; sonst neu angelegt.
 *  - Stationen/Bonierdrucker bleiben an den bestehenden Artikeln/Gruppen unberührt.
 * Idempotent: ein zweiter Lauf ordnet dieselben Artikel/Gruppen zu und ändert nichts mehr.
 */

import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { LayoutBericht, LayoutGruppe, LayoutImport, LayoutImportOptionen } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, kassen, kasseFavoriten, kategorien } from '../db/schema.js'
import type { DbOrTx } from './bestandteil.service.js'
import { generiereArtikelNummer } from './artikel.service.js'

/** Farbe für Gruppen ohne gesetzte Farbe (Asello: „grau"). */
export const STANDARD_GRUPPENFARBE = '#637685'

// ---------------------------------------------------------------------------
// Normalisierung + Namens-Passung
// ---------------------------------------------------------------------------

/**
 * Vergleichsform eines Namens: Kleinbuchstaben, Whitespace gekürzt, Apostroph-
 * Varianten (´ ` ‘ ’) vereinheitlicht, führendes „#"/Leerzeichen ignoriert.
 * Umlaute bleiben erhalten.
 */
export function normalisiereName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[  -​ 　]/g, ' ')
    .replace(/[´`‘’′ʼ]/g, "'")
    .replace(/^[#\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Passt der Name einer Kassa-Gruppe zum Namen eines Layout-Knotens?
 * 2 = gleich, 1 = Präfix-Variante („Kellner Speisen" für „Speisen"), 0 = nein.
 */
export function namensPassung(kassaGruppe: string, knoten: string): 0 | 1 | 2 {
  const g = normalisiereName(kassaGruppe)
  const k = normalisiereName(knoten)
  if (k === '') return 0
  if (g === k) return 2
  return g.endsWith(' ' + k) ? 1 : 0
}

const MWST_SAETZE: Record<number, string> = { 20: 'normal', 10: 'ermaessigt1', 13: 'ermaessigt2', 0: 'null', 19: 'besonders' }

/** 0.2 → 'normal', 0.1 → 'ermaessigt1', 0.13 → 'ermaessigt2', 0 → 'null', 0.19 → 'besonders'; sonst undefined. */
export function mwstZuSatz(mwst: number): string | undefined {
  return MWST_SAETZE[Math.round(mwst * 100)]
}

// ---------------------------------------------------------------------------
// Typen: Ist-Zustand + Plan
// ---------------------------------------------------------------------------

export interface KassaGruppe {
  id: string; name: string; parentId: string | null; aktiv: boolean
  farbe: string; reihenfolge: number
  station: string | null; bonierdruckerId: string | null; terminalSichtbar: boolean
}
export interface KassaArtikel {
  id: string; bezeichnung: string; kategorieId: string | null; farbe: string | null
  rasterPosition: number | null; reihenfolge: number
  istFavorit: boolean; favoritenReihenfolge: number
  aktiv: boolean; istBestandteil: boolean
}
export interface KassaZustand {
  gruppen: KassaGruppe[]
  artikel: KassaArtikel[]
  kassen: { id: string; artikelProZeile: number }[]
  kassenFavoritenAnzahl: number
}

export interface LayoutPlan {
  bericht: LayoutBericht
  /** Eltern vor Kindern */
  neueGruppen: { id: string; name: string; parentId: string | null; farbe: string; reihenfolge: number
    station: string | null; bonierdruckerId: string | null; terminalSichtbar: boolean }[]
  gruppenUpdates: { id: string; werte: { parentId?: string | null; farbe?: string; reihenfolge?: number } }[]
  neueArtikel: { id: string; bezeichnung: string; preisBruttoCent: number; mwstSatz: string; kategorieId: string
    farbe: string | null; rasterPosition: number | null; reihenfolge: number
    istFavorit: boolean; favoritenReihenfolge: number }[]
  artikelUpdates: { id: string; werte: { kategorieId?: string; farbe?: string | null; rasterPosition?: number | null
    reihenfolge?: number; istFavorit?: boolean; favoritenReihenfolge?: number } }[]
  kassenFavoritenLoeschen: boolean
  kassenUpdates: { id: string; artikelProZeile: number }[]
}

// ---------------------------------------------------------------------------
// Interne Strukturen
// ---------------------------------------------------------------------------

interface Zeile {
  knoten:  Knoten
  artikel: LayoutGruppe['artikel'][number]
  nameNorm: string
  ordnung: number
  /** zugeordneter Kassa-Artikel */
  kassa?:   KassaArtikel
  /** neu anzulegender Artikel (id vorab vergeben) */
  neuId?:   string
  status:  'offen' | 'zugeordnet' | 'neu' | 'mehrdeutig' | 'fehlt'
  slotDoppelt?: boolean
}

interface Knoten {
  ordnung:  number
  layout:   LayoutGruppe
  segmente: string[]
  norm:     string[]
  pfad:     string
  parent:   Knoten | null
  position: number
  zeilen:   Zeile[]
  kinder:   Knoten[]
  ziel?:    { id: string; neu: boolean; gruppe?: KassaGruppe }
  werte?:   { station: string | null; bonierdruckerId: string | null; terminalSichtbar: boolean }
}

function flacheKnoten(gruppen: readonly LayoutGruppe[]): Knoten[] {
  const liste: Knoten[] = []
  const rein = (gs: readonly LayoutGruppe[], parent: Knoten | null) => {
    const sortiert = gs.map((g, i) => ({ g, i }))
      .sort((a, b) => (a.g.reihenfolge ?? Number.MAX_SAFE_INTEGER) - (b.g.reihenfolge ?? Number.MAX_SAFE_INTEGER) || a.i - b.i)
    sortiert.forEach(({ g }, position) => {
      const segmente = [...(parent?.segmente ?? []), g.name]
      const knoten: Knoten = {
        ordnung: liste.length, layout: g, segmente, norm: segmente.map(normalisiereName),
        pfad: segmente.join('/'), parent, position, zeilen: [], kinder: [],
      }
      parent?.kinder.push(knoten)
      liste.push(knoten)
      rein(g.untergruppen, knoten)
    })
  }
  rein(gruppen, null)
  return liste
}

const zaehle = <T>(items: Iterable<T>, schluessel: (t: T) => string | null): Map<string, number> => {
  const m = new Map<string, number>()
  for (const t of items) {
    const k = schluessel(t)
    if (k !== null) m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

// ---------------------------------------------------------------------------
// Planung (rein)
// ---------------------------------------------------------------------------

export function planeLayout(zustand: KassaZustand, layout: LayoutImport, opts: LayoutImportOptionen): LayoutPlan {
  const knotenListe = flacheKnoten(layout.gruppen)
  const gruppeById = new Map(zustand.gruppen.map(g => [g.id, g] as const))
  const aktiveGruppen = zustand.gruppen.filter(g => g.aktiv).sort((a, b) => a.reihenfolge - b.reihenfolge || a.id.localeCompare(b.id))

  // Pfad (normalisierte Namen von der Wurzel) einer Kassa-Gruppe — Zyklen im Altbestand abfangen
  const pfadCache = new Map<string, string[]>()
  const kassaPfad = (g: KassaGruppe): string[] => {
    const hit = pfadCache.get(g.id)
    if (hit) return hit
    const pfad: string[] = []
    const besucht = new Set<string>()
    for (let cur: KassaGruppe | undefined = g; cur && !besucht.has(cur.id); cur = cur.parentId ? gruppeById.get(cur.parentId) : undefined) {
      besucht.add(cur.id)
      pfad.unshift(normalisiereName(cur.name))
    }
    pfadCache.set(g.id, pfad)
    return pfad
  }
  const pfadPasst = (g: KassaGruppe, k: Knoten): boolean => {
    const p = kassaPfad(g)
    return p.length === k.norm.length && p.every((seg, i) => namensPassung(seg, k.norm[i]!) > 0)
  }
  /**
   * Passung Kassa-Gruppe ↔ Knoten (0 = passt nicht): gleicher Name 20; Präfix-Variante 10 — 25, wenn das
   * Präfix in einer Elterngruppe des Knotens vorkommt („Kellner Alkoholfrei" für Kellner Getränke/Alkoholfrei);
   * +5 wenn der ganze Pfad passt.
   */
  const gruppenPassung = (g: KassaGruppe, k: Knoten): number => {
    const letzter = k.norm[k.norm.length - 1]!
    const nf = namensPassung(g.name, letzter)
    if (nf === 0) return 0
    let basis = 20
    if (nf === 1) {
      const praefix = normalisiereName(g.name).slice(0, -(letzter.length + 1))
      const belegt = k.norm.slice(0, -1).some(seg => seg.startsWith(praefix) || seg.split(' ').includes(praefix))
      basis = belegt ? 25 : 10
    }
    return basis + (pfadPasst(g, k) ? 5 : 0)
  }

  // --- Zeilen je Knoten (nach Slot) --------------------------------------
  const zeilen: Zeile[] = []
  for (const k of knotenListe) {
    const sortiert = k.layout.artikel.map((a, i) => ({ a, i })).sort((x, y) => x.a.slot - y.a.slot || x.i - y.i)
    for (const { a } of sortiert) {
      const z: Zeile = { knoten: k, artikel: a, nameNorm: normalisiereName(a.name), ordnung: zeilen.length, status: 'offen' }
      k.zeilen.push(z)
      zeilen.push(z)
    }
  }

  // --- 1. Artikel zuordnen ------------------------------------------------
  const kandidatenNachName = new Map<string, KassaArtikel[]>()
  for (const a of [...zustand.artikel].sort((x, y) => x.id.localeCompare(y.id))) {
    if (!a.aktiv || a.istBestandteil) continue
    const key = normalisiereName(a.bezeichnung)
    kandidatenNachName.set(key, [...(kandidatenNachName.get(key) ?? []), a])
  }
  const zeilenNachName = new Map<string, Zeile[]>()
  for (const z of zeilen) zeilenNachName.set(z.nameNorm, [...(zeilenNachName.get(z.nameNorm) ?? []), z])

  const mehrdeutigKandidaten = new Map<Zeile, KassaArtikel[]>()
  const artikelPassung = (z: Zeile, c: KassaArtikel): number => {
    const g = c.kategorieId ? gruppeById.get(c.kategorieId) : undefined
    return g ? gruppenPassung(g, z.knoten) : 0
  }

  for (const [name, rs] of zeilenNachName) {
    const cs = kandidatenNachName.get(name) ?? []
    const benutzt = new Set<string>()
    const vergeben = (z: Zeile, c: KassaArtikel) => { z.kassa = c; z.status = 'zugeordnet'; benutzt.add(c.id) }

    if (rs.length === 1 && cs.length === 1) {
      vergeben(rs[0]!, cs[0]!)
      continue
    }
    const paare = rs.flatMap(z => cs.map(c => ({ z, c, fit: artikelPassung(z, c) }))).filter(p => p.fit > 0)
    const stufen = [...new Set(paare.map(p => p.fit))].sort((a, b) => b - a)
    for (const stufe of stufen) {
      let aktuell = paare.filter(p => p.fit === stufe && p.z.status === 'offen' && !benutzt.has(p.c.id))
      // Zeile mit Kandidaten aus verschiedenen Gruppen / Kandidat, um den Zeilen verschiedener Gruppen
      // konkurrieren → nicht zu entscheiden
      const unklar = new Set<Zeile>()
      for (const z of new Set(aktuell.map(p => p.z))) {
        const eigene = aktuell.filter(p => p.z === z)
        if (new Set(eigene.map(p => p.c.kategorieId)).size > 1) unklar.add(z)
      }
      for (const c of new Set(aktuell.map(p => p.c))) {
        const konkurrenz = aktuell.filter(p => p.c === c).map(p => p.z)
        if (new Set(konkurrenz.map(z => z.knoten)).size > 1) konkurrenz.forEach(z => unklar.add(z))
      }
      for (const z of unklar) {
        z.status = 'mehrdeutig'
        mehrdeutigKandidaten.set(z, aktuell.filter(p => p.z === z).map(p => p.c))
      }
      aktuell = aktuell.filter(p => !unklar.has(p.z))
      for (const z of rs) {
        if (z.status !== 'offen') continue
        const eigene = aktuell
          .filter(p => p.z === z && !benutzt.has(p.c.id))
          // austauschbare Duplikate: bevorzugt der Artikel, der schon an diesem Slot steht (Idempotenz)
          .sort((a, b) => Number(b.c.rasterPosition === z.artikel.slot) - Number(a.c.rasterPosition === z.artikel.slot) || a.c.id.localeCompare(b.c.id))
        if (eigene[0]) vergeben(z, eigene[0].c)
      }
    }
    // Rest: noch freie Kassa-Artikel → nicht zu entscheiden; sonst fehlt der Artikel
    const frei = cs.filter(c => !benutzt.has(c.id))
    for (const z of rs) {
      if (z.status !== 'offen') continue
      if (frei.length > 0) { z.status = 'mehrdeutig'; mehrdeutigKandidaten.set(z, frei) } else z.status = 'fehlt'
    }
  }

  // --- 2. Gruppen zuordnen -------------------------------------------------
  const paareG: { k: Knoten; g: KassaGruppe; score: number }[] = []
  for (const k of knotenListe) {
    const eigene = zaehle(k.zeilen.filter(z => z.kassa), z => z.kassa!.kategorieId)
    for (const g of aktiveGruppen) {
      const fit = gruppenPassung(g, k)
      if (fit === 0) continue
      paareG.push({ k, g, score: (eigene.get(g.id) ?? 0) * 1000 + fit })
    }
  }
  paareG.sort((a, b) => b.score - a.score || a.k.ordnung - b.k.ordnung)
  const gruppeVergeben = new Set<string>()
  for (const p of paareG) {
    if (p.k.ziel || gruppeVergeben.has(p.g.id)) continue
    p.k.ziel = { id: p.g.id, neu: false, gruppe: p.g }
    gruppeVergeben.add(p.g.id)
  }

  // --- 3. Gruppen planen (Eltern vor Kindern) ---------------------------
  const plan: LayoutPlan = {
    bericht: undefined as unknown as LayoutBericht,
    neueGruppen: [], gruppenUpdates: [], neueArtikel: [], artikelUpdates: [],
    kassenFavoritenLoeschen: false, kassenUpdates: [],
  }
  let gruppenGeaendert = 0, gruppenUmgehaengt = 0

  const unterKnoten = (k: Knoten): Knoten[] => [k, ...k.kinder.flatMap(unterKnoten)]
  for (const k of knotenListe) {
    const parentId = k.parent?.ziel?.id ?? null
    const farbe = k.layout.farbeGesetzt === false ? STANDARD_GRUPPENFARBE : k.layout.farbe
    if (k.ziel?.gruppe) {
      const g = k.ziel.gruppe
      k.werte = { station: g.station, bonierdruckerId: g.bonierdruckerId, terminalSichtbar: g.terminalSichtbar }
      const werte: LayoutPlan['gruppenUpdates'][number]['werte'] = {}
      if (g.parentId !== parentId) { werte.parentId = parentId; gruppenUmgehaengt++ }
      if (g.farbe !== farbe) werte.farbe = farbe
      if (g.reihenfolge !== k.position) werte.reihenfolge = k.position
      if (Object.keys(werte).length > 0) { plan.gruppenUpdates.push({ id: g.id, werte }); gruppenGeaendert++ }
    } else {
      // Station/Bonierdrucker/Terminal von der häufigsten bisherigen Gruppe der Artikel erben
      const bisherige = (ks: Knoten[]) => zaehle(
        ks.flatMap(x => x.zeilen).filter(z => z.kassa?.kategorieId),
        z => z.kassa!.kategorieId,
      )
      let haeufigste = [...bisherige([k]).entries()]
      if (haeufigste.length === 0) haeufigste = [...bisherige(unterKnoten(k)).entries()]
      haeufigste.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      const quelle = haeufigste[0] ? gruppeById.get(haeufigste[0][0]) : undefined
      k.werte = quelle
        ? { station: quelle.station, bonierdruckerId: quelle.bonierdruckerId, terminalSichtbar: quelle.terminalSichtbar }
        : (k.parent?.werte ?? { station: null, bonierdruckerId: null, terminalSichtbar: false })
      const id = randomUUID()
      k.ziel = { id, neu: true }
      plan.neueGruppen.push({ id, name: k.layout.name, parentId, farbe, reihenfolge: k.position, ...k.werte })
    }
  }

  // --- 4. Artikel planen ---------------------------------------------------
  const probleme: LayoutBericht['probleme'] = {
    mehrdeutig: [], nichtGefunden: [], doppelteSlots: [], favoritenNichtAufgeloest: [], nichtZugeordneteKassaGruppen: [],
  }
  const artikelVorab = new Map(zustand.artikel.map(a => [a.id, a] as const))
  const artikelUpdates = new Map<string, LayoutPlan['artikelUpdates'][number]['werte']>()
  const neueArtikel = new Map<string, LayoutPlan['neueArtikel'][number]>()
  let zugeordnet = 0, neu = 0, mehrdeutig = 0, nichtAngelegt = 0, artikelGeaendert = 0

  for (const k of knotenListe) {
    const belegteSlots = new Set<number>()
    for (const z of k.zeilen) {
      const slotFrei = !belegteSlots.has(z.artikel.slot)
      belegteSlots.add(z.artikel.slot)
      if (!slotFrei) {
        z.slotDoppelt = true
        probleme.doppelteSlots.push({ name: z.artikel.name, pfad: k.pfad, slot: z.artikel.slot })
      }
      const rasterPosition = slotFrei ? z.artikel.slot : null
      const farbe = z.artikel.farbe ?? null
      const kategorieId = k.ziel!.id

      if (z.status === 'mehrdeutig') {
        mehrdeutig++
        probleme.mehrdeutig.push({
          name: z.artikel.name, pfad: k.pfad,
          kandidaten: (mehrdeutigKandidaten.get(z) ?? []).map(c => ({
            id: c.id, gruppe: (c.kategorieId ? gruppeById.get(c.kategorieId)?.name : undefined) ?? '(ohne Gruppe)',
          })),
        })
      } else if (z.status === 'zugeordnet' && z.kassa) {
        zugeordnet++
        const a = z.kassa
        const werte: LayoutPlan['artikelUpdates'][number]['werte'] = {}
        if (a.kategorieId !== kategorieId)      werte.kategorieId    = kategorieId
        if (a.farbe !== farbe)                  werte.farbe          = farbe
        if (a.rasterPosition !== rasterPosition) werte.rasterPosition = rasterPosition
        if (a.reihenfolge !== z.artikel.slot)   werte.reihenfolge    = z.artikel.slot
        if (Object.keys(werte).length > 0) { artikelUpdates.set(a.id, werte); artikelGeaendert++ }
      } else if (z.status === 'fehlt') {
        const satz = mwstZuSatz(z.artikel.mwst)
        if (!opts.fehlendeAnlegen || !satz || z.artikel.preisCent < 0) {
          nichtAngelegt++
          probleme.nichtGefunden.push({
            name: z.artikel.name, pfad: k.pfad,
            grund: !opts.fehlendeAnlegen ? 'nicht in der Kassa — Anlegen abgewählt'
              : !satz ? `Steuersatz ${Math.round(z.artikel.mwst * 100)} % unbekannt — nicht angelegt`
              : 'negativer Preis (Rückgabe/Pfand) — bitte von Hand anlegen',
          })
        } else {
          neu++
          z.status = 'neu'
          z.neuId = randomUUID()
          neueArtikel.set(z.neuId, {
            id: z.neuId, bezeichnung: z.artikel.name.trim(), preisBruttoCent: z.artikel.preisCent, mwstSatz: satz,
            kategorieId, farbe, rasterPosition, reihenfolge: z.artikel.slot, istFavorit: false, favoritenReihenfolge: 0,
          })
        }
      }
    }
  }

  // --- 5. Favoriten --------------------------------------------------------
  const favoriten = { gesetzt: 0, nichtAufgeloest: 0, entfernt: 0 }
  if (layout.favoriten.length > 0) {
    const verwendet = new Set<Zeile>()
    const zielArtikel: string[] = []
    for (const f of layout.favoriten) {
      const pfadNorm = f.pfad.split('/').map(normalisiereName).join('/')
      const nameNorm = normalisiereName(f.name)
      const treffer = zeilen.filter(z => !verwendet.has(z) && z.nameNorm === nameNorm && z.knoten.norm.join('/') === pfadNorm)
      const z = treffer[0]
      if (!z) {
        favoriten.nichtAufgeloest++
        probleme.favoritenNichtAufgeloest.push({ name: f.name, pfad: f.pfad, grund: 'Artikel mit diesem Namen nicht in dieser Gruppe des Layouts' })
        continue
      }
      verwendet.add(z)
      const id = z.kassa?.id ?? z.neuId
      if (!id) {
        favoriten.nichtAufgeloest++
        probleme.favoritenNichtAufgeloest.push({
          name: f.name, pfad: f.pfad,
          grund: z.status === 'mehrdeutig' ? 'Artikel ist mehrdeutig' : 'Artikel nicht in der Kassa (nicht angelegt)',
        })
        continue
      }
      zielArtikel.push(id)
    }
    const position = new Map(zielArtikel.map((id, i) => [id, i + 1] as const))
    favoriten.gesetzt = zielArtikel.length
    for (const a of zustand.artikel) {
      const pos = position.get(a.id)
      const werte = artikelUpdates.get(a.id) ?? {}
      if (pos === undefined) {
        if (a.istFavorit) { werte.istFavorit = false; favoriten.entfernt++ }
      } else {
        if (!a.istFavorit) werte.istFavorit = true
        if (a.favoritenReihenfolge !== pos) werte.favoritenReihenfolge = pos
      }
      if (Object.keys(werte).length > 0) artikelUpdates.set(a.id, werte)
    }
    for (const n of neueArtikel.values()) {
      const pos = position.get(n.id)
      if (pos !== undefined) { n.istFavorit = true; n.favoritenReihenfolge = pos }
    }
    plan.kassenFavoritenLoeschen = zustand.kassenFavoritenAnzahl > 0
  }
  plan.artikelUpdates = [...artikelUpdates].map(([id, werte]) => ({ id, werte }))
  plan.neueArtikel = [...neueArtikel.values()]

  // --- 6. Kassen: Spalten ---------------------------------------------------
  if (opts.spaltenSetzen && layout.spalten !== undefined) {
    plan.kassenUpdates = zustand.kassen
      .filter(ka => ka.artikelProZeile !== layout.spalten)
      .map(ka => ({ id: ka.id, artikelProZeile: layout.spalten! }))
  }

  // --- 7. Kassa-Gruppen ohne Gegenstück (zur Info) ---------------------------
  const kategorieNach = new Map(zustand.artikel.map(a => [a.id, a.kategorieId] as const))
  for (const u of plan.artikelUpdates) if (u.werte.kategorieId) kategorieNach.set(u.id, u.werte.kategorieId)
  const rest = zaehle(
    zustand.artikel.filter(a => a.aktiv && !a.istBestandteil),
    a => kategorieNach.get(a.id) ?? null,
  )
  for (const g of aktiveGruppen) {
    if (gruppeVergeben.has(g.id)) continue
    probleme.nichtZugeordneteKassaGruppen.push({ id: g.id, name: g.name, artikel: rest.get(g.id) ?? 0 })
  }

  // --- Bericht ---------------------------------------------------------------
  const kassenFavoritenGeloescht = plan.kassenFavoritenLoeschen ? zustand.kassenFavoritenAnzahl : 0
  const zaehler: LayoutBericht['zaehler'] = {
    gruppen: {
      imLayout: knotenListe.length,
      gefunden: knotenListe.filter(k => k.ziel && !k.ziel.neu).length,
      neu: plan.neueGruppen.length,
      geaendert: gruppenGeaendert,
      umgehaengt: gruppenUmgehaengt,
    },
    artikel: { imLayout: zeilen.length, zugeordnet, neu, mehrdeutig, nichtGefundenNichtAngelegt: nichtAngelegt, geaendert: artikelGeaendert },
    favoriten: { ...favoriten, kassenFavoritenGeloescht },
    kassen: { rasterAufSpaltenGesetzt: plan.kassenUpdates.length },
  }
  const z = zaehler
  const zusammenfassung = [
    `Gruppen: ${z.gruppen.imLayout} im Layout — ${z.gruppen.gefunden} bestehende wiederverwendet, ${z.gruppen.neu} neu angelegt, ${z.gruppen.geaendert} bestehende angepasst (davon ${z.gruppen.umgehaengt} umgehängt).`,
    `Artikel: ${z.artikel.imLayout} im Layout — ${z.artikel.zugeordnet} zugeordnet (${z.artikel.geaendert} davon mit Änderung), ${z.artikel.neu} neu angelegt, ${z.artikel.mehrdeutig} mehrdeutig (nicht angefasst), ${z.artikel.nichtGefundenNichtAngelegt} nicht gefunden und nicht angelegt.`,
    layout.favoriten.length > 0
      ? `Favoriten: ${z.favoriten.gesetzt} von ${layout.favoriten.length} gesetzt, ${z.favoriten.nichtAufgeloest} nicht aufgelöst, ${z.favoriten.entfernt} bisherige entfernt` +
        (kassenFavoritenGeloescht > 0 ? `; ${kassenFavoritenGeloescht} Zeilen der Kassen-eigenen Favoritenlisten gelöscht (sonst überschreiben sie die globale Liste).` : '.')
      : 'Favoriten: keine im Layout — unverändert.',
    opts.spaltenSetzen && layout.spalten !== undefined
      ? `Raster: ${z.kassen.rasterAufSpaltenGesetzt} Kasse(n) auf ${layout.spalten} Spalten gestellt.`
      : 'Raster: Spaltenanzahl unverändert.',
  ]
  if (probleme.nichtZugeordneteKassaGruppen.length > 0) {
    zusammenfassung.push(`${probleme.nichtZugeordneteKassaGruppen.length} bestehende Kassa-Gruppe(n) ohne Gegenstück im Layout bleiben unverändert (ggf. aufräumen).`)
  }
  plan.bericht = { dryRun: opts.dryRun, zusammenfassung, zaehler, probleme }
  return plan
}

// ---------------------------------------------------------------------------
// Ausführung
// ---------------------------------------------------------------------------

async function ladeZustand(db: DbOrTx, mandantId: string): Promise<KassaZustand> {
  const gruppen = await db.select().from(kategorien).where(eq(kategorien.mandantId, mandantId))
  const artikelRows = await db.select().from(artikel).where(eq(artikel.mandantId, mandantId))
  const kassenRows = await db.select({ id: kassen.id, artikelProZeile: kassen.artikelProZeile })
    .from(kassen).where(eq(kassen.mandantId, mandantId))
  const [fav] = await db.select({ n: sql<number>`count(*)::int` }).from(kasseFavoriten).where(eq(kasseFavoriten.mandantId, mandantId))
  return {
    gruppen: gruppen.map(g => ({
      id: g.id, name: g.name, parentId: g.parentId, aktiv: g.aktiv, farbe: g.farbe, reihenfolge: g.reihenfolge,
      station: g.station, bonierdruckerId: g.bonierdruckerId, terminalSichtbar: g.terminalSichtbar,
    })),
    artikel: artikelRows.map(a => ({
      id: a.id, bezeichnung: a.bezeichnung, kategorieId: a.kategorieId, farbe: a.farbe,
      rasterPosition: a.rasterPosition, reihenfolge: a.reihenfolge,
      istFavorit: a.istFavorit, favoritenReihenfolge: a.favoritenReihenfolge,
      aktiv: a.aktiv, istBestandteil: a.istBestandteil,
    })),
    kassen: kassenRows,
    kassenFavoritenAnzahl: fav?.n ?? 0,
  }
}

async function schreibePlan(tx: DbOrTx, mandantId: string, plan: LayoutPlan): Promise<void> {
  const jetzt = new Date()
  // Neue Gruppen: Eltern vor Kindern (Self-FK)
  for (const g of plan.neueGruppen) {
    await tx.insert(kategorien).values({
      id: g.id, mandantId, name: g.name, farbe: g.farbe, reihenfolge: g.reihenfolge, parentId: g.parentId,
      station: g.station, bonierdruckerId: g.bonierdruckerId, terminalSichtbar: g.terminalSichtbar,
    })
  }
  for (const u of plan.gruppenUpdates) {
    await tx.update(kategorien).set({ ...u.werte, updatedAt: jetzt })
      .where(and(eq(kategorien.id, u.id), eq(kategorien.mandantId, mandantId)))
  }
  if (plan.neueArtikel.length > 0) {
    let nummer = Number(await generiereArtikelNummer(tx, mandantId))
    for (const n of plan.neueArtikel) {
      await tx.insert(artikel).values({
        id: n.id, mandantId, bezeichnung: n.bezeichnung, preisBruttoCent: n.preisBruttoCent, mwstSatz: n.mwstSatz,
        artikelnummer: String(nummer++).padStart(4, '0'), kategorieId: n.kategorieId, farbe: n.farbe,
        rasterPosition: n.rasterPosition, reihenfolge: n.reihenfolge,
        istFavorit: n.istFavorit, favoritenReihenfolge: n.favoritenReihenfolge,
      })
    }
  }
  for (const u of plan.artikelUpdates) {
    await tx.update(artikel).set({ ...u.werte, updatedAt: jetzt })
      .where(and(eq(artikel.id, u.id), eq(artikel.mandantId, mandantId)))
  }
  if (plan.kassenFavoritenLoeschen) {
    await tx.delete(kasseFavoriten).where(eq(kasseFavoriten.mandantId, mandantId))
  }
  for (const u of plan.kassenUpdates) {
    await tx.update(kassen).set({ artikelProZeile: u.artikelProZeile })
      .where(and(eq(kassen.id, u.id), eq(kassen.mandantId, mandantId)))
  }
}

/**
 * Wendet das Layout auf den Mandanten an. `mandantId` kommt IMMER aus dem JWT.
 * Alles in einer Transaktion; bei dryRun wird nichts geschrieben.
 */
export async function wendeLayoutAn(
  db: Db,
  mandantId: string,
  layout: LayoutImport,
  opts: LayoutImportOptionen,
): Promise<LayoutBericht> {
  return db.transaction(async (tx) => {
    // Zwei gleichzeitige Importe desselben Mandanten würden doppelt anlegen
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'layout-import:' + mandantId}))`)
    const zustand = await ladeZustand(tx, mandantId)
    const plan = planeLayout(zustand, layout, opts)
    if (!opts.dryRun) await schreibePlan(tx, mandantId, plan)
    return plan.bericht
  })
}
