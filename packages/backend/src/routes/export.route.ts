/**
 * Buchhaltungs-Export-Routen
 *
 *  GET /api/export/bmd?kasseId=&vonDatum=&bisDatum=
 *    → CSV im BMD NTCS-Format (Buchungsjournal)
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { belege, kassen, mandanten } from '../db/schema.js'
import { pruefeKasseGehoertZuMandant } from '../auth/scope.js'

export interface ExportRouteOptions { db: Db }

const BmdQuerySchema = z.object({
  kasseId:  z.string().uuid(),
  vonDatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bisDatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

// BMD-Konten (vereinfachte Standardzuordnung)
const ZAHLUNGSART_KONTO: Record<string, string> = {
  bar:      '2000', // Kasse
  karte:    '2600', // Bank
  sonstige: '3800', // Sonstige Verbindlichkeiten → Gutscheine etc.
}

const MWST_ERLOES_KONTO: Record<string, { konto: string; steuercode: string }> = {
  '20%':  { konto: '4000', steuercode: '022' },
  '10%':  { konto: '4010', steuercode: '011' },
  '13%':  { konto: '4013', steuercode: '013' },
  '19%':  { konto: '4019', steuercode: '019' },
  '0%':   { konto: '4020', steuercode: '000' },
}

export const exportRoute: FastifyPluginAsync<ExportRouteOptions> = async (fastify, opts) => {
  const guard = { onRequest: [fastify.authenticate] }

  fastify.get('/export/bmd', guard, async (request, reply) => {
    const q = BmdQuerySchema.safeParse(request.query)
    if (!q.success) return reply.status(400).send({ fehler: q.error.issues })

    const ok = await pruefeKasseGehoertZuMandant(opts.db, q.data.kasseId, request.user.mandantId)
    if (!ok) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const [kasse]   = await opts.db.select().from(kassen).where(eq(kassen.id, q.data.kasseId)).limit(1)
    const [mandant] = await opts.db.select().from(mandanten).where(eq(mandanten.id, request.user.mandantId)).limit(1)
    if (!kasse || !mandant) return reply.status(404).send({ fehler: 'Nicht gefunden' })

    // Beleg-Rohdaten laden (barzahlung + storno, kein Null/Monats/Jahresbeleg).
    // Datumsvergleich in Europe/Vienna — berücksichtigt Sommer-/Winterzeit korrekt.
    const heuteWien = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' })
    const von = q.data.vonDatum ?? `${heuteWien.slice(0, 4)}-01-01`
    const bis = q.data.bisDatum ?? heuteWien

    const rows = await opts.db
      .select()
      .from(belege)
      .where(and(
        eq(belege.kasseId, q.data.kasseId),
        inArray(belege.belegTyp, ['Barzahlungsbeleg', 'Stornobeleg']),
        sql`(${belege.belegDatum} AT TIME ZONE 'Europe/Vienna')::date BETWEEN ${von} AND ${bis}`,
      ))
      .orderBy(belege.belegDatum)

    // CSV-Zeilen aufbauen
    // BMD NTCS CSV-Format:
    // Belegdatum;Belegnummer;Buchungstext;Betrag;Steuercode;Netto;Steuer;Konto;Gegenkonto
    const csvZeilen: string[] = [
      'Belegdatum;Belegnummer;Buchungstext;BruttoBetrag;Steuercode;NettoBetrag;MwStBetrag;Konto;Gegenkonto',
    ]

    const fmt = (cent: number) => (cent / 100).toFixed(2).replace('.', ',')
    const fmtDatum = (d: Date) =>
      d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Vienna' })

    for (const beleg of rows) {
      const vorzeichen = beleg.belegTyp === 'Stornobeleg' ? -1 : 1
      const datum      = fmtDatum(new Date(beleg.belegDatum))
      const nr         = String(beleg.belegNummer)
      const text       = beleg.belegTyp === 'Stornobeleg' ? `Storno Beleg #${nr}` : `Kassenbon #${nr}`

      // Zahlungsart-Zeile(n)
      const zahlungsarten: { art: string; cent: number }[] = []
      if (beleg.summeBarCent   !== 0) zahlungsarten.push({ art: 'bar',     cent: beleg.summeBarCent })
      if (beleg.summeKarteCent !== 0) zahlungsarten.push({ art: 'karte',   cent: beleg.summeKarteCent })
      if (beleg.summeSonstigeCent !== 0) zahlungsarten.push({ art: 'sonstige', cent: beleg.summeSonstigeCent })

      // Bruttogesamtbetrag
      const bruttoCent = vorzeichen * (beleg.summeBarCent + beleg.summeKarteCent + beleg.summeSonstigeCent)

      // Pro Steuersatz eine Zeile
      const satzFelder: { konto: string; steuercode: string; nettoCent: number; ustCent: number; bruttoCent: number }[] = []

      const normal      = beleg.betragNormalCent
      const ermaessigt1 = beleg.betragErmaessigt1Cent
      const ermaessigt2 = beleg.betragErmaessigt2Cent
      const nullSatz    = beleg.betragNullCent
      const besonders   = beleg.betragBesondersCent

      const addSatz = (brutto: number, satz: number, labelKey: string) => {
        if (brutto === 0) return
        const netto = Math.round(brutto / (1 + satz / 100))
        const ust   = brutto - netto
        const cfg   = MWST_ERLOES_KONTO[`${satz}%`] ?? { konto: '4000', steuercode: '000' }
        satzFelder.push({ konto: cfg.konto, steuercode: cfg.steuercode, nettoCent: vorzeichen * netto, ustCent: vorzeichen * ust, bruttoCent: vorzeichen * brutto })
      }

      addSatz(normal,      20, '20%')
      addSatz(ermaessigt1, 10, '10%')
      addSatz(ermaessigt2, 13, '13%')
      addSatz(nullSatz,     0,  '0%')
      addSatz(besonders,   19, '19%')

      // Gegenkonto = Zahlungsart-Konto (erstes, falls mehrere)
      const gegenkonto = ZAHLUNGSART_KONTO[zahlungsarten[0]?.art ?? 'bar'] ?? '2000'

      for (const sf of satzFelder) {
        csvZeilen.push(
          [datum, nr, text, fmt(sf.bruttoCent), sf.steuercode, fmt(sf.nettoCent), fmt(sf.ustCent), sf.konto, gegenkonto].join(';')
        )
      }
    }

    const dateiname = `BMD_${kasse.kassenId}_${von}_${bis}.csv`

    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${dateiname}"`)
      .header('X-Anzahl-Belege', String(rows.length))
      .send(String.fromCharCode(0xFEFF) + csvZeilen.join('\r\n'))  // BOM für Excel-UTF-8-Erkennung
  })
}
