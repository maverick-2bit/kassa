/**
 * PdfVorschauModal — zeigt ein erzeugtes PDF (z. B. einen Bericht) direkt am Bildschirm, ohne Download.
 * Von hier aus lässt es sich bei Bedarf trotzdem speichern oder drucken.
 */

import { useRef } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

interface Props {
  /** Blob-Adresse des PDFs; null = geschlossen */
  url:       string | null
  titel:     string
  dateiname: string
  onClose:   () => void
}

export function PdfVorschauModal({ url, titel, dateiname, onClose }: Props) {
  const rahmen = useRef<HTMLIFrameElement>(null)

  const drucken = () => {
    const fenster = rahmen.current?.contentWindow
    if (!fenster) return
    fenster.focus()
    fenster.print()
  }

  return (
    <Modal open={url !== null} onClose={onClose} title={titel} size="xl">
      {url && (
        <div className="space-y-3">
          <iframe
            ref={rahmen}
            src={url}
            title={`Vorschau: ${titel}`}
            data-testid="pdf-vorschau"
            className="h-[70vh] w-full rounded-md border border-line bg-white"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <a
              href={url}
              download={dateiname}
              className="inline-flex items-center rounded-md border border-line-strong bg-panel px-3 py-1.5 text-sm font-medium text-ink hover:border-brand-400"
            >
              Herunterladen
            </a>
            <Button variant="secondary" onClick={drucken}>Drucken</Button>
            <Button onClick={onClose}>Schließen</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
