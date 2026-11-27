/**
 * Signaturwahl bei der Einrichtung: Womit signiert die Kasse ihre RKSV-Belege? Die Kasse wird komplett auf
 * die gewählte Variante gestellt — schon der Startbeleg wird damit signiert.
 */

import { useState } from 'react'
import { KartePinSchema, type SeeTestErgebnis, type SignaturWahl } from '@kassa/shared'
import { Field } from './ui/Field'
import { Input } from './ui/Input'
import { Button } from './ui/Button'

export type SignaturArt = SignaturWahl['art']

export interface SignaturEingabe {
  art:            SignaturArt | null
  kartePin:       string
  atrustBasisUrl: string
  atrustBenutzer: string
  atrustPasswort: string
}

export const LEERE_SIGNATUR: SignaturEingabe = {
  art: null, kartePin: '', atrustBasisUrl: 'https://hs.a-trust.at/RegistrierkasseMobile/v2', atrustBenutzer: '', atrustPasswort: '',
}

/** Eingabe → Wahl für den Server, oder Fehlermeldung */
export function baueSignaturWahl(e: SignaturEingabe): { wahl: SignaturWahl } | { fehler: string } {
  if (e.art === null) return { fehler: 'Bitte wählen, womit die Kasse signiert.' }
  if (e.art === 'software') return { wahl: { art: 'software' } }
  if (e.art === 'atrust_chip') {
    const pin = KartePinSchema.safeParse(e.kartePin)
    return pin.success ? { wahl: { art: 'atrust_chip', kartePin: pin.data } } : { fehler: pin.error.issues[0]?.message ?? 'PIN ungültig' }
  }
  if (!e.atrustBasisUrl.trim() || !e.atrustBenutzer.trim() || !e.atrustPasswort) {
    return { fehler: 'Für A-Trust online bitte Adresse, Benutzer und Passwort angeben.' }
  }
  return { wahl: { art: 'atrust_hsm', atrustBasisUrl: e.atrustBasisUrl.trim(), atrustBenutzer: e.atrustBenutzer.trim(), atrustPasswort: e.atrustPasswort } }
}

const OPTIONEN: { art: SignaturArt; titel: string; text: string }[] = [
  { art: 'atrust_chip', titel: 'Signaturkarte im Stick (lokal)',
    text: 'A-Trust a.sign RK CHIP im USB-Stick/Kartenleser am Kassen-PC. Signiert ohne Internet — für Kleininstallationen mit einer oder zwei Kassen.' },
  { art: 'atrust_hsm', titel: 'A-Trust online',
    text: 'a.sign RK HSM bei A-Trust. Jede Signatur geht übers Internet; fällt es aus, läuft die Kasse im Ausfallmodus weiter.' },
  { art: 'software', titel: 'Test / Demo',
    text: 'Ohne Signatureinheit — nur zum Ausprobieren. FinanzOnline nimmt diese Kasse nicht an.' },
]

interface Props {
  wert:      SignaturEingabe
  onChange:  (e: SignaturEingabe) => void
  /** UID aus dem Formular — die Karte muss auf sie lauten */
  uid:       string
  fehler?:   string | undefined
  /** „Karte prüfen" (ohne PIN) — z. B. setupApi.signaturkarte */
  karteLesen: (uid: string) => Promise<SeeTestErgebnis>
}

export function SignaturWahlAuswahl({ wert, onChange, uid, fehler, karteLesen }: Props) {
  const [pruefung, setPruefung] = useState<{ ok: boolean; text: string } | null>(null)
  const [prueft, setPrueft] = useState(false)
  const setze = (teil: Partial<SignaturEingabe>) => onChange({ ...wert, ...teil })

  const karteKontrollieren = async () => {
    setPrueft(true); setPruefung(null)
    try {
      const r = await karteLesen(uid.trim())
      setPruefung(r.erfolgreich
        ? { ok: true, text: `Karte erkannt — ${r.karte ?? 'Signaturkarte'}, Zertifikat ${r.zertifikatSn ?? '?'}${r.hinweis ? ` — ${r.hinweis}` : ''}` }
        : { ok: false, text: r.fehler ?? 'Keine Signaturkarte erkannt' })
    } catch (e) {
      setPruefung({ ok: false, text: e instanceof Error ? e.message : 'Prüfung fehlgeschlagen' })
    } finally { setPrueft(false) }
  }

  return (
    <div className="space-y-4" data-testid="signatur-wahl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Signatur">
        {OPTIONEN.map(o => (
          <button
            key={o.art} type="button" role="radio" aria-checked={wert.art === o.art}
            onClick={() => { setze({ art: o.art }); setPruefung(null) }}
            className={`text-left rounded-lg border p-3 transition ${
              wert.art === o.art ? 'border-brand-500 ring-1 ring-brand-500 bg-brand-50/50' : 'border-line-strong hover:border-line-strong'
            }`}
          >
            <span className="block text-sm font-medium text-ink">{o.titel}</span>
            <span className="mt-1 block text-xs text-ink-muted">{o.text}</span>
          </button>
        ))}
      </div>

      {wert.art === 'atrust_chip' && (
        <div className="space-y-3 rounded-lg border border-line p-4">
          <p className="text-sm text-ink-muted">
            Stick bzw. Kartenleser mit der Karte jetzt am Kassen-PC anstecken. Die Kassa prüft Karte und PIN, bevor
            sie FinanzOnline meldet, und signiert schon den Startbeleg mit der Karte.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Karten-PIN" htmlFor="karte-pin" hint="Aus dem PIN-Brief von A-Trust">
              <Input
                id="karte-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={12}
                value={wert.kartePin} onChange={e => setze({ kartePin: e.target.value.replace(/\D/g, '') })}
                data-testid="setup-karte-pin"
              />
            </Field>
            <Button type="button" variant="secondary" onClick={() => { void karteKontrollieren() }} loading={prueft}>
              Karte prüfen (ohne PIN)
            </Button>
          </div>
          {pruefung && (
            <p className={`text-sm ${pruefung.ok ? 'text-green-700' : 'text-red-600'}`} role="status">{pruefung.text}</p>
          )}
          <p className="text-xs text-amber-700">
            ⚠️ Die PIN wird beim Einrichten einmal mit einer Probesignatur geprüft. Eine falsche PIN zählt als
            Fehlversuch der Karte — nach wenigen Fehlversuchen ist sie für immer gesperrt.
          </p>
        </div>
      )}

      {wert.art === 'atrust_hsm' && (
        <div className="grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-3">
          <Field label="Basis-URL" htmlFor="atrust-url">
            <Input id="atrust-url" value={wert.atrustBasisUrl} onChange={e => setze({ atrustBasisUrl: e.target.value })} />
          </Field>
          <Field label="A-Trust-Benutzer" htmlFor="atrust-benutzer">
            <Input id="atrust-benutzer" placeholder="u123456789" value={wert.atrustBenutzer} onChange={e => setze({ atrustBenutzer: e.target.value })} />
          </Field>
          <Field label="Passwort" htmlFor="atrust-passwort">
            <Input id="atrust-passwort" type="password" autoComplete="off" value={wert.atrustPasswort} onChange={e => setze({ atrustPasswort: e.target.value })} />
          </Field>
        </div>
      )}

      {fehler && <p className="text-sm text-red-600" role="alert">{fehler}</p>}
    </div>
  )
}
