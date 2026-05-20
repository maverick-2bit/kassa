/**
 * KDS-Stationen.
 * Slug = stabile ID, Label = Anzeige-Name.
 */

import { z } from 'zod'

export const StationSchema = z.enum(['schank', 'kueche', 'kalte_kueche', 'dessert'])
export type Station = z.infer<typeof StationSchema>

export const STATION_LABELS: Record<Station, string> = {
  schank:       'Schank',
  kueche:       'Küche',
  kalte_kueche: 'Kalte Küche',
  dessert:      'Dessert',
}

export const ALLE_STATIONEN: Station[] = ['schank', 'kueche', 'kalte_kueche', 'dessert']
