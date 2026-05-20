import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary'
  loading?: boolean
  children: ReactNode
}

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 ' +
    'text-sm font-semibold shadow-sm transition ' +
    'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 ' +
    'disabled:opacity-60 disabled:cursor-not-allowed'

  const variants = {
    primary:   'bg-brand-500 text-white hover:bg-brand-600',
    secondary: 'bg-white text-gray-800 border border-gray-300 hover:bg-gray-50',
  }

  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`${base} ${variants[variant]} ${className}`}
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
