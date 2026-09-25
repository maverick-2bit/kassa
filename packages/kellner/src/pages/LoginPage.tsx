import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { PIN_LAENGE_CODE } from '@kassa/shared'
import { ApiError, authApi, kasseApi } from '../lib/api'
import { gemerktePinLaenge, getGeraetToken, merkePinLaenge, setAuth } from '../lib/auth'
import { getKasseIdentity, setKasseIdentity } from '../lib/kasse'
import { restzeitText, usePinSperre } from '../lib/pin-sperre'

export function LoginPage() {
  const navigate    = useNavigate()
  const identity    = getKasseIdentity()
  const [pin, setPin]         = useState('')
  const [fehler, setFehler]   = useState<string | null>(null)
  const inputRef              = useRef<HTMLInputElement>(null)
  const sperre                = usePinSperre()

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
  const effKasseId = identity?.kasseId ?? gewaehlteKasseId

  // PIN-Länge des Betriebs (4 oder 6): zuletzt bekannte sofort, dann frisch vom
  // Server — das Feld schickt nach der letzten Ziffer automatisch ab.
  const [pinLaenge, setPinLaenge] = useState(gemerktePinLaenge)
  const pinInfo = useQuery({
    queryKey:  ['pin-info', effKasseId],
    queryFn:   () => authApi.pinInfo(effKasseId),
    enabled:   !!effKasseId,
    staleTime: 60_000,
    retry:     false,
  })
  useEffect(() => {
    if (!pinInfo.data) return
    setPinLaenge(pinInfo.data.pinLaenge)
    merkePinLaenge(pinInfo.data.pinLaenge)
  }, [pinInfo.data])

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
      setPin('')
      inputRef.current?.focus()
      // Zu viele Fehlversuche: Countdown statt Meldung — bis dahin prüft der Server nichts
      if (sperre.uebernimm(err)) { setFehler(null); return }
      // Betrieb wurde auf eine andere PIN-Länge umgestellt → Feld anpassen
      if (err instanceof ApiError && err.code === PIN_LAENGE_CODE && err.pinLaenge) {
        setPinLaenge(err.pinLaenge === 6 ? 6 : 4)
        merkePinLaenge(err.pinLaenge)
        setFehler(`PINs haben jetzt ${err.pinLaenge} Ziffern — bitte erneut eingeben.`)
        return
      }
      setFehler(err instanceof Error ? err.message : 'PIN ungültig')
    },
  })

  /** Geräte-Merkmal mitschicken: ein Fremder kann dieses Handy dann nicht aussperren */
  function anmelden(kasseId: string, eingabe: string) {
    const geraetToken = getGeraetToken()
    mutation.mutate({ kasseId, pin: eingabe, ...(geraetToken ? { geraetToken } : {}) })
  }

  function handleDigit(d: string) {
    if (!effKasseId || sperre.gesperrt) return
    const next = (pin + d).slice(0, pinLaenge)
    setPin(next)
    setFehler(null)
    if (next.length === pinLaenge) anmelden(effKasseId, next)
  }

  function handleDelete() { setPin(p => p.slice(0, -1)) }

  function handleKasseWaehlen(kasseId: string) {
    const kasse = kassenQuery.data?.find(k => k.id === kasseId)
    if (!kasse) return
    setKasseIdentity({ mandantId, kasseId })
    setGewaehlteKasseId(kasseId)
  }

  const kasseGesetzt = !!(identity?.kasseId || gewaehlteKasseId)

  // Frisches Gerät OHNE Einrichtungs-Link: Ein PIN-Feld wäre hier tot (der
  // Login braucht eine Kasse) — das wurde bisher kommentarlos angezeigt und
  // als „PIN funktioniert nicht" gemeldet. Stattdessen sagen, was fehlt.
  if (!identity && !mandantId) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-600 text-white text-2xl">🍽</div>
          <h1 className="text-2xl font-black text-ink">Kellner-App</h1>
          <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 text-left space-y-2">
            <p className="font-bold">Dieses Gerät ist noch nicht eingerichtet.</p>
            <p>
              Bitte den <strong>QR-Code der Kellner-App</strong> scannen — zu finden an der
              Kassa unter <strong>Einstellungen → Geräte</strong>. Er enthält die Zuordnung
              zu eurem Betrieb; ohne sie kann die App keine Anmeldung annehmen.
            </p>
          </div>
        </div>
      </div>
    )
  }

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

          {kassenQuery.isError && (
            <p className="text-center text-red-500 text-sm">
              Kassenliste nicht erreichbar — ist das Gerät im Kassa-WLAN?
              ({kassenQuery.error instanceof Error ? kassenQuery.error.message : 'Fehler'})
            </p>
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
          {Array.from({ length: pinLaenge }, (_, i) => (
            <div
              key={i}
              className={`w-4 h-4 rounded-full transition-all ${
                i < pin.length ? 'bg-brand-600 scale-110' : 'bg-panel-2'
              }`}
            />
          ))}
        </div>

        {/* Sperre nach zu vielen Fehlversuchen */}
        {sperre.gesperrt && (
          <p role="alert" className="rounded-2xl border-2 border-amber-300 bg-amber-50 px-3 py-2 text-center text-sm font-medium text-amber-900">
            Zu viele falsche PINs — wieder möglich in{' '}
            <span className="font-black tabular-nums">{restzeitText(sperre.restSekunden)}</span>
          </p>
        )}

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
                disabled={mutation.isPending || sperre.gesperrt}
                className={`h-16 rounded-2xl text-xl font-black transition active:scale-90 disabled:opacity-50 ${
                  d === '⌫'
                    ? 'bg-panel-2 text-ink-muted hover:bg-panel-2'
                    : 'bg-panel border-2 border-line text-ink hover:border-brand-400 hover:bg-brand-50'
                }`}
              >
                {mutation.isPending && pin.length === pinLaenge ? '…' : d}
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
            if (sperre.gesperrt) return
            const v = e.target.value.replace(/\D/g, '').slice(0, pinLaenge)
            setPin(v)
            setFehler(null)
            if (v.length === pinLaenge && effKasseId) anmelden(effKasseId, v)
          }}
          className="sr-only"
          autoFocus
        />
      </div>
    </div>
  )
}
