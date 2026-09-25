/**
 * App-Versionen vergleichen — für den Update-Hinweis der Service-Worker-Apps
 * (Kassa und Kellner-App).
 */

/** Semver-ähnlicher Vergleich: ist a echt neuer als b? (fehlende/ungültige Teile = 0) */
export function istNeuereVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * Gehört der Service Worker (Registrierungs-URL /sw.js?v=<version>) zu einer
 * NEUEREN Version als die laufende Seite?
 *
 * Nur dann ist ein `controllerchange` ein Update-Hinweis wert. Nach einem
 * Update übernimmt auch der SW der eigenen Version (die neue Seite registriert
 * ihn beim Start selbst), und ändert sich sw.js mit dem Release, übernimmt
 * vorher kurz noch der alte SW mit neuem Code — beides ist kein Update.
 */
export function istNeuererServiceWorker(scriptUrl: string | undefined, seitenVersion: string): boolean {
  if (!scriptUrl) return false
  let swVersion: string | null
  try {
    swVersion = new URL(scriptUrl).searchParams.get('v')
  } catch {
    return false
  }
  return !!swVersion && istNeuereVersion(swVersion, seitenVersion)
}
