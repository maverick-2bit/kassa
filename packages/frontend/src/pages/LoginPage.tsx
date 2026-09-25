import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { LoginInputSchema, PIN_LAENGE_CODE, type LoginInput, type Startseite } from '@kassa/shared'
import { ApiError, authApi, posConfigApi, setupApi } from '../lib/api'
import { gemerktePinLaenge, getGeraetToken, merkePinLaenge, setAuth } from '../lib/auth'
import { getKasseIdentity, setKasseIdentity } from '../lib/kasse'
import { restzeitText, usePinSperre } from '../lib/pin-sperre'
import { Field } from '../components/ui/Field'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'

const STARTSEITE_PFAD: Record<Startseite, string> = {
  tische:          '/tische',
  kasse:           '/kasse',
  kasse_favoriten: '/kasse?tab=favoriten',
  dashboard:       '/dashboard',
}

async function leseStartseitePfad(kasseId: string): Promise<string> {
  try {
    const cfg = await posConfigApi.get(kasseId)
    return STARTSEITE_PFAD[cfg.startseite] ?? '/tische'
  } catch {
    return '/tische'
  }
}

type Tab = 'passwort' | 'pin'

export function LoginPage() {
  const navigate   = useNavigate()
  // Ohne bekannte Kasse (frisches Gerät) zuerst den E-Mail-Login zeigen — der
  // PIN-Login setzt eine bereits gewählte Kasse voraus.
  const [tab, setTab] = useState<Tab>(() => (getKasseIdentity() ? 'pin' : 'passwort'))

  // Frische Installation erkennen: solange es keine Benutzer gibt, führt ein
  // Login-Formular nur in die Irre — Zugangsdaten anderer Installationen
  // funktionieren hier nicht, und genau das wird sonst als „kaputt" gemeldet.
  // Bei Fehlern (Backend noch nicht erreichbar) im Zweifel das normale Login
  // zeigen — die Statusabfrage darf die Anmeldung nie blockieren.
  const setupStatus = useQuery({
    queryKey:  ['setup-status'],
    queryFn:   setupApi.status,
    staleTime: 60_000,
    retry:     false,
  })
  const frisch = setupStatus.data?.eingerichtet === false

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-panel-2">
      <div className="w-full max-w-md">
        <header className="mb-6 text-center">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-brand-500 text-white mb-3">
            <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v4H3zM3 11h18v10H3zM7 15h2M7 18h2"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-ink">{frisch ? 'Willkommen' : 'Anmeldung'}</h1>
        </header>

        {frisch && (
          <div className="mb-4 rounded-xl border-2 border-brand-300 bg-brand-50 p-5 text-center space-y-3">
            <p className="text-sm font-semibold text-ink">
              Diese Kassa ist noch nicht eingerichtet.
            </p>
            <p className="text-xs text-ink-muted">
              Es gibt hier noch keine Benutzer — Zugangsdaten von einer anderen
              Installation funktionieren nicht. Zuerst die Ersteinrichtung
              durchführen; die dabei vergebenen Admin-Zugangsdaten gelten dann
              für dieses Gerät.
            </p>
            <Button className="w-full" onClick={() => { window.location.href = '/setup' }}>
              Jetzt Kasse einrichten →
            </Button>
          </div>
        )}

        {/* Tab-Umschalter */}
        <div className="flex rounded-lg border border-line bg-panel-2 p-1 mb-4">
          {(['pin', 'passwort'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex-1 py-1.5 text-sm font-medium rounded-md transition ${
                tab === t
                  ? 'bg-panel shadow-sm text-ink'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              {t === 'pin' ? 'PIN' : 'E-Mail & Passwort'}
            </button>
          ))}
        </div>

        {tab === 'pin'
          ? <PinLoginForm onNavigate={(pfad) => navigate(pfad)} />
          : <PasswortLoginForm onNavigate={(pfad) => navigate(pfad)} />
        }
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PIN-Login
// ---------------------------------------------------------------------------

function PinLoginForm({ onNavigate }: { onNavigate: (pfad: string) => void }) {
  const [pin, setPin]         = useState('')
  const [fehler, setFehler]   = useState<string | null>(null)
  const inputRef              = useRef<HTMLInputElement>(null)
  const sperre                = usePinSperre()

  const identity = getKasseIdentity()

  // PIN-Länge des Betriebs (4 oder 6): zuletzt bekannte sofort, dann frisch vom
  // Server — das Feld schickt nach der letzten Ziffer automatisch ab.
  const [pinLaenge, setPinLaenge] = useState(gemerktePinLaenge)
  const pinInfo = useQuery({
    queryKey:  ['pin-info', identity?.kasseId],
    queryFn:   () => authApi.pinInfo(identity!.kasseId),
    enabled:   !!identity,
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
    onSuccess: async (data) => {
      setAuth(data)
      // Kasse wechseln: wenn aktuelle Kasse nicht in den zugewiesenen ist, auf die erste umschalten
      const aktuelle = getKasseIdentity()
      const passt = aktuelle && data.kassen.some(k => k.id === aktuelle.kasseId)
      if (!passt && data.kassen[0]) {
        setKasseIdentity({ mandantId: data.mandant.id, kasseId: data.kassen[0].id })
      }
      const kasseId = getKasseIdentity()?.kasseId
      const pfad = kasseId ? await leseStartseitePfad(kasseId) : '/tische'
      onNavigate(pfad)
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

  /** Geräte-Merkmal mitschicken: ein Fremder kann dieses Gerät dann nicht aussperren */
  const anmelden = (kasseId: string, eingabe: string) => {
    const geraetToken = getGeraetToken()
    mutation.mutate({ kasseId, pin: eingabe, ...(geraetToken ? { geraetToken } : {}) })
  }

  const handleDigit = (d: string) => {
    if (sperre.gesperrt) return
    const next = (pin + d).slice(0, pinLaenge)
    setPin(next)
    setFehler(null)
    if (next.length === pinLaenge && identity) anmelden(identity.kasseId, next)
  }

  const handleDelete = () => setPin(p => p.slice(0, -1))

  if (!identity) {
    return (
      <div className="rounded-xl bg-panel shadow-sm border border-line p-6 text-center">
        <p className="text-sm text-ink-muted">Keine Kasse eingerichtet.</p>
        <button type="button" onClick={() => window.location.href = '/setup'} className="mt-2 text-sm text-brand-600 hover:underline">
          Kasse einrichten →
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl bg-panel shadow-sm border border-line p-6">
      <p className="text-center text-sm text-ink-muted mb-5">PIN eingeben</p>

      {/* PIN-Punkte */}
      <div className="flex justify-center gap-3 mb-6">
        {Array.from({ length: pinLaenge }, (_, i) => (
          <div
            key={i}
            className={`h-4 w-4 rounded-full border-2 transition ${
              pin.length > i
                ? 'bg-brand-500 border-brand-500'
                : 'bg-panel border-line-strong'
            }`}
          />
        ))}
      </div>

      {sperre.gesperrt && (
        <div role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 text-center">
          Zu viele falsche PIN-Eingaben — wieder möglich in{' '}
          <span className="font-semibold tabular-nums">{restzeitText(sperre.restSekunden)}</span>
        </div>
      )}

      {fehler && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 text-center">
          {fehler}
        </div>
      )}

      {/* Numpad */}
      <div className="grid grid-cols-3 gap-2">
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((d, i) => (
          <button
            key={i}
            type="button"
            disabled={mutation.isPending || sperre.gesperrt || d === ''}
            onClick={() => d === '⌫' ? handleDelete() : handleDigit(d)}
            className={`h-14 rounded-xl text-xl font-semibold transition ${
              d === ''
                ? 'cursor-default'
                : d === '⌫'
                ? 'bg-panel-2 hover:bg-panel-2 text-ink-muted'
                : 'bg-panel-2 hover:bg-brand-50 hover:text-brand-700 border border-line text-ink'
            } disabled:opacity-50`}
          >
            {d}
          </button>
        ))}
      </div>

      {/* Hidden input für Keyboard auf Tablets */}
      <input
        ref={inputRef}
        type="tel"
        value={pin}
        onChange={(e) => {
          if (sperre.gesperrt) return
          const v = e.target.value.replace(/\D/g, '').slice(0, pinLaenge)
          setPin(v)
          setFehler(null)
          if (v.length === pinLaenge && identity) anmelden(identity.kasseId, v)
        }}
        className="sr-only"
        aria-hidden
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Passwort-Login
// ---------------------------------------------------------------------------

function PasswortLoginForm({ onNavigate }: { onNavigate: (pfad: string) => void }) {
  const [serverFehler, setServerFehler] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(LoginInputSchema),
    defaultValues: { email: '', passwort: '' },
  })

  const mutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: async (data) => {
      setAuth(data)
      // Aktive Kasse sicherstellen: wenn keine oder eine nicht (mehr) zugewiesene
      // Kasse gewählt ist, auf die erste umschalten. Wichtig bei mehreren Kassen —
      // sonst bleibt keine aktive Kasse gesetzt und Seiten crashen.
      const aktuelle = getKasseIdentity()
      const passt = aktuelle && data.kassen.some(k => k.id === aktuelle.kasseId)
      if (!passt && data.kassen[0]) {
        setKasseIdentity({ mandantId: data.mandant.id, kasseId: data.kassen[0].id })
      }
      const kasseId = getKasseIdentity()?.kasseId
      const pfad = kasseId ? await leseStartseitePfad(kasseId) : '/tische'
      onNavigate(pfad)
    },
    onError: (err) => setServerFehler(err instanceof Error ? err.message : 'Login fehlgeschlagen'),
  })

  return (
    <form
      onSubmit={handleSubmit((data) => {
        setServerFehler(null)
        // Auch der E-Mail-Login verlängert das Geräte-Merkmal (gleiches Gerät, gleicher Topf)
        const geraetToken = getGeraetToken()
        mutation.mutate({ ...data, ...(geraetToken ? { geraetToken } : {}) })
      })}
      className="rounded-xl bg-panel shadow-sm border border-line p-6 space-y-4"
      noValidate
    >
      <Field label="E-Mail" htmlFor="email" required error={errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" autoFocus invalid={!!errors.email} {...register('email')} />
      </Field>
      <Field label="Passwort" htmlFor="passwort" required error={errors.passwort?.message}>
        <Input id="passwort" type="password" autoComplete="current-password" invalid={!!errors.passwort} {...register('passwort')} />
      </Field>
      {serverFehler && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{serverFehler}</div>
      )}
      <div className="pt-2 border-t border-line">
        <Button type="submit" loading={mutation.isPending} className="w-full">Einloggen</Button>
      </div>
      <p className="text-center text-xs text-ink-muted pt-1">
        Noch keine Kasse?{' '}
        <button type="button" onClick={() => window.location.href = '/setup'} className="text-brand-600 hover:underline">
          Kasse einrichten
        </button>
      </p>
    </form>
  )
}
