import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | undefined
  size?:    'sm' | 'md' | undefined
  loading?: boolean | undefined
  children: ReactNode
}

/**
 * Das Aussehen steht in index.css (`.btn`, `.btn-md`, `.btn-primary` …) in der
 * components-Ebene: Utility-Klassen aus `className` gewinnen dort immer gegen
 * die Vorgabe, gleich ob Schriftgröße, Polster oder Farbe.
 */
export function Button({
  variant = 'primary',
  size    = 'md',
  loading = false,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const sizes = {
    sm: 'btn-sm',
    md: 'btn-md',
  }

  const variants = {
    primary:   'btn-primary',
    secondary: 'btn-secondary',
    danger:    'btn-danger',
  }

  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`btn ${sizes[size]} ${variants[variant]} ${className}`}
      {...rest}
    >
      {loading && (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4"/>
          <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/>
        </svg>
      )}
      {children}
    </button>
  )
}
