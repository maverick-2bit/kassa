/**
 * Einstellung „Geschäftstag" (nur Admin): Tagesbeginn des Betriebs, gültig ab
 * einem Stichtag.
 *
 * Wer über Mitternacht hinaus geöffnet hat, verschiebt den Tagesbeginn (z. B.
 * auf 06:00): Ein Geschäftstag läuft dann von 06:00 bis 06:00 des Folgetages,
 * und eine Schicht von 18:00 bis 02:00 liegt auf EINEM Tag. Eine Änderung gilt
 * erst ab dem Stichtag — vergangene Tage und alte Tagesabschlüsse bleiben, der
 * Übergangstag wird länger oder kürzer. Die Vorschau zeigt genau das.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  STANDARD_TAGESBEGINN,
  addTage,
  beginnFuer,
  dauerStunden,
  geschaeftstagText,
  istKalenderDatum,
  istTagesbeginn,
  normalisiereRegel,
  tagesGrenzen,
  uebergangsVorschau,
  wienerZeit,
  type TagesbeginnStand,
} from '@kassa/shared'
import { mandantApi } from '../lib/api'
import { getAuth, updateMandantTagesRegel } from '../lib/auth'
import { datumKurz, tagMonat } from '../lib/geschaeftstag'
import { Button } from './ui/Button'
import { Field } from './ui/Field'
import { Input } from './ui/Input'

/** 'TT.MM. HH:MM' (Wiener Zeit) eines Zeitpunkts */
function tagUhrzeit(z: Date): string {
  const w = wienerZeit(z)
  return `${tagMonat(w.datum)} ${w.hm}`
}

/** 30 → '30', 30,5 → '30,5' */
function stunden(n: number): string {
  return String(Math.round(n * 10) / 10).replace('.', ',')
}

export function GeschaeftstagEinstellung() {
  const queryClient = useQueryClient()
  const istAdmin    = getAuth()?.user.rolle === 'admin'

  const standQuery = useQuery({
    queryKey: ['mandant-tagesbeginn'],
    queryFn:  mandantApi.getTagesbeginn,
    enabled:  istAdmin,
  })

  const [beginn, setBeginn]       = useState('06:00')
  const [gueltigAb, setGueltigAb] = useState('')   // leer = morgen (Vorgabe, sobald der Stand da ist)
  const [erfolg, setErfolg]       = useState<string | null>(null)

  const nachAenderung = (neu: TagesbeginnStand) => {
    queryClient.setQueryData(['mandant-tagesbeginn'], neu)
    // Das Frontend rechnet „heute" mit derselben Historie — sofort, ohne neue Anmeldung
    updateMandantTagesRegel(neu.eintraege)
  }

  const anlegen = useMutation({
    mutationFn: (eingabe: { gueltigAb: string; beginn: string }) => mandantApi.postTagesbeginn(eingabe),
    onSuccess:  (neu, eingabe) => {
      nachAenderung(neu)
      setGueltigAb('')   // Formular zurück auf die Vorgabe (morgen)
      setErfolg(`Gespeichert: Ab dem ${datumKurz(eingabe.gueltigAb)} beginnt der Tag um ${eingabe.beginn} Uhr.`)
    },
    onMutate: () => setErfolg(null),
  })

  const zuruecknehmen = useMutation({
    mutationFn: (id: string) => mandantApi.deleteTagesbeginn(id),
    onSuccess:  (neu) => { nachAenderung(neu); setErfolg('Der geplante Wechsel wurde zurückgenommen.') },
    onMutate:   () => setErfolg(null),
  })

  if (!istAdmin) return null

  const stand = standQuery.data

  return (
    <section data-testid="geschaeftstag-abschnitt" className="space-y-4">
      <header>
        <h2 className="text-lg font-bold text-ink">Geschäftstag</h2>
        <p className="mt-1 text-sm text-ink-muted leading-relaxed">
          Normalerweise beginnt der Tag um 00:00. Wer über Mitternacht hinaus geöffnet hat, kann den Tagesbeginn
          verschieben — etwa auf 06:00: Der Tag läuft dann von 06:00 bis 06:00 des Folgetages, und eine Schicht
          von 18:00 bis 02:00 liegt auf einem Tag. Das gilt für Tagesabschluss, Berichte, Zeiterfassung, Kassenbuch
          und die Buchhaltungs-Exporte. Monats- und Jahresbeleg der RKSV bleiben Kalendermonat bzw. Kalenderjahr,
          und jeder Beleg behält seinen genauen Zeitstempel.
        </p>
      </header>

      {standQuery.isLoading && (
        <div className="rounded-lg border border-line bg-panel p-6 text-center text-sm text-ink-subtle">Wird geladen…</div>
      )}
      {standQuery.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Fehler beim Laden des Tagesbeginns.
        </div>
      )}

      {stand && <Inhalt
        stand={stand}
        beginn={beginn} onBeginn={setBeginn}
        gueltigAb={gueltigAb} onGueltigAb={setGueltigAb}
        speichert={anlegen.isPending}
        zuruecknehmenLaeuft={zuruecknehmen.isPending}
        onSpeichern={(datum) => anlegen.mutate({ gueltigAb: datum, beginn })}
        onZuruecknehmen={(id) => zuruecknehmen.mutate(id)}
      />}

      {erfolg && (
        <div role="status" data-testid="geschaeftstag-erfolg" className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          {erfolg}
        </div>
      )}
      {(anlegen.isError || zuruecknehmen.isError) && (
        <div role="alert" data-testid="geschaeftstag-fehler" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {(anlegen.error ?? zuruecknehmen.error) instanceof Error
            ? (anlegen.error ?? zuruecknehmen.error)!.message
            : 'Fehler beim Speichern'}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------

function Inhalt({
  stand, beginn, onBeginn, gueltigAb, onGueltigAb, speichert, zuruecknehmenLaeuft, onSpeichern, onZuruecknehmen,
}: {
  stand:               TagesbeginnStand
  beginn:              string
  onBeginn:            (v: string) => void
  gueltigAb:           string
  onGueltigAb:         (v: string) => void
  speichert:           boolean
  zuruecknehmenLaeuft: boolean
  onSpeichern:         (datum: string) => void
  onZuruecknehmen:     (id: string) => void
}) {
  const regel       = normalisiereRegel(stand.eintraege)
  const kalendertag = stand.heute.kalendertag
  const morgen      = addTage(kalendertag, 1)
  const datum       = gueltigAb || morgen

  // Der heute gültige Eintrag: größter Stichtag <= heute
  const geltend = [...regel].reverse().find(e => e.gueltigAb <= kalendertag)
  const verschoben = stand.heute.beginn !== STANDARD_TAGESBEGINN

  // Vorschau der Eingabe
  const eingabeOk       = istTagesbeginn(beginn) && istKalenderDatum(datum)
  const ohneGleichen    = regel.filter(e => e.gueltigAb !== datum)
  const bisher          = eingabeOk ? beginnFuer(ohneGleichen, datum) : null
  const keineAenderung  = eingabeOk && bisher === beginn
  const vorschau        = eingabeOk && !keineAenderung ? uebergangsVorschau(ohneGleichen, { gueltigAb: datum, beginn }) : null
  const dauerBisher     = vorschau ? dauerStunden(tagesGrenzen(ohneGleichen, vorschau.datum)) : null
  const aendertSich     = vorschau && dauerBisher !== null && Math.abs(vorschau.dauerStunden - dauerBisher) > 0.001
  const laenger         = vorschau && dauerBisher !== null && vorschau.dauerStunden > dauerBisher

  return (
    <div className="space-y-4">
      {/* Aktueller Stand */}
      <div data-testid="geschaeftstag-aktuell" className="rounded-lg border border-line bg-panel p-5">
        <p className="text-sm text-ink-muted">Aktueller Tagesbeginn</p>
        <p className="mt-0.5 text-2xl font-bold text-ink font-mono">{stand.heute.beginn} Uhr</p>
        <p className="mt-2 text-sm text-ink-muted">
          Heute ist Geschäftstag <span className="font-semibold text-ink">{datumKurz(stand.heute.geschaeftstag)}</span>
          {verschoben
            ? <> ({geschaeftstagText(stand.heute.von, stand.heute.bis).replace(/^Geschäftstag /, '')})</>
            : <> (Mitternacht bis Mitternacht)</>}
          {stand.heute.geschaeftstag !== kalendertag && (
            <> — der Kalendertag ist schon der {datumKurz(kalendertag)}, aber der Geschäftstag läuft noch.</>
          )}
        </p>
      </div>

      {/* Historie */}
      {regel.length > 0 && (
        <div className="rounded-lg border border-line bg-panel overflow-hidden">
          <div className="px-4 py-3 bg-panel-2 border-b border-line">
            <h3 className="text-sm font-semibold text-ink">Wechsel des Tagesbeginns</h3>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-2 font-semibold">Gilt ab</th>
                <th className="px-4 py-2 font-semibold">Tagesbeginn</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...stand.eintraege].reverse().map(e => {
                const geplant = e.gueltigAb > kalendertag
                const aktuell = geltend?.gueltigAb === e.gueltigAb
                return (
                  <tr key={e.id} data-testid={`geschaeftstag-eintrag-${e.gueltigAb}`}>
                    <td className="px-4 py-2 text-ink">{datumKurz(e.gueltigAb)}</td>
                    <td className="px-4 py-2 font-mono text-ink">{e.beginn} Uhr</td>
                    <td className="px-4 py-2">
                      {geplant
                        ? <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">geplant</span>
                        : aktuell
                          ? <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">gilt jetzt</span>
                          : <span className="text-xs text-ink-subtle">früher</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {geplant && (
                        <button
                          type="button"
                          data-testid={`geschaeftstag-zurueck-${e.gueltigAb}`}
                          disabled={zuruecknehmenLaeuft}
                          onClick={() => { if (confirm(`Den geplanten Wechsel auf ${e.beginn} Uhr ab ${datumKurz(e.gueltigAb)} zurücknehmen?`)) onZuruecknehmen(e.id) }}
                          className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                        >
                          Zurücknehmen
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Neuer Tagesbeginn */}
      <form
        className="rounded-lg border border-line bg-panel p-5 space-y-4"
        onSubmit={(ev) => { ev.preventDefault(); if (eingabeOk && !keineAenderung) onSpeichern(datum) }}
      >
        <h3 className="text-sm font-semibold text-ink">Neuer Tagesbeginn</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Field label="Tagesbeginn (Uhrzeit)" htmlFor="geschaeftstag-beginn" hint="z. B. 06:00 — der Tag läuft bis zur gleichen Uhrzeit des Folgetages.">
            <Input
              id="geschaeftstag-beginn" data-testid="geschaeftstag-beginn" type="time" required
              value={beginn} onChange={(e) => onBeginn(e.target.value)}
              invalid={beginn !== '' && !istTagesbeginn(beginn)}
            />
          </Field>
          <Field label="Gilt ab (Datum)" htmlFor="geschaeftstag-ab" hint={`Frühestens ab morgen (${datumKurz(morgen)}). Ab heute nur, solange noch keine Belege oder Arbeitszeiten vorliegen.`}>
            <Input
              id="geschaeftstag-ab" data-testid="geschaeftstag-ab" type="date" required
              value={datum} onChange={(e) => onGueltigAb(e.target.value)}
              invalid={datum !== '' && !istKalenderDatum(datum)}
            />
          </Field>
        </div>

        {/* Vorschau des Übergangstags */}
        {eingabeOk && (
          <div data-testid="geschaeftstag-vorschau" className="rounded-md border border-line bg-panel-2 px-4 py-3 text-sm text-ink leading-relaxed">
            {keineAenderung ? (
              <>Keine Änderung: Ab dem {datumKurz(datum)} beginnt der Tag bereits um {beginn} Uhr.</>
            ) : vorschau ? (
              <>
                Ab dem <strong>{datumKurz(datum)}</strong> beginnt der Tag um <strong>{beginn} Uhr</strong>.
                {' '}
                {aendertSich ? (
                  <>
                    Der Übergangstag <strong>{tagMonat(vorschau.datum)}</strong> wird dadurch {laenger ? 'länger' : 'kürzer'}:
                    {' '}er dauert dann von {tagUhrzeit(vorschau.von)} bis {tagUhrzeit(vorschau.bis)}
                    {' '}({stunden(vorschau.dauerStunden)} Stunden statt {stunden(dauerBisher!)}).
                  </>
                ) : (
                  <>Der Tag davor ({tagMonat(vorschau.datum)}) dauert wie gewohnt {stunden(vorschau.dauerStunden)} Stunden.</>
                )}
                {' '}Frühere Tage und bereits erstellte Tagesabschlüsse bleiben unverändert.
              </>
            ) : null}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" data-testid="geschaeftstag-speichern" loading={speichert} disabled={!eingabeOk || keineAenderung}>
            Tagesbeginn speichern
          </Button>
        </div>
      </form>
    </div>
  )
}
