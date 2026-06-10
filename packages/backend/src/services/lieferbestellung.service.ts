/**
 * Lieferbestellungs-Service: Normalisierung eingehender Webhooks
 * und CRUD für die Bestellungsqueue.
 *
 * Unterstützte Provider:
 *   lieferando  — Just Eat Takeaway Webhook-Format
 *   mergeport   — Mergeport Aggregator-Format
 *   custom      — Generisches Format (eigene Integrationen)
 */

import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { kassen, lieferbestellungen, mandanten } from '../db/schema.js'
import { emitKasseEvent } from '../sse/event-bus.js'
import { druckerConfigVonKasse, sendBytes } from './drucker.service.js'
import { baueLieferbestellungBon } from './escpos/layout.js'
import type {
  LieferbestellungPosition,
  LieferbestellungResponse,
  LieferbestellungStatus,
} from '@kassa/shared'

// ---------------------------------------------------------------------------
// Payload-Normalisierung (Provider-spezifisch)
// ---------------------------------------------------------------------------

interface NormalisierteBestellung {
  externeId:        string
  positionen:       LieferbestellungPosition[]
  gesamtbetragCent: number
  lieferName?:      string
  lieferTelefon?:   string
  lieferAdresse?:   string
  notiz?:           string
}

/**
 * Lieferando (Just Eat Takeaway):
 * POST-Payload enthält ein `order`-Objekt mit `id`, `customer`,
 * `delivery.address`, `items[]`, `totalPrice` (in Cent), `remark`.
 */
function normalisiereLiferando(raw: unknown): NormalisierteBestellung {
  const body = raw as Record<string, unknown>
  const order = (body['order'] ?? body) as Record<string, unknown>

  const id = String(order['id'] ?? order['orderId'] ?? `LD-${Date.now()}`)

  // Items
  const rawItems = (order['items'] ?? order['orderItems'] ?? []) as unknown[]
  const positionen: LieferbestellungPosition[] = rawItems.map((item) => {
    const it = item as Record<string, unknown>
    return {
      bezeichnung:            String(it['name'] ?? it['productName'] ?? 'Artikel'),
      menge:                  Number(it['quantity'] ?? it['count'] ?? 1),
      einzelpreisBreuttoCent: Number(it['price'] ?? it['unitPrice'] ?? 0),
      ...(it['remark'] || it['notes'] ? { notiz: String(it['remark'] ?? it['notes']) } : {}),
    }
  })

  // Gesamtbetrag: erst explizites Feld, dann aus Positionen summieren
  const rawTotal = order['totalPrice'] ?? order['total'] ?? order['grandTotal']
  const gesamtbetragCent = rawTotal !== undefined
    ? Number(rawTotal)
    : positionen.reduce((s, p) => s + p.einzelpreisBreuttoCent * p.menge, 0)

  // Kunde
  const customer  = order['customer']  as Record<string, unknown> | undefined
  const delivery  = order['delivery']  as Record<string, unknown> | undefined
  const address   = delivery?.['address'] as Record<string, unknown> | undefined

  const lieferName     = customer ? String(customer['name'] ?? customer['firstName'] ?? '') || undefined : undefined
  const lieferTelefon  = customer ? String(customer['phoneNumber'] ?? customer['phone'] ?? '') || undefined : undefined
  const lieferAdresse  = address  ? String(address['formattedAddress'] ?? address['street'] ?? '') || undefined : undefined
  const notiz          = String(order['remark'] ?? order['notes'] ?? '') || undefined

  return {
    externeId: id,
    positionen,
    gesamtbetragCent,
    ...(lieferName    && { lieferName    }),
    ...(lieferTelefon && { lieferTelefon }),
    ...(lieferAdresse && { lieferAdresse }),
    ...(notiz         && { notiz         }),
  }
}

/**
 * Mergeport:
 * Mergeport normalisiert bereits über alle Lieferdienste.
 * Payload enthält `data.order` mit weitgehend JET-kompatiblem Format
 * plus einem `source`-Feld das den Original-Provider nennt.
 */
function normalisiereMergeport(raw: unknown): NormalisierteBestellung {
  const body  = raw as Record<string, unknown>
  const data  = (body['data'] ?? body) as Record<string, unknown>
  const order = (data['order'] ?? data) as Record<string, unknown>

  const id = String(
    body['id'] ?? body['orderId'] ?? order['id'] ??
    order['externalId'] ?? `MP-${Date.now()}`
  )

  const rawItems = (order['items'] ?? order['lines'] ?? order['products'] ?? []) as unknown[]
  const positionen: LieferbestellungPosition[] = rawItems.map((item) => {
    const it = item as Record<string, unknown>
    return {
      bezeichnung:            String(it['name'] ?? it['productName'] ?? it['title'] ?? 'Artikel'),
      menge:                  Number(it['quantity'] ?? it['amount'] ?? 1),
      einzelpreisBreuttoCent: Number(it['price'] ?? it['unitPrice'] ?? it['totalPrice'] ?? 0),
      ...(it['remark'] || it['comment'] ? { notiz: String(it['remark'] ?? it['comment']) } : {}),
    }
  })

  const rawTotal = order['totalPrice'] ?? order['total'] ?? body['totalAmount']
  const gesamtbetragCent = rawTotal !== undefined
    ? Number(rawTotal)
    : positionen.reduce((s, p) => s + p.einzelpreisBreuttoCent * p.menge, 0)

  const customer = (order['customer'] ?? body['customer']) as Record<string, unknown> | undefined
  const address  = (order['deliveryAddress'] ?? order['address']) as Record<string, unknown> | undefined

  const lieferName     = customer ? String(customer['name'] ?? customer['fullName'] ?? '') || undefined : undefined
  const lieferTelefon  = customer ? String(customer['phone'] ?? customer['phoneNumber'] ?? '') || undefined : undefined
  const lieferAdresse  = address  ? String(address['formattedAddress'] ?? address['street'] ?? '') || undefined : undefined
  const notiz          = String(order['remark'] ?? order['comment'] ?? body['notes'] ?? '') || undefined

  return {
    externeId: id,
    positionen,
    gesamtbetragCent,
    ...(lieferName    && { lieferName    }),
    ...(lieferTelefon && { lieferTelefon }),
    ...(lieferAdresse && { lieferAdresse }),
    ...(notiz         && { notiz         }),
  }
}

/**
 * Generisches / Custom-Format:
 * Erwartet ein JSON-Objekt mit folgenden (optionalen) Feldern:
 *   id, items[], total, customerName, phone, address, notes
 */
function normalisiereCustom(raw: unknown): NormalisierteBestellung {
  const body = raw as Record<string, unknown>

  const id = String(body['id'] ?? body['orderId'] ?? body['bestellId'] ?? `CUSTOM-${Date.now()}`)

  const rawItems = (body['items'] ?? body['positionen'] ?? []) as unknown[]
  const positionen: LieferbestellungPosition[] = rawItems.map((item) => {
    const it = item as Record<string, unknown>
    return {
      bezeichnung:            String(it['name'] ?? it['bezeichnung'] ?? 'Artikel'),
      menge:                  Number(it['quantity'] ?? it['menge'] ?? 1),
      einzelpreisBreuttoCent: Number(it['price'] ?? it['preis'] ?? it['einzelpreisBreuttoCent'] ?? 0),
      ...(it['notes'] || it['notiz'] ? { notiz: String(it['notes'] ?? it['notiz']) } : {}),
    }
  })

  const rawTotal = body['total'] ?? body['totalPrice'] ?? body['gesamtbetragCent']
  const gesamtbetragCent = rawTotal !== undefined
    ? Number(rawTotal)
    : positionen.reduce((s, p) => s + p.einzelpreisBreuttoCent * p.menge, 0)

  const lieferName    = String(body['customerName'] ?? body['name']    ?? '') || undefined
  const lieferTelefon = String(body['phone']        ?? body['telefon'] ?? '') || undefined
  const lieferAdresse = String(body['address']      ?? body['adresse'] ?? '') || undefined
  const notiz         = String(body['notes']        ?? body['notiz']   ?? '') || undefined

  return {
    externeId: id,
    positionen,
    gesamtbetragCent,
    ...(lieferName    && { lieferName    }),
    ...(lieferTelefon && { lieferTelefon }),
    ...(lieferAdresse && { lieferAdresse }),
    ...(notiz         && { notiz         }),
  }
}

export function normalisiereWebhookPayload(
  provider: string,
  raw: unknown,
): NormalisierteBestellung {
  try {
    if (provider === 'lieferando') return normalisiereLiferando(raw)
    if (provider === 'mergeport')  return normalisiereMergeport(raw)
    return normalisiereCustom(raw)
  } catch {
    // Fallback: leere Bestellung mit Timestamp-ID
    return {
      externeId:        `${provider.toUpperCase()}-${Date.now()}`,
      positionen:       [],
      gesamtbetragCent: 0,
      notiz:            'Bestellung konnte nicht automatisch geparst werden.',
    }
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function erstelleBestellung(
  db:       Db,
  kasseId:  string,
  provider: string,
  raw:      unknown,
): Promise<LieferbestellungResponse> {
  const [kasse] = await db
    .select({
      mandantId:         kassen.mandantId,
      kassenId:          kassen.kassenId,
      druckerIp:         kassen.druckerIp,
      druckerPort:       kassen.druckerPort,
      druckerAktiv:      kassen.druckerAktiv,
      druckerBreite:     kassen.druckerBreite,
      druckerTimeoutSek: kassen.druckerTimeoutSek,
    })
    .from(kassen)
    .where(eq(kassen.id, kasseId))
    .limit(1)
  if (!kasse) throw new Error('Kasse nicht gefunden')

  const norm = normalisiereWebhookPayload(provider, raw)

  // Duplikat-Schutz: gleiche externeId + provider → ignorieren
  const [existing] = await db
    .select({ id: lieferbestellungen.id })
    .from(lieferbestellungen)
    .where(
      and(
        eq(lieferbestellungen.provider, provider),
        eq(lieferbestellungen.externeId, norm.externeId),
      )
    )
    .limit(1)

  if (existing) {
    // Idempotent: gleiche Bestellung nochmals gesendet → bereits vorhandene zurückgeben
    const [row] = await db
      .select()
      .from(lieferbestellungen)
      .where(eq(lieferbestellungen.id, existing.id))
      .limit(1)
    return toDto(row!)
  }

  const [row] = await db
    .insert(lieferbestellungen)
    .values({
      mandantId:        kasse.mandantId,
      kasseId,
      externeId:        norm.externeId,
      provider,
      status:           'neu',
      positionen:       norm.positionen,
      gesamtbetragCent: norm.gesamtbetragCent,
      ...(norm.lieferName    && { lieferName:    norm.lieferName    }),
      ...(norm.lieferTelefon && { lieferTelefon: norm.lieferTelefon }),
      ...(norm.lieferAdresse && { lieferAdresse: norm.lieferAdresse }),
      ...(norm.notiz         && { notiz:         norm.notiz         }),
      rohDaten:         raw as Record<string, unknown>,
    })
    .returning()

  if (!row) throw new Error('Bestellung konnte nicht gespeichert werden')

  // SSE-Push an alle verbundenen Clients dieses Mandanten
  emitKasseEvent(kasse.mandantId, {
    typ:              'neue_bestellung',
    bestellungId:     row.id,
    provider,
    gesamtbetragCent: norm.gesamtbetragCent,
    positionen:       norm.positionen.length,
  })

  // Auto-Print: Lieferbon drucken wenn Bondrucker aktiviert
  const druckerConfig = druckerConfigVonKasse(kasse)
  if (druckerConfig) {
    // Mandant-Infos für den Bon-Kopf laden
    const [mandant] = await db
      .select({ firmenname: mandanten.firmenname, uid: mandanten.uid })
      .from(mandanten)
      .where(eq(mandanten.id, kasse.mandantId))
      .limit(1)

    if (mandant) {
      try {
        const bytes = baueLieferbestellungBon(
          toDto(row),
          { firmenname: mandant.firmenname, uid: mandant.uid, kassenId: kasse.kassenId },
          { breite: kasse.druckerBreite },
        )
        await sendBytes(bytes, druckerConfig)
      } catch {
        // Druckfehler nicht nach oben werfen — Bestellung ist bereits gespeichert
      }
    }
  }

  return toDto(row)
}

export async function listeBestellungen(
  db:      Db,
  kasseId: string,
  opts:    { limit?: number; nurNeu?: boolean } = {},
): Promise<LieferbestellungResponse[]> {
  const conditions = [eq(lieferbestellungen.kasseId, kasseId)]
  if (opts.nurNeu) {
    conditions.push(eq(lieferbestellungen.status, 'neu'))
  }
  const rows = await db
    .select()
    .from(lieferbestellungen)
    .where(and(...conditions))
    .orderBy(desc(lieferbestellungen.createdAt))
    .limit(opts.limit ?? 100)

  return rows.map(toDto)
}

export async function aktualisiereBestellungStatus(
  db:        Db,
  id:        string,
  mandantId: string,
  status:    LieferbestellungStatus,
): Promise<LieferbestellungResponse> {
  const [row] = await db
    .update(lieferbestellungen)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(lieferbestellungen.id, id),
        eq(lieferbestellungen.mandantId, mandantId),
      )
    )
    .returning()

  if (!row) throw new Error('Bestellung nicht gefunden')
  return toDto(row)
}

// ---------------------------------------------------------------------------
// Manueller Reprint
// ---------------------------------------------------------------------------

export async function druckeLieferbestellung(
  db:        Db,
  id:        string,
  mandantId: string,
): Promise<void> {
  // Bestellung laden
  const [row] = await db
    .select()
    .from(lieferbestellungen)
    .where(and(eq(lieferbestellungen.id, id), eq(lieferbestellungen.mandantId, mandantId)))
    .limit(1)
  if (!row) throw new Error('Bestellung nicht gefunden')

  // Kasse laden
  const [kasse] = await db
    .select({
      kassenId:          kassen.kassenId,
      druckerIp:         kassen.druckerIp,
      druckerPort:       kassen.druckerPort,
      druckerAktiv:      kassen.druckerAktiv,
      druckerBreite:     kassen.druckerBreite,
      druckerTimeoutSek: kassen.druckerTimeoutSek,
    })
    .from(kassen)
    .where(eq(kassen.id, row.kasseId))
    .limit(1)
  if (!kasse) throw new Error('Kasse nicht gefunden')

  const druckerConfig = druckerConfigVonKasse(kasse)
  if (!druckerConfig) throw new Error('Drucker nicht konfiguriert oder deaktiviert')

  // Mandant laden
  const [mandant] = await db
    .select({ firmenname: mandanten.firmenname, uid: mandanten.uid })
    .from(mandanten)
    .where(eq(mandanten.id, mandantId))
    .limit(1)
  if (!mandant) throw new Error('Mandant nicht gefunden')

  const bytes = baueLieferbestellungBon(
    toDto(row),
    { firmenname: mandant.firmenname, uid: mandant.uid, kassenId: kasse.kassenId },
    { breite: kasse.druckerBreite },
  )
  await sendBytes(bytes, druckerConfig)
}

// ---------------------------------------------------------------------------
// DB-Row → DTO
// ---------------------------------------------------------------------------

function toDto(row: typeof lieferbestellungen.$inferSelect): LieferbestellungResponse {
  return {
    id:               row.id,
    kasseId:          row.kasseId,
    externeId:        row.externeId,
    provider:         row.provider,
    status:           row.status as LieferbestellungStatus,
    positionen:       row.positionen as LieferbestellungPosition[],
    gesamtbetragCent: row.gesamtbetragCent,
    ...(row.lieferName    && { lieferName:    row.lieferName    }),
    ...(row.lieferTelefon && { lieferTelefon: row.lieferTelefon }),
    ...(row.lieferAdresse && { lieferAdresse: row.lieferAdresse }),
    ...(row.notiz         && { notiz:         row.notiz         }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
