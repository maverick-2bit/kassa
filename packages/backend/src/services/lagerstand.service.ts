/**
 * Lagerstand-Service: Bulk-Aktualisierung für Wareneingang und Inventur.
 *
 * Zwei Modi:
 *   - absolut     → Bestand direkt auf den angegebenen Wert setzen (Inventur)
 *   - wareneingang → Menge zum bestehenden Bestand addieren (Zugangsbuchung)
 *
 * Sicherheit: mandantId-Filter verhindert Cross-Tenant-Zugriff.
 *             Bei Artikeln wird zusätzlich lagerstandAktiv geprüft.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { LagerstandBulkInput } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { artikel, modifikatoren } from '../db/schema.js'

export async function bulkLagerstandAktualisieren(
  input: LagerstandBulkInput,
  mandantId: string,
  db: Db,
): Promise<void> {
  if (input.artikel.length === 0 && input.modifikatoren.length === 0) return

  const isAbsolut = input.modus === 'absolut'

  await db.transaction(async (tx) => {
    // Artikel-Lagerstand
    for (const item of input.artikel) {
      await tx
        .update(artikel)
        .set({
          lagerstandMenge: isAbsolut
            ? item.menge
            : sql`GREATEST(0, COALESCE(${artikel.lagerstandMenge}, 0) + ${item.menge})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(artikel.id, item.id),
            eq(artikel.mandantId, mandantId),
            eq(artikel.lagerstandAktiv, true),
          ),
        )
    }

    // Modifikator-Varianten-Lagerstand
    for (const item of input.modifikatoren) {
      await tx
        .update(modifikatoren)
        .set({
          lagerstandMenge: isAbsolut
            ? item.menge
            : sql`GREATEST(0, COALESCE(${modifikatoren.lagerstandMenge}, 0) + ${item.menge})`,
        })
        .where(
          and(
            eq(modifikatoren.id, item.id),
            eq(modifikatoren.mandantId, mandantId),
          ),
        )
    }
  })
}
