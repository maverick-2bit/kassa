import type { ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import type { SetupInput } from '@kassa/shared'
import { postSetup, setupApi, systemApi } from '../lib/api'
import { getToken } from '../lib/auth'
import { setKasseIdentity } from '../lib/kasse'
import { SetupForm } from '../components/SetupForm'
import { SetupProgress } from '../components/SetupProgress'
import { SetupSuccess } from '../components/SetupSuccess'

/**
 * Einrichtungsseite. Zwei Fälle, die der Server unterscheidet:
 *
 *  - Frische Installation (noch kein Benutzer): jeder darf einrichten — Ersteinrichtung. Der dabei
 *    angelegte Admin ist der Betreiber der Installation.
 *  - Eingerichtete Installation: nur der angemeldete Betreiber legt hier weitere Mandanten an
 *    (Einstellungen → System → „Weiteren Mandanten anlegen"). Alle anderen sehen den Hinweis.
 *    Die Antwort des Servers entscheidet; die Seite zeigt das nur vorher an, damit niemand ein langes
 *    Formular ausfüllt, das der Server abweist.
 */
export function SetupPage() {
  const navigate = useNavigate()

  const status       = useQuery({ queryKey: ['setup-status'], queryFn: setupApi.status, retry: false })
  const eingerichtet = status.data?.eingerichtet === true
  const angemeldet   = getToken() !== null

  // Eingerichtet: ist der angemeldete Benutzer der Betreiber? (frisch beim Server fragen — nicht der
  // gespeicherten Anmeldung glauben, die noch aus der Zeit vor dem Betreiber-Konzept stammen kann)
  const betreiberQuery = useQuery({
    queryKey: ['system-status'],
    queryFn:  () => systemApi.status(),
    retry:    false,
    enabled:  eingerichtet && angemeldet,
  })
  const istBetreiber = betreiberQuery.data?.istBetreiber === true

  const mutation = useMutation({
    mutationFn: postSetup,
    onSuccess: (data) => {
      // Die Kassa-Identität dieses Geräts gehört zur ERSTEN Einrichtung. Legt der Betreiber einen weiteren
      // Mandanten an, bleibt das Gerät bei seinem — sonst meldete es sich plötzlich am neuen an.
      if (!eingerichtet && data.erfolgreich && data.mandantId && data.kasseId) {
        setKasseIdentity({ mandantId: data.mandantId, kasseId: data.kasseId })
      }
    },
  })

  const isSuccess = mutation.isSuccess && mutation.data.erfolgreich
  const fehler    = mutation.isError
    ? (mutation.error instanceof Error ? mutation.error.message : 'Netzwerkfehler')
    : (mutation.data && !mutation.data.erfolgreich ? mutation.data.fehler : undefined)

  const handleSubmit = (input: SetupInput): void => {
    mutation.mutate(input)
  }

  let inhalt: ReactNode
  if (isSuccess && mutation.data) {
    inhalt = (
      <div className="space-y-6">
        <SetupSuccess data={mutation.data} />
        <div className="flex flex-wrap justify-center gap-3 pt-2">
          {eingerichtet ? (
            <>
              <button
                onClick={() => navigate('/login?konto=neu')}
                className="inline-flex items-center gap-2 rounded-md bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-600"
              >
                Am neuen Mandanten anmelden →
              </button>
              <button
                onClick={() => navigate('/einstellungen?bereich=system')}
                className="inline-flex items-center gap-2 rounded-md border border-line px-4 py-2.5 text-sm font-semibold text-ink hover:bg-panel-2"
              >
                Zurück zu den Einstellungen
              </button>
            </>
          ) : (
            <button
              onClick={() => navigate('/kasse')}
              className="inline-flex items-center gap-2 rounded-md bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-600"
            >
              Zur Kasse →
            </button>
          )}
        </div>
      </div>
    )
  } else if (mutation.isPending) {
    inhalt = (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-ink">Kasse wird eingerichtet…</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Bitte warten — die Anmeldung bei FinanzOnline kann einige Sekunden dauern.
          </p>
        </div>
        <SetupProgress schritte={[]} pending />
      </div>
    )
  } else if (status.isLoading || (eingerichtet && angemeldet && betreiberQuery.isLoading)) {
    inhalt = <p className="text-sm text-ink-muted" data-testid="setup-pruefe">Einen Moment — Einrichtungsstand wird geprüft…</p>
  } else if (eingerichtet && (!angemeldet || betreiberQuery.isError)) {
    inhalt = (
      <Hinweis titel="Diese Kassa ist bereits eingerichtet">
        <p>
          Weitere Mandanten legt der <strong>Betreiber</strong> an: zuerst anmelden, dann unter
          <strong> Einstellungen → System → Weiteren Mandanten anlegen</strong>.
        </p>
        <Link
          to="/login"
          className="mt-3 inline-flex items-center rounded-md bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
        >
          Zur Anmeldung
        </Link>
      </Hinweis>
    )
  } else if (eingerichtet && !istBetreiber) {
    inhalt = (
      <Hinweis titel="Nur der Betreiber legt weitere Mandanten an">
        <p>
          Du bist angemeldet, aber nicht als Betreiber dieser Kassa. Wende dich an den Betreiber, wenn ein
          weiterer Betrieb eingerichtet werden soll.
        </p>
        <Link
          to="/dashboard"
          className="mt-3 inline-flex items-center rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-panel-2"
        >
          Zurück
        </Link>
      </Hinweis>
    )
  } else {
    inhalt = (
      <>
        {mutation.data?.schritte && mutation.data.schritte.length > 0 && (
          <div className="mb-6 rounded-md border border-line bg-panel-2 p-4">
            <h3 className="text-sm font-semibold text-ink mb-3">
              Vorheriger Versuch
            </h3>
            <SetupProgress schritte={mutation.data.schritte} />
          </div>
        )}
        <SetupForm
          onSubmit={handleSubmit}
          loading={mutation.isPending}
          error={fehler}
        />
      </>
    )
  }

  return (
    <div className="min-h-screen px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-2xl">
        <Header eingerichtet={eingerichtet} angemeldet={angemeldet} />

        <main className="rounded-xl bg-panel shadow-sm border border-line p-6 sm:p-8">
          {inhalt}
        </main>

        <Footer />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Layout-Bausteine
// ---------------------------------------------------------------------------

function Hinweis({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <div className="text-sm text-ink-muted" data-testid="setup-gesperrt">
      <h2 className="text-lg font-semibold text-ink mb-2">{titel}</h2>
      {children}
    </div>
  )
}

function Header({ eingerichtet, angemeldet }: { eingerichtet: boolean; angemeldet: boolean }) {
  // Angemeldet auf einer eingerichteten Installation = ein weiterer Mandant (Betreiber); ohne Anmeldung gibt es dort nur den Hinweis
  const weiterer = eingerichtet && angemeldet
  return (
    <header className="mb-8 text-center">
      <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-brand-500 text-white mb-3">
        <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v4H3zM3 11h18v10H3zM7 15h2M7 18h2"/>
        </svg>
      </div>
      <h1 className="text-3xl font-bold tracking-tight text-ink">
        {weiterer ? 'Weiteren Mandanten anlegen' : 'Kasse einrichten'}
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        Einmalige Anmeldung bei FinanzOnline gemäß RKSV
      </p>
      {(weiterer || !eingerichtet) && (
        <p className="mt-3 text-sm text-ink-muted">
          {weiterer ? 'Doch nicht?' : 'Kasse bereits eingerichtet?'}{' '}
          <Link to={weiterer ? '/einstellungen?bereich=system' : '/login'} className="font-medium text-brand-600 hover:underline">
            {weiterer ? 'Zurück zu den Einstellungen' : 'Zur Anmeldung'}
          </Link>
        </p>
      )}
    </header>
  )
}

function Footer() {
  return (
    <footer className="mt-8 text-center text-xs text-ink-subtle">
      RKSV-konform · ECDSA P-256 · DEP7-Archivierung
    </footer>
  )
}
