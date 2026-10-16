import { useEffect, useRef, useState } from 'react'

/** Aufklappliste (Umschalter in der Kopfleiste): schließt bei Klick daneben und mit Esc. */
export function useAufklappen() {
  const [offen, setOffen] = useState(false)
  const huelle = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!offen) return
    const aussen = (e: MouseEvent) => { if (huelle.current && !huelle.current.contains(e.target as Node)) setOffen(false) }
    const taste  = (e: KeyboardEvent) => { if (e.key === 'Escape') setOffen(false) }
    document.addEventListener('mousedown', aussen)
    document.addEventListener('keydown', taste)
    return () => { document.removeEventListener('mousedown', aussen); document.removeEventListener('keydown', taste) }
  }, [offen])

  return { offen, setOffen, huelle }
}
