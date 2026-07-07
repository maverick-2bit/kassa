/**
 * Kassen-Informationen (Status, Zertifikats-Ablauf, Jahresbeleg-Fälligkeit).
 */

import type { FastifyPluginAsync } from 'fastify'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { belege, kassen } from '../db/schema.js'
import { z } from 'zod'
import { FinanzOnlineCredentialsSchema, KasseBezeichnungUpdateSchema, SeeConfigUpdateSchema, WeitereKasseInputSchema, type KasseListeItem, type WeitereKasseResponse } from '@kassa/shared'
import { ATrustHsmEinheit } from '@kassa/rksv'
import { X509Certificate } from 'node:crypto'
import { decryptPrivateKey, encryptPrivateKey } from '../crypto/master-key.js'
import { legeWeitereKasseAn } from '../services/kasse.service.js'
import type { SetupServiceDeps } from '../services/setup.service.js'
import { BelegError, nimmKasseAusserBetrieb, type BelegServiceDeps } from '../services/beleg.service.js'

export interface KasseRouteOptions { db: Db; setupDeps: SetupServiceDeps; belegDeps: BelegServiceDeps }

const MS_PRO_TAG = 1000 * 60 * 60 * 24

export const kasseRoute: FastifyPluginAsync<KasseRouteOptions> = async (fastify, opts) => {
  const auth = { onRequest: [fastify.authenticate] }

  /** Nur Admins oder Benutzer mit „einstellungen"-Berechtigung dürfen Kassen verwalten. */
  const darfVerwalten = (u: { rolle: string; berechtigungen: string[] }) =>
    u.rolle === 'admin' || u.berechtigungen.includes('einstellungen')

  /**
   * GET /kassen
   * Alle Kassen des Mandanten — für Verwaltung und Kassen-Umschalter.
   */
  fastify.get('/kassen', auth, async (request, reply) => {
    const rows = await opts.db
      .select({
        id:               kassen.id,
        kassenId:         kassen.kassenId,
        bezeichnung:      kassen.bezeichnung,
        status:           kassen.status,
        umgebung:         kassen.umgebung,
        seeGueltigBis:    kassen.seeGueltigBis,
        beiFoRegistriert: kassen.bei_fo_registriert,
        ausserBetriebAm:  kassen.ausserBetriebAm,
      })
      .from(kassen)
      .where(eq(kassen.mandantId, request.user.mandantId))
      .orderBy(asc(kassen.createdAt))

    const liste: KasseListeItem[] = rows.map(r => ({
      id:               r.id,
      kassenId:         r.kassenId,
      bezeichnung:      r.bezeichnung,
      status:           r.status,
      umgebung:         r.umgebung,
      seeGueltigBis:    r.seeGueltigBis.toISOString(),
      beiFoRegistriert: r.beiFoRegistriert,
      ausserBetriebAm:  r.ausserBetriebAm ? r.ausserBetriebAm.toISOString() : null,
    }))
    return reply.send(liste)
  })

  /**
   * POST /kassen/:id/ausser-betrieb
   * RKSV-konforme Stilllegung: Schlussbeleg + status='ausser_betrieb',
   * optional FinanzOnline-Abmeldung (Zugangsdaten pro Aufruf, nie gespeichert).
   */
  fastify.post('/kassen/:id/ausser-betrieb', auth, async (request, reply) => {
    if (!darfVerwalten(request.user)) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    }

    const { id } = request.params as { id: string }
    const body = z.object({
      credentials: FinanzOnlineCredentialsSchema.optional(),
    }).safeParse(request.body ?? {})
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    // Ownership-Check
    const [check] = await opts.db
      .select({ id: kassen.id })
      .from(kassen)
      .where(and(eq(kassen.id, id), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)
    if (!check) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    try {
      const ergebnis = await nimmKasseAusserBetrieb(id, body.data.credentials, opts.belegDeps)
      return reply.send(ergebnis)
    } catch (err) {
      if (err instanceof BelegError) {
        return reply.status(err.httpStatus).send({ fehler: err.message })
      }
      throw err
    }
  })

  /**
   * POST /kassen
   * Weitere Registrierkasse für den Mandanten anlegen (eigene SEE + Startbeleg).
   */
  fastify.post('/kassen', auth, async (request, reply) => {
    if (!darfVerwalten(request.user)) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    }

    const parsed = WeitereKasseInputSchema.safeParse(request.body)
    if (!parsed.success) {
      const meldung = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      const response: WeitereKasseResponse = {
        erfolgreich: false,
        schritte: [{ schritt: 'eingabe-validierung', status: 'fehler', meldung, zeitstempel: new Date().toISOString() }],
        fehler: meldung,
      }
      return reply.status(400).send(response)
    }

    try {
      const result = await legeWeitereKasseAn(request.user.mandantId, parsed.data, opts.setupDeps)
      return reply.status(result.erfolgreich ? 201 : 400).send(result)
    } catch (err) {
      fastify.log.error({ err }, 'Kasse anlegen unerwartet fehlgeschlagen')
      const meldung = err instanceof Error ? err.message : String(err)
      const response: WeitereKasseResponse = {
        erfolgreich: false,
        schritte: [{ schritt: 'eingabe-validierung', status: 'fehler', meldung, zeitstempel: new Date().toISOString() }],
        fehler: meldung,
      }
      return reply.status(500).send(response)
    }
  })

  /**
   * GET /kassen/:id/status
   * Ablauf-Datum des SEE-Zertifikats — Frontend kann rechtzeitig warnen.
   */
  fastify.get('/kassen/:id/status', auth, async (request, reply) => {
    const { id }      = request.params as { id: string }
    const mandantId   = request.user.mandantId

    const [kasse] = await opts.db
      .select({
        id:              kassen.id,
        kassenId:        kassen.kassenId,
        bezeichnung:     kassen.bezeichnung,
        seeGueltigBis:   kassen.seeGueltigBis,
        beiFoRegistriert: kassen.bei_fo_registriert,
        status:          kassen.status,
      })
      .from(kassen)
      .where(and(eq(kassen.id, id), eq(kassen.mandantId, mandantId)))
      .limit(1)

    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const now          = new Date()
    const restMs       = kasse.seeGueltigBis.getTime() - now.getTime()
    const restTage     = Math.floor(restMs / MS_PRO_TAG)
    const abgelaufen   = restMs <= 0

    return reply.send({
      kasseId:         kasse.kassenId,
      bezeichnung:     kasse.bezeichnung,
      status:          kasse.status,
      seeGueltigBis:   kasse.seeGueltigBis.toISOString(),
      seeRestTage:     Math.max(0, restTage),
      seeAbgelaufen:   abgelaufen,
    })
  })

  /**
   * GET /kassen/:kasseId/jahresbeleg-status
   *
   * Prüft, ob für die Kasse bereits ein Jahresbeleg im aktuellen Kalenderjahr
   * (Wiener Ortszeit) erstellt wurde.  Wird vom Frontend für den
   * Jahresbeleg-Fälligkeits-Banner verwendet.
   */
  fastify.get('/kassen/:kasseId/jahresbeleg-status', auth, async (request, reply) => {
    const { kasseId } = request.params as { kasseId: string }
    const mandantId   = request.user.mandantId

    // Ownership-Check + Jahre in Wiener Ortszeit (konsistent zur Beleg-Abfrage)
    const [kasse] = await opts.db
      .select({
        id:            kassen.id,
        erstelltJahr:  sql<number>`EXTRACT(YEAR FROM (${kassen.createdAt} AT TIME ZONE 'Europe/Vienna'))::int`,
        aktuellesJahr: sql<number>`EXTRACT(YEAR FROM (now() AT TIME ZONE 'Europe/Vienna'))::int`,
      })
      .from(kassen)
      .where(and(eq(kassen.id, kasseId), eq(kassen.mandantId, mandantId)))
      .limit(1)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    // Der Jahresbeleg (letzter Monatsbeleg des Kalenderjahres) wird erst NACH
    // Ablauf eines Kalenderjahres fällig — Prüf-/Erstellungsfrist reicht in die
    // ersten Tage des Folgejahres. Er ist also für das VORJAHR fällig, und nur
    // wenn die Kasse in diesem Vorjahr bereits bestand. Eine im laufenden Jahr
    // angelegte Kasse braucht noch keinen Jahresbeleg (kein Fehlalarm).
    const vorjahr = kasse.aktuellesJahr - 1

    if (kasse.erstelltJahr > vorjahr) {
      return reply.send({ jahr: vorjahr, jahresbelegFaellig: false, jahresbelegErstelltAm: null })
    }

    const rows = await opts.db
      .select({ id: belege.id, belegDatum: belege.belegDatum })
      .from(belege)
      .where(and(
        eq(belege.kasseId, kasseId),
        eq(belege.belegTyp, 'Jahresbeleg'),
        sql`EXTRACT(YEAR FROM (${belege.belegDatum} AT TIME ZONE 'Europe/Vienna')) = ${vorjahr}`,
      ))
      .orderBy(desc(belege.belegDatum))
      .limit(1)

    const letzter = rows[0] ?? null

    return reply.send({
      jahr:                   vorjahr,
      jahresbelegFaellig:     letzter === null,
      jahresbelegErstelltAm:  letzter?.belegDatum.toISOString() ?? null,
    })
  })

  /**
   * PATCH /kassen/:id/bezeichnung
   * Kassenbezeichnung (Anzeigename) aktualisieren.
   */
  fastify.patch('/kassen/:id/bezeichnung', auth, async (request, reply) => {
    if (
      request.user.rolle !== 'admin' &&
      !request.user.berechtigungen.includes('einstellungen')
    ) {
      return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    }

    const { id } = request.params as { id: string }

    const body = KasseBezeichnungUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    // Ownership-Check
    const [check] = await opts.db
      .select({ id: kassen.id })
      .from(kassen)
      .where(and(eq(kassen.id, id), eq(kassen.mandantId, request.user.mandantId)))
      .limit(1)
    if (!check) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const [updated] = await opts.db
      .update(kassen)
      .set({ bezeichnung: body.data.bezeichnung })
      .where(eq(kassen.id, id))
      .returning({ id: kassen.id, bezeichnung: kassen.bezeichnung })

    return reply.send(updated)
  })

  // ---------------------------------------------------------------------------
  // Signaturerstellungseinheit (SEE): Software (Dev) oder A-Trust a.sign RK HSM
  // ---------------------------------------------------------------------------

  const ladeKasse = async (id: string, mandantId: string) => {
    const [kasse] = await opts.db
      .select()
      .from(kassen)
      .where(and(eq(kassen.id, id), eq(kassen.mandantId, mandantId)))
      .limit(1)
    return kasse
  }

  /** A-Trust-Zugang aus Update-Body + gespeicherten Werten aufloesen. */
  const atrustZugang = (
    kasse: typeof kassen.$inferSelect,
    body: { atrustBasisUrl?: string | undefined; atrustBenutzer?: string | undefined; atrustPasswort?: string | undefined },
  ): { basisUrl: string; benutzer: string; passwort: string } | { fehler: string } => {
    const basisUrl = body.atrustBasisUrl ?? kasse.atrustBasisUrl ?? ''
    const benutzer = body.atrustBenutzer ?? kasse.atrustBenutzer ?? ''
    const passwort = body.atrustPasswort ?? (kasse.atrustPasswortEnc
      ? decryptPrivateKey(kasse.atrustPasswortEnc, opts.belegDeps.masterPassphrase).toString('utf8')
      : '')
    if (!basisUrl || !benutzer || !passwort) {
      return { fehler: 'A-Trust-Zugang unvollstaendig (Basis-URL, Benutzer und Passwort erforderlich)' }
    }
    return { basisUrl, benutzer, passwort }
  }

  /** GET /kassen/:id/see — aktuelle SEE-Konfiguration (ohne Geheimnisse) */
  fastify.get<{ Params: { id: string } }>('/kassen/:id/see', auth, async (request, reply) => {
    const kasse = await ladeKasse(request.params.id, request.user.mandantId)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    return reply.send({
      seeTyp:                kasse.seeTyp,
      seeZdaId:              kasse.seeZdaId,
      atrustBasisUrl:        kasse.atrustBasisUrl,
      atrustBenutzer:        kasse.atrustBenutzer,
      atrustPasswortGesetzt: kasse.atrustPasswortEnc != null,
      zertifikatSn:          kasse.seeZertifikatSn,
      zertifikatGueltigBis:  kasse.seeGueltigBis.toISOString(),
    })
  })

  /** POST /kassen/:id/see/test — Verbindung zur A-Trust-Einheit pruefen (ohne zu speichern) */
  fastify.post<{ Params: { id: string } }>('/kassen/:id/see/test', auth, async (request, reply) => {
    if (!darfVerwalten(request.user)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const body = SeeConfigUpdateSchema.safeParse(request.body ?? {})
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const kasse = await ladeKasse(request.params.id, request.user.mandantId)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    const zugang = atrustZugang(kasse, body.data)
    if ('fehler' in zugang) return reply.status(400).send({ erfolgreich: false, fehler: zugang.fehler })

    try {
      const einheit = new ATrustHsmEinheit(zugang)
      const [zda, zert] = await Promise.all([einheit.zdaId(), einheit.zertifikat()])
      return reply.send({ erfolgreich: true, zdaId: zda, zertifikatSn: zert.seriennummerHex })
    } catch (err) {
      return reply.send({ erfolgreich: false, fehler: err instanceof Error ? err.message : String(err) })
    }
  })

  /**
   * PATCH /kassen/:id/see — SEE-Konfiguration speichern.
   * Bei atrust_hsm wird die Verbindung geprueft und Zertifikat + ZDA der Kasse
   * uebernommen. Achtung Zertifikatswechsel: aeltere Belege verifizieren nur
   * noch gegen das fruehere Zertifikat — fuer den Echtbetrieb die SEE nur bei
   * Kassen-Neuanlage wechseln.
   */
  fastify.patch<{ Params: { id: string } }>('/kassen/:id/see', auth, async (request, reply) => {
    if (!darfVerwalten(request.user)) return reply.status(403).send({ fehler: 'Keine Berechtigung' })
    const body = SeeConfigUpdateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ fehler: body.error.issues })

    const kasse = await ladeKasse(request.params.id, request.user.mandantId)
    if (!kasse) return reply.status(404).send({ fehler: 'Kasse nicht gefunden' })

    if (body.data.seeTyp === 'software') {
      await opts.db
        .update(kassen)
        .set({ seeTyp: 'software', seeZdaId: 'AT0', updatedAt: new Date() })
        .where(eq(kassen.id, kasse.id))
      return reply.send({ erfolgreich: true, zdaId: 'AT0', zertifikatSn: kasse.seeZertifikatSn })
    }

    // atrust_hsm: Verbindung pruefen, dann Zugang + Zertifikat uebernehmen
    const zugang = atrustZugang(kasse, body.data)
    if ('fehler' in zugang) return reply.status(400).send({ erfolgreich: false, fehler: zugang.fehler })

    try {
      const einheit = new ATrustHsmEinheit(zugang)
      const [zda, zert] = await Promise.all([einheit.zdaId(), einheit.zertifikat()])
      const zertifikat = new X509Certificate(Buffer.from(zert.derBase64, 'base64'))

      await opts.db
        .update(kassen)
        .set({
          seeTyp:            'atrust_hsm',
          seeZdaId:          zda,
          atrustBasisUrl:    zugang.basisUrl,
          atrustBenutzer:    zugang.benutzer,
          atrustPasswortEnc: encryptPrivateKey(Buffer.from(zugang.passwort, 'utf8'), opts.belegDeps.masterPassphrase),
          seeZertifikatDer:  zert.derBase64,
          seeZertifikatSn:   zert.seriennummerHex,
          seeGueltigBis:     new Date(zertifikat.validTo),
          updatedAt:         new Date(),
        })
        .where(eq(kassen.id, kasse.id))

      return reply.send({ erfolgreich: true, zdaId: zda, zertifikatSn: zert.seriennummerHex })
    } catch (err) {
      return reply.status(502).send({ erfolgreich: false, fehler: err instanceof Error ? err.message : String(err) })
    }
  })
}
