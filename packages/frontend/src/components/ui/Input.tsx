import { forwardRef, type InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ invalid, className = '', ...rest }, ref) {
    const base =
      'block w-full rounded-md border px-3 py-2 text-sm text-ink ' +
      'shadow-sm placeholder:text-ink-subtle ' +
      'focus:outline-none focus:ring-2 focus:ring-brand-500/40 ' +
      'disabled:bg-panel-2 disabled:cursor-not-allowed'
    const variant = invalid
      ? 'border-red-400 focus:border-red-500'
      : 'border-line-strong focus:border-brand-500'

    return <input ref={ref} className={`${base} ${variant} ${className}`} {...rest} />
  },
)
