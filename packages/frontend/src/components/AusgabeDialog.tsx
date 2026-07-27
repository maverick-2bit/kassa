/**
 * Einheitlicher Ausgabe-Dialog für ALLE Dokumente (Beleg, Rechnung, Lieferschein,
 * Angebot, Gutschein, Inventur, Wareneingang …).
 *
 * Bewusst immer dieselbe Auswahl, damit die Bedienung überall gleich ist:
 *   Bondrucker · A4/PDF · weitere eingerichtete Drucker · E-Mail · ohne Druck weiter
 *
 * Der Dialog ist reine Auswahl — die eigentliche Ausgabe führt der Aufrufer in
 * `onAusgabe` aus (jedes Dokument hat seinen eigenen Endpoint). Wege, die ein
 * Dokument nicht unterstützt, werden über `wege` ausgeblendet.
 *
 * WICHTIG (Ablauf): Dieser Dialog darf NIE automatisch aufpoppen, wenn ohnehin
 * der Standarddrucker greift — er wird nur über eine Options-Schaltfläche
 * geöffnet, wenn der Kassier bewusst einen anderen Weg wählen will.
 */

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { druckerPoolApi } from '../lib/api'

export type AusgabeZiel =
  | { art: 'bon' }
  | { art: 'a4' }
  | { art: 'drucker'; druckerId: string; name: string }
  | { art: 'mail'; empfaenger: string }
  | { art: 'keine' }

export interface AusgabeWege {
  bon?:            boolean
  a4?:             boolean
  weitereDrucker?: boolean
  mail?:           boolean
  ohne?:           boolean
}

interface Props {
  open:           boolean
  onClose:        () => void
  titel?:         string
  /** Kurze Beschreibung dessen, was ausgegeben wird (z. B. „Rechnung 2026-014"). */
  beschreibung?:  string
  wege?:          AusgabeWege
  mailVorschlag?: string
  /** Führt die gewählte Ausgabe aus. Fehler werden im Dialog angezeigt. */
  onAusgabe:      (ziel: AusgabeZiel) => Promise<unknown> | unknown
}

const ALLE_WEGE: Required<AusgabeWege> = {
  bon: true, a4: true, weitereDrucker: true, mail: true, ohne: true,
}

export function AusgabeDialog({
  open, onClose, titel = 'Ausgabe wählen', beschreibung, wege, mailVorschlag, onAusgabe,
}: Props) {
  const w = { ...ALLE_WEGE, ...wege }
  const [laeuft,       setLaeuft]       = useState<string | null>(null)
  const [fehler,       setFehler]       = useState<string | null>(null)
  const [mailOffen,    setMailOffen]    = useState(false)
  const [mailAdresse,  setMailAdresse]  = useState('')

  useEffect(() => {
    if (open) { setFehler(null); setMailOffen(false); setMailAdresse(mailVorschlag ?? '') }
  }, [open, mailVorschlag])

  // Drucker-Bibliothek nur laden, wenn der Weg überhaupt angeboten wird.
  // Kurze staleTime: neu angelegte Drucker sollen beim nächsten Öffnen da sein.
  const drucker = useQuery({
    queryKey: ['drucker-pool'],
    queryFn:  () => druckerPoolApi.list(),
    enabled:  open && w.weitereDrucker,
    staleTime: 30_000,
  })
  const weitere = (drucker.data ?? []).filter(d => d.aktiv)

  const fuehreAus = async (ziel: AusgabeZiel, key: string) => {
    setLaeuft(key)
    setFehler(null)
    try {
      await onAusgabe(ziel)
      onClose()
    } catch (err) {
      setFehler(err instanceof Error ? err.message : String(err))
    } finally {
      setLaeuft(null)
    }
  }

  const Kachel = ({ k, icon, label, hinweis, onClick }: {
    k: string; icon: string; label: string; hinweis?: string; onClick: () => void
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={laeuft !== null}
      className="flex flex-col items-center justify-center gap-1 rounded-lg border border-line bg-panel-2 px-3 py-4 text-center transition hover:border-brand-400 hover:bg-brand-50 disabled:opacity-50"
    >
      <span className="text-2xl leading-none">{laeuft === k ? '⏳' : icon}</span>
      <span className="text-sm font-medium text-ink">{label}</span>
      {hinweis && <span className="text-[11px] text-ink-subtle">{hinweis}</span>}
    </button>
  )

  return (
    <Modal open={open} onClose={onClose} title={titel} size="md">
      <div className="space-y-4">
        {beschreibung && <p className="text-sm text-ink-muted">{beschreibung}</p>}

        {fehler && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{fehler}</div>
        )}

        {!mailOffen ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {w.bon && (
                <Kachel k="bon" icon="🖨" label="Bondrucker" hinweis="Standard"
                  onClick={() => void fuehreAus({ art: 'bon' }, 'bon')} />
              )}
              {w.a4 && (
                <Kachel k="a4" icon="📄" label="A4 / PDF" hinweis="Druckfenster"
                  onClick={() => void fuehreAus({ art: 'a4' }, 'a4')} />
              )}
              {w.mail && (
                <Kachel k="mail" icon="✉" label="E-Mail"
                  onClick={() => { setFehler(null); setMailOffen(true) }} />
              )}
              {w.weitereDrucker && weitere.map(d => (
                <Kachel key={d.id} k={`d-${d.id}`} icon="🖨" label={d.name} hinweis={`${d.ip}`}
                  onClick={() => void fuehreAus({ art: 'drucker', druckerId: d.id, name: d.name }, `d-${d.id}`)} />
              ))}
            </div>

            {w.weitereDrucker && drucker.isLoading && (
              <p className="text-xs text-ink-subtle">Drucker werden geladen …</p>
            )}

            {w.ohne && (
              <div className="border-t border-line pt-3">
                <Button variant="secondary" onClick={() => void fuehreAus({ art: 'keine' }, 'keine')}
                  disabled={laeuft !== null} className="w-full">
                  Ohne Druck fortfahren
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm font-medium text-ink">
              E-Mail-Adresse
              <input
                type="email"
                autoFocus
                value={mailAdresse}
                onChange={e => setMailAdresse(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && mailAdresse.trim()) {
                    void fuehreAus({ art: 'mail', empfaenger: mailAdresse.trim() }, 'mail')
                  }
                }}
                placeholder="gast@example.at"
                className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm"
              />
            </label>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setMailOffen(false)} className="flex-1">
                Zurück
              </Button>
              <Button
                onClick={() => void fuehreAus({ art: 'mail', empfaenger: mailAdresse.trim() }, 'mail')}
                loading={laeuft === 'mail'}
                disabled={!mailAdresse.trim()}
                className="flex-1"
              >
                Senden
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
