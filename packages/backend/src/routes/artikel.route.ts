/**
 * Artikel-Routen (alle auth-protected, mandantId aus JWT).
 *   POST   /api/artikel              Anlegen
 *   POST   /api/artikel/bulk         Bulk-Import (Array von Artikel-Inputs)
 *   POST   /api/artikel/layout-import  Layout-Import (Gruppenbaum, Raster, Farben, Favoriten; nur Admin)
 *   GET    /api/artikel/layout-export  Layout-Export (Warengruppen samt Artikeln im Import-Format; nur Admin)
 *   GET    /api/artikel              Auflisten (mandantId aus JWT; ?nurAktive=true|false, Standard true)
 *   PUT    /api/artikel/:id          Aktualisieren
 *   DELETE /api/artikel/:id          Deaktivieren (soft delete)
 */

import type { FastifyPluginAsync } from 'fastify'
import { ArtikelInputSchema, ArtikelUpdateSchema, LayoutImportSchema } from '@kassa/shared'
import { z } from 'zod'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { artikel } from '../db/schema.js'
import { fachfehlerStatus } from '../fehler-handler.js'
import {
  erstelleArtikel,
  listeArtikel,
  aktualisiereArtikel,
  deaktiviereArtikel,
} from '../services/artikel.service.js'
import { exportiereLayout } from '../services/layout-export.service.js'
import { wendeLayoutAn } from '../services/layout-import.service.js'
import { queryBool } from './query-bool.js'

export interface ArtikelRouteOptions {
  db: Db
}

const ListQuerySchema = z.object({
  nurAktive: queryBool(true),
})

const IdParamSchema = z.object({ id: z.string().uuid() })

/** Prüft ob ein Artikel zum Mandanten des angemeldeten Users gehört */
async function gehortArtikelZuMandant(db: Db, artikelId: string, mandantId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: artikel.id })
    .from(artikel)
    .where(and(eq(artikel.id, artikelId), eq(artikel.mandantId, mandantId)))
    .limit(1)
  return !!row
}

// mandantId fehlt absichtlich — kommt aus dem JWT und wird serverseitig gesetzt
const BulkImportSchema = z.array(z.record(z.unknown())).min(1).max(500)

const LayoutImportQuerySchema = z.object({
  /** Standard true: ohne ausdrückliches dryRun=false wird nichts geschrieben */
  dryRun:          queryBool(true),
  fehlendeAnlegen: queryBool(true),
  spaltenSetzen:   queryBool(true),
  /** Sauberer Neustart: Altbestand vorher LÖSCHEN (Standard aus) */
  katalogLoeschen: queryBool(false),
})

const LayoutExportQuerySchema = z.object({
  /** Kommagetrennte Warengruppen-IDs (samt Untergruppen); fehlt sie, werden alle aktiven Gruppen exportiert */
  kategorieIds: z.string().optional()
    .transform(s => (s ? s.split(',').map(x => x.trim()).filter(x => x !== '') : undefined))
    .pipe(z.array(z.string().uuid()).max(2000).optional()),
})

export const artikelRoute: FastifyPluginAsync<ArtikelRouteOptions> = async (fastify, opts) => {

  /**
   * GET /artikel/layout-export?kategorieIds=a,b — der Katalog (Warengruppen samt Untergruppen, Artikel, Farben,
   * Raster-Plätze, Optionen) im Format des Layout-Imports: hier exportieren, in einer anderen Kassa (einem anderen
   * Mandanten) per „Layout importieren" einlesen. Nur Admin, mandantId aus dem JWT — fremde Gruppen-IDs bleiben ohne Wirkung.
   */
  fastify.get('/artikel/layout-export', {
    onRequest: [fastify.requireRolle('admin')],
  }, async (request, reply) => {
    const query = LayoutExportQuerySchema.safeParse(request.query)
    if (!query.success) return reply.status(400).send({ fehler: query.error.issues })

    const ergebnis = await exportiereLayout(opts.db, request.user.mandantId, {
      kategorieIds: query.data.kategorieIds,
      datum:        new Date().toISOString().slice(0, 10),
    })
    if (ergebnis.zusammenfassung.gruppen === 0) {
      return reply.status(422).send({ fehler: 'Keine Warengruppen zum Exportieren gefunden.' })
    }
    // Die Datei muss der Import wieder lesen können (Tiefe, Größe) — sonst lieber jetzt eine klare Meldung
    const pruefung = LayoutImportSchema.safeParse(ergebnis.layout)
    if (!pruefung.success) {
      return reply.status(422).send({ fehler: `Der Export wäre nicht importierbar: ${pruefung.error.issues[0]?.message ?? 'ungültiges Layout'}` })
    }
    return reply.send(ergebnis)
  })

  /**
   * POST /artikel/layout-import?dryRun=true|false — wendet ein Layout (Gruppenbaum mit
   * Untergruppen, Raster-Slots, Farben, Favoriten) auf die bestehenden Artikel an.
   * Nur Admin. mandantId kommt aus dem JWT, nie aus dem Body. Alles in einer Transaktion;
   * dryRun liefert denselben Bericht, ohne zu schreiben.
   */
  fastify.post('/artikel/layout-import', {
    onRequest: [fastify.requireRolle('admin')],
    bodyLimit: 8 * 1024 * 1024,
  }, async (request, reply) => {
    const query = LayoutImportQuerySchema.safeParse(request.query)
    if (!query.success) return reply.status(400).send({ fehler: query.error.issues })
    const layout = LayoutImportSchema.safeParse(request.body)
    if (!layout.success) return reply.status(400).send({ fehler: layout.error.issues })

    const bericht = await wendeLayoutAn(opts.db, request.user.mandantId, layout.data, query.data)
    return reply.send(bericht)
  })

  /**
   * POST /artikel/bulk — bis zu 500 Artikel in einer Anfrage anlegen.
   * mandantId kommt aus dem JWT, nicht aus dem Body.
   * Jede Zeile wird einzeln versucht; Fehler einer Zeile blockieren die anderen nicht.
   */
  fastify.post('/artikel/bulk', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = BulkImportSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const mandantId = request.user.mandantId
    let erstellt    = 0
    const fehlzeilen: { index: number; fehler: string }[] = []

    for (let i = 0; i < parsed.data.length; i++) {
      // mandantId aus JWT einfügen und vollständig validieren
      const artikelParsed = ArtikelInputSchema.safeParse({ ...parsed.data[i], mandantId })
      if (!artikelParsed.success) {
        fehlzeilen.push({ index: i, fehler: 'Validierungsfehler: ' + artikelParsed.error.issues.map(e => e.message).join(', ') })
        continue
      }
      try {
        await erstelleArtikel(opts.db, artikelParsed.data)
        erstellt++
      } catch (err) {
        // Fachfehler (4xx, z. B. fremder Bestandteil) mit ihrer Meldung — alles andere
        // nur ins Log, sonst stünden SQL und Eingabewerte in der Importliste
        const status = fachfehlerStatus(err)
        if (err instanceof Error && status !== undefined && status < 500) {
          fehlzeilen.push({ index: i, fehler: err.message })
        } else {
          request.log.error({ err, zeile: i }, 'Artikel-Import: Zeile unerwartet fehlgeschlagen')
          fehlzeilen.push({ index: i, fehler: 'Interner Serverfehler' })
        }
      }
    }

    return reply.send({ erstellt, fehlgeschlagen: fehlzeilen.length, fehlzeilen })
  })

  fastify.post('/artikel', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    // mandantId IMMER aus JWT — Body wird ignoriert
    const bodyWithoutMandant = { ...(request.body as object), mandantId: request.user.mandantId }
    const parsed = ArtikelInputSchema.safeParse(bodyWithoutMandant)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const result = await erstelleArtikel(opts.db, parsed.data)
    return reply.status(201).send(result)
  })

  fastify.get('/artikel', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })
    const list = await listeArtikel(opts.db, request.user.mandantId, {
      nurAktive: parsed.data.nurAktive,
    })
    return reply.send(list)
  })

  fastify.put('/artikel/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    if (!(await gehortArtikelZuMandant(opts.db, id.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Artikel nicht gefunden' })
    }

    const update = ArtikelUpdateSchema.safeParse(request.body)
    if (!update.success) return reply.status(400).send({ fehler: update.error.issues })

    const result = await aktualisiereArtikel(opts.db, id.data.id, update.data)
    if (!result) return reply.status(404).send({ fehler: 'Artikel nicht gefunden' })
    return reply.send(result)
  })

  /**
   * POST /artikel/lager-aktivieren — setzt lagerstandAktiv = true für alle
   * Artikel einer Warengruppe (oder alle aktiven Artikel ohne Kategorie).
   */
  fastify.post('/artikel/lager-aktivieren', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = z.object({
      kategorieId: z.string().uuid().nullable(),
    }).safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const mandantId  = request.user.mandantId
    const where = parsed.data.kategorieId === null
      ? and(eq(artikel.mandantId, mandantId), eq(artikel.aktiv, true))
      : and(
          eq(artikel.mandantId, mandantId),
          eq(artikel.aktiv, true),
          eq(artikel.kategorieId, parsed.data.kategorieId),
        )

    const rows = await opts.db
      .update(artikel)
      .set({ lagerstandAktiv: true, updatedAt: new Date() })
      .where(where)
      .returning({ id: artikel.id })

    return reply.send({ aktiviert: rows.length })
  })

  /**
   * POST /artikel/kds-zuruecksetzen — setzt die eigene KDS-Station der genannten Artikel
   * auf "Automatisch" (null): sie folgen danach der Station ihrer Warengruppe bzw. deren
   * Elterngruppe, auch wenn vorher eine abweichende Station eingestellt war.
   * Nur Artikel des eigenen Mandanten; geliefert wird die Zahl der tatsächlich geänderten.
   */
  fastify.post('/artikel/kds-zuruecksetzen', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parsed = z.object({
      artikelIds: z.array(z.string().uuid()).min(1).max(10000),
    }).safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ fehler: parsed.error.issues })

    const rows = await opts.db
      .update(artikel)
      .set({ station: null, updatedAt: new Date() })
      .where(and(
        eq(artikel.mandantId, request.user.mandantId),
        inArray(artikel.id, [...new Set(parsed.data.artikelIds)]),
        isNotNull(artikel.station),
      ))
      .returning({ id: artikel.id })

    return reply.send({ zurueckgesetzt: rows.length })
  })

  fastify.delete('/artikel/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = IdParamSchema.safeParse(request.params)
    if (!id.success) return reply.status(400).send({ fehler: 'Ungültige ID' })

    if (!(await gehortArtikelZuMandant(opts.db, id.data.id, request.user.mandantId))) {
      return reply.status(404).send({ fehler: 'Artikel nicht gefunden' })
    }

    const result = await deaktiviereArtikel(opts.db, id.data.id)
    if (!result) return reply.status(404).send({ fehler: 'Artikel nicht gefunden' })
    return reply.send(result)
  })
}
