/** Ein/Aus-Schieberegler (gleiche Optik wie in den Einstellungen). */
export function Schalter({
  an, label, disabled, onChange,
}: {
  an:        boolean
  label:     string
  disabled?: boolean
  onChange:  (an: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={an}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!an)}
      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-50 ${
        an ? 'bg-amber-500' : 'bg-line-strong'
      }`}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-panel shadow transition-transform ${
        an ? 'translate-x-5' : 'translate-x-0'
      }`} />
    </button>
  )
}
