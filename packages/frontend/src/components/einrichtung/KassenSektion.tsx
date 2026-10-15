/**
 * Kassen — alle Kassen auf einen Blick, jede Zeile direkt bedienbar: Startseite, Belegausgabe,
 * Rechnungsdrucker, aktive Bonierdrucker und KDS an/aus. Alles Weitere (Bezeichnung, Zahlungsarten, Gast-
 * Bestellung, KDS-Adressen, Kartenterminal, Einrichtung übernehmen, Betrieb) klappt unter der Zeile auf.
 * Dazu: weitere Kassen anlegen — auch mehrere auf einmal.
 *
 * Bisher gab es zwei Wege: „Kassen" (Umschalter) und „Hardware" (je Kasse eine Karte, KDS und Kartenterminal
 * nur für die gerade aktive Kasse). Hier gilt alles für JEDE Kasse, ohne zwischen Kassen zu wechseln.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { type EinrichtungKasse, type Startseite } from '@kassa/shared'
import { bonierdruckerApi, druckerPoolApi } from '../../lib/api'
import { getKasseIdentity, setKasseIdentity } from '../../lib/kasse'
import { getAuth } from '../../lib/auth'
import { kassenName } from '../../lib/einrichtung'
import { Button } from '../ui/Button'
import { Schalter } from '../ui/Schalter'
import { useEinrichtung } from './EinrichtungKontext'
import { KasseDetails } from './KasseDetails'
import { NeueKasseFormular } from './NeueKasseFormular'

type Meldung = { typ: 'ok' | 'fehler'; text: string }

const STARTSEITEN: { value: Startseite; label: string }[] = [
  { value: 'tische',          label: 'Tische' },
  { value: 'kasse',           label: 'Kasse' },
  { value: 'kasse_favoriten', label: 'Favoriten' },
  { value: 'dashboard',       label: 'Dashboard' },
]

const ZELLEN_AUSWAHL = 'block w-full min-w-[7.5rem] rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50'

export function KassenSektion() {
  const { kassen, laedt, istGastro, neuLaden } = useEinrichtung()
  const auth     = getAuth()!
  const identity = getKasseIdentity()

  const [formOffen, setFormOffen] = useState(false)
  const [offen, setOffen]         = useState<ReadonlySet<string>>(() => new Set())
  const [meldung, setMeldung]     = useState<Meldung | null>(null)

  function wechsleZu(kasseId: string) {
    if (kasseId === identity?.kasseId) return
    setKasseIdentity({ mandantId: auth.mandant.id, kasseId })
    // Detail-Sektionen lesen die Kassen-ID nicht-reaktiv beim Render → Neuladen.
    window.location.reload()
  }

  const umschalten = (id: string) =>
    setOffen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const spalten = istGastro ? 7 : 6

  return (
    <section id="einrichtung-kassen" className="rounded-lg bg-panel shadow-sm border border-line p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Kassen</h2>
          <p className="text-sm text-ink-muted mt-0.5">
            Alle Kassen auf einen Blick — jede Zeile ist direkt änderbar und wirkt sofort. „Details" öffnet alles Weitere
            (Bezeichnung, Zahlungsarten, Gast-Bestellung, Kartenterminal, Einrichtung von einer anderen Kasse übernehmen).
          </p>
        </div>
        {!formOffen && (
          <Button variant="secondary" onClick={() => { setMeldung(null); setFormOffen(true) }}>+ Weitere Kasse anlegen</Button>
        )}
      </div>

      {formOffen && (
        <NeueKasseFormular
          kassen={kassen}
          onAbbrechen={() => { setFormOffen(false); setMeldung(null) }}
          onFertig={m => {
            setMeldung(m)
            void neuLaden()
            if (m.typ === 'ok') setFormOffen(false)
          }}
        />
      )}

      {meldung && (
        <div role="status" className={`rounded-md p-3 text-sm ${
          meldung.typ === 'ok'
            ? 'bg-green-50 border border-green-200 text-green-700'
            : 'bg-red-50 border border-red-200 text-red-700'
        }`}>{meldung.text}</div>
      )}

      {laedt ? (
        <p className="text-sm text-ink-muted">Wird geladen…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm" data-testid="kassen-tabelle">
            <thead className="bg-panel-2 text-ink-muted">
              <tr className="text-left text-xs font-medium">
                <th className="px-3 py-2">Kasse</th>
                <th className="px-3 py-2">Startseite</th>
                <th className="px-3 py-2">Belegausgabe</th>
                <th className="px-3 py-2">Rechnungsdrucker</th>
                {istGastro && <th className="px-3 py-2">Bonierdrucker (Küche/Schank)</th>}
                <th className="px-3 py-2">KDS</th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            {kassen.map(k => (
              <KasseZeile
                key={k.id}
                kasse={k}
                spalten={spalten}
                istDiesesGeraet={k.id === identity?.kasseId}
                detailsOffen={offen.has(k.id)}
                onDetails={() => umschalten(k.id)}
                onWechseln={() => wechsleZu(k.id)}
                onMeldung={setMeldung}
              />
            ))}
          </table>
        </div>
      )}
    </section>
  )
}

function KasseZeile({ kasse: k, spalten, istDiesesGeraet, detailsOffen, onDetails, onWechseln, onMeldung }: {
  kasse:           EinrichtungKasse
  spalten:         number
  istDiesesGeraet: boolean
  detailsOffen:    boolean
  onDetails:       () => void
  onWechseln:      () => void
  onMeldung:       (m: Meldung | null) => void
}) {
  const { istGastro, speichern } = useEinrichtung()
  const poolQuery   = useQuery({ queryKey: ['drucker-pool'], queryFn: () => druckerPoolApi.list() })
  const bonierQuery = useQuery({ queryKey: ['bonierdrucker'], queryFn: bonierdruckerApi.list, enabled: istGastro })
  const pool   = poolQuery.data ?? []
  const bonier = bonierQuery.data ?? []

  const name        = kassenName(k)
  const stillgelegt = k.status === 'ausser_betrieb'

  // Aktive Bonierdrucker dieser Kasse: leere Liste = ALLE (wie der Server sie auswertet). Ein Klick schaltet
  // einen Drucker an/aus; sind danach alle an, gilt wieder „leer = alle"; der letzte lässt sich nicht abwählen.
  const alleIds = bonier.map(b => b.id)
  const imEinsatz = k.sichtbareBonierdruckerIds.length === 0 ? new Set(alleIds) : new Set(k.sichtbareBonierdruckerIds)
  const druckerUmschalten = (id: string) => {
    const neu = new Set(imEinsatz)
    if (neu.has(id)) neu.delete(id); else neu.add(id)
    if (neu.size === 0) { onMeldung({ typ: 'fehler', text: `${name}: Mindestens ein Bonierdrucker bleibt aktiv.` }); return }
    onMeldung(null)
    void speichern(k.id, { sichtbareBonierdruckerIds: neu.size >= alleIds.length ? [] : alleIds.filter(i => neu.has(i)) })
  }

  return (
    <tbody data-testid={`kasse-zeile-${k.kassenId}`} className="border-t border-line first:border-t-0">
      <tr className={`${istDiesesGeraet && !stillgelegt ? 'bg-brand-50' : ''} ${stillgelegt ? 'bg-panel-2/60' : ''} align-top`}>
        <td className={`px-3 py-2.5 min-w-[12rem] ${stillgelegt ? 'opacity-70' : ''}`}>
          <p className="font-medium text-ink">
            {name}
            {istDiesesGeraet && !stillgelegt && <span className="ml-2 text-xs font-semibold text-brand-700">● aktiv</span>}
            {stillgelegt && (
              <span className="ml-2 text-xs font-semibold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                außer Betrieb
                {k.ausserBetriebAm && <> seit {new Date(k.ausserBetriebAm).toLocaleDateString('de-AT')}</>}
              </span>
            )}
          </p>
          <p className="text-xs text-ink-muted">
            ID: {k.kassenId} · {k.umgebung === 'produktion' ? 'Produktion' : 'Test'}
            {k.beiFoRegistriert ? ' · FinanzOnline registriert' : ' · provisorisch'}
          </p>
        </td>

        {stillgelegt ? (
          <td colSpan={spalten - 2} className="px-3 py-2.5 text-xs text-ink-subtle">Diese Kasse ist stillgelegt — keine Einstellungen mehr nötig.</td>
        ) : (
          <>
            <td className="px-3 py-2.5">
              <select
                aria-label={`Startseite ${name}`}
                className={ZELLEN_AUSWAHL}
                value={k.startseite}
                onChange={e => void speichern(k.id, { startseite: e.target.value as Startseite })}
              >
                {STARTSEITEN.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </td>
            <td className="px-3 py-2.5">
              <select
                aria-label={`Belegausgabe ${name}`}
                className={ZELLEN_AUSWAHL}
                value={k.belegModus}
                onChange={e => void speichern(k.id, { belegModus: e.target.value as EinrichtungKasse['belegModus'] })}
              >
                <option value="drucken" title="Nur Papier-Bon">Drucken</option>
                <option value="digital" title="Nur digital (Bildschirm + E-Mail)">Digital</option>
                <option value="beides" title="Papier-Bon UND digital">Beides</option>
              </select>
            </td>
            <td className="px-3 py-2.5">
              <select
                aria-label={k.belegModus === 'digital' ? `Ausweich-Bondrucker ${name}` : `Rechnungsdrucker ${name}`}
                className={ZELLEN_AUSWAHL}
                value={k.druckerId ?? ''}
                onChange={e => void speichern(k.id, { druckerId: e.target.value || null })}
              >
                <option value="">— kein Druck —</option>
                {pool.map(d => (
                  <option key={d.id} value={d.id} title={`${d.ip}:${d.port}`}>{d.name}{d.aktiv ? '' : ' — deaktiviert'}</option>
                ))}
              </select>
            </td>
            {istGastro && (
              <td className="px-3 py-2.5 min-w-[13rem]">
                {bonier.length === 0 ? (
                  <span className="text-xs text-ink-subtle">Noch kein Bonierdrucker angelegt.</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {bonier.map(b => {
                      const an = imEinsatz.has(b.id)
                      return (
                        <button
                          key={b.id}
                          type="button"
                          aria-pressed={an}
                          title={b.istBackup ? 'Backup-Drucker: bekommt eine Kopie jedes Bons' : 'Aktiv an dieser Kasse'}
                          onClick={() => druckerUmschalten(b.id)}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
                            an ? 'bg-brand-600 border-brand-600 text-white' : 'bg-panel border-line-strong text-ink-muted hover:border-brand-400'
                          } ${b.aktiv ? '' : 'line-through opacity-60'}`}
                        >
                          <span aria-hidden>{an ? '✓' : '+'}</span>{b.name}{b.istBackup && <span className="opacity-80">· Backup</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
              </td>
            )}
            <td className="px-3 py-2.5">
              <Schalter an={k.kdsAktiv} label={`KDS ${name}`} onChange={an => void speichern(k.id, { kdsAktiv: an })} />
            </td>
          </>
        )}

        <td className="px-3 py-2.5 text-right whitespace-nowrap">
          <div className="flex items-center justify-end gap-2">
            {!stillgelegt && !istDiesesGeraet && (
              <Button variant="secondary" size="sm" onClick={onWechseln}>Wechseln</Button>
            )}
            <button
              type="button"
              aria-expanded={detailsOffen}
              onClick={onDetails}
              className="text-xs px-2 py-1.5 rounded-md border border-line-strong text-ink hover:border-brand-400"
            >
              Details {detailsOffen ? '▴' : '▾'}
            </button>
          </div>
        </td>
      </tr>
      {detailsOffen && (
        <tr className="bg-panel-2/40">
          <td colSpan={spalten}>
            <KasseDetails kasse={k} istDiesesGeraet={istDiesesGeraet} onMeldung={onMeldung} />
          </td>
        </tr>
      )}
    </tbody>
  )
}
