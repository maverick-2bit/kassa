import { forwardRef, type SelectHTMLAttributes } from 'react'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ invalid, className = '', children, ...rest }, ref) {
    const base =
      'block w-full rounded-md border px-3 py-2 text-sm text-ink bg-panel ' +
      'shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 ' +
      'disabled:bg-panel-2 disabled:cursor-not-allowed'
    const variant = invalid
      ? 'border-red-400 focus:border-red-500'
      : 'border-line-strong focus:border-brand-500'

    return (
      <select ref={ref} className={`${base} ${variant} ${className}`} {...rest}>
        {children}
      </select>
    )
  },
)
