/**
 * TischAktionen — Funktionen für einen offenen Tisch am Kellnerhandy (wie am PC):
 * Tisch umbuchen, Positionen aufteilen/verschieben, Tische zusammenführen, Kellner ändern,
 * Verlauf ansehen und den Tisch verwerfen (stornieren).
 *
 * Bottom-Sheet über der Tisch-Übersicht. Die Fachlogik liegt im Backend (tisch-tab.service);
 * hier nur Bedienung. „Teilen" geschieht durch Verschieben von Positionen auf einen anderen
 * Tisch (wird bei Bedarf neu angelegt) — jeder Tisch wird danach getrennt kassiert.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BonierZielFehler, BonierungInput, TabPosition, TischTabResponse } from '@kassa/shared'
import { bonierFehlschlaege } from '@kassa/shared'
import { ApiError, bonierApi, tischTabApi } from '../lib/api'
import { getAuth } from '../lib/auth'
import { formatPreis } from '../lib/format'

type Ansicht = 'menu' | 'umbuchen' | 'kellner' | 'verschieben' | 'zusammenfuehren' | 'verwerfen' | 'verlauf' | 'korrekturbon'

interface Props {
  tab:            TischTabResponse
  onClose:        () => void
  /** Daten am Tisch haben sich geändert (neu laden) */
  onGeaendert:    () => void
  /** Zurück zur Tisch-Liste (nach Verwerfen, Positionen komplett verschoben …) */
  onZurUebersicht: () => void
}

const EREIGNIS_LABEL: Record<string, string> = {
  geoeffnet:               'Tisch geöffnet',
  bonierung:               'Bon gesendet',
  positionen_aktualisiert: 'Positionen geändert',
  storno:                  'Storno',
  tisch_gewechselt:        'Tisch umgebucht',
  kellner_umbenannt:       'Kellner geändert',
  bezahlt:                 'Bezahlt',
  gesplittet:              'Getrennt bezahlt',
  zusammengefuehrt:        'Tische zusammengeführt',
  positionen_verschoben:   'Positionen verschoben',
  gang_gefeuert:           'Gang abgerufen',
  gang_nachgeschickt:      'Position nachgeschickt',
}

/** Gleicher Schlüssel wie im Backend (positionKey): Artikel + gewählte Optionen. */
function positionKey(p: TabPosition): string {
  const modIds = (p.modifikatoren ?? []).map(m => m.modifikatorId).sort().join(',')
  return `${p.artikelId}::${modIds}`
}

function fehlerText(err: unknown, standard: string): string {
  return err instanceof Error && err.message ? err.message : standard
}

export function TischAktionen({ tab, onClose, onGeaendert, onZurUebersicht }: Props) {
  const auth = getAuth()
  const [ansicht, setAnsicht] = useState<Ansicht>('menu')
  const [fehler, setFehler]   = useState<string | null>(null)
  const [laeuft, setLaeuft]   = useState(false)

  // Eingaben
  const [tischNr, setTischNr]       = useState(tab.tischNummer)
  const [kellnerName, setKellnerName] = useState(tab.kellner)
  const [zielTisch, setZielTisch]   = useState('')
  const [mengen, setMengen]         = useState<Record<string, number>>({})
  const [quellen, setQuellen]       = useState<string[]>([])
  const [grund, setGrund]           = useState('')
  const [pin, setPin]               = useState('')
  const [pinNoetig, setPinNoetig]   = useState(false)
  const [korrektur, setKorrektur]   = useState<{ ziele: BonierZielFehler[]; nachsenden: BonierungInput } | null>(null)

  // Andere offene Tische dieser Kasse (für Verschieben/Zusammenführen)
  const tabsQuery = useQuery({
    queryKey: ['tisch-tabs', 'aktionen', tab.kasseId],
    queryFn:  () => tischTabApi.list(tab.kasseId),
    enabled:  ansicht === 'verschieben' || ansicht === 'zusammenfuehren',
  })
  const andereTische = (tabsQuery.data ?? []).filter(t => t.id !== tab.id && t.status === 'offen')

  const verlaufQuery = useQuery({
    queryKey: ['tab-verlauf', tab.id],
    queryFn:  () => tischTabApi.getVerlauf(tab.id),
    enabled:  ansicht === 'verlauf',
  })

  /** Eine Aktion ausführen: Fehler anzeigen, sonst Erfolg melden. */
  async function aktion(fn: () => Promise<void>, standardFehler: string) {
    setFehler(null)
    setLaeuft(true)
    try {
      await fn()
    } catch (err) {
      setFehler(fehlerText(err, standardFehler))
    } finally {
      setLaeuft(false)
    }
  }

  const zurueck = () => { setAnsicht('menu'); setFehler(null) }

  // ---- Positionen aufteilen: gruppiert nach Artikel + Optionen ----
  const gruppen = tab.positionen.reduce<{ key: string; pos: TabPosition; menge: number }[]>((acc, p) => {
    const key = positionKey(p)
    const g = acc.find(x => x.key === key)
    if (g) g.menge += p.menge
    else acc.push({ key, pos: p, menge: p.menge })
    return acc
  }, [])
  const gewaehlt = gruppen
    .map(g => ({ g, n: Math.min(mengen[g.key] ?? 0, g.menge) }))
    .filter(x => x.n > 0)
  const gewaehltSummeCent = gewaehlt.reduce((s, x) => s + x.g.pos.preisBruttoCent * x.n, 0)

  async function verschieben() {
    const ziel = zielTisch.trim()
    if (!ziel) { setFehler('Bitte den Ziel-Tisch angeben.'); return }
    if (gewaehlt.length === 0) { setFehler('Bitte mindestens eine Position wählen.'); return }
    await aktion(async () => {
      const res = await tischTabApi.verschiebePositionen(tab.id, {
        zielTischNummer: ziel,
        positionen:      gewaehlt.map(x => ({ ...x.g.pos, menge: x.n })),
      })
      onGeaendert()
      // Wurde alles verschoben, ist dieser Tisch leer — zurück zur Übersicht, der Ziel-Tisch hat die Positionen
      if (res.quelle.positionen.length === 0) onZurUebersicht()
      else onClose()
    }, 'Positionen konnten nicht verschoben werden')
  }

  async function verwerfen() {
    await aktion(async () => {
      try {
        const res = await tischTabApi.verwerfe(tab.id, grund.trim() || undefined, pinNoetig ? pin.trim() || undefined : undefined)
        onGeaendert()
        // Korrekturbon nicht überall angekommen → Kellner muss es erfahren, die Station bereitet sonst weiter zu
        if (res.stornoBon) {
          const nachsenden: BonierungInput = {
            kasseId:    tab.kasseId,
            tabId:      tab.id,
            tisch:      tab.tischNummer,
            kellner:    auth?.user.name ?? tab.kellner,
            positionen: res.stornoBon.positionen,
            ohneLagerabzug: true,
            storno:     true,
            ...(res.stornoBon.bestellId ? { bestellId: res.stornoBon.bestellId } : {}),
          }
          setKorrektur({ ziele: res.stornoBon.fehler, nachsenden })
          setAnsicht('korrekturbon')
          return
        }
        onZurUebersicht()
      } catch (err) {
        // Über der Storno-Schwelle: PIN eines Freigabeberechtigten nötig
        if (err instanceof ApiError && err.code === 'freigabe_erforderlich') {
          setPinNoetig(true)
          throw new Error('Freigabe erforderlich — bitte den PIN eines Freigabeberechtigten eingeben.')
        }
        throw err
      }
    }, 'Tisch konnte nicht verworfen werden')
  }

  async function korrekturNachsenden() {
    if (!korrektur) return
    await aktion(async () => {
      const ergebnis = await bonierApi.bonieren(korrektur.nachsenden)
      const ziele = bonierFehlschlaege(ergebnis)
      if (ziele.length === 0) { onZurUebersicht(); return }
      setKorrektur({ ziele, nachsenden: korrektur.nachsenden })
    }, 'Nachsenden fehlgeschlagen')
  }

  // ---------------------------------------------------------------------------

  const titel: Record<Ansicht, string> = {
    menu:            `Tisch ${tab.tischNummer}`,
    umbuchen:        'Tisch umbuchen',
    kellner:         'Kellner ändern',
    verschieben:     'Positionen aufteilen',
    zusammenfuehren: 'Tische zusammenführen',
    verwerfen:       'Tisch verwerfen',
    verlauf:         'Verlauf',
    korrekturbon:    'Storno-Bon nicht angekommen',
  }

  const eingabeKlasse = 'w-full rounded-xl border border-line-strong bg-surface px-4 py-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-brand-500'
  const hauptKnopf    = 'w-full py-4 rounded-2xl bg-brand-600 text-white font-black text-base active:scale-95 transition disabled:opacity-50'

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/50" onClick={ansicht === 'korrekturbon' ? undefined : onClose}>
      <div
        className="mx-auto w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-t-3xl bg-panel p-4 pb-8 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Kopf */}
        <div className="flex items-center gap-3">
          {ansicht !== 'menu' && ansicht !== 'korrekturbon' && (
            <button onClick={zurueck} className="text-2xl leading-none text-ink-subtle" aria-label="Zurück">‹</button>
          )}
          <h2 className="flex-1 font-black text-lg text-ink truncate">{titel[ansicht]}</h2>
          {ansicht !== 'korrekturbon' && (
            <button onClick={onClose} className="text-2xl leading-none text-ink-subtle" aria-label="Schließen">×</button>
          )}
        </div>

        {fehler && (
          <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{fehler}</p>
        )}

        {/* ---------------- Menü ---------------- */}
        {ansicht === 'menu' && (
          <div className="space-y-2">
            <AktionsKnopf icon="🔀" titel="Tisch umbuchen" hinweis="Tischnummer ändern" onClick={() => { setTischNr(tab.tischNummer); setAnsicht('umbuchen') }} />
            <AktionsKnopf
              icon="✂️" titel="Positionen aufteilen" hinweis="Auf anderen oder neuen Tisch verschieben — danach getrennt kassieren"
              onClick={() => { setMengen({}); setZielTisch(''); setAnsicht('verschieben') }}
              deaktiviert={tab.positionen.length === 0}
            />
            <AktionsKnopf icon="🔗" titel="Tische zusammenführen" hinweis="Andere offene Tische in diesen Tisch holen" onClick={() => { setQuellen([]); setAnsicht('zusammenfuehren') }} />
            <AktionsKnopf icon="👤" titel="Kellner ändern" hinweis={`Aktuell: ${tab.kellner}`} onClick={() => { setKellnerName(tab.kellner); setAnsicht('kellner') }} />
            <AktionsKnopf icon="🕘" titel="Verlauf" hinweis="Was an diesem Tisch passiert ist" onClick={() => setAnsicht('verlauf')} />
            <AktionsKnopf icon="🗑" titel="Tisch verwerfen" hinweis="Alle Positionen stornieren" rot onClick={() => { setGrund(''); setPin(''); setPinNoetig(false); setAnsicht('verwerfen') }} />
          </div>
        )}

        {/* ---------------- Umbuchen ---------------- */}
        {ansicht === 'umbuchen' && (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">Neue Tischnummer oder Bezeichnung für „{tab.tischNummer}“:</p>
            <input value={tischNr} onChange={e => setTischNr(e.target.value)} className={eingabeKlasse} autoFocus placeholder="Tischnummer" />
            <button
              className={hauptKnopf}
              disabled={laeuft || !tischNr.trim() || tischNr.trim() === tab.tischNummer}
              onClick={() => aktion(async () => {
                await tischTabApi.umbucheTisch(tab.id, tischNr.trim())
                onGeaendert(); onClose()
              }, 'Tisch konnte nicht umgebucht werden')}
            >
              {laeuft ? '⏳ …' : 'Umbuchen'}
            </button>
          </div>
        )}

        {/* ---------------- Kellner ---------------- */}
        {ansicht === 'kellner' && (
          <div className="space-y-3">
            <input value={kellnerName} onChange={e => setKellnerName(e.target.value)} className={eingabeKlasse} autoFocus placeholder="Name" />
            {auth && auth.user.name !== kellnerName && (
              <button type="button" onClick={() => setKellnerName(auth.user.name)} className="text-sm font-bold text-brand-600">
                Mir zuweisen ({auth.user.name})
              </button>
            )}
            <button
              className={hauptKnopf}
              disabled={laeuft || !kellnerName.trim() || kellnerName.trim() === tab.kellner}
              onClick={() => aktion(async () => {
                await tischTabApi.umbenenne(tab.id, kellnerName.trim())
                onGeaendert(); onClose()
              }, 'Kellner konnte nicht geändert werden')}
            >
              {laeuft ? '⏳ …' : 'Speichern'}
            </button>
          </div>
        )}

        {/* ---------------- Positionen aufteilen ---------------- */}
        {ansicht === 'verschieben' && (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">Wähle die Positionen, die auf einen anderen Tisch gehen sollen:</p>
            <div className="space-y-2">
              {gruppen.map(g => {
                const n = Math.min(mengen[g.key] ?? 0, g.menge)
                return (
                  <div key={g.key} className={`flex items-center gap-3 rounded-2xl border px-3 py-2 ${n > 0 ? 'border-brand-500 bg-brand-50' : 'border-line bg-surface'}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-ink leading-tight">{g.pos.bezeichnung}</p>
                      <p className="text-xs text-ink-subtle">
                        {g.menge}× · {formatPreis(g.pos.preisBruttoCent)}
                        {(g.pos.modifikatoren?.length ?? 0) > 0 && ` · ${g.pos.modifikatoren!.map(m => m.name).join(', ')}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        className="h-9 w-9 rounded-xl bg-panel-2 text-xl font-black text-ink disabled:opacity-30"
                        disabled={n <= 0}
                        onClick={() => setMengen(m => ({ ...m, [g.key]: n - 1 }))}
                        aria-label="weniger"
                      >−</button>
                      <span className="w-6 text-center font-mono font-black text-ink">{n}</span>
                      <button
                        className="h-9 w-9 rounded-xl bg-panel-2 text-xl font-black text-ink disabled:opacity-30"
                        disabled={n >= g.menge}
                        onClick={() => setMengen(m => ({ ...m, [g.key]: n + 1 }))}
                        aria-label="mehr"
                      >+</button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-bold text-ink">Auf welchen Tisch?</p>
              <input value={zielTisch} onChange={e => setZielTisch(e.target.value)} className={eingabeKlasse} placeholder="Tischnummer (neu oder bestehend)" />
              {andereTische.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {andereTische.map(t => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setZielTisch(t.tischNummer)}
                      className={`rounded-full border px-3 py-1.5 text-sm font-bold ${zielTisch === t.tischNummer ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-surface text-ink-muted'}`}
                    >
                      {t.tischNummer}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-ink-subtle">Gibt es den Tisch noch nicht, wird er neu angelegt.</p>
            </div>

            <button className={hauptKnopf} disabled={laeuft || gewaehlt.length === 0 || !zielTisch.trim()} onClick={() => void verschieben()}>
              {laeuft ? '⏳ …' : gewaehlt.length === 0 ? 'Positionen wählen' : `Verschieben · ${formatPreis(gewaehltSummeCent)}`}
            </button>
          </div>
        )}

        {/* ---------------- Zusammenführen ---------------- */}
        {ansicht === 'zusammenfuehren' && (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              Diese Tische in <strong>{tab.tischNummer}</strong> zusammenführen. Ihre Positionen kommen hierher, die Tische werden geschlossen.
            </p>
            {tabsQuery.isLoading ? (
              <p className="text-sm text-ink-subtle">Lade offene Tische…</p>
            ) : andereTische.length === 0 ? (
              <p className="text-sm text-ink-subtle">Keine anderen offenen Tische.</p>
            ) : (
              <div className="space-y-2">
                {andereTische.map(t => {
                  const an = quellen.includes(t.id)
                  return (
                    <label key={t.id} className={`flex items-center gap-3 rounded-2xl border px-3 py-3 ${an ? 'border-brand-500 bg-brand-50' : 'border-line bg-surface'}`}>
                      <input
                        type="checkbox"
                        checked={an}
                        onChange={() => setQuellen(q => an ? q.filter(x => x !== t.id) : [...q, t.id])}
                        className="h-5 w-5"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-ink">{t.tischNummer}</p>
                        <p className="text-xs text-ink-subtle">{t.kellner}</p>
                      </div>
                      <span className="font-mono text-sm font-semibold text-ink">{formatPreis(t.summeGesamtCent)}</span>
                    </label>
                  )
                })}
              </div>
            )}
            <button
              className={hauptKnopf}
              disabled={laeuft || quellen.length === 0}
              onClick={() => aktion(async () => {
                await tischTabApi.zusammenfuehren(tab.id, quellen)
                onGeaendert(); onClose()
              }, 'Tische konnten nicht zusammengeführt werden')}
            >
              {laeuft ? '⏳ …' : quellen.length === 0 ? 'Tisch wählen' : `${quellen.length} Tisch${quellen.length > 1 ? 'e' : ''} zusammenführen`}
            </button>
          </div>
        )}

        {/* ---------------- Verlauf ---------------- */}
        {ansicht === 'verlauf' && (
          <div className="space-y-2">
            {verlaufQuery.isLoading && <p className="text-sm text-ink-subtle">Lade…</p>}
            {verlaufQuery.isError && <p className="text-sm text-red-600">Verlauf konnte nicht geladen werden.</p>}
            {verlaufQuery.data?.length === 0 && <p className="text-sm text-ink-subtle">Noch keine Einträge.</p>}
            {verlaufQuery.data?.map(e => {
              const ts = new Date(e.createdAt)
              const d  = e.details as Record<string, unknown>
              const zusatz = [d.tischNummer, d.kellner].filter((x): x is string => typeof x === 'string').join(' · ')
              return (
                <div key={e.id} className="rounded-xl border border-line bg-surface px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-bold text-ink">{EREIGNIS_LABEL[e.typ] ?? e.typ}</span>
                    <span className="text-xs text-ink-subtle shrink-0">
                      {ts.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })} · {ts.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' })}
                    </span>
                  </div>
                  {zusatz && <p className="text-xs text-ink-subtle mt-0.5">{zusatz}</p>}
                </div>
              )
            })}
          </div>
        )}

        {/* ---------------- Verwerfen ---------------- */}
        {ansicht === 'verwerfen' && (
          <div className="space-y-3">
            <div className="rounded-2xl border border-red-300 bg-red-50 p-3 space-y-1">
              <p className="text-sm font-bold text-red-800">Tisch {tab.tischNummer} komplett verwerfen?</p>
              <p className="text-xs text-red-700">
                {tab.positionen.length === 0
                  ? 'Der Tisch ist leer und wird geschlossen.'
                  : `Alle ${tab.positionen.reduce((s, p) => s + p.menge, 0)} Positionen (${formatPreis(tab.summeGesamtCent)}) werden storniert. Ein Storno-Bon geht an Küche/Schank. Das lässt sich nicht rückgängig machen.`}
              </p>
            </div>
            <input value={grund} onChange={e => setGrund(e.target.value)} className={eingabeKlasse} placeholder="Grund (optional)" maxLength={200} />
            {pinNoetig && (
              <input
                type="password" inputMode="numeric" autoComplete="off" value={pin}
                onChange={e => setPin(e.target.value)} className={eingabeKlasse}
                placeholder="PIN Freigabe" autoFocus
              />
            )}
            <button
              className="w-full py-4 rounded-2xl bg-red-600 text-white font-black text-base active:scale-95 transition disabled:opacity-50"
              disabled={laeuft || (pinNoetig && pin.trim().length < 4)}
              onClick={() => void verwerfen()}
            >
              {laeuft ? '⏳ …' : '🗑 Tisch verwerfen'}
            </button>
            <button className="w-full py-3 rounded-2xl border border-line-strong text-ink-muted font-bold text-sm" onClick={zurueck}>
              Abbrechen
            </button>
          </div>
        )}

        {/* ---------------- Korrekturbon nicht angekommen ---------------- */}
        {ansicht === 'korrekturbon' && korrektur && (
          <div className="space-y-3">
            <div className="rounded-2xl border-2 border-red-500 bg-red-50 p-3 space-y-2">
              <p className="text-sm font-bold text-red-800">⚠ Der Tisch ist verworfen — der Storno-Bon ist NICHT überall angekommen</p>
              <ul className="space-y-1 text-xs text-red-700">
                {korrektur.ziele.map((z, i) => (
                  <li key={`${z.ziel}-${i}`}>
                    <span className="font-semibold">{z.ziel}</span>
                    <span className="block text-red-600">{z.fehler}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-red-700">Die Station bereitet sonst weiter zu. Nochmal senden oder in der Küche Bescheid geben.</p>
            </div>
            <button className="w-full py-4 rounded-2xl bg-red-600 text-white font-black text-base disabled:opacity-50" disabled={laeuft} onClick={() => void korrekturNachsenden()}>
              {laeuft ? 'Sende …' : 'Nochmal senden'}
            </button>
            <button className="w-full py-3 rounded-2xl border border-line-strong text-ink font-bold text-sm" onClick={onZurUebersicht}>
              OK, zur Übersicht
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function AktionsKnopf({ icon, titel, hinweis, onClick, rot = false, deaktiviert = false }: {
  icon: string; titel: string; hinweis: string; onClick: () => void; rot?: boolean; deaktiviert?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={deaktiviert}
      className={`w-full flex items-center gap-3 rounded-2xl border px-4 py-3 text-left active:scale-[0.98] transition disabled:opacity-40 ${
        rot ? 'border-red-200 bg-red-50' : 'border-line bg-surface'
      }`}
    >
      <span className="text-2xl w-8 text-center shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className={`block font-bold text-base ${rot ? 'text-red-700' : 'text-ink'}`}>{titel}</span>
        <span className="block text-xs text-ink-subtle">{hinweis}</span>
      </span>
      <span className="text-ink-subtle text-xl">›</span>
    </button>
  )
}
