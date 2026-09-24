import { useEffect, useRef, useState } from 'react'
import type QrScannerTyp from 'qr-scanner'

type Status = 'startet' | 'laeuft' | 'keine' | 'verweigert' | 'unsicher'

const STATUS_TEXT: Record<Exclude<Status, 'laeuft'>, string> = {
  startet:    'Kamera startet …',
  keine:      'Keine Kamera gefunden — Code unten eingeben oder Handscanner verwenden.',
  verweigert: 'Kamerazugriff verweigert — in den Browser-Einstellungen erlauben, oder Code unten eingeben.',
  unsicher:   'Kamera nur über HTTPS möglich — Code unten eingeben oder Handscanner verwenden.',
}

/**
 * Kamera-Scanner (qr-scanner: nutzt den schnellen BarcodeDetector des Handys,
 * sonst einen Web-Worker). Läuft durchgehend — während ein Ergebnis angezeigt
 * wird, filtert der Scanner-Bildschirm Treffer weg, statt die Kamera zu stoppen
 * (ein Neustart dauert und flackert).
 */
export function Kamera({ onErkannt }: { onErkannt: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const rueckruf = useRef(onErkannt)
  rueckruf.current = onErkannt
  const [status, setStatus] = useState<Status>(window.isSecureContext ? 'startet' : 'unsicher')

  useEffect(() => {
    if (!window.isSecureContext) return
    let scanner: QrScannerTyp | null = null
    let beendet = false
    void (async () => {
      const QrScanner = (await import('qr-scanner')).default
      if (beendet) return
      if (!(await QrScanner.hasCamera())) { setStatus('keine'); return }
      scanner = new QrScanner(video.current!, (r) => rueckruf.current(r.data), {
        returnDetailedScanResult: true,
        preferredCamera: 'environment',
        maxScansPerSecond: 8,
        highlightScanRegion: true,
        highlightCodeOutline: true,
      })
      try {
        await scanner.start()
        if (!beendet) setStatus('laeuft')
      } catch {
        if (!beendet) setStatus('verweigert')
      }
    })()
    return () => { beendet = true; scanner?.stop(); scanner?.destroy() }
  }, [])

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black">
      <video ref={video} className="h-full w-full object-cover" muted playsInline />
      {status !== 'laeuft' && (
        <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-leise">
          {STATUS_TEXT[status]}
        </p>
      )}
    </div>
  )
}
