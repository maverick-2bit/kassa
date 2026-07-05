import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { authApi, kasseApi } from '../lib/api'
import { setAuth } from '../lib/auth'
import { getKasseIdentity, setKasseIdentity } from '../lib/kasse'

export function LoginPage() {
  const navigate    = useNavigate()
  const identity    = getKasseIdentity()
  const [pin, setPin]         = useState('')
  const [fehler, setFehler]   = useState<string | null>(null)
  const inputRef              = useRef<HTMLInputElement>(null)

  // Kassen laden für den Setup-Schritt (mandantId aus URL-Param)
  const urlParams  = new URLSearchParams(window.location.search)
  const mandantId  = urlParams.get('mandantId') ?? identity?.mandantId ?? ''

  const kassenQuery = useQuery({
    queryKey:  ['kassen', mandantId],
    queryFn:   () => kasseApi.list(mandantId),
    enabled:   !!mandantId && !identity,
    staleTime: Infinity,
  })

  // Noch keine Kasse gewählt — Kasse wählen
  const [gewaehlteKasseId, setGewaehlteKasseId] = useState<string>('')

  const mutation = useMutation({
    mutationFn: authApi.pinLogin,
    onSuccess: (data) => {
      setAuth(data)
      const aktuelle = getKasseIdentity()
      const passt = aktuelle && data.kassen.some(k => k.id === aktuelle.kasseId)
      if (!passt && data.kassen[0]) {
        setKasseIdentity({ mandantId: data.mandant.id, kasseId: data.kassen[0].id })
      }
      navigate('/', { replace: true })
    },
    onError: (err) => {
      setFehler(err instanceof Error ? err.message : 'PIN ungültig')
      setPin('')
      inputRef.current?.focus()
    },
  })

  function handleDigit(d: string) {
    const eff = identity?.kasseId ?? gewaehlteKasseId
    if (!eff) return
    const next = (pin + d).slice(0, 4)
    setPin(next)
    setFehler(null)
    if (next.length === 4) {
      mutation.mutate({ kasseId: eff, pin: next })
    }
  }

  function handleDelete() { setPin(p => p.slice(0, -1)) }

  function handleKasseWaehlen(kasseId: string) {
    const kasse = kassenQuery.data?.find(k => k.id === kasseId)
    if (!kasse) return
    setKasseIdentity({ mandantId, kasseId })
    setGewaehlteKasseId(kasseId)
  }

  const kasseGesetzt = !!(identity?.kasseId || gewaehlteKasseId)

  // Setup-Schritt: Kasse wählen
  if (mandantId && !kasseGesetzt) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-600 text-white mb-3 text-2xl">
              🍽
            </div>
            <h1 className="text-2xl font-black text-ink">Kellner-App</h1>
            <p className="text-ink-subtle text-sm mt-1">Kasse auswählen</p>
          </div>

          {kassenQuery.isLoading && (
            <div className="text-center py-8">
              <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          )}

          {kassenQuery.data && kassenQuery.data.length === 0 && (
            <p className="text-center text-ink-subtle text-sm">Keine Kassen gefunden.</p>
          )}

          <div className="space-y-2">
            {kassenQuery.data?.map(k => (
              <button
                key={k.id}
                onClick={() => handleKasseWaehlen(k.id)}
                className="w-full p-4 rounded-2xl bg-panel border-2 border-line text-left font-semibold text-ink hover:border-brand-400 active:scale-98 transition"
              >
                {k.bezeichnung}
              </button>
            ))}
          </div>

          {!mandantId && (
            <p className="text-center text-red-500 text-sm">
              Kein mandantId in der URL. Bitte die App korrekt aufrufen.
            </p>
          )}
        </div>
      </div>
    )
  }

  // PIN-Eingabe
  const digits = ['1','2','3','4','5','6','7','8','9','','0','⌫']

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-xs space-y-6">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-600 text-white mb-3 text-2xl">
            🍽
          </div>
          <h1 className="text-2xl font-black text-ink">Kellner-App</h1>
          <p className="text-ink-subtle text-sm mt-1">PIN eingeben</p>
        </div>

        {/* PIN-Punkte */}
        <div className="flex justify-center gap-4">
          {[0,1,2,3].map(i => (
            <div
              key={i}
              className={`w-4 h-4 rounded-full transition-all ${
                i < pin.length ? 'bg-brand-600 scale-110' : 'bg-panel-2'
              }`}
            />
          ))}
        </div>

        {/* Fehler */}
        {fehler && (
          <p className="text-center text-red-500 text-sm font-medium">{fehler}</p>
        )}

        {/* Numpad */}
        <div className="grid grid-cols-3 gap-3">
          {digits.map((d, i) => {
            if (d === '') return <div key={i} />
            return (
              <button
                key={i}
                onClick={() => d === '⌫' ? handleDelete() : handleDigit(d)}
                disabled={mutation.isPending}
                className={`h-16 rounded-2xl text-xl font-black transition active:scale-90 disabled:opacity-50 ${
                  d === '⌫'
                    ? 'bg-panel-2 text-ink-muted hover:bg-panel-2'
                    : 'bg-panel border-2 border-line text-ink hover:border-brand-400 hover:bg-brand-50'
                }`}
              >
                {mutation.isPending && pin.length === 4 ? '…' : d}
              </button>
            )
          })}
        </div>

        {/* Verstecktes Input für physische Tastatur */}
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={e => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 4)
            setPin(v)
            setFehler(null)
            const eff = identity?.kasseId ?? gewaehlteKasseId
            if (v.length === 4 && eff) mutation.mutate({ kasseId: eff, pin: v })
          }}
          className="sr-only"
          autoFocus
        />
      </div>
    </div>
  )
}
