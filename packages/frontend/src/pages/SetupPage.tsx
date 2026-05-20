import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { SetupInput } from '@kassa/shared'
import { postSetup } from '../lib/api'
import { setKasseIdentity } from '../lib/kasse'
import { SetupForm } from '../components/SetupForm'
import { SetupProgress } from '../components/SetupProgress'
import { SetupSuccess } from '../components/SetupSuccess'

export function SetupPage() {
  const navigate = useNavigate()
  const mutation = useMutation({
    mutationFn: postSetup,
    onSuccess: (data) => {
      if (data.erfolgreich && data.mandantId && data.kasseId) {
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

  return (
    <div className="min-h-screen px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-2xl">
        <Header />

        <main className="rounded-xl bg-white shadow-sm border border-gray-200 p-6 sm:p-8">
          {isSuccess && mutation.data ? (
            <div className="space-y-6">
              <SetupSuccess data={mutation.data} />
              <div className="flex justify-center pt-2">
                <button
                  onClick={() => navigate('/kasse')}
                  className="inline-flex items-center gap-2 rounded-md bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-600"
                >
                  Zur Kasse →
                </button>
              </div>
            </div>
          ) : mutation.isPending ? (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Kasse wird eingerichtet…</h2>
                <p className="mt-1 text-sm text-gray-500">
                  Bitte warten — die Anmeldung bei FinanzOnline kann einige Sekunden dauern.
                </p>
              </div>
              <SetupProgress schritte={[]} pending />
            </div>
          ) : (
            <>
              {mutation.data?.schritte && mutation.data.schritte.length > 0 && (
                <div className="mb-6 rounded-md border border-gray-200 bg-gray-50 p-4">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">
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
          )}
        </main>

        <Footer />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Layout-Bausteine
// ---------------------------------------------------------------------------

function Header() {
  return (
    <header className="mb-8 text-center">
      <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-brand-500 text-white mb-3">
        <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h18v4H3zM3 11h18v10H3zM7 15h2M7 18h2"/>
        </svg>
      </div>
      <h1 className="text-3xl font-bold tracking-tight text-gray-900">
        Kasse einrichten
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        Einmalige Anmeldung bei FinanzOnline gemäß RKSV
      </p>
    </header>
  )
}

function Footer() {
  return (
    <footer className="mt-8 text-center text-xs text-gray-400">
      RKSV-konform · ECDSA P-256 · DEP7-Archivierung
    </footer>
  )
}
