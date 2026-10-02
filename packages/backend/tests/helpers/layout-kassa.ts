/**
 * Testhilfe für den Layout-Import: baut aus dem Asello-Layout den Zustand, den die
 * Kassa nach dem früheren Artikel-Import hatte — FLACHE Warengruppen (letzte Ebene
 * als Name, bei Namensgleichheit mit Präfix „Kellner"/„Event"/„Grill"), jeder Artikel
 * einmal in der Gruppe seines Knotens.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { LayoutImportSchema, type LayoutGruppe, type LayoutImport } from '@kassa/shared'
import type { KassaArtikel, KassaGruppe, KassaZustand, LayoutPlan } from '../../src/services/layout-import.service.js'

const hier = dirname(fileURLToPath(import.meta.url))

export function ladeAselloLayout(): LayoutImport {
  const roh = JSON.parse(readFileSync(join(hier, '..', 'fixtures', 'asello-layout-komplett.json'), 'utf8'))
  return LayoutImportSchema.parse(roh)
}

const PRAEFIX: Record<string, string> = { 'Kellner Getränke': 'Kellner', 'Kellner Speisen': 'Kellner', Eventmanagement: 'Event', Grillen: 'Grill' }

let zaehler = 0
export const testId = () => `00000000-0000-4000-8000-${String(++zaehler).padStart(12, '0')}`

export function flacherKassaZustand(layout: LayoutImport): {
  zustand: KassaZustand
  /** Layout-Pfad → Name der flachen Kassa-Gruppe */
  gruppeVonPfad: Map<string, KassaGruppe>
  artikelVonPfadUndName: Map<string, KassaArtikel>
} {
  const gruppen: KassaGruppe[] = []
  const artikel: KassaArtikel[] = []
  const gruppeVonPfad = new Map<string, KassaGruppe>()
  const artikelVonPfadUndName = new Map<string, KassaArtikel>()
  const vergeben = new Set<string>()

  const rein = (gs: LayoutGruppe[], wurzel: string | null, pfad: string[]) => {
    for (const g of gs) {
      const w = wurzel ?? g.name
      const p = [...pfad, g.name]
      if (g.artikel.length > 0) {
        let name = g.name
        if (vergeben.has(name.toLowerCase())) name = `${PRAEFIX[w] ?? 'Alt'} ${g.name}`
        vergeben.add(name.toLowerCase())
        const gruppe: KassaGruppe = {
          id: testId(), name, parentId: null, aktiv: true, farbe: 'grau', reihenfolge: gruppen.length,
          station: p[0] === 'Kellner Getränke' ? 'schank' : null,
          bonierdruckerId: null, terminalSichtbar: false,
        }
        gruppen.push(gruppe)
        gruppeVonPfad.set(p.join('/'), gruppe)
        for (const a of g.artikel) {
          const k: KassaArtikel = {
            id: testId(), bezeichnung: a.name, kategorieId: gruppe.id, farbe: null, rasterPosition: null,
            reihenfolge: 0, istFavorit: false, favoritenReihenfolge: 0, aktiv: true, istBestandteil: false,
          }
          artikel.push(k)
          artikelVonPfadUndName.set(`${p.join('/')}|${a.name}`, k)
        }
      }
      rein(g.untergruppen, w, p)
    }
  }
  rein(layout.gruppen, null, [])
  return {
    zustand: { gruppen, artikel, kassen: [{ id: testId(), artikelProZeile: 4 }], kassenFavoritenAnzahl: 0 },
    gruppeVonPfad, artikelVonPfadUndName,
  }
}

/** Wendet einen Plan auf einen In-Memory-Zustand an (wie die DB-Ausführung, für Idempotenz-Tests). */
export function wendePlanAn(z: KassaZustand, plan: LayoutPlan): KassaZustand {
  const gruppen = z.gruppen.map(g => ({ ...g }))
  const artikel = z.artikel.map(a => ({ ...a }))
  for (const g of plan.neueGruppen) {
    gruppen.push({ id: g.id, name: g.name, parentId: g.parentId, aktiv: true, farbe: g.farbe, reihenfolge: g.reihenfolge,
      station: g.station, bonierdruckerId: g.bonierdruckerId, terminalSichtbar: g.terminalSichtbar })
  }
  for (const u of plan.gruppenUpdates) Object.assign(gruppen.find(g => g.id === u.id)!, u.werte)
  for (const n of plan.neueArtikel) {
    artikel.push({ id: n.id, bezeichnung: n.bezeichnung, kategorieId: n.kategorieId, farbe: n.farbe, rasterPosition: n.rasterPosition,
      reihenfolge: n.reihenfolge, istFavorit: n.istFavorit, favoritenReihenfolge: n.favoritenReihenfolge, aktiv: true, istBestandteil: false })
  }
  for (const u of plan.artikelUpdates) Object.assign(artikel.find(a => a.id === u.id)!, u.werte)
  const kassen = z.kassen.map(k => ({ ...k, artikelProZeile: plan.kassenUpdates.find(u => u.id === k.id)?.artikelProZeile ?? k.artikelProZeile }))
  return { gruppen, artikel, kassen, kassenFavoritenAnzahl: plan.kassenFavoritenLoeschen ? 0 : z.kassenFavoritenAnzahl }
}
