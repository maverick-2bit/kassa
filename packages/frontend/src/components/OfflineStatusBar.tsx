/**
 * OfflineStatusBar — sichtbarer Hinweis auf Offline-Betrieb und die Warteschlange
 *
 * Zeigt:
 *  - Orangen Banner wenn offline
 *  - Anzahl der Verkäufe in der Warteschlange
 *  - Manuellen Sync-Button (für Browser ohne Background Sync API)
 *  - Hinweis, wenn zum Nachsenden eine neue Anmeldung nötig ist
 *  - Roten Banner für Verkäufe, die das Backend abgelehnt hat — mit Liste, aus der
 *    der Kassier jeden erneut senden oder bewusst verwerfen kann (nichts geht still verloren)
 *  - Grünen Erfolgs-Toast nach erfolgreichem Sync
 */

import { useEffect, useState } from 'react'
import { useOffline } from '../lib/useOffline'
import { offlineManager, type WarteschlangenEintrag } from '../lib/offline'
import { formatPreis } from '../lib/format'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

function zeitText(ms: number): string {
  return new Date(ms).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function OfflineStatusBar() {
  const { online, queueCount, triggerSync } = useOffline()
  const [syncErfolg, setSyncErfolg]           = useState(false)
  const [syncing, setSyncing]                 = useState(false)
  const [eintraege, setEintraege]             = useState<WarteschlangenEintrag[]>([])
  const [anmeldungNoetig, setAnmeldungNoetig] = useState(false)
  const [listeOffen, setListeOffen]           = useState(false)
  const [verwerfenId, setVerwerfenId]         = useState<number | null>(null)

  useEffect(() => {
    let toastTimer: ReturnType<typeof setTimeout> | undefined
    const unsub = offlineManager.subscribe((event) => {
      switch (event.type) {
        case 'QUEUE_LISTE':
          setEintraege(event.eintraege)
          if (event.eintraege.length === 0) setAnmeldungNoetig(false)
          break
        case 'SYNC_ANMELDUNG_NOETIG':
          setSyncing(false)
          setAnmeldungNoetig(true)
          break
        case 'SYNC_DONE':
          setSyncing(false)
          offlineManager.requestQueueListe()
          break
        case 'BELEG_SYNCED':
          setSyncing(false)
          setAnmeldungNoetig(false)
          setSyncErfolg(true)
          clearTimeout(toastTimer)
          toastTimer = setTimeout(() => setSyncErfolg(false), 4000)
          offlineManager.requestQueueListe()
          break
        case 'BELEG_QUEUED':
        case 'BELEG_SYNC_FEHLER':
        case 'STATUS_CHANGE':
          // Nie auf QUEUE_COUNT reagieren: QUEUE_LISTE meldet selbst einen QUEUE_COUNT (Endlosschleife)
          offlineManager.requestQueueListe()
          break
      }
    })
    offlineManager.requestQueueListe()
    // Die Leiste erscheint erst im angemeldeten Bereich: jetzt nachsenden, was beim App-Start noch
    // auf die Anmeldung wartete (sonst bliebe die Warteschlange bis zum nächsten Anstoß liegen)
    if (navigator.onLine) offlineManager.triggerSync()
    return () => { unsub(); clearTimeout(toastTimer) }
  }, [])

  const abgelehnt = eintraege.filter(e => e.fehler)
  const offen     = Math.max(0, queueCount - abgelehnt.length)

  // ── Abgelehnte Verkäufe: Vorrang vor allem anderen ───────────────────────
  if (abgelehnt.length > 0) {
    return (
      <>
        <div className="fixed top-0 left-0 right-0 z-50
                        bg-red-600 text-white text-sm font-semibold
                        px-4 py-2 flex items-center justify-between shadow-md" data-testid="offline-abgelehnt">
          <span>
            {abgelehnt.length === 1
              ? '1 offline erfasster Verkauf wurde nicht gebucht'
              : `${abgelehnt.length} offline erfasste Verkäufe wurden nicht gebucht`}
            {offen > 0 && ` · ${offen} ${offen === 1 ? 'wartet' : 'warten'} noch`}
          </span>
          <button
            onClick={() => setListeOffen(true)}
            className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1 rounded-full transition-colors"
          >
            Anzeigen
          </button>
        </div>
        <Modal
          open={listeOffen}
          onClose={() => { setListeOffen(false); setVerwerfenId(null) }}
          title="Nicht gebuchte Verkäufe"
          size="lg"
        >
          <p className="text-sm text-gray-600 mb-4">
            Diese Verkäufe wurden offline erfasst, beim Nachbuchen aber abgelehnt. Sie bleiben hier,
            bis du sie erneut sendest (z. B. nach dem Beheben des Grundes) oder bewusst verwirfst.
          </p>
          <ul className="divide-y divide-gray-200">
            {abgelehnt.map(e => (
              <li key={e.id} className="py-3 flex flex-wrap items-center gap-3" data-testid="abgelehnter-verkauf">
                <div className="flex-1 min-w-[12rem]">
                  <div className="font-medium">
                    {zeitText(e.createdAt)} · {e.summeCent == null ? 'Betrag unbekannt' : formatPreis(e.summeCent)}
                  </div>
                  <div className="text-sm text-red-700">{e.fehler!.meldung}</div>
                </div>
                {verwerfenId === e.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-red-700">Der Verkauf wird nicht gebucht.</span>
                    <Button size="sm" variant="danger" onClick={() => { offlineManager.verwerfen(e.id); setVerwerfenId(null) }}>
                      Endgültig verwerfen
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setVerwerfenId(null)}>Abbrechen</Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    {!e.nurVerwerfen && (
                      <Button size="sm" onClick={() => offlineManager.erneutVersuchen(e.id)}>Erneut senden</Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => setVerwerfenId(e.id)}>Verwerfen</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Modal>
      </>
    )
  }

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
        <span>Alle offline erfassten Verkäufe sind gebucht</span>
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
              {queueCount} {queueCount === 1 ? 'Verkauf' : 'Verkäufe'} in Warteschlange
            </span>
          )}
        </div>
        <span className="text-amber-100 text-xs">
          Verkäufe werden gespeichert und nach Verbindungsaufbau gebucht — Storno und Sonderbelege erst wieder online
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
          {anmeldungNoetig
            ? `Bitte neu anmelden — danach ${queueCount === 1 ? 'wird 1 offline erfasster Verkauf' : `werden ${queueCount} offline erfasste Verkäufe`} gebucht`
            : `${queueCount} ${queueCount === 1 ? 'Verkauf wird' : 'Verkäufe werden'} nachgebucht …`}
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
