import type { DruckerConfig } from './api'

/**
 * URL zur öffentlichen Web-Ansicht des digitalen Belegs (Ziel des QR-Codes).
 * Gibt `undefined` zurück, wenn die Kasse nur druckt (`belegModus === 'drucken'`)
 * — dann wird kein QR angeboten. Basis = konfigurierte öffentliche URL oder,
 * als Fallback, der Origin der Kassa-App (im LAN vom Gast-Handy erreichbar).
 */
export function digitalerBelegUrl(
  cfg:     DruckerConfig | undefined | null,
  belegId: string,
): string | undefined {
  if (!cfg || cfg.belegModus === 'drucken') return undefined
  const basis = (cfg.belegBasisUrl?.trim() || window.location.origin).replace(/\/+$/, '')
  return `${basis}/beleg/${belegId}`
}
