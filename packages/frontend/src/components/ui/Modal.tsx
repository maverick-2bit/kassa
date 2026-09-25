import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface ModalProps {
  open:    boolean
  onClose: () => void
  title:   string
  children: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** false: ein Tipp auf den abgedunkelten Hintergrund schließt nicht (laufender
   *  Vorgang wie die Terminal-Zahlung) — ✕ und Esc bleiben als bewusste Bedienung. */
  closeOnBackdrop?: boolean
}

const sizeClass = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
}

export function Modal({ open, onClose, title, children, size = 'md', closeOnBackdrop = true }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // Per Portal direkt unter <body>: so liegt jeder Dialog über der ganzen Seite,
  // auch wenn er in einem sticky Abschnitt gerendert wird (eigener Stapelkontext —
  // Optionen-Dialog und „Neuer Kunde" in der Kasse lagen sonst unter Kopfleiste
  // und Hinweis-Karten). Die Hinweis-Karten liegen bewusst darunter (z-40).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={closeOnBackdrop ? onClose : undefined}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`w-full ${sizeClass[size]} rounded-xl bg-panel shadow-xl border border-line max-h-[90vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-subtle hover:text-ink-muted hover:bg-panel-2"
            aria-label="Schließen"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.3 5.3a1 1 0 0 1 1.4 0L10 8.6l3.3-3.3a1 1 0 1 1 1.4 1.4L11.4 10l3.3 3.3a1 1 0 1 1-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 1 1-1.4-1.4L8.6 10 5.3 6.7a1 1 0 0 1 0-1.4z" clipRule="evenodd"/>
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
