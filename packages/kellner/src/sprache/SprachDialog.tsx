/**
 * Sprachbestellung (optionales Modul) — Dialog mit Sprechtaste.
 *
 * Ablauf: Taste HALTEN und die Bestellung sagen, loslassen → die App versteht, liest vor („zwei Bier … Richtig?")
 * und zeigt die Vorschläge. Dann „ja" sagen (Taste halten) oder „In den Korb" tippen. Weitere Sätze („noch zwei Cola")
 * hängen sich an die Liste. Nichts wird gebucht, bevor der Kellner bestätigt; die Vorschläge landen im normalen Korb.
 *
 * Wird nur geladen, wenn das Modul aktiv ist (React.lazy in der Artikelseite) — die Logik steckt in den
 * reinen Dateien nebenan (befehle, eintraege, korb) und ist dort getestet.
 */

import { useEffect, useRef, useState } from 'react'
import type { Artikel, ModifikatorGruppe } from '@kassa/shared'
import { ApiError, modifikatorApi, spracheApi } from '../lib/api'
import { erkenneBefehl } from './befehle'
import {
  aendereMenge, alternativeGewaehlt, anzeigeStatus, auswahlArtikel, ausErgebnis, hinweiseFuer, optionenFuer,
  tischStimmt, vorlesetextFuer, waehleArtikel, type SprachEintrag,
} from './eintraege'
import { erkennungStatus, starteErkennung, type ErkennungSitzung } from './erkennung'
import { baueKorbPositionen, type KorbPosition, type OffenerEintrag } from './korb'
import { speichereVorlesenGewuenscht, spreche, stoppeSprechen, vorlesenGewuenscht, vorlesenVerfuegbar } from './vorlesen'

interface Props {
  /** Alle bestellbaren Artikel der Kasse (aus der Artikelseite) */
  artikel:       Artikel[]
  /** Nummer des geöffneten Tisches (für den Abgleich mit dem gehörten Tisch), null = Theke */
  tischNummer:   string | null
  onUebernehmen: (positionen: KorbPosition[]) => void
  /** Optionen von Hand wählen (öffnet die normale Optionen-Seite) */
  onManuell:     (artikel: Artikel, menge: number) => void
  onSchliessen:  () => void
}

type Phase = 'bereit' | 'hoert' | 'verarbeite'

const MAX_SPRECHDAUER_MS = 30_000

const AMPEL = { sicher: 'bg-brand-500', pruefen: 'bg-amber-500', unbekannt: 'bg-red-500' } as const
const AMPEL_TEXT = { sicher: 'sicher erkannt', pruefen: 'bitte prüfen', unbekannt: 'nicht verstanden' } as const

export default function SprachDialog({ artikel, tischNummer, onUebernehmen, onManuell, onSchliessen }: Props) {
  const [phase, setPhaseState] = useState<Phase>('bereit')
  const [zwischen, setZwischen] = useState('')
  const [eintraege, setEintraege] = useState<SprachEintrag[]>([])
  const [offen, setOffen] = useState<OffenerEintrag[] | null>(null)
  /** Wie viele Einträge schon in den Korb gelegt wurden (für die Überschrift der offenen Liste) */
  const [uebernommen, setUebernommen] = useState(0)
  const [fehler, setFehler] = useState<string | null>(null)
  const [gehoerterTisch, setGehoerterTisch] = useState<string | null>(null)
  const [vorlesen, setVorlesen] = useState(() => vorlesenVerfuegbar() && vorlesenGewuenscht())
  const [uebernimmt, setUebernimmt] = useState(false)

  // Refs: Ereignis-Handler der Taste und asynchrone Abläufe sehen so immer den aktuellen Stand
  const phaseRef = useRef<Phase>('bereit')
  const eintraegeRef = useRef<SprachEintrag[]>([])
  const vorlesenRef = useRef(vorlesen)
  const sitzung = useRef<ErkennungSitzung | null>(null)
  const zeitLimit = useRef<ReturnType<typeof setTimeout> | null>(null)
  const naechsteId = useRef(1)
  eintraegeRef.current = eintraege
  vorlesenRef.current = vorlesen

  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p) }

  function loescheZeitLimit() {
    if (zeitLimit.current) { clearTimeout(zeitLimit.current); zeitLimit.current = null }
  }

  useEffect(() => () => { loescheZeitLimit(); sitzung.current?.abbrechen(); stoppeSprechen() }, [])

  // ---- Sprechen -------------------------------------------------------------

  function startSprechen() {
    if (phaseRef.current !== 'bereit' || uebernimmt) return
    stoppeSprechen() // eine laufende Ansage sofort beenden
    setFehler(null)
    setZwischen('')
    const status = erkennungStatus()
    if (!status.ok) { setFehler(status.grund); return }
    setPhase('hoert')
    sitzung.current = starteErkennung({
      onZwischen: setZwischen,
      onFertig:   (text) => { void verarbeite(text) },
      onFehler:   (meldung) => { loescheZeitLimit(); setFehler(meldung); setPhase('bereit') },
    })
    // Sicherung: eine hängende Taste (z. B. nach dem Mikrofon-Dialog) beendet sich selbst
    zeitLimit.current = setTimeout(() => sitzung.current?.stoppen(), MAX_SPRECHDAUER_MS)
  }

  function endeSprechen() {
    if (phaseRef.current !== 'hoert') return
    loescheZeitLimit()
    sitzung.current?.stoppen() // der fertige Text kommt über onFertig
  }

  async function verarbeite(text: string) {
    loescheZeitLimit()
    setZwischen(text)

    const befehl = erkenneBefehl(text)
    if (befehl) {
      setPhase('bereit')
      if (eintraegeRef.current.length === 0) { setFehler('Es gibt noch nichts zu bestätigen.'); return }
      if (befehl === 'bestaetigen') await uebernehmen()
      else onSchliessen()
      return
    }

    setPhase('verarbeite')
    try {
      const ergebnis = await spracheApi.bestellung(text)
      const neue = ausErgebnis(ergebnis, naechsteId.current)
      naechsteId.current += neue.length
      if (neue.length === 0) { setFehler('Nichts verstanden. Bitte noch einmal sagen.'); return }
      const alle = [...eintraegeRef.current, ...neue]
      setEintraege(alle)
      if (ergebnis.tisch !== null) setGehoerterTisch(ergebnis.tisch)
      if (vorlesenRef.current) void spreche(vorlesetextFuer(alle))
    } catch (err) {
      setFehler(err instanceof ApiError ? err.message : 'Die Bestellung konnte nicht verarbeitet werden.')
    } finally {
      setPhase('bereit')
    }
  }

  // ---- Übernehmen -----------------------------------------------------------

  async function uebernehmen() {
    if (uebernimmt) return
    setUebernimmt(true)
    setFehler(null)
    try {
      const aktuelle = eintraegeRef.current
      const ids = [...new Set(aktuelle.flatMap(e => (e.artikelId ? [e.artikelId] : [])))]
      // Optionsgruppen JEDES Artikels laden — scheitert das, wird NICHT geraten (sonst fehlten Pflicht-Optionen)
      const gruppenJe = new Map<string, ModifikatorGruppe[]>()
      await Promise.all(ids.map(async id => { gruppenJe.set(id, await modifikatorApi.getGruppenFuerArtikel(id)) }))

      const { positionen, offen: rest } = baueKorbPositionen(aktuelle, artikel, gruppenJe)
      if (positionen.length > 0) onUebernehmen(positionen)
      if (rest.length === 0) { stoppeSprechen(); onSchliessen(); return }
      setUebernommen(aktuelle.length - rest.length)
      setOffen(rest)
      setEintraege(rest.map(r => r.eintrag))
    } catch (err) {
      setFehler(err instanceof ApiError ? err.message : 'Die Optionen der Artikel konnten nicht geladen werden. Bitte noch einmal versuchen.')
    } finally {
      setUebernimmt(false)
    }
  }

  function entferneOffen(id: number) {
    const rest = (offen ?? []).filter(o => o.eintrag.id !== id)
    if (rest.length === 0) { onSchliessen(); return }
    setOffen(rest)
    setEintraege(rest.map(r => r.eintrag))
  }

  const aendere = (id: number, fn: (e: SprachEintrag) => SprachEintrag) =>
    setEintraege(prev => prev.map(e => (e.id === id ? fn(e) : e)))
  const entferne = (id: number) => setEintraege(prev => prev.filter(e => e.id !== id))

  function schalteVorlesen() {
    const an = !vorlesen
    setVorlesen(an)
    speichereVorlesenGewuenscht(an)
    if (!an) stoppeSprechen()
  }

  const tischWarnung = gehoerterTisch !== null && !tischStimmt(gehoerterTisch, tischNummer)

  // ---------------------------------------------------------------------------

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" data-testid="sprache-dialog">
      <div className="w-full max-w-lg max-h-[92vh] flex flex-col rounded-t-3xl bg-panel shadow-2xl">

        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          <h2 className="flex-1 font-black text-ink text-lg">🎙 Sprachbestellung</h2>
          {vorlesenVerfuegbar() && (
            <button
              type="button"
              onClick={schalteVorlesen}
              aria-pressed={vorlesen}
              title={vorlesen ? 'Vorlesen ist an' : 'Vorlesen ist aus'}
              className={`h-9 rounded-xl border-2 px-3 text-sm font-bold transition ${vorlesen ? 'border-brand-500 text-brand-700' : 'border-line text-ink-subtle'}`}
            >{vorlesen ? '🔊 Vorlesen' : '🔇 Vorlesen'}</button>
          )}
          <button type="button" onClick={onSchliessen} aria-label="Schließen" className="h-9 w-9 rounded-xl text-2xl leading-none text-ink-subtle">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-2 space-y-3">

          {tischWarnung && (
            <p data-testid="sprache-tischwarnung" className="rounded-xl bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-900">
              Du hast „Tisch {gehoerterTisch}" gesagt — die Bestellung geht an {tischNummer ? `Tisch ${tischNummer.replace(/^tisch\s*/i, '')}` : 'die Theke'}.
            </p>
          )}

          {offen !== null && (
            <p data-testid="sprache-offen-titel" className="text-sm font-semibold text-ink">
              {uebernommen > 0 ? `${uebernommen} in den Korb gelegt. ` : 'Noch nichts in den Korb gelegt. '}Das hier braucht deine Hilfe:
            </p>
          )}

          {eintraege.length === 0 && phase !== 'hoert' && !fehler && (
            <p className="py-4 text-center text-sm text-ink-subtle">
              Sprechtaste <strong>halten</strong>, die Bestellung sagen, loslassen.<br />
              Zum Beispiel: „zwei Bier und ein Schnitzel mit Pommes".
            </p>
          )}

          {phase === 'hoert' && (
            <p data-testid="sprache-zwischen" className="rounded-2xl bg-surface px-4 py-3 text-center text-base text-ink">
              {zwischen || 'Ich höre …'}
            </p>
          )}

          {fehler && <p data-testid="sprache-fehler" role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{fehler}</p>}

          <ul className="space-y-2">
            {offen === null && eintraege.map(e => {
              const status = anzeigeStatus(e)
              const optionen = optionenFuer(e)
              const hinweise = hinweiseFuer(e)
              const waehlbar = auswahlArtikel(e)
              const name = waehlbar.find(a => a.id === e.artikelId)?.bezeichnung
              return (
                <li key={e.id} data-testid="sprache-eintrag" data-status={status} className="rounded-2xl border-2 border-line bg-surface px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${AMPEL[status]}`} title={AMPEL_TEXT[status]} />
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-ink text-sm leading-snug">
                        {name ?? `Nicht verstanden: „${e.vorschlag.text}"`}
                      </p>
                      {waehlbar.length > 1 && (
                        <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Meintest du …">
                          {waehlbar.map(a => (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => aendere(e.id, x => waehleArtikel(x, a.id))}
                              aria-pressed={a.id === e.artikelId}
                              className={`rounded-lg border px-2 py-1 text-xs font-semibold ${a.id === e.artikelId ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-line text-ink-muted'}`}
                            >{a.bezeichnung}</button>
                          ))}
                        </div>
                      )}
                      {optionen.length > 0 && <p className="mt-0.5 text-xs text-brand-700">{optionen.map(o => o.name).join(', ')}</p>}
                      {hinweise.length > 0 && (
                        <p className="mt-0.5 text-xs font-semibold text-amber-700">⚠ {hinweise.join(', ')} — nicht zuordenbar, bitte von Hand wählen</p>
                      )}
                      {alternativeGewaehlt(e) && e.vorschlag.modifikatoren.length > 0 && (
                        <p className="mt-0.5 text-xs text-ink-subtle">Optionen des ersten Treffers entfallen.</p>
                      )}
                    </div>
                    {e.artikelId !== null && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button type="button" onClick={() => aendere(e.id, x => aendereMenge(x, -1))} aria-label="Weniger" className="h-8 w-8 rounded-lg border-2 border-brand-300 font-black text-brand-700">−</button>
                        <span className="w-6 text-center text-sm font-black text-ink" data-testid="sprache-menge">{e.menge}</span>
                        <button type="button" onClick={() => aendere(e.id, x => aendereMenge(x, +1))} aria-label="Mehr" className="h-8 w-8 rounded-lg bg-brand-600 font-black text-white">+</button>
                      </div>
                    )}
                    <button type="button" onClick={() => entferne(e.id)} aria-label="Entfernen" className="h-8 w-8 shrink-0 rounded-lg text-xl leading-none text-ink-subtle">×</button>
                  </div>
                </li>
              )
            })}

            {offen !== null && offen.map(o => (
              <li key={o.eintrag.id} data-testid="sprache-offen" className="rounded-2xl border-2 border-amber-300 bg-amber-50 px-3 py-2.5">
                <p className="font-bold text-ink text-sm">{o.eintrag.menge}× {o.artikel?.bezeichnung ?? o.eintrag.vorschlag.text}</p>
                <p className="text-xs font-semibold text-amber-800">{o.grund}</p>
                <div className="mt-2 flex gap-2">
                  {o.artikel && (
                    <button type="button" onClick={() => onManuell(o.artikel!, o.eintrag.menge)} className="flex-1 rounded-xl bg-brand-600 py-2 text-sm font-black text-white active:scale-95 transition">
                      Optionen wählen
                    </button>
                  )}
                  <button type="button" onClick={() => entferneOffen(o.eintrag.id)} className="rounded-xl border-2 border-line px-4 py-2 text-sm font-bold text-ink-muted">Entfernen</button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2 border-t border-line px-4 py-3">
          {offen === null ? (
            <>
              {eintraege.length > 0 && (
                <button
                  type="button"
                  data-testid="sprache-uebernehmen"
                  onClick={() => void uebernehmen()}
                  disabled={uebernimmt || phase !== 'bereit'}
                  className="w-full rounded-2xl bg-brand-600 py-3.5 text-lg font-black text-white active:scale-95 transition disabled:opacity-50"
                >{uebernimmt ? 'Einen Moment …' : `In den Korb (${eintraege.length})`}</button>
              )}
              <button
                type="button"
                data-testid="sprache-sprechtaste"
                onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); startSprechen() }}
                onPointerUp={endeSprechen}
                onPointerCancel={endeSprechen}
                onContextMenu={e => e.preventDefault()}
                onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startSprechen() } }}
                onKeyUp={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); endeSprechen() } }}
                disabled={uebernimmt}
                className={`w-full touch-none select-none rounded-2xl py-5 text-lg font-black transition disabled:opacity-50 ${
                  phase === 'hoert' ? 'bg-red-600 text-white scale-[0.98]' : 'border-2 border-brand-600 text-brand-700 active:scale-95'
                }`}
              >
                {phase === 'hoert' ? '● Ich höre … (loslassen)' : phase === 'verarbeite' ? 'Moment …' : eintraege.length > 0 ? '🎙 Halten: „ja" oder weiter bestellen' : '🎙 Halten und sprechen'}
              </button>
              <p className="text-center text-[11px] leading-snug text-ink-subtle">
                Die Erkennung läuft über den Browser (Chrome/Edge) — das Gesprochene geht dabei an dessen Hersteller.
              </p>
            </>
          ) : (
            <button type="button" onClick={onSchliessen} className="w-full rounded-2xl border-2 border-line py-3 text-base font-bold text-ink-muted">Fertig</button>
          )}
        </div>
      </div>
    </div>
  )
}
