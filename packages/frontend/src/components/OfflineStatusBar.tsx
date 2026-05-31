/**
 * OfflineStatusBar — sichtbarer Hinweis wenn die App offline ist
 *
 * Zeigt:
 *  - Orangen Banner wenn offline
 *  - Anzahl der Belege in der Sync-Queue
 *  - Manuellen Sync-Button (für Browser ohne Background Sync API)
 *  - Grünen Erfolgs-Toast nach erfolgreichem Sync
 */

import { useEffect, useState } from 'react'
import { useOffline } from '../lib/useOffline'
import { offlineManager } from '../lib/offline'

export function OfflineStatusBar() {
  const { online, queueCount, triggerSync } = useOffline()
  const [syncErfolg, setSyncErfolg]         = useState(false)
  const [syncing, setSyncing]               = useState(false)

  // Erfolgs-Toast nach Sync ausblenden
  useEffect(() => {
    const unsub = offlineManager.subscribe((event) => {
      if (event.type === 'SYNC_DONE') {
        setSyncing(false)
        setSyncErfolg(true)
        const t = setTimeout(() => setSyncErfolg(false), 4000)
        return () => clearTimeout(t)
      }
      if (event.type === 'BELEG_SYNCED') {
        setSyncing(false)
      }
    })
    return unsub
  }, [])

  // Online & Queue leer & kein Toast → nichts anzeigen
  if (online && queueCount === 0 && !syncErfolg) return null

  // ── Sync-Erfolg Toast ────────────────────────────────────────────────────
  if (online && queueCount === 0 && syncErfolg) {
    return (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50
                      bg-green-600 text-white text-sm font-medium
                      px-5 py-2.5 rounded-full shadow-lg
                      flex items-center gap-2 animate-fade-in">
        <span>✓</span>
        <span>Alle Belege wurden erfolgreich synchronisiert</span>
      </div>
    )
  }

  // ── Offline-Banner ────────────────────────────────────────────────────────
  if (!online) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50
                      bg-amber-500 text-white text-sm font-semibold
                      px-4 py-2 flex items-center justify-between shadow-md">
        <div className="flex items-center gap-2">
          <WifiOffIcon />
          <span>Offline-Modus aktiv</span>
          {queueCount > 0 && (
            <span className="bg-white/20 text-white text-xs
                             px-2 py-0.5 rounded-full">
              {queueCount} {queueCount === 1 ? 'Beleg' : 'Belege'} in Warteschlange
            </span>
          )}
        </div>
        <span className="text-amber-100 text-xs">
          Belege werden gespeichert und nach Verbindungsaufbau übermittelt
        </span>
      </div>
    )
  }

  // ── Online aber Queue nicht leer ──────────────────────────────────────────
  return (
    <div className="fixed top-0 left-0 right-0 z-50
                    bg-blue-600 text-white text-sm font-semibold
                    px-4 py-2 flex items-center justify-between shadow-md">
      <div className="flex items-center gap-2">
        <SyncIcon spinning={syncing} />
        <span>
          {queueCount} {queueCount === 1 ? 'Beleg wird' : 'Belege werden'} synchronisiert …
        </span>
      </div>
      <button
        onClick={() => {
          setSyncing(true)
          triggerSync()
        }}
        disabled={syncing}
        className="text-xs bg-white/20 hover:bg-white/30 disabled:opacity-50
                   px-3 py-1 rounded-full transition-colors"
      >
        {syncing ? 'Läuft …' : 'Jetzt synchronisieren'}
      </button>
    </div>
  )
}

// ── Icons (inline SVG, kein externes Package nötig) ──────────────────────────

function WifiOffIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none"
         viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
            d="M3 3l18 18M8.111 8.111A9.955 9.955 0 0112 7c2.29 0 4.397.77 6.075 2.05
               M16.804 16.804A5.98 5.98 0 0112 15a5.98 5.98 0 00-4.243 1.757
               M12 20h.01" />
    </svg>
  )
}

function SyncIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg"
         className={`w-4 h-4 ${spinning ? 'animate-spin' : ''}`}
         fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9
               m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  )
}
