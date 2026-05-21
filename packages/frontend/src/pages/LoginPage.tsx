import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { LoginInputSchema, type LoginInput } from '@kassa/shared'
import { authApi } from '../lib/api'
import { setAuth } from '../lib/auth'
import { setKasseIdentity } from '../lib/kasse'
import { Field } from '../components/ui/Field'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'

export function LoginPage() {
  const navigate = useNavigate()
  const [serverFehler, setServerFehler] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(LoginInputSchema),
    defaultValues: { email: '', passwort: '' },
  })

  const loginMutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: (data) => {
      setAuth(data)
      // Falls genau eine Kasse vorhanden ist, direkt setzen
      if (data.kassen.length === 1 && data.kassen[0]) {
        setKasseIdentity({ mandantId: data.mandant.id, kasseId: data.kassen[0].id })
      }
      navigate('/kasse')
    },
    onError: (err) => setServerFehler(err instanceof Error ? err.message : 'Login fehlgeschlagen'),
  })

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gray-50">
      <div className="w-full max-w-md">
        <header className="mb-6 text-center">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-brand-500 text-white mb-3">
            <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v4H3zM3 11h18v10H3zM7 15h2M7 18h2"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Anmeldung</h1>
          <p className="mt-1 text-sm text-gray-600">Mit deinem Kassa-Konto einloggen</p>
        </header>

        <form
          onSubmit={handleSubmit((data) => { setServerFehler(null); loginMutation.mutate(data) })}
          className="rounded-xl bg-white shadow-sm border border-gray-200 p-6 space-y-4"
          noValidate
        >
          <Field label="E-Mail" htmlFor="email" required error={errors.email?.message}>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              invalid={!!errors.email}
              {...register('email')}
            />
          </Field>

          <Field label="Passwort" htmlFor="passwort" required error={errors.passwort?.message}>
            <Input
              id="passwort"
              type="password"
              autoComplete="current-password"
              invalid={!!errors.passwort}
              {...register('passwort')}
            />
          </Field>

          {serverFehler && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
              {serverFehler}
            </div>
          )}

          <div className="pt-2 border-t border-gray-200">
            <Button type="submit" loading={loginMutation.isPending} className="w-full">
              Einloggen
            </Button>
          </div>

          <p className="text-center text-xs text-gray-500 pt-1">
            Noch keine Kasse?{' '}
            <button
              type="button"
              onClick={() => navigate('/setup')}
              className="text-brand-600 hover:underline"
            >
              Kasse einrichten
            </button>
          </p>
        </form>
      </div>
    </div>
  )
}
