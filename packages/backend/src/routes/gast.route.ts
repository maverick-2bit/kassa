/**
 * Gast-Bestellsystem — öffentliche Routen (kein JWT nötig).
 *
 *   GET  /api/gast/karte?kasseId=<uuid>          Speisekarte laden
 *   POST /api/gast/bestellung                    Bestellung aufgeben
 */

import type { FastifyPluginAsync } from 'fastify'
import { and, eq, asc, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import { artikel, kategorien, kassen, kassekategorieSichtbarkeit, tischTabs } from '../db/schema.js'
import { emitKasseEvent } from '../sse/event-bus.js'

export interface GastRouteOptions { db: Db }

const BestellPosition = z.object({
  artikelId: z.string().uuid(),
  menge:     z.number().int().min(1).max(50),
})

const BestellungBody = z.object({
  kasseId:     z.string().uuid(),
  tischNummer: z.string().min(1).max(40),
  positionen:  z.array(BestellPosition).min(1).max(50).refine(
    arr => new Set(arr.map(p => p.artikelId)).size === arr.length,
    { message: 'Doppelte artikelId' },
  ),
})

export const gastRoute: FastifyPluginAsync<GastRouteOptions> = async (fastify, opts) => {

  // ── Speisekarte laden ───────────────────────────────────────────────────────
  fastify.get<{ Querystring: { kasseId?: string } }>(
    '/gast/karte',
    async (request, reply) => {
      const { kasseId } = request.query
      if (!kasseId) return reply.status(400).send({ fehler: 'kasseId fehlt' })

      // Kasse ermitteln
      const [kasse] = await opts.db
        .select({ id: kassen.id, mandantId: kassen.mandantId, bezeichnung: kassen.bezeichnung, kassenId: kassen.kassenId })
        .from(kassen)
        .where(eq(kassen.id, kasseId))
        .limit(1)

      if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

      // Sichtbare Kategorien für diese Kasse
      const sichtbareKategorieIds = await opts.db
        .select({ kategorieId: kassekategorieSichtbarkeit.kategorieId })
        .from(kassekategorieSichtbarkeit)
        .where(eq(kassekategorieSichtbarkeit.kasseId, kasseId))

      const sichtbareIds = new Set(sichtbareKategorieIds.map(r => r.kategorieId))

      // Alle aktiven Kategorien des Mandanten
      const alleKategorien = await opts.db
        .select({ id: kategorien.id, name: kategorien.name, reihenfolge: kategorien.reihenfolge })
        .from(kategorien)
        .where(and(eq(kategorien.mandantId, kasse.mandantId), eq(kategorien.aktiv, true)))
        .orderBy(asc(kategorien.reihenfolge))

      // Filtern: nur sichtbare (oder alle wenn keine Einschränkung konfiguriert)
      const gefilterteKategorien = sichtbareIds.size > 0
        ? alleKategorien.filter(k => sichtbareIds.has(k.id))
        : alleKategorien

      // Aktive Artikel des Mandanten mit Lagerstand > 0 (oder kein Lagerstand)
      const alleArtikel = await opts.db
        .select({
          id:              artikel.id,
          bezeichnung:     artikel.bezeichnung,
          preisBruttoCent: artikel.preisBruttoCent,
          kategorieId:     artikel.kategorieId,
          reihenfolge:     artikel.reihenfolge,
          lagerstandAktiv: artikel.lagerstandAktiv,
          lagerstandMenge: artikel.lagerstandMenge,
        })
        .from(artikel)
        .where(and(eq(artikel.mandantId, kasse.mandantId), eq(artikel.aktiv, true)))
        .orderBy(asc(artikel.reihenfolge))

      // Nur verfügbare Artikel (Lagerstand > 0 oder kein Countdown)
      const verfuegbar = alleArtikel.filter(a =>
        !a.lagerstandAktiv || (a.lagerstandMenge !== null && a.lagerstandMenge > 0)
      )

      return reply.send({
        kasse: {
          id:          kasse.id,
          bezeichnung: kasse.bezeichnung ?? kasse.kassenId,
        },
        kategorien: gefilterteKategorien,
        artikel:    verfuegbar,
      })
    },
  )

  // ── Bestellung aufgeben ─────────────────────────────────────────────────────
  fastify.post(
    '/gast/bestellung',
    async (request, reply) => {
      const b = BestellungBody.safeParse(request.body)
      if (!b.success) return reply.status(400).send({ fehler: b.error.issues })

      const { kasseId, tischNummer, positionen } = b.data

      // Kasse + Mandant validieren
      const [kasse] = await opts.db
        .select({ id: kassen.id, mandantId: kassen.mandantId })
        .from(kassen)
        .where(eq(kassen.id, kasseId))
        .limit(1)

      if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

      // Artikel-Preise und Verfügbarkeit aus der DB laden (nie vom Client übernehmen)
      const artikelIds = [...new Set(positionen.map(p => p.artikelId))]
      const dbArtikel  = await opts.db
        .select({
          id:              artikel.id,
          bezeichnung:     artikel.bezeichnung,
          preisBruttoCent: artikel.preisBruttoCent,
          aktiv:           artikel.aktiv,
          lagerstandAktiv: artikel.lagerstandAktiv,
          lagerstandMenge: artikel.lagerstandMenge,
        })
        .from(artikel)
        .where(and(eq(artikel.mandantId, kasse.mandantId), inArray(artikel.id, artikelIds)))

      const artikelMap = new Map(dbArtikel.map(a => [a.id, a]))

      for (const p of positionen) {
        const a = artikelMap.get(p.artikelId)
        if (!a || !a.aktiv) {
          return reply.status(400).send({ fehler: 'Artikel nicht verfügbar' })
        }
        if (a.lagerstandAktiv && (a.lagerstandMenge === null || a.lagerstandMenge <= 0)) {
          return reply.status(400).send({ fehler: 'Artikel nicht mehr verfügbar' })
        }
      }

      // Neuen Tab anlegen
      const tabPositionen = positionen.map(p => {
        const a = artikelMap.get(p.artikelId)!
        return {
          artikelId:       p.artikelId,
          bezeichnung:     a.bezeichnung,
          preisBruttoCent: a.preisBruttoCent,
          menge:           p.menge,
        }
      })

      const gesamtbetragCent = tabPositionen.reduce(
        (sum, p) => sum + p.preisBruttoCent * p.menge, 0
      )

      await opts.db.insert(tischTabs).values({
        mandantId:   kasse.mandantId,
        kasseId:     kasse.id,
        tischNummer,
        kellner:     'Gast',
        positionen:  tabPositionen,
        status:      'offen',
      })

      // SSE-Event an die Kasse
      emitKasseEvent(kasse.mandantId, {
        typ:              'neue_gastbestellung',
        kasseId:          kasse.id,
        tischNummer,
        anzahlPositionen: positionen.reduce((s, p) => s + p.menge, 0),
        gesamtbetragCent,
      })

      return reply.status(201).send({ erfolgreich: true })
    },
  )
}
